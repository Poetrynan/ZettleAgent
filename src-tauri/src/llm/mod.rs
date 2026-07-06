pub mod prompts;
pub mod openai;
pub mod claude;
pub mod gemini;
pub mod prompted_thinking;
pub mod reasoning_mode;
pub mod memory_extractor;
pub mod approval;
pub mod context;
pub mod planning;
pub mod plan_guard;
pub mod adaptive_prompt;
pub mod agent_recovery;

// Re-export approval gate items
pub use approval::{
    approve_tool_call, reject_tool_call, is_write_tool,
    build_approval_diff_data, get_pending_approvals, ApprovalDiffData,
};

// Re-export context window management items
pub use context::{
    estimate_tokens, compress_context_window, get_max_context_tokens,
    compress_tool_result,
};

// Re-export adaptive planning items
pub use planning::{classify_query_complexity, is_greeting_or_chitchat};

// Re-export adaptive prompt items
pub use adaptive_prompt::{
    TaskComplexity, assess_complexity, build_prompt,
    tool_quick_ref, tool_coordination_guide,
};

// agent_recovery module kept for potential future use, but no longer wired
// into the main loop — the "Less Control" philosophy lets the model decide
// when to stop rather than injecting stagnation/recovery prompts.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tauri::Emitter;

// Re-export adapter functions used by other modules
use openai::send_and_parse_openai_tools;
use claude::{send_claude_request, send_and_parse_claude_tools};
use gemini::{messages_to_gemini, send_and_parse_gemini_tools};

// ── Types ──────────────────────────────────────────────────────────

/// Configuration for the LLM client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub api_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
    pub provider_id: Option<String>, // "deepseek", "openai", "claude", "qwen", "zhipu", "moonshot", etc.
    /// Optional context window hint (in tokens) from the frontend provider preset.
    /// When set, this overrides the hardcoded heuristics in `get_max_context_tokens`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    /// User-controlled native reasoning switch (Settings → "原生思考模式").
    /// `true`: parse API reasoning fields (`reasoning_content`, Claude `thinking_delta`).
    /// `false`: inject `<thought>` XML prompt + stream parser. No model whitelist — user decides.
    #[serde(default)]
    pub supports_thinking: Option<bool>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            api_url: "http://127.0.0.1:11434/v1/chat/completions".to_string(),
            api_key: None,
            model: "deepseek-v4".to_string(),
            temperature: 0.7,
            max_tokens: None,
            provider_id: Some("ollama".to_string()),
            context_window: None,
            supports_thinking: None,
        }
    }
}

/// A single message in the conversation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

// ── Tool Calling Types ─────────────────────────────────────────────

/// Tool definition — sent to LLM as available tools list
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub tool_type: String, // fixed "function"
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value, // JSON Schema format
}

/// Tool call — returned by LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String, // "function"
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String, // JSON string
}

/// Tool execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
}

/// A single step in the agent's live plan (model-driven via `todo_write`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub text: String,
    /// "pending" | "in_progress" | "done"
    #[serde(default)]
    pub status: String,
}

/// Agent event — sent to frontend via Tauri events
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    #[serde(rename = "thinking")]
    Thinking { message: String },
    /// Live plan update emitted when the model calls `todo_write`.
    #[serde(rename = "plan_update")]
    PlanUpdate { steps: Vec<PlanStep> },
    #[serde(rename = "tool_start")]
    ToolStart { tool_call_id: String, name: String, arguments: String },
    /// Streaming progress emitted *during* tool execution (between ToolStart and ToolResult).
    /// Carries a human-readable stage label and optional partial content preview.
    #[serde(rename = "tool_progress")]
    ToolProgress {
        tool_call_id: String,
        /// Human-readable stage label, e.g. "Fetching web page…", "Converting HTML…"
        stage: String,
        /// Optional partial content preview (first N chars of in-progress result)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
    },
    #[serde(rename = "tool_result")]
    ToolResult { tool_call_id: String, name: String, content: String, #[serde(default)] duration_ms: u64 },
    #[serde(rename = "tool_call_detected")]
    ToolCallDetected { tool_call_id: String, name: String },
    #[serde(rename = "text_delta")]
    TextDelta { content: String },
    #[serde(rename = "done")]
    Done {
        total_tool_calls: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer_source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer_preview: Option<String>,
    },
    #[serde(rename = "role_selected")]
    RoleSelected { agent_id: String, agent_name: String, agent_icon: String },
    #[serde(rename = "pipeline_progress")]
    PipelineProgress { current_step: usize, total_steps: usize, agent_name: String },
    #[serde(rename = "approval_required")]
    ApprovalRequired {
        action_description: String, agent_id: String, approval_id: String,
        /// Structured diff data encoded as JSON — frontend decodes for real diff view
        #[serde(default)]
        diff_json: String,
    },
    /// 审批已被解决(用户批准/拒绝/超时)— 前端据此移除卡片,避免永久转圈
    #[serde(rename = "approval_resolved")]
    ApprovalResolved { approval_id: String, approved: bool, reason: String },
    /// Clear the frontend answer buffer. `answer_stream: true` only for synthesis / final report.
    #[serde(rename = "clear_text")]
    ClearText {
        #[serde(default)]
        answer_stream: bool,
    },
}

/// Format an agent event as a single log line (no huge stream payloads).
pub fn format_agent_event(event: &AgentEvent) -> String {
    match event {
        AgentEvent::Thinking { message } => {
            format!("thinking +{} chars", message.len())
        }
        AgentEvent::PlanUpdate { steps } => {
            format!("plan_update steps={}", steps.len())
        }
        AgentEvent::ToolStart {
            tool_call_id,
            name,
            arguments,
        } => {
            format!(
                "tool_start id={} name={} args={}",
                tool_call_id,
                name,
                crate::chat_file_log::trunc(arguments, 240)
            )
        }
        AgentEvent::ToolResult {
            tool_call_id,
            name,
            content,
            duration_ms,
        } => {
            format!(
                "tool_result id={} name={} {}ms result={}",
                tool_call_id,
                name,
                duration_ms,
                crate::chat_file_log::trunc(content, 320)
            )
        }
        AgentEvent::ToolProgress {
            tool_call_id,
            stage,
            preview,
        } => {
            format!(
                "tool_progress id={} stage={} preview={}",
                tool_call_id,
                stage,
                preview.as_deref().map(|p| crate::chat_file_log::trunc(p, 120)).unwrap_or_default()
            )
        }
        AgentEvent::ToolCallDetected { tool_call_id, name } => {
            format!("tool_detected id={} name={}", tool_call_id, name)
        }
        AgentEvent::TextDelta { content } => {
            format!("text_delta +{} chars", content.len())
        }
        AgentEvent::Done {
            total_tool_calls,
            answer_source,
            answer_preview,
        } => {
            if let Some(src) = answer_source {
                if let Some(preview) = answer_preview {
                    format!(
                        "done total_tool_calls={} source={} preview={}",
                        total_tool_calls,
                        src,
                        crate::chat_file_log::trunc(preview, 160)
                    )
                } else {
                    format!("done total_tool_calls={} source={}", total_tool_calls, src)
                }
            } else {
                format!("done total_tool_calls={}", total_tool_calls)
            }
        }
        AgentEvent::RoleSelected {
            agent_id,
            agent_name,
            ..
        } => {
            format!("role_selected id={} name={}", agent_id, agent_name)
        }
        AgentEvent::PipelineProgress {
            current_step,
            total_steps,
            agent_name,
        } => {
            format!(
                "pipeline {}/{} agent={}",
                current_step, total_steps, agent_name
            )
        }
        AgentEvent::ApprovalRequired {
            approval_id,
            action_description,
            ..
        } => {
            format!(
                "approval_required id={} action={}",
                approval_id,
                crate::chat_file_log::trunc(action_description, 200)
            )
        }
        AgentEvent::ApprovalResolved {
            approval_id,
            approved,
            reason,
        } => {
            format!(
                "approval_resolved id={} approved={} reason={}",
                approval_id, approved, reason
            )
        }
        AgentEvent::ClearText { answer_stream } => {
            if *answer_stream {
                "clear_text answer_stream".to_string()
            } else {
                "clear_text".to_string()
            }
        }
    }
}

