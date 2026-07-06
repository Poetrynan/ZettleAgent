// ── Anthropic Claude Adapter ───────────────────────────────────────
// Handles: Claude (tool_use / tool_result format)

use reqwest::Client;
use crate::llm::{ChatMessage, LlmConfig, ToolDef, ToolCall, ToolCallFunction};
use crate::llm::prompted_thinking::{
    ThoughtStreamParser, dispatch_content_delta, flush_content_parser, is_native_reasoning,
    emit_thinking,
};

use super::ToolCallResponse;
use super::openai::build_http_client;

/// Convert our ToolDef (OpenAI format) to Claude's tool format
fn tool_defs_to_claude(tools: &[ToolDef]) -> Vec<serde_json::Value> {
    tools.iter().map(|t| {
        serde_json::json!({
            "name": t.function.name,
            "description": t.function.description,
            "input_schema": t.function.parameters,
        })
    }).collect()
}

/// Convert internal messages to Claude's message format
pub(crate) fn messages_to_claude(messages: &[ChatMessage]) -> (String, Vec<serde_json::Value>) {
    let system = messages.iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let mut claude_msgs: Vec<serde_json::Value> = Vec::new();

    // Track consecutive tool results to batch them as user content blocks
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();

    for m in messages.iter().filter(|m| m.role != "system") {
        if m.role == "tool" {
            // Claude: tool results are user message content blocks
            pending_tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": m.tool_call_id.as_deref().unwrap_or(""),
                "content": m.content,
            }));
            continue;
        }

        // Flush pending tool results as a user message before any non-tool message
        if !pending_tool_results.is_empty() {
            claude_msgs.push(serde_json::json!({
                "role": "user",
                "content": pending_tool_results.clone(),
            }));
            pending_tool_results.clear();
        }

        if m.role == "assistant" {
            if let Some(ref tcs) = m.tool_calls {
                // Assistant with tool_calls → content blocks
                let mut content_blocks: Vec<serde_json::Value> = Vec::new();
                if !m.content.is_empty() {
                    content_blocks.push(serde_json::json!({
                        "type": "text",
                        "text": m.content,
                    }));
                }
                for tc in tcs {
                    let input: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::json!({}));
                    content_blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.function.name,
                        "input": input,
                    }));
                }
                claude_msgs.push(serde_json::json!({
                    "role": "assistant",
                    "content": content_blocks,
                }));
            } else {
                claude_msgs.push(serde_json::json!({
                    "role": "assistant",
                    "content": m.content,
                }));
            }
        } else {
            // user message
            claude_msgs.push(serde_json::json!({
                "role": "user",
                "content": m.content,
            }));
        }
    }

    // Flush remaining tool results
    if !pending_tool_results.is_empty() {
        claude_msgs.push(serde_json::json!({
            "role": "user",
            "content": pending_tool_results,
        }));
    }

    (system, claude_msgs)
}

/// Send a request to Claude API (non-tool-calling, e.g. for `chat_completion`)
pub(crate) async fn send_claude_request(
    client: &Client,
    config: &LlmConfig,
    messages: &[ChatMessage],
) -> anyhow::Result<reqwest::Response> {
    // Claude API format: system prompt is separate from messages
    let system_prompt = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let user_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": [{
                    "type": "text",
                    "text": m.content,
                    "cache_control": { "type": "ephemeral" }
                }]
            })
        })
        .collect();

    let request = serde_json::json!({
        "model": config.model,
        "max_tokens": config.max_tokens.unwrap_or(64000),
        "system": [{
            "type": "text",
            "text": system_prompt,
            "cache_control": { "type": "ephemeral" }
        }],
        "messages": user_messages,
        "temperature": config.temperature,
    });

    let mut builder = client
        .post(&config.api_url)
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .json(&request);

    if let Some(key) = &config.api_key {
        builder = builder.header("x-api-key", key);
    }

    Ok(builder.send().await?)
}

