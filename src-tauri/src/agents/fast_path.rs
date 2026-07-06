//! Fast-path execution for high-confidence intents (L0/L1 Chitchat, VaultStats).
//!
//! Skips the full agent loop: runs zero or one tool, then a lightweight LLM reply.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::AppHandle;

use crate::error::ZettelError;
use crate::llm::{self, AgentEvent, ChatMessage, LlmConfig};

/// Natural conversation system prompt — shared by greeting path and chitchat fast path.
pub fn chitchat_system_prompt(current_time: &str) -> String {
    format!(
        "You are ZettelAgent, a friendly assistant in a personal note-taking app. \
         Current time: {current_time}.\n\n\
         Reply naturally and briefly in the SAME language as the user.\n\
         - Greetings, small talk, jokes, banter, or mild provocation: respond warmly with \
         light humor — never stiff, preachy, or corporate.\n\
         - If the user teases or insults playfully, deflect with brief wit; do not lecture or \
         repeat boilerplate like \"I'm your knowledge assistant\".\n\
         - Only explain your capabilities when the user explicitly asks what you can do.\n\
         - Do not mention tools, APIs, orchestration, or internal architecture.\n\
         - Keep replies to 1–3 sentences unless the user asks for more.\n\n\
         {chitchat_context}"
        ,
        chitchat_context = crate::llm::prompts::CHITCHAT_CONTEXT_GUIDANCE,
    )
}

fn append_user_if_needed(messages: &mut Vec<ChatMessage>, user_query: &str) {
    if messages.last().map(|m| m.role.as_str()) != Some("user") {
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: user_query.to_string(),
            ..Default::default()
        });
    }
}

/// Pure `chat_completion` streaming — no tool loop, no thinking overhead.
/// When `answer_stream` is true, emits `ClearText` first so the frontend routes
/// tokens to the answer bubble instead of the agent trace (avoids flash-then-wipe).
pub async fn stream_natural_reply(
    config: &LlmConfig,
    messages: &[ChatMessage],
    app: &AppHandle,
    answer_stream: bool,
) -> Result<String, ZettelError> {
    if answer_stream {
        llm::emit_agent_event(app, AgentEvent::ClearText { answer_stream: true });
    }

    let mut rx = llm::chat_completion_stream(config, messages)
        .await
        .map_err(|e| ZettelError::Llm(llm::format_llm_user_error(&e.to_string())))?;

    let mut full = String::new();
    while let Some(chunk) = rx.recv().await {
        if !chunk.content.is_empty() {
            full.push_str(&chunk.content);
            llm::emit_agent_event(
                app,
                AgentEvent::TextDelta {
                    content: chunk.content,
                },
            );
        }
        if chunk.done {
            break;
        }
    }

    llm::emit_agent_event(
        app,
        AgentEvent::Done {
            total_tool_calls: 0,
            answer_source: None,
            answer_preview: None,
        },
    );

    Ok(full)
}

/// Help / capability Q&A — no tools, natural conversation prompt.
pub async fn run_chitchat_fast_path(
    config: &LlmConfig,
    user_query: &str,
    chat_history: &[ChatMessage],
    current_time: &str,
    app: &AppHandle,
) -> Result<String, ZettelError> {
    crate::chat_file_log::log_agent("fast_path chitchat");

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: chitchat_system_prompt(current_time),
        ..Default::default()
    }];
    messages.extend(chat_history.iter().cloned());
    append_user_if_needed(&mut messages, user_query);

    let content = stream_natural_reply(config, &messages, app, true).await?;

    crate::chat_file_log::log_agent(&format!(
        "turn_complete fast_path_chitchat chars={}",
        content.len()
    ));
    Ok(content)
}

/// Vault statistics — one `get_vault_stats` call, then a concise formatted answer.
pub async fn run_vault_stats_fast_path(
    config: &LlmConfig,
    user_query: &str,
    chat_history: &[ChatMessage],
    current_time: &str,
    vault_info: &str,
    db: Arc<Mutex<rusqlite::Connection>>,
    vault: String,
    all_vaults: Vec<String>,
    skill_dirs: Vec<String>,
    app: &AppHandle,
) -> Result<String, ZettelError> {
    crate::chat_file_log::log_agent("fast_path vault_stats");

    let tool_call_id = "fastpath_stats_1".to_string();
    let tool_name = "get_vault_stats";
    let tool_args = "{}";

    llm::emit_agent_event(
        app,
        AgentEvent::ToolCallDetected {
            tool_call_id: tool_call_id.clone(),
            name: tool_name.to_string(),
        },
    );
    llm::emit_agent_event(
        app,
        AgentEvent::ToolStart {
            tool_call_id: tool_call_id.clone(),
            name: tool_name.to_string(),
            arguments: tool_args.to_string(),
        },
    );

    let started = Instant::now();
    let stats = crate::tools::execute_tool(
        tool_name,
        tool_args,
        &db,
        &vault,
        &all_vaults,
        config,
        &skill_dirs,
    )
    .await
    .map_err(|e| ZettelError::Llm(e.to_string()))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    llm::emit_agent_event(
        app,
        AgentEvent::ToolResult {
            tool_call_id: tool_call_id.clone(),
            name: tool_name.to_string(),
            content: stats.clone(),
            duration_ms,
        },
    );

    llm::emit_agent_event(app, AgentEvent::ClearText { answer_stream: true });

    let system = format!(
        "You are ZettelAgent, a personal knowledge assistant. \
         Current time: {current_time}. {vault_info}\n\n\
         The user asked about vault statistics. Use ONLY the data below — do not invent numbers.\n\
         If earlier messages discuss stats already shown, build on that thread instead of repeating a generic intro.\n\n\
         ## Vault statistics (JSON)\n{stats}\n\n\
         Answer in the SAME language as the user. Be concise and friendly. \
         Highlight note count, recent activity, and tags if present."
    );

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system,
        ..Default::default()
    }];
    messages.extend(chat_history.iter().cloned());
    append_user_if_needed(&mut messages, user_query);

    // ClearText already emitted above (post-tool synthesis).
    let content = stream_natural_reply(config, &messages, app, false).await?;

    crate::chat_file_log::log_agent(&format!(
        "turn_complete fast_path_vault_stats chars={}",
        content.len()
    ));
    Ok(content)
}