/// Emit agent event to UI and append to `logs/agent.log`.
pub fn emit_agent_event(app_handle: &tauri::AppHandle, event: AgentEvent) {
    crate::chat_file_log::log_agent(&format_agent_event(&event));
    let _ = app_handle.emit("agent-event", event);
}

/// Request body for OpenAI-compatible chat completions API.
#[derive(Serialize)]
pub(crate) struct ChatRequest {
    pub model: String,
    pub messages: Vec<serde_json::Value>,
    pub temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>, // Kimi-specific
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDef>>,
}

/// A chunk of a streaming response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunk {
    pub content: String,
    pub done: bool,
}

/// Unified response from any provider's tool calling API
pub(crate) struct ToolCallResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

// ── Provider Detection ─────────────────────────────────────────────

/// Global cancellation flag for the active agent turn.
/// Uses the same OnceLock-global pattern as `approval::pending_approvals()`
/// so we don't have to thread an `Arc<AtomicBool>` through the whole
/// orchestrator → instance → loop call chain.
fn agent_stop_flag() -> &'static std::sync::Arc<std::sync::atomic::AtomicBool> {
    static FLAG: OnceLock<std::sync::Arc<std::sync::atomic::AtomicBool>> = OnceLock::new();
    FLAG.get_or_init(|| std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)))
}