/// Send tool-calling request and parse Claude response
pub(crate) async fn send_and_parse_claude_tools(
    config: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[ToolDef],
    app_handle: &tauri::AppHandle,
) -> anyhow::Result<ToolCallResponse> {
    let client = build_http_client()?;
    let (system, claude_msgs) = messages_to_claude(messages);
    let claude_tools = tool_defs_to_claude(tools);

    let mut request = serde_json::json!({
        "model": config.model,
        "max_tokens": config.max_tokens.unwrap_or(64000),
        "temperature": config.temperature,
        "messages": claude_msgs,
        "stream": true,
    });

    if is_native_reasoning(config) {
        request["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": 10000
        });
    }

    if !system.is_empty() {
        request["system"] = serde_json::json!(system);
    }
    if !claude_tools.is_empty() {
        request["tools"] = serde_json::json!(claude_tools);
    }

    let mut builder = client
        .post(&config.api_url)
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .json(&request);

    if let Some(key) = &config.api_key {
        builder = builder.header("x-api-key", key);
    }

    let response = builder.send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Claude API error ({}): {}", status, body);
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut byte_buffer = Vec::new();

    let mut text_content = String::new();
    let mut thought_parser: Option<ThoughtStreamParser> = None;
    let native = is_native_reasoning(config);
    
    #[derive(Debug, Default)]
    struct ClaudeToolBlock {
        id: String,
        name: String,
        input_json: String,
    }
    let mut active_blocks = std::collections::HashMap::<usize, ClaudeToolBlock>::new();
    let mut text_block_indices = std::collections::HashSet::<usize>::new();

    loop {
        // Poll with a short timeout so user-cancel works even while the
        // server has not sent any bytes yet.
        let chunk_result = match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            stream.next(),
        )
        .await
        {
            Ok(Some(r)) => r,
            Ok(None) => break, // stream ended
            Err(_) => {
                if super::is_agent_cancelled() {
                    log::info!("Claude stream cancelled while waiting for data");
                    break;
                }
                continue;
            }
        };
        // Mid-stream hard cancel: drop the stream so the provider stops generating.
        if super::is_agent_cancelled() {
            log::info!("Claude stream cancelled mid-flight by user");
            break;
        }
        let bytes = chunk_result.map_err(|e| {
            anyhow::anyhow!(super::format_llm_user_error(&e.to_string()))
        })?;
        byte_buffer.extend_from_slice(&bytes);
        while let Some(pos) = byte_buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = &byte_buffer[..pos];
            let line_str = String::from_utf8_lossy(line_bytes).trim().to_string();
            byte_buffer.drain(..pos + 1);

            if line_str.is_empty() || line_str.starts_with(':') { continue; }
            if line_str == "event: message_stop" { break; }
            if let Some(data) = line_str.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    let event_type = parsed["type"].as_str().unwrap_or("");
                    match event_type {
                        "content_block_start" => {
                            if let Some(idx) = parsed["index"].as_u64() {
                                let idx = idx as usize;
                                let block = &parsed["content_block"];
                                match block["type"].as_str() {
                                    Some("thinking") => {
                                        if !native {
                                            crate::llm::reasoning_mode::bail_on_native_reasoning_mismatch(config)?;
                                        }
                                    }
                                    Some("text") => {
                                        text_block_indices.insert(idx);
                                    }
                                    Some("tool_use") => {
                                        let id = block["id"].as_str().unwrap_or("").to_string();
                                        let name = block["name"].as_str().unwrap_or("").to_string();
                                        // Emit ToolCallDetected immediately for real-time UI
                                        if !name.trim().is_empty() {
                                            crate::llm::emit_agent_event(
                                                app_handle,
                                                crate::llm::AgentEvent::ToolCallDetected {
                                                    tool_call_id: id.clone(),
                                                    name: name.clone(),
                                                },
                                            );
                                        }
                                        active_blocks.insert(idx, ClaudeToolBlock {
                                            id,
                                            name,
                                            input_json: String::new(),
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "content_block_delta" => {
                            if let Some(idx) = parsed["index"].as_u64() {
                                let idx = idx as usize;
                                let delta = &parsed["delta"];
                                let delta_type = delta["type"].as_str().unwrap_or("");
                                if delta_type == "thinking_delta" {
                                    if !native {
                                        if delta["thinking"].as_str().is_some_and(|t| !t.is_empty()) {
                                            crate::llm::reasoning_mode::bail_on_native_reasoning_mismatch(config)?;
                                        }
                                    } else if let Some(thinking) = delta["thinking"].as_str() {
                                        if !thinking.is_empty() {
                                            emit_thinking(app_handle, thinking);
                                        }
                                    }
                                } else if delta_type == "text_delta" {
                                    if let Some(text) = delta["text"].as_str() {
                                        dispatch_content_delta(
                                            config,
                                            app_handle,
                                            text,
                                            &mut thought_parser,
                                            &mut text_content,
                                        );
                                    }
                                } else if delta_type == "input_json_delta" {
                                    if let Some(json_delta) = delta["partial_json"].as_str() {
                                        if let Some(block) = active_blocks.get_mut(&idx) {
                                            block.input_json.push_str(json_delta);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    flush_content_parser(config, app_handle, &mut thought_parser, &mut text_content);

    let mut tool_calls = Vec::new();
    let mut sorted_keys: Vec<_> = active_blocks.keys().cloned().collect();
    sorted_keys.sort();
    for k in sorted_keys {
        if let Some(block) = active_blocks.get(&k) {
            // Skip tool calls with empty names (LLM hallucination)
            if block.name.trim().is_empty() {
                log::warn!("Skipping Claude tool_use block with empty name (index {})", k);
                continue;
            }
            tool_calls.push(ToolCall {
                id: block.id.clone(),
                call_type: "function".to_string(),
                function: ToolCallFunction {
                    name: block.name.clone(),
                    arguments: block.input_json.clone(),
                },
            });
        }
    }

    Ok(ToolCallResponse { content: text_content, tool_calls })
}