/// Reset the stop flag at the start of a new agent turn (called by `agent_chat`).
pub fn reset_agent_stop() {
    agent_stop_flag().store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Signal the active agent turn to stop (called by `cancel_agent_turn` command).
pub fn cancel_agent_turn_global() {
    agent_stop_flag().store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Check whether the active turn has been cancelled by the user.
pub fn is_agent_cancelled() -> bool {
    agent_stop_flag().load(std::sync::atomic::Ordering::SeqCst)
}

use std::sync::OnceLock;

/// Detect provider from config (by URL or provider_id).
pub(crate) fn detect_provider(config: &LlmConfig) -> &str {
    if let Some(ref id) = config.provider_id {
        return id.as_str();
    }
    // Fallback: detect by URL
    let url = config.api_url.to_lowercase();
    if url.contains("anthropic") { return "claude"; }
    if url.contains("generativelanguage.googleapis") || url.contains("gemini") { return "gemini"; }
    if url.contains("moonshot") || url.contains("kimi") { return "moonshot"; }
    if url.contains("deepseek") { return "deepseek"; }
    if url.contains("openai") { return "openai"; }
    if url.contains("dashscope") || url.contains("aliyuncs") { return "qwen"; }
    if url.contains("bigmodel") || url.contains("zhipu") { return "zhipu"; }
    if url.contains("minimax") { return "minimax"; }
    if url.contains("lingyiwanwu") || url.contains("01.ai") { return "yi"; }
    if url.contains("baichuan") { return "baichuan"; }
    if url.contains("siliconflow") { return "siliconflow"; }
    if url.contains("openrouter") { return "openrouter"; }
    if url.contains("together") { return "together"; }
    if url.contains("groq") { return "groq"; }
    "unknown"
}

/// Build messages with provider-specific prompt cache optimizations.
fn build_messages_with_cache(config: &LlmConfig, messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let _provider = detect_provider(config);

    match _provider {
        // Claude: mark system prompt with cache_control (handled separately in request)
        // Others: messages are sent as-is, caching is automatic
        _ => messages.to_vec(),
    }
}

// ── LLM Client ─────────────────────────────────────────────────────

/// Map low-level reqwest / provider errors to bilingual user-facing text.
pub fn format_llm_user_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("error decoding response body")
        || lower.contains("invalid json")
        || lower.contains("returned invalid json")
        || lower.contains("empty response body")
    {
        return "LLM API 返回无法解析的响应（连接中断、空响应体或非 JSON）。\
                常见原因：API 余额/配额不足、网络不稳定、上下文过长，或网关返回了 HTML 错误页。\n\n\
                The LLM API returned a response that could not be decoded \
                (connection dropped, empty body, or non-JSON). \
                Check your API balance, network, and try a shorter request."
            .to_string();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "LLM 请求超时。请检查网络，或换用更快/更小的模型。\n\n\
                LLM request timed out. Check your network or try a faster/smaller model."
            .to_string();
    }
    if lower.contains("error sending request")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
    {
        return "LLM 网络连接失败。请检查 API 地址、代理与网络。\n\n\
                LLM network connection failed. Check API URL, proxy, and connectivity."
            .to_string();
    }
    raw.to_string()
}

/// Send a chat completion request and get a full response.
pub async fn chat_completion(
    config: &LlmConfig,
    messages: &[ChatMessage],
) -> anyhow::Result<String> {
    let provider = detect_provider(config);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;

    // Build request based on provider
    let response = match provider {
        "claude" => {
            // Claude uses a different API format with cache_control
            send_claude_request(&client, config, messages).await?
        }
        "gemini" => {
            // Gemini uses generateContent endpoint
            let (system_instruction, contents) = messages_to_gemini(messages);
            let api_key = config.api_key.as_deref().unwrap_or("");
            let base = config.api_url.trim_end_matches('/');
            let url = format!("{}/models/{}:generateContent?key={}", base, config.model, api_key);

            let mut gen_config = serde_json::json!({
                "temperature": config.temperature,
            });
            if let Some(mt) = config.max_tokens {
                gen_config["maxOutputTokens"] = serde_json::json!(mt);
            }

            let mut request = serde_json::json!({
                "contents": contents,
                "generationConfig": gen_config,
            });
            if let Some(sys) = system_instruction {
                request["systemInstruction"] = sys;
            }

            client.post(&url)
                .header("Content-Type", "application/json")
                .json(&request)
                .send()
                .await?
        }
        _ => {
            // OpenAI-compatible format (works for DeepSeek, OpenAI, Qwen, Zhipu, Kimi, etc.)
            let request = ChatRequest {
                model: config.model.clone(),
                messages: build_messages_with_cache(config, messages).iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect(),
                temperature: config.temperature,
                max_tokens: config.max_tokens,
                stream: false,
                prompt_cache_key: if provider == "moonshot" {
                    Some("zettelagent-cache".to_string())
                } else {
                    None
                },
                tools: None,
            };

            let mut builder = client.post(&config.api_url).json(&request);
            if let Some(key) = &config.api_key {
                builder = builder.header("Authorization", format!("Bearer {}", key));
            }
            builder.send().await?
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let mut err_msg = format!("LLM API error ({}): {}", status, body);
        if config.supports_thinking == Some(true) {
            err_msg += "\n提示：当前开启了原生思考模式，若模型不支持此功能，请尝试在设置中关闭「原生思考模式」开关。";
            err_msg += "\nHint: Native reasoning mode is enabled. If the model doesn't support this feature, try disabling \"Native Reasoning Mode\" in settings.";
        }
        anyhow::bail!("{}", err_msg);
    }

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    if body_text.trim().is_empty() {
        anyhow::bail!(
            "LLM API returned an empty response body (HTTP {status}). \
             Check API balance, model name, and endpoint URL."
        );
    }
    let result: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        anyhow::anyhow!(
            "LLM API returned invalid JSON ({e}). Body preview: {}",
            crate::chat_file_log::trunc(&body_text, 400)
        )
    })?;

    // Extract content based on provider format
    let content = match provider {
        "claude" => {
            // Claude: content is array of blocks
            result["content"].as_array()
                .map(|arr| arr.iter()
                    .filter_map(|b| if b["type"].as_str() == Some("text") { b["text"].as_str() } else { None })
                    .collect::<Vec<_>>()
                    .join(""))
                .unwrap_or_default()
        }
        "gemini" => {
            // Gemini: candidates[0].content.parts[].text
            result["candidates"][0]["content"]["parts"].as_array()
                .map(|parts| parts.iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(""))
                .unwrap_or_default()
        }
        _ => {
            // OpenAI-compatible: choices[0].message.content
            result["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string()
        }
    };

    Ok(content)
}

/// Send a chat completion request with explicit temperature and max_tokens override.
/// This is used by the intent classifier (L2) which needs different parameters than the main agent.
pub async fn chat_completion_with_params(
    config: &LlmConfig,
    messages: &[ChatMessage],
    temperature: f32,
    max_tokens: u32,
) -> anyhow::Result<String> {
    // Clone config and override parameters for this specific call
    let mut override_config = config.clone();
    override_config.temperature = temperature;
    override_config.max_tokens = Some(max_tokens);

    // Delegate to the main chat_completion function with overridden config
    chat_completion(&override_config, messages).await
}

/// Send a streaming chat completion request.
pub async fn chat_completion_stream(
    config: &LlmConfig,
    messages: &[ChatMessage],
) -> anyhow::Result<mpsc::Receiver<StreamChunk>> {
    let provider = detect_provider(config);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;

    let response = if provider == "claude" {
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
            "stream": true,
        });

        let mut builder = client
            .post(&config.api_url)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .json(&request);

        if let Some(key) = &config.api_key {
            builder = builder.header("x-api-key", key);
        }

        builder.send().await?
    } else if provider == "gemini" {
        let (system_instruction, contents) = messages_to_gemini(messages);
        let api_key = config.api_key.as_deref().unwrap_or("");
        
        let url = if config.api_url.contains("generateContent") {
            let updated_url = config.api_url.replace("generateContent", "streamGenerateContent");
            if updated_url.contains("key=") {
                if updated_url.contains('?') {
                    format!("{}&alt=sse", updated_url)
                } else {
                    format!("{}?alt=sse", updated_url)
                }
            } else {
                format!("{}?alt=sse&key={}", updated_url, api_key)
            }
        } else {
            let base = config.api_url.trim_end_matches('/');
            format!("{}/models/{}:streamGenerateContent?alt=sse&key={}", base, config.model, api_key)
        };

        let mut gen_config = serde_json::json!({
            "temperature": config.temperature,
        });
        if let Some(mt) = config.max_tokens {
            gen_config["maxOutputTokens"] = serde_json::json!(mt);
        }

        let mut request = serde_json::json!({
            "contents": contents,
            "generationConfig": gen_config,
        });

        if let Some(sys) = system_instruction {
            request["systemInstruction"] = sys;
        }

        client.post(&url)
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?
    } else {
        let request = ChatRequest {
            model: config.model.clone(),
            messages: build_messages_with_cache(config, messages).iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect(),
            temperature: config.temperature,
            max_tokens: config.max_tokens,
            stream: true,
            prompt_cache_key: if provider == "moonshot" {
                Some("zettelagent-cache".to_string())
            } else {
                None
            },
            tools: None,
        };

        let mut builder = client.post(&config.api_url).json(&request);
        if let Some(key) = &config.api_key {
            builder = builder.header("Authorization", format!("Bearer {}", key));
        }
        builder.send().await?
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let mut err_msg = format!("LLM API error ({}): {}", status, body);
        if config.supports_thinking == Some(true) {
            err_msg += "\n提示：当前开启了原生思考模式，若模型不支持此功能，请尝试在设置中关闭「原生思考模式」开关。";
            err_msg += "\nHint: Native reasoning mode is enabled. If the model doesn't support this feature, try disabling \"Native Reasoning Mode\" in settings.";
        }
        anyhow::bail!("{}", err_msg);
    }

    let (tx, rx) = mpsc::channel(256);
    let provider_str = provider.to_string();

    tokio::spawn(async move {
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        let mut byte_buffer = Vec::new();

        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(bytes) => {
                    byte_buffer.extend_from_slice(&bytes);
                    while let Some(pos) = byte_buffer.iter().position(|&b| b == b'\n') {
                        let line_bytes = &byte_buffer[..pos];
                        let line_str = String::from_utf8_lossy(line_bytes).trim().to_string();
                        byte_buffer.drain(..pos + 1);

                        if line_str.is_empty() || line_str.starts_with(':') { continue; }
                        
                        if provider_str == "claude" {
                            if line_str == "event: message_stop" {
                                let _ = tx.send(StreamChunk { content: String::new(), done: true }).await;
                                return;
                            }
                            if let Some(data) = line_str.strip_prefix("data: ") {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                                    if parsed["type"].as_str() == Some("content_block_delta") {
                                        if let Some(text) = parsed["delta"]["text"].as_str() {
                                            let _ = tx.send(StreamChunk { content: text.to_string(), done: false }).await;
                                        }
                                    }
                                }
                            }
                        } else if provider_str == "gemini" {
                            if let Some(data) = line_str.strip_prefix("data: ") {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(candidates) = parsed["candidates"].as_array() {
                                        if !candidates.is_empty() {
                                            if let Some(parts) = candidates[0]["content"]["parts"].as_array() {
                                                if !parts.is_empty() {
                                                    if let Some(text) = parts[0]["text"].as_str() {
                                                        let _ = tx.send(StreamChunk { content: text.to_string(), done: false }).await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            if line_str == "data: [DONE]" {
                                let _ = tx.send(StreamChunk { content: String::new(), done: true }).await;
                                return;
                            }
                            if let Some(data) = line_str.strip_prefix("data: ") {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
                                        let _ = tx.send(StreamChunk { content: delta.to_string(), done: false }).await;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    crate::chat_file_log::log_agent(&format!("stream_read_error: Stream read error: {}", e));
                    break;
                }
            }
        }

        let _ = tx.send(StreamChunk { content: String::new(), done: true }).await;
    });

    Ok(rx)
}

/// RAG-enhanced chat: search for relevant context, then send to LLM.
/// DEPRECATED: Use rag_search_and_stream (streaming) or rag_search_and_chat (which now
/// builds its own messages directly). Kept for backward compatibility.
#[allow(dead_code)]
pub async fn rag_chat(
    config: &LlmConfig,
    user_message: &str,
    context_chunks: &[String],
) -> anyhow::Result<String> {
    let system_prompt = prompts::rag_system_prompt("zettelkasten");

    let context_block = if context_chunks.is_empty() {
        String::from("No relevant notes found in the knowledge base.")
    } else {
        format!(
            "Below are relevant snippets from the knowledge base:\n\n{}",
            context_chunks.join("\n\n---\n\n")
        )
    };

    let rag_prompt = prompts::rag_answer_prompt(&context_block, user_message);

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
            ..Default::default()
        },
        ChatMessage {
            role: "user".to_string(),
            content: rag_prompt,
            ..Default::default()
        },
    ];

    chat_completion(config, &messages).await
}

fn are_arguments_equal(a: &str, b: &str) -> bool {
    if let (Ok(va), Ok(vb)) = (serde_json::from_str::<serde_json::Value>(a), serde_json::from_str::<serde_json::Value>(b)) {
        va == vb
    } else {
        a.trim() == b.trim()
    }
}

/// Search tools that should use fuzzy argument matching.
const SEARCH_LIKE_TOOLS: &[&str] = &["search_notes", "find_similar_notes"];

/// Check if a search tool call is a near-duplicate of a previous one.
/// For search tools, compares the "query" field — if one query contains the other,
/// treat them as duplicates (e.g., "机器学习" vs "关于机器学习的笔记").
fn is_search_near_duplicate(tool_name: &str, args: &str, executed: &[(String, String)]) -> bool {
    if !SEARCH_LIKE_TOOLS.contains(&tool_name) {
        return false;
    }
    // Extract the "query" field from the new call
    let new_query = serde_json::from_str::<serde_json::Value>(args)
        .ok()
        .and_then(|v| v.get("query").and_then(|q| q.as_str()).map(|s| s.to_lowercase()));
    let new_query = match new_query {
        Some(q) if !q.is_empty() => q,
        _ => return false,
    };

    for (prev_name, prev_args) in executed {
        if !SEARCH_LIKE_TOOLS.contains(&prev_name.as_str()) {
            continue;
        }
        if let Some(prev_query) = serde_json::from_str::<serde_json::Value>(prev_args)
            .ok()
            .and_then(|v| v.get("query").and_then(|q| q.as_str()).map(|s| s.to_lowercase()))
        {
            // Near-duplicate if one contains the other
            if new_query.contains(&prev_query) || prev_query.contains(&new_query) {
                return true;
            }
        }
    }
    false
}

// ── Tool Result Summarization ──────────────────────────────────────

/// Tools whose output is already compact and should NOT be summarized.
const SKIP_SUMMARY_TOOLS: &[&str] = &[
    "list_notes", "get_vault_stats", "get_note_tags", "run_lint",
    "web_search", "create_note", "edit_note", "delete_note",
    "rename_note", "move_note", "merge_notes", "update_memory",
    "append_to_note", "patch_note", "create_folder",
];

// ── First-Token Streaming Helper ───────────────────────────────────

/// Emit already-computed content as TextDelta events for streaming UX.
/// This avoids a redundant LLM call while giving users instant first-token display.
/// Content is split into chunks at sentence/paragraph boundaries for natural pacing.
#[allow(dead_code)]
fn emit_content_as_stream(content: &str, app_handle: &tauri::AppHandle, total_tool_calls: usize) {
    if content.is_empty() {
        emit_agent_event(app_handle, AgentEvent::Done {
            total_tool_calls,
            answer_source: None,
            answer_preview: None,
        });
        return;
    }

    // Split content into natural chunks (by line, preserving markdown structure)
    for line in content.split_inclusive('\n') {
        emit_agent_event(app_handle, AgentEvent::TextDelta { content: line.to_string() },);
    }
    // If content doesn't end with newline, the last chunk was already emitted

    emit_agent_event(app_handle, AgentEvent::Done {
        total_tool_calls,
        answer_source: None,
        answer_preview: None,
    });
}

/// Where the user-visible final answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerSource {
    Loop,
    Mandatory,
    StubRetry,
}

impl AnswerSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Loop => "loop",
            Self::Mandatory => "mandatory",
            Self::StubRetry => "stub_retry",
        }
    }
}

/// Result of a full agent tool-calling turn.
#[derive(Debug, Clone)]
pub struct AgentTurnResult {
    pub content: String,
    pub source: AnswerSource,
}

impl AgentTurnResult {
    fn finish(
        content: String,
        source: AnswerSource,
        total_tool_calls: usize,
        app_handle: &tauri::AppHandle,
    ) -> Self {
        let preview = crate::chat_file_log::trunc(content.trim(), 200);
        crate::chat_file_log::log_agent(&format!(
            "turn_complete source={} chars={} preview={}",
            source.as_str(),
            content.chars().count(),
            preview
        ));
        emit_agent_event(
            app_handle,
            AgentEvent::Done {
                total_tool_calls,
                answer_source: Some(source.as_str().to_string()),
                answer_preview: Some(preview.clone()),
            },
        );
        Self { content, source }
    }
}

/// Dedicated synthesis pass: clean context, no tools, streams final report.
async fn run_synthesis_pass(
    config: &LlmConfig,
    messages: &[ChatMessage],
    user_query: &str,
    task_kind: plan_guard::TaskKind,
    app_handle: &tauri::AppHandle,
    total_tool_calls: usize,
    pass_label: &str,
) -> anyhow::Result<String> {
    let zh = plan_guard::user_prefers_zh(user_query);
    emit_agent_event(app_handle, AgentEvent::Thinking {
        message: plan_guard::synthesis_thinking_ui(zh),
    });
    emit_agent_event(app_handle, AgentEvent::ClearText { answer_stream: true });

    crate::chat_file_log::log_agent(&format!(
        "synthesis_pass {} task={:?} tool_calls={}",
        pass_label,
        task_kind,
        total_tool_calls
    ));

    let synth_messages =
        plan_guard::build_synthesis_context(messages, user_query, task_kind);
    // Final report pass: plain markdown answer, no tool XML / thought injection.

    let provider = detect_provider(config);
    let resp = match provider {
        "claude" => {
            send_and_parse_claude_tools(config, &synth_messages, &[], app_handle).await?
        }
        "gemini" => {
            send_and_parse_gemini_tools(config, &synth_messages, &[], app_handle).await?
        }
        _ => send_and_parse_openai_tools(config, &synth_messages, &[], app_handle).await?,
    };

    let answer = plan_guard::sanitize_user_visible_answer(&resp.content);
    crate::chat_file_log::log_agent(&format!(
        "synthesis_pass_done {} chars={}",
        pass_label,
        answer.chars().count()
    ));
    Ok(answer)
}

/// Run synthesis up to twice when the first pass is empty or errors.
async fn run_synthesis_with_retry(
    config: &LlmConfig,
    messages: &[ChatMessage],
    user_query: &str,
    task_kind: plan_guard::TaskKind,
    app_handle: &tauri::AppHandle,
    total_tool_calls: usize,
    base_label: &str,
) -> Option<String> {
    for attempt in 0..2u8 {
        let label = if attempt == 0 {
            base_label.to_string()
        } else {
            format!("{base_label}_retry")
        };
        match run_synthesis_pass(
            config,
            messages,
            user_query,
            task_kind,
            app_handle,
            total_tool_calls,
            &label,
        )
        .await
        {
            Ok(answer) if !answer.trim().is_empty() => {
                if attempt > 0 {
                    crate::chat_file_log::log_agent(&format!("synthesis_pass_retry_ok {base_label}"));
                }
                return Some(answer);
            }
            Ok(_) => {
                crate::chat_file_log::log_agent(&format!("synthesis_pass_empty {label}"));
            }
            Err(e) => {
                crate::chat_file_log::log_agent(&format!("synthesis_pass_error {label} {e}"));
            }
        }
    }
    None
}

/// Human-readable stage label for a tool, shown as streaming progress before
/// and during execution. Returns bilingual labels based on `zh`.
fn tool_stage_label(name: &str, zh: bool) -> &'static str {
    if zh {
        match name {
            "web_search" => "正在搜索网页…",
            "fetch_web_content" => "正在抓取网页内容…",
            "search_notes" | "search_by_tag" => "正在搜索笔记…",
            "find_similar_notes" => "正在查找相似笔记…",
            "list_notes" => "正在列出笔记…",
            "read_note" | "batch_read_notes" => "正在读取笔记…",
            "get_graph" | "get_local_graph" => "正在加载知识图谱…",
            "find_shortest_path" => "正在查找关系路径…",
            "query_relations" | "get_relations_by_type" => "正在查询关系…",
            "run_lint" => "正在诊断知识库…",
            "get_vault_stats" => "正在统计知识库…",
            "create_note" => "正在创建笔记…",
            "edit_note" | "patch_note" | "apply_edit" => "正在编辑笔记…",
            "append_to_note" => "正在追加内容…",
            "rename_note" | "move_note" => "正在移动笔记…",
            "merge_notes" => "正在合并笔记…",
            "delete_note" => "正在删除笔记…",
            "read_canvas" => "正在读取画布…",
            "modify_canvas" | "create_canvas" => "正在修改画布…",
            "arrange_canvas_by" => "正在自动布局画布…",
            "group_canvas_nodes" => "正在分组画布节点…",
            "generate_structure_note" => "正在生成结构笔记…",
            "explain_relationship" => "正在分析笔记关系…",
            "compare_notes" => "正在对比笔记…",
            "extract_facts" => "正在提取事实…",
            "propagate_fact_update" => "正在传播事实更新…",
            "ocr_image" => "正在识别图片文字…",
            "get_note_metadata" => "正在获取笔记元数据…",
            "get_note_facts" => "正在获取笔记事实…",
            "get_timeline" | "get_global_timeline" => "正在获取时间线…",
            "query_temporal" => "正在查询时间事实…",
            "trigger_sync" => "正在同步知识库…",
            "rebuild_semantic_edges" => "正在重建语义边…",
            _ => "正在执行…",
        }
    } else {
        match name {
            "web_search" => "Searching the web…",
            "fetch_web_content" => "Fetching web page…",
            "search_notes" | "search_by_tag" => "Searching notes…",
            "find_similar_notes" => "Finding similar notes…",
            "list_notes" => "Listing notes…",
            "read_note" | "batch_read_notes" => "Reading notes…",
            "get_graph" | "get_local_graph" => "Loading knowledge graph…",
            "find_shortest_path" => "Finding relationship path…",
            "query_relations" | "get_relations_by_type" => "Querying relations…",
            "run_lint" => "Diagnosing vault…",
            "get_vault_stats" => "Computing statistics…",
            "create_note" => "Creating note…",
            "edit_note" | "patch_note" | "apply_edit" => "Editing note…",
            "append_to_note" => "Appending content…",
            "rename_note" | "move_note" => "Moving note…",
            "merge_notes" => "Merging notes…",
            "delete_note" => "Deleting note…",
            "read_canvas" => "Reading canvas…",
            "modify_canvas" | "create_canvas" => "Modifying canvas…",
            "arrange_canvas_by" => "Arranging canvas…",
            "group_canvas_nodes" => "Grouping nodes…",
            "generate_structure_note" => "Generating structure note…",
            "explain_relationship" => "Analyzing relationship…",
            "compare_notes" => "Comparing notes…",
            "extract_facts" => "Extracting facts…",
            "propagate_fact_update" => "Propagating fact update…",
            "ocr_image" => "Running OCR…",
            "get_note_metadata" => "Fetching metadata…",
            "get_note_facts" => "Fetching facts…",
            "get_timeline" | "get_global_timeline" => "Loading timeline…",
            "query_temporal" => "Querying temporal facts…",
            "trigger_sync" => "Syncing vault…",
            "rebuild_semantic_edges" => "Rebuilding semantic edges…",
            _ => "Executing…",
        }
    }
}

/// Emit `ToolResult` events for tool calls that had `ToolStart` but no `ToolResult`,
/// preventing permanently-spinning tool cards on early exit. Idempotent — safe to
/// call when nothing is pending.
fn flush_pending_tool_results(
    pending: &mut Vec<(String, String)>,
    app_handle: &tauri::AppHandle,
    reason: &str,
) {
    for (tool_call_id, name) in pending.drain(..) {
        emit_agent_event(
            app_handle,
            AgentEvent::ToolResult {
                tool_call_id,
                name,
                content: reason.to_string(),
                duration_ms: 0,
            },
        );
    }
}

/// Try a dedicated synthesis pass at early-exit points when substantive tools ran,
/// then fall back to the provided content if synthesis also fails or is unneeded.
/// Used to route non-cancel early exits through synthesis instead of finishing on an
/// incomplete raw loop response.
async fn synthesize_or_fallback(
    config: &LlmConfig,
    messages: &mut Vec<ChatMessage>,
    user_query: &str,
    task_kind: plan_guard::TaskKind,
    app_handle: &tauri::AppHandle,
    total_tool_calls: usize,
    executed: &[(String, String)],
    fallback: String,
    label: &str,
) -> (String, AnswerSource) {
    let substantive = plan_guard::substantive_tool_count(executed);
    if substantive > 0 {
        if let Some(synth) = run_synthesis_with_retry(
            config,
            messages,
            user_query,
            task_kind,
            app_handle,
            total_tool_calls,
            label,
        )
        .await
        {
            return (synth, AnswerSource::Mandatory);
        }
        // Synthesis failed: prefer the best substantive assistant content from the
        // loop history over the raw (possibly empty/noisy) reply.
        let best = plan_guard::extract_best_loop_answer(messages);
        if !best.is_empty() {
            return (best, AnswerSource::Loop);
        }
    }
    (fallback, AnswerSource::Loop)
}

// ── Tool Calling Loop ──────────────────────────────────────────────

/// Chat completion with Tool Calling loop.
/// Loops calling LLM until no tool_calls are returned (max 10 iterations).
/// Now includes context window compression and error recovery.
/// Supports OpenAI-compatible, Anthropic Claude, and Google Gemini APIs.
pub async fn chat_completion_with_tools<F>(
    config: &LlmConfig,
    messages: &mut Vec<ChatMessage>,
    tools: &[ToolDef],
    exec_config: &crate::agents::instance::AgentExecutionConfig,
    tool_executor: F,
    app_handle: &tauri::AppHandle,
) -> anyhow::Result<AgentTurnResult>
where
    F: for<'a> Fn(&'a str, &'a str) -> futures_util::future::BoxFuture<'a, anyhow::Result<String>>,
{
    let _max_iterations = exec_config.max_iterations; // Kept for reference; true loop uses no iteration cap
    let max_total_tool_calls: usize = exec_config.max_total_tool_calls; // configurable per-agent
    let mut total_tool_calls = 0;
    let provider = detect_provider(config);

    // Get user query from message history
    let user_query = messages
        .iter()
        .filter(|m| m.role == "user")
        .last()
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let task_kind = plan_guard::classify_task_kind(&user_query);
    let user_zh = plan_guard::user_prefers_zh(&user_query);
    if task_kind == plan_guard::TaskKind::DiagnosticReport {
        crate::chat_file_log::log_agent("task_pipeline diagnostic_report");
    }

    // ── Model-driven agent loop (Cursor/Claude Code style) ──────────
    // No separate Planner/Reflector LLM calls. The model plans by calling
    // the `todo_write` tool inside the loop, and decides itself when to
    // stop (no tool_calls → final streamed answer).

    // Greetings/small-talk: hard-disable tool access for this turn so the
    // model literally cannot call a tool (e.g. get_vault_stats) just because
    // it's in the toolset. This is enforced independently of what the model
    // decides — no reliance on the LLM "choosing" not to call tools.
    let is_greeting = is_greeting_or_chitchat(&user_query);
    if is_greeting {
        crate::chat_file_log::log_agent("greeting_detected: Greeting/small-talk detected: hard-disabling tools for this turn");
    }

    let mut web_search_count = 0;
    let mut db_search_count = 0;
    let mut executed_calls: Vec<(String, String)> = Vec::new();
    // Tool calls that emitted ToolStart but not yet ToolResult — flushed on early
    // exit so the frontend never leaves a tool card permanently spinning.
    let mut pending_tool_results: Vec<(String, String)> = Vec::new();

    // Model-driven loop: the model plans via todo_write and decides itself
    // when to stop. We keep only essential safety state here.
    let mut last_plan_steps: Option<Vec<PlanStep>> = None;
    let mut consecutive_errors = 0u32;

    let max_context = get_max_context_tokens(config);

    // ── Loop Engineering: True Loop ─────────────────────────────
    // No fixed iteration cap. Agent decides when to stop.
    // Only max_total_tool_calls remains as a cost safety net.
    let mut _iteration = 0usize;
    loop {
        // ── User cancellation check ───────────────────────────────
        // Checked every iteration so the stop button takes effect
        // between tool calls (the natural granularity for an agent loop).
        if is_agent_cancelled() {
            crate::chat_file_log::log_agent(&format!("turn_cancelled: Agent turn cancelled by user at iteration {}", _iteration));
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call cancelled");
            return Ok(AgentTurnResult::finish(
                String::new(),
                AnswerSource::Loop,
                total_tool_calls,
                app_handle,
            ));
        }

        _iteration += 1;
        // ── Hard limit on total tool calls — cost safety net ──
        if total_tool_calls >= max_total_tool_calls {
            crate::chat_file_log::log_agent(&format!(
                "hard_limit_tool_calls: Agent hit hard limit of {} total tool calls — forcing completion",
                max_total_tool_calls
            ));
            emit_agent_event(app_handle, AgentEvent::Thinking {
                message: plan_guard::tool_limit_thinking(user_zh, max_total_tool_calls),
            });
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call skipped (turn ending)");

            let substantive = plan_guard::substantive_tool_count(&executed_calls);
            if substantive > 0 {
                if let Some(synth) = run_synthesis_with_retry(
                    config, messages, &user_query, task_kind,
                    app_handle, total_tool_calls, "hard_limit",
                ).await {
                    return Ok(AgentTurnResult::finish(
                        synth, AnswerSource::Mandatory, total_tool_calls, app_handle));
                }
                let best = plan_guard::extract_best_loop_answer(messages);
                if !best.is_empty() {
                    return Ok(AgentTurnResult::finish(
                        best, AnswerSource::Loop, total_tool_calls, app_handle));
                }
            }
            // Simple final call without tools
            let mut final_messages = messages.clone();
            final_messages.push(ChatMessage {
                role: "user".to_string(),
                content: plan_guard::tool_limit_nudge(user_zh),
                ..Default::default()
            });
            if !prompted_thinking::is_native_reasoning(config) {
                prompted_thinking::inject_non_native_thought_prompt(&mut final_messages);
            }
            let final_resp = match provider {
                "claude" => send_and_parse_claude_tools(config, &final_messages, &[], app_handle).await?,
                "gemini" => send_and_parse_gemini_tools(config, &final_messages, &[], app_handle).await?,
                _ => send_and_parse_openai_tools(config, &final_messages, &[], app_handle).await?,
            };
            return Ok(AgentTurnResult::finish(
                plan_guard::sanitize_user_visible_answer(&final_resp.content),
                AnswerSource::Loop,
                total_tool_calls,
                app_handle,
            ));
        }

        // ── Context Window Compression ──────────────────────────────
        compress_context_window(config, messages, &user_query, max_context).await;
        // Enforce tool budget (State Graph constraints)
        // Greetings/small-talk: no tools at all — the model physically cannot
        // call one, no matter how it interprets the prompt.
        let mut active_tools = Vec::new();
        if !is_greeting {
            for t in tools {
                if (t.function.name == "web_search" || t.function.name == "fetch_web_content") && web_search_count >= 5 {
                    crate::chat_file_log::log_agent(&format!("filtering_tool_budget: Filtering out tool '{}' due to budget limit", t.function.name));
                    continue;
                }
                if (t.function.name == "search_notes" || t.function.name == "find_similar_notes" || t.function.name == "list_notes") && db_search_count >= 10 {
                    crate::chat_file_log::log_agent(&format!("filtering_tool_budget: Filtering out tool '{}' due to budget limit", t.function.name));
                    continue;
                }
                active_tools.push(t.clone());
            }
        }

        let mut exec_messages = messages.clone();
        // A-2: The base system prompt (role prompt) already contains all the
        // agent guidance. With the model-driven loop, there is no separate
        // executor/react wrapper — the model plans via the `todo_write` tool.
        if let Some(_sys_msg) = exec_messages.iter_mut().find(|m| m.role == "system") {
            // ── Loop Engineering: Progress Logging ─────────────────
            let unique_tools: std::collections::HashSet<&str> = executed_calls.iter().map(|(n,_)| n.as_str()).collect();
            crate::chat_file_log::log_agent(&format!(
                "loop_status: Loop Status - Iteration: {} | Tools called: {} | Unique tools used: {} | Sources gathered: {}",
                _iteration,
                total_tool_calls,
                unique_tools.len(),
                executed_calls.len()
            ));
            // Intentionally do NOT rewrite sys_msg.content — keep the original
            // role prompt stable across iterations to avoid prompt stacking.
        }

        // Non-native reasoning: inject <thought> XML format instructions into system prompt
        if !prompted_thinking::is_native_reasoning(config) {
            prompted_thinking::inject_non_native_thought_prompt(&mut exec_messages);
        }

        // Send request and parse response using provider-specific adapter
        let tools_for_request = &active_tools;
        let resp = match provider {
            "claude" => send_and_parse_claude_tools(config, &exec_messages, tools_for_request, app_handle).await?,
            "gemini" => send_and_parse_gemini_tools(config, &exec_messages, tools_for_request, app_handle).await?,
            _ => send_and_parse_openai_tools(config, &exec_messages, tools_for_request, app_handle).await?,
        };

        if resp.tool_calls.is_empty() {
            // The model produced a final answer (no tool calls). It already
            // streamed via SSE TextDelta in the provider adapter — just emit
            // Done and return. No separate Reflector/Critique LLM call.

            // If the user cancelled mid-stream, return whatever partial content
            // was produced — do NOT run the truncation-nudge retry below.
            if is_agent_cancelled() {
                crate::chat_file_log::log_agent(&format!("turn_cancelled: Turn cancelled mid-stream; returning partial answer ({} chars)", resp.content.len()));
                flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call cancelled");
                return Ok(AgentTurnResult::finish(
                    resp.content.clone(),
                    AnswerSource::Loop,
                    total_tool_calls,
                    app_handle,
                ));
            }

            // ── Trust the model's final answer ──
            // The model decided to stop calling tools and produced a final answer.
            // We sanitize it and optionally run a synthesis pass if the answer is
            // empty or a meta-stub after substantive tool work. No enforcement,
            // no nudges, no plan-gating — the model decides when it's done.

            let mut final_answer = plan_guard::sanitize_user_visible_answer(&resp.content);
            let substantive = plan_guard::substantive_tool_count(&executed_calls);
            let mut answer_source = AnswerSource::Loop;

            // If the answer is empty or a meta-stub and substantive tools ran,
            // try a synthesis pass to get a proper report.
            if !is_greeting && substantive > 0 {
                let needs_synth = final_answer.trim().is_empty()
                    || plan_guard::is_meta_stub_answer(&final_answer)
                    || plan_guard::needs_report_synthesis(
                        &user_query, total_tool_calls, substantive, &final_answer,
                    );
                if needs_synth {
                    if let Some(synth) = run_synthesis_with_retry(
                        config, messages, &user_query, task_kind,
                        app_handle, total_tool_calls, "mandatory",
                    ).await {
                        final_answer = synth;
                        answer_source = AnswerSource::Mandatory;
                    } else {
                        let best = plan_guard::extract_best_loop_answer(messages);
                        if !best.is_empty() {
                            final_answer = best;
                        }
                    }
                }
            }

            if final_answer.trim().is_empty() {
                crate::chat_file_log::log_agent(&format!(
                    "turn_end_empty total_tool_calls={} executed_tools={}",
                    total_tool_calls,
                    executed_calls.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(",")
                ));
            }

            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call skipped (turn ending)");
            return Ok(AgentTurnResult::finish(
                final_answer,
                answer_source,
                total_tool_calls,
                app_handle,
            ));
        }

        // If the user cancelled while the model was streaming tool calls,
        // do NOT execute them — stop cleanly with whatever partial text exists.
        if is_agent_cancelled() {
            crate::chat_file_log::log_agent(&format!("turn_cancelled: Turn cancelled before tool execution; skipping {} tool call(s)", resp.tool_calls.len()));
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call cancelled");
            return Ok(AgentTurnResult::finish(
                resp.content.clone(),
                AnswerSource::Loop,
                total_tool_calls,
                app_handle,
            ));
        }

        // Add assistant message with tool_calls to history
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: resp.content.clone(),
            tool_calls: Some(resp.tool_calls.clone()),
            tool_call_id: None,
        });

        // Clear pre-tool text from frontend to avoid duplication when LLM regenerates
        // Clear pre-tool narration from frontend (timeline keeps the history).
        emit_agent_event(app_handle, AgentEvent::ClearText { answer_stream: false });

        // 1. Prepare parallel tool execution inputs
        let tool_calls_data: Vec<(String, String, String)> = resp.tool_calls.iter().map(|tc| {
            (tc.id.clone(), tc.function.name.clone(), tc.function.arguments.clone())
        }).collect();

        // 2. Build concurrent futures (A-7: includes timing)
        let mut tool_futures: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = (String, String, String, u64)> + Send + '_>>> = Vec::new();
        let mut duplicate_count = 0usize;
        for (tc_id, tc_name, tc_args) in &tool_calls_data {
            total_tool_calls += 1;

            if tc_name == "web_search" || tc_name == "fetch_web_content" {
                web_search_count += 1;
            }
            if tc_name == "search_notes" || tc_name == "find_similar_notes" || tc_name == "list_notes" {
                db_search_count += 1;
            }

            emit_agent_event(app_handle, AgentEvent::ToolStart {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    arguments: tc_args.clone(),
                },);
            // ── Streaming progress: emit initial stage label immediately ──
            // This gives the user instant feedback about what the tool is doing,
            // rather than just a spinning card with the tool name.
            if tc_name != "todo_write" {
                emit_agent_event(app_handle, AgentEvent::ToolProgress {
                    tool_call_id: tc_id.clone(),
                    stage: tool_stage_label(tc_name, user_zh).to_string(),
                    preview: None,
                });
            }
            // Track ToolStart without a matching ToolResult so early exits can flush it.
            pending_tool_results.push((tc_id.clone(), tc_name.clone()));

            // ── Inline control-plane tool: todo_write ───────────────
            // Handled by the orchestrator itself (emits a PlanUpdate event
            // for the frontend's live plan checklist), NOT by the tool_executor.
            // Same pattern Cursor/Claude Code use for their plan/todo tool.
            if tc_name == "todo_write" {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(tc_args) {
                    if let Some(steps_arr) = parsed.get("steps").and_then(|s| s.as_array()) {
                        let steps: Vec<PlanStep> = steps_arr.iter().map(|s| PlanStep {
                            text: s.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            status: s.get("status").and_then(|v| v.as_str()).unwrap_or("pending").to_string(),
                        }).filter(|s| !s.text.is_empty()).collect();
                        last_plan_steps = Some(steps.clone());
                        emit_agent_event(app_handle, AgentEvent::PlanUpdate { steps },);
                    }
                }
                let result_json = last_plan_steps
                    .as_ref()
                    .map(|s| plan_guard::format_todo_write_result(s, user_zh))
                    .unwrap_or_else(|| plan_guard::format_todo_write_result(&[], user_zh));
                let tc_id_clone = tc_id.clone();
                let tc_name_clone = tc_name.clone();
                tool_futures.push(Box::pin(async move {
                    (tc_id_clone, tc_name_clone, result_json, 0u64)
                }));
                continue;
            }

            let is_duplicate = executed_calls.iter().any(|(n, a)| {
                n == tc_name && are_arguments_equal(a, tc_args)
            }) || is_search_near_duplicate(tc_name, tc_args, &executed_calls);

            if is_duplicate {
                duplicate_count += 1;
                let tc_id_clone = tc_id.clone();
                let tc_name_clone = tc_name.clone();
                let tc_args_clone = tc_args.clone();
                let zh = user_zh;
                tool_futures.push(Box::pin(async move {
                    let warning = plan_guard::duplicate_tool_warning(
                        &tc_name_clone,
                        &tc_args_clone,
                        zh,
                    );
                    (tc_id_clone, tc_name_clone, warning, 0u64)
                }));
            } else {
                executed_calls.push((tc_name.clone(), tc_args.clone()));

                // Approval gate: check if this is a write tool
                let needs_approval = is_write_tool(tc_name);
                let approval_id = if needs_approval {
                    format!("approval-{}-{}", tc_name, std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis())
                } else {
                    String::new()
                };

                // Emit approval request for write tools
                if needs_approval {
                    let action_desc = format!("{}: {}", tc_name, tc_args.chars().take(200).collect::<String>());
                    let diff_json = build_approval_diff_data(tc_name, tc_args);
                    emit_agent_event(app_handle, AgentEvent::ApprovalRequired {
                            action_description: action_desc,
                            agent_id: "agent".to_string(),
                            approval_id: approval_id.clone(),
                            diff_json,
                        },);
                }

                let fut = tool_executor(tc_name, tc_args);
                let tc_id_clone = tc_id.clone();
                let tc_name_clone = tc_name.clone();
                let approval_id_clone = approval_id.clone();
                let app_handle_hb = app_handle.clone();
                let stage_label = tool_stage_label(tc_name, user_zh).to_string();

                tool_futures.push(Box::pin(async move {
                    // ── Heartbeat: emit progress every 3 seconds while the tool runs ──
                    // This keeps the UI alive during long-running tools (fetch_web_content,
                    // generate_structure_note, etc.) so users know it hasn't stalled.
                    let hb_id = tc_id_clone.clone();
                    let hb_stage = stage_label.clone();
                    let hb_handle = app_handle_hb.clone();
                    let heartbeat = tokio::spawn(async move {
                        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
                        interval.tick().await; // skip first immediate tick
                        loop {
                            interval.tick().await;
                            emit_agent_event(&hb_handle, AgentEvent::ToolProgress {
                                tool_call_id: hb_id.clone(),
                                stage: hb_stage.clone(),
                                preview: None,
                            });
                        }
                    });

                    // Wait for approval if this is a write tool
                    if needs_approval {
                        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                        let pending_approvals = get_pending_approvals();
                        {
                            let mut pending = pending_approvals.lock().await;
                            pending.insert(approval_id_clone.clone(), tx);
                        }

                        // Wait for approval with timeout (60 seconds)
                        let approved = tokio::time::timeout(
                            std::time::Duration::from_secs(60),
                            rx,
                        ).await;

                        // Clean up
                        {
                            let mut pending = pending_approvals.lock().await;
                            pending.remove(&approval_id_clone);
                        }

                        match approved {
                            Ok(Ok(true)) => { /* approved, continue */ }
                            Ok(Ok(false)) | Ok(Err(_)) => {
                                // 用户拒绝或通道关闭:通知前端移除卡片
                                heartbeat.abort();
                                emit_agent_event(app_handle, AgentEvent::ApprovalResolved {
                                        approval_id: approval_id_clone.clone(),
                                        approved: false,
                                        reason: "rejected".to_string(),
                                    },);
                                return (tc_id_clone, tc_name_clone, "User rejected this edit. Please do not retry this exact operation.".to_string(), 0);
                            }
                            Err(_) => {
                                // 超时:通知前端移除卡片
                                heartbeat.abort();
                                emit_agent_event(app_handle, AgentEvent::ApprovalResolved {
                                        approval_id: approval_id_clone.clone(),
                                        approved: false,
                                        reason: "timeout".to_string(),
                                    },);
                                return (tc_id_clone, tc_name_clone, "Approval timed out after 60 seconds. Please ask the user again if you want to proceed.".to_string(), 0);
                            }
                        }
                    }

                    let start = std::time::Instant::now();
                    // A-8: Timeout protection — prevent single tool from hanging the agent loop
                    let res = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        fut,
                    ).await;
                    let duration_ms = start.elapsed().as_millis() as u64;
                    // Stop the heartbeat — tool is done (success or timeout)
                    heartbeat.abort();
                    let content = match res {
                        Ok(Ok(v)) => v,
                        Ok(Err(e)) => format!("Error: {}", e),
                        Err(_) => format!("Error: Tool '{}' timed out after 30 seconds. Please try with different parameters or a different approach.", tc_name_clone),
                    };
                    (tc_id_clone, tc_name_clone, content, duration_ms)
                }));
            }
        }

        // If ALL tool calls in this iteration are duplicates, force-break to prevent infinite loop
        if duplicate_count == tool_calls_data.len() {
            crate::chat_file_log::log_agent(&format!("duplicate_tool_calls_break: All {} tool calls are duplicates — breaking tool loop to prevent infinite retry", duplicate_count));
            // This iteration's tool calls emitted ToolStart but join_all never ran —
            // flush them now so no tool card is left permanently spinning.
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call skipped (turn ending)");
            let fallback = if !resp.content.is_empty() {
                resp.content.clone()
            } else {
                "I've already gathered all the information I need. Let me summarize what I found.".to_string()
            };
            // Route through synthesis when substantive tools ran earlier in the turn.
            let (content, source) = synthesize_or_fallback(
                config,
                messages,
                &user_query,
                task_kind,
                app_handle,
                total_tool_calls,
                &executed_calls,
                fallback,
                "duplicate_break",
            )
            .await;
            return Ok(AgentTurnResult::finish(
                content,
                source,
                total_tool_calls,
                app_handle,
            ));
        }

        // 3. Resolve futures in parallel
        let results = futures_util::future::join_all(tool_futures).await;

        // 4. Update message history with parallel tool outputs
        for (tc_id, tc_name, content, duration_ms) in results {
            emit_agent_event(app_handle, AgentEvent::ToolResult {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    content: content.clone(),
                    duration_ms,
                },);

            let max_tool_result_chars = 25000;
            let summarize_threshold = 3000;
            let mut sanitized_content: String = content.chars()
                .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                .collect();

            // Normalize JSON output format so the Agent always gets a clean, consistent representation (Fix 2)
            if (sanitized_content.trim().starts_with('{') && sanitized_content.trim().ends_with('}'))
                || (sanitized_content.trim().starts_with('[') && sanitized_content.trim().ends_with(']')) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&sanitized_content) {
                    if let Ok(pretty) = serde_json::to_string_pretty(&val) {
                        sanitized_content = format!("```json\n{}\n```", pretty);
                    }
                }
            }

            // Phase 4: deterministic, non-LLM compression of long tool outputs.
            // The full content is already sent to the frontend via ToolResult;
            // this only shrinks the copy going back into LLM context. No extra
            // API call — replaces the previous LLM-based summarizer.
            let final_content = if sanitized_content.chars().count() > summarize_threshold
                && !SKIP_SUMMARY_TOOLS.contains(&tc_name.as_str())
            {
                let compressed = compress_tool_result(&tc_name, &sanitized_content, summarize_threshold);
                crate::chat_file_log::log_agent(&format!(
                    "compressed_tool_output: Compressed tool '{}' output: {} chars → {} chars (deterministic)",
                    tc_name,
                    sanitized_content.chars().count(),
                    compressed.chars().count()
                ));
                compressed
            } else if sanitized_content.chars().count() > max_tool_result_chars {
                let t: String = sanitized_content.chars().take(max_tool_result_chars).collect();
                format!("{}...[truncated, total {} chars]", t, sanitized_content.chars().count())
            } else {
                sanitized_content
            };

            // Track consecutive errors for simple escalation
            let is_error = final_content.starts_with("Error:") || final_content.starts_with("error:");
            if is_error {
                consecutive_errors += 1;
            } else {
                consecutive_errors = 0;
            }

            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: final_content.clone(),
                tool_calls: None,
                tool_call_id: Some(tc_id.clone()),
            });

            if is_error {
                crate::chat_file_log::log_agent(&format!("tool_returned_error: Tool '{}' returned error: {}", tc_name, &final_content[..final_content.len().min(200)]));
            }
        }

        // All this iteration's tool calls now have a matching ToolResult — clear the
        // pending tracker so early exits in subsequent iterations don't double-flush.
        pending_tool_results.clear();

        // ── Error escalation: stop after 3 consecutive errors ──
        if consecutive_errors >= 3 {
            crate::chat_file_log::log_agent(&format!(
                "error_escalation: {} consecutive tool errors — stopping", consecutive_errors));
            emit_agent_event(app_handle, AgentEvent::Thinking {
                message: if user_zh {
                    "多次工具错误，需要你的指引…".to_string()
                } else {
                    "Encountered repeated errors — handing back to the user for guidance.".to_string()
                },
            });
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call skipped (turn ending)");
            let fallback = if user_zh {
                format!("抱歉，连续 {} 次工具调用失败，无法自动恢复。\n\n请检查相关笔记/路径，或换一种方式描述你的需求。", consecutive_errors)
            } else {
                format!("Sorry — {} consecutive tool errors prevented automatic recovery.\n\nPlease check the relevant notes/paths, or rephrase your request.", consecutive_errors)
            };
            let (content, source) = synthesize_or_fallback(
                config, messages, &user_query, task_kind,
                app_handle, total_tool_calls, &executed_calls, fallback, "error_escalation",
            ).await;
            return Ok(AgentTurnResult::finish(content, source, total_tool_calls, app_handle));
        }
    }
}
