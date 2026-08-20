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
pub mod tool_hooks;
pub mod token_usage;

// Re-export tool hook system items
pub use tool_hooks::{
    HookOutcome, HookStage, run_pre_hooks, run_post_hooks, run_abort_hook,
    set_active_vault_path, active_vault_path, flush_memory_before_fold,
    set_active_app_handle, active_app_handle,
    clear_turn_taint, mark_turn_tainted, turn_taint,
};

// Re-export approval gate items
pub use approval::{
    approve_tool_call, reject_tool_call, requires_approval,
    build_approval_diff_data, get_pending_approvals, ApprovalDiffData,
    ApprovalDecision, ApprovalRule, PermissionMode, RiskLevel,
    base_risk_level, effective_risk_level, decide, decide_ambient,
    permission_mode, store_permission_mode,
};

// Re-export context window management items
pub use context::{
    estimate_tokens, compress_context_window, get_max_context_tokens,
    compress_tool_result,
    // Budget accounting: the estimate now includes tool_calls, tool schemas and
    // per-message role overhead, and compaction is gated on it.
    estimate_message_tokens, estimate_messages_tokens, estimate_tool_schema_tokens,
    estimate_request_tokens, compression_trigger_threshold, should_compress,
    COMPRESSION_TRIGGER_RATIO, DEFAULT_CONTEXT_WINDOW_TOKENS,
};

// Re-export adaptive planning items
pub use planning::{classify_query_complexity, is_greeting_or_chitchat};

// Re-export adaptive prompt items
pub use adaptive_prompt::{
    TaskComplexity, assess_complexity, build_prompt,
    tool_quick_ref, tool_coordination_guide,
};

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
    /// A PRE hook vetoed a tool call before execution (destructive pattern).
    #[serde(rename = "tool_blocked")]
    ToolBlocked { tool_call_id: String, name: String, reason: String },
    /// A PRE hook flagged a write op as elevated-risk (surfaced in the approval card).
    #[serde(rename = "tool_risk_notice")]
    ToolRiskNotice { tool_call_id: String, name: String, reason: String },
    /// A POST hook scrubbed secret-shaped values from tool output.
    #[serde(rename = "tool_redacted")]
    ToolRedacted { tool_call_id: String, name: String, redactions: u32 },
    /// Key info was flushed to core memory before a context fold.
    #[serde(rename = "memory_flushed")]
    MemoryFlushed { count: u32 },
    /// A new agent run began. The frontend records `run_id` and drops any
    /// subsequent event carrying a different one.
    #[serde(rename = "run_started")]
    RunStarted { run_id: String },
    /// Progress of a batch AI run (体检台批量). One event per note, twice:
    /// `status: "start"` before the turn and `"ok"`/`"error"`/`"skipped"` after.
    /// `index` is 1-based so the UI can render "3/12" without arithmetic.
    #[serde(rename = "batch_progress")]
    BatchProgress {
        index: usize,
        total: usize,
        file_path: String,
        status: String,
    },
    /// Explicit lifecycle phase transition.
    #[serde(rename = "phase")]
    Phase {
        phase: AgentPhase,
        /// Pre-localized label so the frontend needs no phase→text table.
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Four-way token accounting for the turn. Emitted once at turn end.
    /// The four buckets are disjoint, so `total` is their sum.
    #[serde(rename = "token_usage")]
    TokenUsage {
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        total: u64,
        /// `cache_read / (cache_read + input)`, in `[0, 1]`.
        cache_hit_rate: f64,
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
        AgentEvent::ToolBlocked { tool_call_id, name, reason } => {
            format!("tool_blocked id={} name={} reason={}", tool_call_id, name,
                crate::chat_file_log::trunc(reason, 160))
        }
        AgentEvent::ToolRiskNotice { tool_call_id, name, reason } => {
            format!("tool_risk_notice id={} name={} reason={}", tool_call_id, name,
                crate::chat_file_log::trunc(reason, 160))
        }
        AgentEvent::ToolRedacted { tool_call_id, name, redactions } => {
            format!("tool_redacted id={} name={} count={}", tool_call_id, name, redactions)
        }
        AgentEvent::MemoryFlushed { count } => {
            format!("memory_flushed count={}", count)
        }
        AgentEvent::RunStarted { run_id } => {
            format!("run_started id={}", run_id)
        }
        AgentEvent::BatchProgress { index, total, file_path, status } => {
            format!("batch_progress {}/{} {} {}", index, total, file_path, status)
        }
        AgentEvent::Phase { phase, label, .. } => {
            format!("phase {} — {}", phase.as_str(), label)
        }
        AgentEvent::TokenUsage {
            input,
            output,
            cache_read,
            cache_write,
            total,
            cache_hit_rate,
        } => {
            format!(
                "token_usage_total in={} out={} cache_read={} cache_write={} total={} hit_rate={:.2}",
                input, output, cache_read, cache_write, total, cache_hit_rate
            )
        }
    }
}

/// Emit agent event to UI and append to `logs/agent.log`.
///
/// Every payload is stamped with the active `run_id` so the frontend can drop
/// events belonging to a superseded run. Serializing to a `Value` first keeps
/// the `AgentEvent` enum free of a run-id field on all 19 variants.
pub fn emit_agent_event(app_handle: &tauri::AppHandle, event: AgentEvent) {
    crate::chat_file_log::log_agent(&format_agent_event(&event));
    match serde_json::to_value(&event) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert(
                "run_id".to_string(),
                serde_json::Value::String(current_run_id()),
            );
            let _ = app_handle.emit("agent-event", serde_json::Value::Object(map));
        }
        // Non-object payloads shouldn't occur (the enum is internally tagged),
        // but emit unstamped rather than dropping the event.
        _ => {
            let _ = app_handle.emit("agent-event", event);
        }
    }
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
    /// `{"include_usage": true}` — asks an OpenAI-compatible provider to append
    /// a final usage-bearing chunk to the stream. Omitted entirely for
    /// providers not known to accept it, since strict gateways reject unknown
    /// request fields outright.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<serde_json::Value>,
}

/// Whether this OpenAI-compatible provider accepts `stream_options`.
///
/// Deliberately a whitelist rather than a blacklist: an unrecognized endpoint
/// (self-hosted gateway, proxy, local server) may reject the field and fail
/// the whole request, and losing token accounting is much cheaper than losing
/// the response.
pub(crate) fn supports_stream_usage(provider: &str) -> bool {
    matches!(
        provider,
        "openai"
            | "deepseek"
            | "moonshot"
            | "qwen"
            | "zhipu"
            | "siliconflow"
            | "openrouter"
            | "together"
            | "groq"
            | "minimax"
    )
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

// ── Lifecycle Generation ───────────────────────────────────────────
// Every agent turn gets a fresh run id. All emitted events are stamped with
// it, and the frontend drops any event whose id does not match the run it is
// currently rendering. This is what keeps a crashed / superseded run from
// writing into a brand-new conversation: the stale task may still be alive
// inside tokio, but its output is now unaddressable.

fn run_id_slot() -> &'static std::sync::Mutex<String> {
    static SLOT: OnceLock<std::sync::Mutex<String>> = OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(String::new()))
}

/// Start a new agent run: mints a fresh run id, clears the stop flag, and
/// returns the id so the caller can announce it via `AgentEvent::RunStarted`.
pub fn begin_agent_run() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    if let Ok(mut guard) = run_id_slot().lock() {
        *guard = id.clone();
    }
    reset_agent_stop();
    token_usage::reset_turn_usage();
    // Untrusted-content provenance is per-turn: a web page read three turns ago
    // must not keep decorating today's approval cards.
    tool_hooks::clear_turn_taint();
    // Publish the id to the tool layer so every file mutation this turn performs
    // lands in `agent_run_journal` under it, enabling "undo this whole turn".
    tool_hooks::set_current_run_id(&id);
    crate::chat_file_log::log_agent(&format!("run_started id={}", id));
    id
}

/// Emit the turn's accumulated four-way token usage. No-op when the provider
/// reported nothing, so a gateway that strips `usage` produces no misleading
/// all-zero card in the UI.
pub fn emit_turn_token_usage(app_handle: &tauri::AppHandle) {
    let u = token_usage::turn_usage();
    if u.is_empty() {
        return;
    }
    emit_agent_event(app_handle, AgentEvent::TokenUsage {
        input: u.input,
        output: u.output,
        cache_read: u.cache_read,
        cache_write: u.cache_write,
        total: u.total(),
        cache_hit_rate: u.cache_hit_rate(),
    });
}

/// The run id of the active turn (empty before the first run).
pub fn current_run_id() -> String {
    run_id_slot().lock().map(|g| g.clone()).unwrap_or_default()
}

/// True when `run_id` belongs to a superseded run and its work should be
/// discarded rather than applied.
pub fn is_stale_run(run_id: &str) -> bool {
    !run_id.is_empty() && run_id != current_run_id()
}

// ── Phase Labels ───────────────────────────────────────────────────

/// Explicit lifecycle phases for one agent turn.
///
/// Without these, a stalled agent is a spinner with no location. Each
/// transition emits an event, so "stuck" always resolves to a phase name in
/// both the UI and `logs/agent.log`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPhase {
    Routing,
    Classifying,
    LoadingTools,
    Planning,
    CallingModel,
    ExecutingTools,
    AwaitingApproval,
    CompressingContext,
    Retrying,
    Synthesizing,
    Finalizing,
    Done,
    Cancelled,
    Failed,
}

impl AgentPhase {
    /// Stable snake_case identifier (matches the serde representation).
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentPhase::Routing => "routing",
            AgentPhase::Classifying => "classifying",
            AgentPhase::LoadingTools => "loading_tools",
            AgentPhase::Planning => "planning",
            AgentPhase::CallingModel => "calling_model",
            AgentPhase::ExecutingTools => "executing_tools",
            AgentPhase::AwaitingApproval => "awaiting_approval",
            AgentPhase::CompressingContext => "compressing_context",
            AgentPhase::Retrying => "retrying",
            AgentPhase::Synthesizing => "synthesizing",
            AgentPhase::Finalizing => "finalizing",
            AgentPhase::Done => "done",
            AgentPhase::Cancelled => "cancelled",
            AgentPhase::Failed => "failed",
        }
    }

    /// Human-readable label for the trace UI.
    pub fn label(&self, zh: bool) -> &'static str {
        if zh {
            match self {
                AgentPhase::Routing => "正在选择角色…",
                AgentPhase::Classifying => "正在理解意图…",
                AgentPhase::LoadingTools => "正在加载工具…",
                AgentPhase::Planning => "正在规划…",
                AgentPhase::CallingModel => "正在等待模型…",
                AgentPhase::ExecutingTools => "正在执行工具…",
                AgentPhase::AwaitingApproval => "等待你确认…",
                AgentPhase::CompressingContext => "正在压缩上下文…",
                AgentPhase::Retrying => "网络波动，正在重试…",
                AgentPhase::Synthesizing => "正在整合结果…",
                AgentPhase::Finalizing => "正在收尾…",
                AgentPhase::Done => "已完成",
                AgentPhase::Cancelled => "已停止",
                AgentPhase::Failed => "执行失败",
            }
        } else {
            match self {
                AgentPhase::Routing => "Selecting agent…",
                AgentPhase::Classifying => "Understanding intent…",
                AgentPhase::LoadingTools => "Loading tools…",
                AgentPhase::Planning => "Planning…",
                AgentPhase::CallingModel => "Waiting for the model…",
                AgentPhase::ExecutingTools => "Running tools…",
                AgentPhase::AwaitingApproval => "Waiting for your approval…",
                AgentPhase::CompressingContext => "Compressing context…",
                AgentPhase::Retrying => "Transient error — retrying…",
                AgentPhase::Synthesizing => "Synthesizing results…",
                AgentPhase::Finalizing => "Finalizing…",
                AgentPhase::Done => "Completed",
                AgentPhase::Cancelled => "Stopped",
                AgentPhase::Failed => "Failed",
            }
        }
    }
}

/// Emit a phase transition. Thin wrapper so call sites stay one line.
pub fn emit_phase(app_handle: &tauri::AppHandle, phase: AgentPhase, zh: bool) {
    emit_agent_event(app_handle, AgentEvent::Phase {
        phase,
        label: phase.label(zh).to_string(),
        detail: None,
    });
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
        return "LLM 请求超时。若使用本地模型（Ollama / LM Studio），首次加载模型可能需要数十秒，请稍后重试；\
                否则请检查网络，或换用更快/更小的模型。\n\n\
                LLM request timed out. If you are running a local model (Ollama / LM Studio), the first \
                load can take tens of seconds — try again shortly. Otherwise check your network or try a \
                faster/smaller model."
            .to_string();
    }
    // Connection refused must be matched BEFORE the generic "error sending request"
    // branch below: reqwest's Display text contains both, and refused is the far
    // more actionable diagnosis. For this project it almost always means a local
    // Ollama / LM Studio that is not running (or is on a different port) — telling
    // that user "check API URL, proxy, and connectivity" sends them hunting for a
    // network problem that does not exist.
    if lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("os error 10061")
    {
        return "无法连接到模型服务（连接被拒绝）。\
                若使用本地部署（Ollama / LM Studio），请确认：\
                1) 服务已启动；2) 端口与设置中的 API 地址一致（Ollama 默认 http://localhost:11434）；\
                3) 模型已下载。若使用云端 API，请检查 API 地址是否正确。\n\n\
                Could not connect to the model service (connection refused). \
                If you are self-hosting (Ollama / LM Studio), check that: \
                1) the server is running; 2) the port matches the API URL in Settings \
                (Ollama defaults to http://localhost:11434); 3) the model is pulled. \
                If you are using a cloud API, verify the API URL."
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
                // Non-streaming: usage arrives in the response body itself.
                stream_options: None,
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
            stream_options: if supports_stream_usage(provider) {
                Some(serde_json::json!({ "include_usage": true }))
            } else {
                None
            },
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

// ── Retry Grace: transient vs deterministic tool failures ──────────

/// Classify a tool result as a *transient* failure worth one retry.
///
/// The distinction matters: retrying "note not found" burns a round-trip and
/// tells the model nothing new, while retrying a dropped connection usually
/// succeeds. Only network/timeout/lock-contention shapes are retried.
fn is_transient_tool_error(content: &str) -> bool {
    if !(content.starts_with("Error:") || content.starts_with("error:")) {
        return false;
    }
    let lower = content.to_lowercase();

    // Deterministic failures — a retry cannot change the outcome.
    const PERMANENT: &[&str] = &[
        "not found",
        "does not exist",
        "no such file",
        "invalid argument",
        "invalid parameter",
        "missing required",
        "already exists",
        "unknown tool",
        "permission denied",
        "user rejected",
        "unsupported",
        "parse error",
        "invalid json",
    ];
    if PERMANENT.iter().any(|p| lower.contains(p)) {
        return false;
    }

    // Transient shapes — worth exactly one more attempt.
    const TRANSIENT: &[&str] = &[
        "timed out",
        "timeout",
        "connection reset",
        "connection closed",
        "connection refused",
        "error sending request",
        "temporarily unavailable",
        "database is locked",
        "resource busy",
        "too many requests",
        "429",
        "502",
        "503",
        "504",
        "dns",
        "tls",
        "network",
    ];
    TRANSIENT.iter().any(|p| lower.contains(p))
}

/// Grace delay before a retry attempt. Short enough that the user does not
/// perceive a stall, long enough that a transient blip has cleared.
const RETRY_GRACE_MS: u64 = 1200;

// ── Empty-result stagnation ────────────────────────────────────────
// Salvaged from the deleted `agent_recovery::StagnationDetector`. Everything
// else that module tracked already has a stronger equivalent in this loop
// (repeated calls → duplicate detection + force-break; search volume → the
// per-tool budget filter; wall clock → the per-tool 30s timeout and
// `max_total_tool_calls`; consecutive errors → `consecutive_errors` >= 3).
//
// The one failure mode nothing covered: the tool *succeeded* and returned
// nothing. `Error:`-prefixed results drive the escalation counter, but an
// empty result is not an error, so it resets that counter (see below) and the
// turn keeps spending calls on a search that will never land.
//
// Note the old detector could not have worked here even if it had been wired:
// it compared the raw string against `"[]"`, but by the time a result reaches
// the loop's bookkeeping it has been pretty-printed and wrapped in a ```json
// fence (see the JSON normalization in the result loop). The fence has to come
// off first — that is what `strip_json_fence` is for.

/// Consecutive empty results before the loop asks the model to change approach.
const EMPTY_RESULT_STAGNATION_THRESHOLD: u32 = 3;

/// Hard cap on stagnation nudges per turn. Recovery must be bounded: a vault
/// that genuinely holds nothing relevant would otherwise earn a nudge every
/// third tool call and burn API quota until `max_total_tool_calls` fires.
const MAX_STAGNATION_NUDGES: u32 = 2;

/// Object keys whose empty array means "the tool found nothing".
///
/// Deliberately a closed list rather than "any empty array in the object".
/// A note payload legitimately carries `"tags": []`, and treating that as an
/// empty result would misfire on a perfectly successful read.
const EMPTY_PAYLOAD_KEYS: &[&str] = &["results", "notes", "matches", "items", "data", "hits"];

/// Unwrap the fenced-JSON block (opening fence, optional language tag, closing
/// fence) that the result loop wraps around JSON tool output.
fn strip_json_fence(content: &str) -> &str {
    let t = content.trim();
    let Some(rest) = t.strip_prefix("```") else {
        return t;
    };
    // Drop the language tag on the opening fence, then the closing fence.
    let rest = rest.split_once('\n').map(|(_lang, body)| body).unwrap_or("");
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}

/// True when a tool call succeeded but produced nothing the model can use.
///
/// Errors are explicitly *not* empty: they belong to the escalation path, which
/// keeps the original message. Counting them here would let the stagnation
/// nudge swallow a real failure.
fn is_empty_tool_result(content: &str) -> bool {
    let body = strip_json_fence(content);
    if body.is_empty() {
        return true;
    }
    if body.starts_with("Error:") || body.starts_with("error:") {
        return false;
    }
    if matches!(body, "{}" | "[]" | "null") {
        return true;
    }
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(serde_json::Value::Array(items)) => items.is_empty(),
        Ok(serde_json::Value::Object(map)) => {
            // Wrapper shape, e.g. `{"results": [], "message": "No results found."}`.
            // The prose field only explains the emptiness, so it does not count
            // as content — but at least one known payload key must be present.
            let payloads: Vec<_> = EMPTY_PAYLOAD_KEYS
                .iter()
                .filter_map(|k| map.get(*k))
                .collect();
            !payloads.is_empty()
                && payloads.iter().all(|v| match v {
                    serde_json::Value::Array(items) => items.is_empty(),
                    serde_json::Value::Object(o) => o.is_empty(),
                    serde_json::Value::Null => true,
                    _ => false,
                })
        }
        _ => false,
    }
}

/// Fold one tool result into the empty-result streak; returns the new streak.
fn track_empty_result(streak: u32, content: &str) -> u32 {
    if is_empty_tool_result(content) {
        streak.saturating_add(1)
    } else {
        0
    }
}

/// Whether the loop should inject one stagnation nudge right now.
fn should_nudge_stagnation(streak: u32, nudges_used: u32) -> bool {
    streak >= EMPTY_RESULT_STAGNATION_THRESHOLD && nudges_used < MAX_STAGNATION_NUDGES
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

/// Run synthesis up to once (no retry). The earlier 2-attempt loop added a
/// full extra LLM round-trip on every failure — which in practice meant: model
/// produces a slightly terse answer → classified as "meta-stub" → new synthesis
/// call → wait another 2-5s → user perceives extreme slowness. One attempt is
/// enough: if it fails, fall back to `extract_best_loop_answer` which is free.
async fn run_synthesis_with_retry(
    config: &LlmConfig,
    messages: &[ChatMessage],
    user_query: &str,
    task_kind: plan_guard::TaskKind,
    app_handle: &tauri::AppHandle,
    total_tool_calls: usize,
    base_label: &str,
) -> Option<String> {
    match run_synthesis_pass(
        config,
        messages,
        user_query,
        task_kind,
        app_handle,
        total_tool_calls,
        base_label,
    )
    .await
    {
        Ok(answer) if !answer.trim().is_empty() => Some(answer),
        Ok(_) => {
            crate::chat_file_log::log_agent(&format!("synthesis_pass_empty {base_label}"));
            None
        }
        Err(e) => {
            crate::chat_file_log::log_agent(&format!("synthesis_pass_error {base_label} {e}"));
            None
        }
    }
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
        // ── ABORT hook stage ───────────────────────────────────────
        // Records the terminal state of a tool call that never produced a
        // result (user cancelled, turn ended, duplicate break).
        tool_hooks::run_abort_hook(&name, reason);
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

// ── Turn budgets ───────────────────────────────────────────────────

/// Which per-turn budget ran out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnLimit {
    /// Model round-trips (`AgentExecutionConfig::max_iterations`).
    Iterations,
    /// Total tool calls (`AgentExecutionConfig::max_total_tool_calls`).
    ToolCalls,
}

/// Decide whether the current turn has exhausted a budget.
///
/// Pure on purpose: the cap arithmetic is the part that is easy to get off by
/// one, and a pure function can be tested without driving a live agent turn or
/// a real provider. `iteration` is 1-based (already incremented for the round
/// about to run), so the comparison is `>`, not `>=`: with `max_iterations = 1`
/// the first round must still be allowed to happen.
///
/// Iterations are reported first when both are exhausted. That ordering is
/// cosmetic — both land in the same synthesis exit — but it keeps the message
/// the user sees deterministic instead of depending on arrival order.
pub(crate) fn exhausted_budget(
    iteration: usize,
    max_iterations: usize,
    tool_calls: usize,
    max_tool_calls: usize,
) -> Option<TurnLimit> {
    if iteration > max_iterations {
        return Some(TurnLimit::Iterations);
    }
    if tool_calls >= max_tool_calls {
        return Some(TurnLimit::ToolCalls);
    }
    None
}

// ── Provider HTTP retry ────────────────────────────────────────────
// The tool layer has had transient-error retry for a while
// (`is_transient_tool_error` + `AgentPhase::Retrying`), but the model calls
// themselves did not: every `send_and_parse_*` propagated the first error with
// `?` and killed the whole turn. A single 429 or a dropped connection threw away
// all the tool work already done in that turn. This is that gap closed, in one
// place, for all three adapters.
//
// Scope note — why this wraps only the *request*, not the stream: all three
// adapters stream tokens to the UI as they arrive. Once a byte has been emitted,
// retrying would replay text the user already saw. So the retry boundary is
// deliberately "before the first byte": connect, send, response status. That
// covers 429/5xx/refused/timeout, which is where these failures actually live.

/// Total attempts (1 initial + 2 retries). Bounded because every attempt on a
/// paid endpoint may still be billed, and a user staring at a spinner would
/// rather see a clear error than an indefinite retry storm.
pub(crate) const LLM_MAX_ATTEMPTS: u32 = 3;

/// First backoff step. Long enough for a load-balancer blip to clear, short
/// enough that a successful retry still feels like a hiccup rather than a hang.
pub(crate) const LLM_RETRY_BASE_MS: u64 = 500;

/// Ceiling for a single backoff step, so an honoured `Retry-After: 300` cannot
/// silently park the turn for five minutes.
pub(crate) const LLM_RETRY_MAX_DELAY_MS: u64 = 8_000;

/// Ceiling on *cumulative* sleeping across all retries in one call. Without
/// this, three capped steps could add ~24s of dead air on top of the request
/// timeouts themselves.
pub(crate) const LLM_RETRY_TOTAL_BUDGET_MS: u64 = 20_000;

/// Retry only what a retry can actually fix.
///
/// 429 and 5xx are the server saying "not now". 408/425 are explicit
/// retry-me signals. Everything else in 4xx (400 bad request, 401/403 bad or
/// missing key, 404 wrong endpoint, 422 bad schema) is a *configuration* error:
/// the identical request will fail identically, so retrying only wastes the
/// user's quota and spams three copies of the same error into the log.
pub(crate) fn should_retry_http_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429) || (500..600).contains(&status)
}

/// Retry only transport failures that are plausibly transient.
///
/// Deliberately conservative on "connection refused": for a cloud endpoint it is
/// worth one more try, and for a local Ollama/LM Studio that is still binding its
/// port a retry is exactly right — but see `format_llm_user_error`, which turns
/// the *final* refusal into an actionable "is the server running?" message rather
/// than a bare `connection refused`.
pub(crate) fn should_retry_transport_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    // Body/decode errors are excluded: by then bytes have already been streamed.
    const TRANSIENT: &[&str] = &[
        "timed out",
        "timeout",
        "connection reset",
        "connection closed",
        "connection refused",
        "connection aborted",
        "actively refused",
        "error sending request",
        "broken pipe",
        "os error 10054", // WSAECONNRESET — Windows spells this numerically
        "os error 10061", // WSAECONNREFUSED
        "dns error",
        "temporarily unavailable",
    ];
    TRANSIENT.iter().any(|p| lower.contains(p))
}

/// Deterministic exponential backoff for `attempt` (1-based), before jitter.
///
/// Kept separate from the jitter step so it stays pure and monotonic — a test
/// can assert "step 2 waits longer than step 1" without fighting randomness.
pub(crate) fn backoff_base_delay(attempt: u32) -> std::time::Duration {
    let exp = attempt.saturating_sub(1).min(16);
    let ms = LLM_RETRY_BASE_MS
        .saturating_mul(1u64 << exp)
        .min(LLM_RETRY_MAX_DELAY_MS);
    std::time::Duration::from_millis(ms)
}

/// Apply proportional jitter, `factor` in `[0.0, 1.0)` mapping to `[75%, 125%]`.
///
/// Jitter matters even for a single-user desktop app: without it, a vault-wide
/// batch (reconcile over N notes) retries in lockstep and re-hammers the same
/// rate limit at the same instant.
pub(crate) fn apply_jitter(base: std::time::Duration, factor: f64) -> std::time::Duration {
    let f = factor.clamp(0.0, 1.0);
    let scaled = base.as_millis() as f64 * (0.75 + 0.5 * f);
    std::time::Duration::from_millis(scaled.round() as u64)
}

/// Parse a `Retry-After` header value (delay-seconds form only).
///
/// The HTTP-date form is intentionally unsupported: it needs a trusted local
/// clock, and every provider that actually sends this header sends seconds.
/// Values above the per-step ceiling are clamped rather than rejected, so a
/// `Retry-After: 120` still slows us down without stalling the turn.
pub(crate) fn parse_retry_after(value: &str) -> Option<std::time::Duration> {
    let secs: f64 = value.trim().parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    let ms = (secs * 1000.0).round() as u64;
    Some(std::time::Duration::from_millis(ms.min(LLM_RETRY_MAX_DELAY_MS)))
}

/// Truncate a provider error body for display.
///
/// `chars().take()`, never a byte slice: provider errors routinely come back in
/// Chinese, and byte-slicing a multi-byte boundary panics. This repo has already
/// been bitten by that class of bug more than once.
fn truncate_error_body(body: &str, max_chars: usize) -> String {
    if body.chars().count() <= max_chars {
        return body.to_string();
    }
    let head: String = body.chars().take(max_chars).collect();
    format!("{}…", head)
}

/// Pick the retry-message language from the transcript.
///
/// The adapters do not receive the orchestrator's `user_zh` flag, and threading it
/// through three public signatures for one label is not worth it — the last user
/// message is the same signal `chat_completion_with_tools` uses.
pub(crate) fn zh_from_messages(messages: &[ChatMessage]) -> bool {
    messages
        .iter()
        .filter(|m| m.role == "user")
        .last()
        .map(|m| plan_guard::user_prefers_zh(&m.content))
        .unwrap_or(false)
}

/// Pseudo-random `[0.0, 1.0)` jitter source.
///
/// Wall-clock nanoseconds rather than the `rand` crate: jitter here only needs to
/// decorrelate retries, not to be cryptographic or statistically clean, and this
/// avoids adding a dependency to a project that deliberately ships a small,
/// auditable, offline-capable dependency tree.
fn jitter_seed() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 1_000) as f64 / 1_000.0
}

/// Send one provider request with bounded exponential backoff + jitter.
///
/// `build` is a closure rather than a pre-built `RequestBuilder` because a
/// builder is consumed by `send()`; rebuilding per attempt also avoids relying
/// on `try_clone()`, which returns `None` for streaming bodies.
///
/// Returns the successful response, or the *last* error encountered — never a
/// synthesized "retries exhausted" string, so the provider's own diagnostics
/// (invalid key, quota exceeded, model not found) reach the user intact.
pub(crate) async fn send_llm_request_with_retry<F>(
    provider_label: &str,
    zh: bool,
    app_handle: &tauri::AppHandle,
    build: F,
) -> anyhow::Result<reqwest::Response>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut slept = std::time::Duration::ZERO;

    for attempt in 1..=LLM_MAX_ATTEMPTS {
        // A user who pressed stop does not want two more attempts.
        if is_agent_cancelled() {
            anyhow::bail!("Agent turn cancelled by user");
        }

        let (last_err, retry_ok, retry_after) = match build().send().await {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                // Read the header before consuming the body.
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_retry_after);
                let body = response.text().await.unwrap_or_default();
                (
                    anyhow::anyhow!(
                        "{} API error ({}): {}",
                        provider_label,
                        status,
                        truncate_error_body(&body, 2000)
                    ),
                    should_retry_http_status(status.as_u16()),
                    retry_after,
                )
            }
            Err(e) => {
                let raw = e.to_string();
                let retry_ok = should_retry_transport_error(&raw);
                (
                    anyhow::anyhow!(format_llm_user_error(&raw)),
                    retry_ok,
                    None,
                )
            }
        };

        if attempt >= LLM_MAX_ATTEMPTS || !retry_ok {
            return Err(last_err);
        }

        // A provider-supplied `Retry-After` is honoured verbatim — jittering it
        // could land us *below* what the server asked for and earn a second 429.
        // Our own backoff is jittered so a batch job (reconcile over N notes)
        // does not retry in lockstep against the same rate limit.
        let delay = match retry_after {
            Some(d) => d,
            None => apply_jitter(backoff_base_delay(attempt), jitter_seed()),
        };

        // Total-time guard: if waiting would blow the budget, surface the real
        // error now instead of holding the turn open for a retry we cannot afford.
        if slept + delay > std::time::Duration::from_millis(LLM_RETRY_TOTAL_BUDGET_MS) {
            crate::chat_file_log::log_agent(&format!(
                "llm_retry_budget_exhausted: {} — {}",
                provider_label, last_err
            ));
            return Err(last_err);
        }

        crate::chat_file_log::log_agent(&format!(
            "llm_retry: {} attempt {}/{} failed ({}) — retrying in {}ms",
            provider_label, attempt, LLM_MAX_ATTEMPTS, last_err, delay.as_millis()
        ));
        // Visible, with the count: "retrying (2/3)" beats a frozen spinner.
        emit_agent_event(app_handle, AgentEvent::Phase {
            phase: AgentPhase::Retrying,
            label: AgentPhase::Retrying.label(zh).to_string(),
            detail: Some(plan_guard::llm_retry_detail(zh, attempt + 1, LLM_MAX_ATTEMPTS)),
        });

        tokio::time::sleep(delay).await;
        slept += delay;
        // Put the UI back into "waiting for the model" rather than leaving it
        // parked on "retrying" for the whole of the next attempt.
        emit_phase(app_handle, AgentPhase::CallingModel, zh);
    }

    // Unreachable: the loop either returns a response or returns the last error
    // on its final attempt. Kept as a real error rather than unreachable!() so a
    // future edit to the bounds cannot turn into a panic in the user's face.
    anyhow::bail!("{} API error: retry loop ended without a result", provider_label)
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
    // ── Two independent turn caps, deliberately not redundant ────────
    // `max_iterations` bounds *model round-trips* (loop safety / latency): a
    // model that keeps calling one tool per turn forever is bounded by this and
    // nothing else. `max_total_tool_calls` bounds *cost* (a single iteration can
    // fan out to many parallel tool calls, so round-trips alone cannot cap spend).
    //
    // They do not fight because neither is a hard break: whichever trips first
    // routes into the same synthesis-and-finish exit below, so the user gets an
    // answer from the work already done either way. `.max(1)` because a
    // misconfigured 0 would otherwise end the turn before the first model call.
    let max_iterations: usize = exec_config.max_iterations.max(1);
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
    // Streak of "succeeded but returned nothing" tool results, and how many
    // change-approach nudges this turn has already spent. Both are per-turn so
    // the budget cannot leak across turns.
    let mut consecutive_empty_results = 0u32;
    let mut stagnation_nudges = 0u32;

    let max_context = get_max_context_tokens(config);

    // ── Loop Engineering: model-driven loop, two bounded exits ──────
    // The model decides when it is done (no tool_calls → final answer). The two
    // caps declared at the top of this function only bound the pathological
    // cases, and both funnel into the single wrap-up block below.
    let mut iteration = 0usize;
    loop {
        // ── User cancellation check ───────────────────────────────
        // Checked every iteration so the stop button takes effect
        // between tool calls (the natural granularity for an agent loop).
        if is_agent_cancelled() {
            crate::chat_file_log::log_agent(&format!("turn_cancelled: Agent turn cancelled by user at iteration {}", iteration));
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call cancelled");
            return Ok(AgentTurnResult::finish(
                String::new(),
                AnswerSource::Loop,
                total_tool_calls,
                app_handle,
            ));
        }

        iteration += 1;

        // ── Turn exhaustion — iteration cap or tool-call cap ─────────
        // `max_iterations` was previously read into `_max_iterations` and thrown
        // away, which made a user-visible, per-agent configurable knob do exactly
        // nothing. It is now a real cap. Round-trips and tool calls are different
        // resources, so both checks exist; whichever trips first wraps the turn up
        // *through synthesis*, never a hard break, so the user still gets an answer
        // built from the work already done.
        let exhausted: Option<(&str, String, String)> = match exhausted_budget(
            iteration, max_iterations, total_tool_calls, max_total_tool_calls,
        ) {
            Some(TurnLimit::Iterations) => Some((
                "iteration",
                plan_guard::iteration_limit_thinking(user_zh, max_iterations),
                plan_guard::iteration_limit_nudge(user_zh),
            )),
            Some(TurnLimit::ToolCalls) => Some((
                "tool_calls",
                plan_guard::tool_limit_thinking(user_zh, max_total_tool_calls),
                plan_guard::tool_limit_nudge(user_zh),
            )),
            None => None,
        };

        if let Some((reason, thinking, nudge)) = exhausted {
            crate::chat_file_log::log_agent(&format!(
                "turn_limit_{}: hit cap (iteration {}/{}, tool_calls {}/{}) — forcing completion",
                reason, iteration, max_iterations, total_tool_calls, max_total_tool_calls
            ));
            // Visible, not silent: the phase event puts the turn in a named state
            // and the Thinking event says which budget ran out.
            emit_phase(app_handle, AgentPhase::Synthesizing, user_zh);
            emit_agent_event(app_handle, AgentEvent::Thinking { message: thinking });
            flush_pending_tool_results(&mut pending_tool_results, app_handle, "Tool call skipped (turn ending)");

            let substantive = plan_guard::substantive_tool_count(&executed_calls);
            if substantive > 0 {
                if let Some(synth) = run_synthesis_with_retry(
                    config, messages, &user_query, task_kind,
                    app_handle, total_tool_calls, reason,
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
                content: nudge,
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

        // ── Context Window Compression (threshold-gated) ─────────────
        // This used to run unconditionally every iteration. Two problems with
        // that: it burned CPU/latency on transcripts nowhere near the limit,
        // and compaction rewrites the head of the message list, which
        // invalidates the provider's prompt-cache prefix every single turn.
        // Now the gate consults the full budget (messages + tool_calls + tool
        // schemas) and stays out of the way until we actually approach it.
        if should_compress(messages, tools, &user_query, max_context) {
            emit_phase(app_handle, AgentPhase::CompressingContext, user_zh);
            compress_context_window(config, messages, tools, &user_query, max_context).await;
        }
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
                iteration,
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
        emit_phase(app_handle, AgentPhase::CallingModel, user_zh);
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
        let mut tool_calls_data: Vec<(String, String, String)> = resp.tool_calls.iter().map(|tc| {
            (tc.id.clone(), tc.function.name.clone(), tc.function.arguments.clone())
        }).collect();

        // ── PRE hook stage ──────────────────────────────────────────
        // Runs before any execution so a hook can veto the call, rewrite its
        // arguments, or attach a risk reason that the approval card surfaces.
        // Outcomes are computed up-front (not inside the future) so rewritten
        // args live as long as the futures that borrow them.
        let mut pre_outcomes: Vec<tool_hooks::HookOutcome> = Vec::with_capacity(tool_calls_data.len());
        for (tc_id, tc_name, tc_args) in tool_calls_data.iter_mut() {
            let outcome = tool_hooks::run_pre_hooks(tc_name, tc_args);
            if let Some(ref rewritten) = outcome.replace_args {
                crate::chat_file_log::log_agent(&format!(
                    "tool_hook_rewrite: PRE hook rewrote args for '{}'", tc_name));
                *tc_args = rewritten.clone();
            }
            if outcome.blocked {
                emit_agent_event(app_handle, AgentEvent::ToolBlocked {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    reason: outcome.reason.clone(),
                });
            } else if outcome.risk_upgrade {
                emit_agent_event(app_handle, AgentEvent::ToolRiskNotice {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    reason: outcome.reason.clone(),
                });
            }
            pre_outcomes.push(outcome);
        }
        let tool_calls_data = tool_calls_data;

        // 2. Build concurrent futures (A-7: includes timing)
        let mut tool_futures: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = (String, String, String, u64)> + Send + '_>>> = Vec::new();
        let mut duplicate_count = 0usize;
        for (idx, (tc_id, tc_name, tc_args)) in tool_calls_data.iter().enumerate() {
            total_tool_calls += 1;
            let pre = &pre_outcomes[idx];

            // PRE hook veto: never execute, feed the reason back to the model so
            // it can pick a different approach instead of blindly retrying.
            if pre.blocked {
                let tc_id_clone = tc_id.clone();
                let tc_name_clone = tc_name.clone();
                let reason = pre.reason.clone();
                emit_agent_event(app_handle, AgentEvent::ToolStart {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    arguments: tc_args.clone(),
                });
                pending_tool_results.push((tc_id.clone(), tc_name.clone()));
                tool_futures.push(Box::pin(async move {
                    (tc_id_clone, tc_name_clone, format!("Error: {}", reason), 0u64)
                }));
                continue;
            }

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

                // Approval gate: permission mode + risk level + allow rules.
                // `decide_ambient` folds the three (see approval::decide) into
                // Allow / Ask / Deny. Critical risk always lands on Ask.
                let (decision, risk, decision_reason) =
                    approval::decide_ambient(tc_name, tc_args);
                crate::chat_file_log::log_agent(&format!(
                    "approval_decision: tool={} decision={:?} risk={} reason={}",
                    tc_name,
                    decision,
                    risk.as_str(),
                    decision_reason.clone().unwrap_or_else(|| "-".to_string())
                ));

                // Deny (ReadOnly mode): never execute, never emit an approval
                // event — feed the reason back so the model stops retrying.
                if decision == approval::ApprovalDecision::Deny {
                    let tc_id_clone = tc_id.clone();
                    let tc_name_clone = tc_name.clone();
                    let reason = decision_reason
                        .unwrap_or_else(|| "Tool denied by the current permission mode.".to_string());
                    emit_agent_event(app_handle, AgentEvent::ToolBlocked {
                        tool_call_id: tc_id.clone(),
                        name: tc_name.clone(),
                        reason: reason.clone(),
                    });
                    tool_futures.push(Box::pin(async move {
                        (tc_id_clone, tc_name_clone, format!("Error: {}", reason), 0u64)
                    }));
                    continue;
                }

                let needs_approval = decision == approval::ApprovalDecision::Ask;
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
                    // PRE hook risk reason is prepended so the approval card
                    // explains WHY this write is elevated-risk, not just what it does.
                    let action_desc = if pre.risk_upgrade && !pre.reason.is_empty() {
                        format!("{}\n{}: {}", pre.reason, tc_name, tc_args.chars().take(200).collect::<String>())
                    } else {
                        format!("{}: {}", tc_name, tc_args.chars().take(200).collect::<String>())
                    };
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
        emit_phase(app_handle, AgentPhase::ExecutingTools, user_zh);
        let mut results = futures_util::future::join_all(tool_futures).await;

        // ── Retry Grace ─────────────────────────────────────────────
        // A transient failure (network blip, timeout, lock contention) is not
        // yet a terminal failure. Wait a short grace window, then retry the
        // affected tools once. Deterministic failures (not-found, bad-args)
        // are never retried — see `is_transient_tool_error`. Cancelled turns
        // skip retry entirely.
        if !is_agent_cancelled() {
            let retry_idx: Vec<usize> = results
                .iter()
                .enumerate()
                .filter(|(_, (_, name, content, _))| {
                    // Never retry the inline control-plane tool or approval outcomes.
                    name != "todo_write" && is_transient_tool_error(content)
                })
                .map(|(i, _)| i)
                .collect();

            if !retry_idx.is_empty() {
                emit_phase(app_handle, AgentPhase::Retrying, user_zh);
                tokio::time::sleep(std::time::Duration::from_millis(RETRY_GRACE_MS)).await;
                for &i in &retry_idx {
                    if is_agent_cancelled() {
                        break;
                    }
                    let (tc_id, tc_name, prev_content, prev_ms) = results[i].clone();
                    // Recover original args from this iteration's call data.
                    let args = tool_calls_data
                        .iter()
                        .find(|(id, _, _)| id == &tc_id)
                        .map(|(_, _, a)| a.clone())
                        .unwrap_or_default();

                    crate::chat_file_log::log_agent(&format!(
                        "retry_grace: retrying transient failure for '{}' after {}ms",
                        tc_name, RETRY_GRACE_MS
                    ));
                    emit_agent_event(app_handle, AgentEvent::ToolProgress {
                        tool_call_id: tc_id.clone(),
                        stage: if user_zh { "网络波动，正在重试…".to_string() } else { "Transient error — retrying…".to_string() },
                        preview: None,
                    });

                    let start = std::time::Instant::now();
                    let res = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        tool_executor(&tc_name, &args),
                    ).await;
                    let retry_ms = prev_ms.saturating_add(start.elapsed().as_millis() as u64);
                    let new_content = match res {
                        Ok(Ok(v)) => v,
                        Ok(Err(e)) => format!("Error: {} (after retry)", e),
                        Err(_) => format!("Error: Tool '{}' timed out after 30 seconds (after retry).", tc_name),
                    };
                    // Keep the retry result only if it's no longer a transient error;
                    // otherwise preserve the original message (avoids churn without gain).
                    if !is_transient_tool_error(&new_content) {
                        results[i] = (tc_id, tc_name, new_content, retry_ms);
                    } else {
                        let _ = prev_content;
                    }
                }
            }
        }

        // 4. Update message history with parallel tool outputs
        for (tc_id, tc_name, content, duration_ms) in results {
            // ── POST hook stage ─────────────────────────────────────
            // Runs *before* the ToolResult event so the frontend, logs, and
            // context history all see the redacted / compressed view. The
            // original raw content only exists inside the executor future.
            let post = tool_hooks::run_post_hooks(&tc_name, &content);
            let after_hook = post.replace_content.clone().unwrap_or(content);
            if post.redactions > 0 {
                emit_agent_event(app_handle, AgentEvent::ToolRedacted {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    redactions: post.redactions,
                });
            }

            emit_agent_event(app_handle, AgentEvent::ToolResult {
                    tool_call_id: tc_id.clone(),
                    name: tc_name.clone(),
                    content: after_hook.clone(),
                    duration_ms,
                },);

            let max_tool_result_chars = 25000;
            let summarize_threshold = 3000;
            let mut sanitized_content: String = after_hook.chars()
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

            // ── Empty-result streak ─────────────────────────────────
            // Before: a tool that returned `[]` looked like a success here, so
            // it reset `consecutive_errors` and the turn kept searching until
            // the tool budget or `max_total_tool_calls` cut it off — silently.
            // Now: an empty result advances its own streak, which trips the
            // change-approach nudge below. The error path is untouched; errors
            // are never counted as empty (see `is_empty_tool_result`).
            consecutive_empty_results = track_empty_result(consecutive_empty_results, &final_content);

            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: final_content.clone(),
                tool_calls: None,
                tool_call_id: Some(tc_id.clone()),
            });

            if is_error {
                crate::chat_file_log::log_agent(&format!("tool_returned_error: Tool '{}' returned error: {}", tc_name, final_content.chars().take(200).collect::<String>()));
            }
        }

        // All this iteration's tool calls now have a matching ToolResult — clear the
        // pending tracker so early exits in subsequent iterations don't double-flush.
        pending_tool_results.clear();

        // ── Stagnation nudge: tools work, but find nothing ───────────
        // Salvaged from the old `agent_recovery` module, with three constraints
        // the original did not have:
        //
        // 1. Bounded — at most `MAX_STAGNATION_NUDGES` per turn, and the streak
        //    resets after each one, so this can never become its own loop.
        // 2. Visible — a Thinking event tells the user why the agent changed
        //    course instead of silently rewriting its own context.
        // 3. Cache-safe — appended at the *tail*. The old design injected into
        //    the system prompt, which would invalidate the provider's
        //    prompt-cache prefix on every fire (the same trap the compression
        //    gate above was reworked to avoid).
        //
        // Guidance only: nothing here re-executes a tool, so a write that was
        // denied or rejected still has to pass `approval::decide_ambient` again
        // on the next model turn. The nudge cannot route around the gate.
        if should_nudge_stagnation(consecutive_empty_results, stagnation_nudges) {
            stagnation_nudges += 1;
            crate::chat_file_log::log_agent(&format!(
                "stagnation_nudge: {} consecutive empty tool results — injecting change-approach guidance ({}/{})",
                consecutive_empty_results, stagnation_nudges, MAX_STAGNATION_NUDGES
            ));
            emit_agent_event(app_handle, AgentEvent::Thinking {
                message: plan_guard::stagnation_thinking_ui(user_zh),
            });
            // "user" role rather than "system": mid-conversation system messages
            // are not portable across the three adapters, and this matches how
            // `tool_limit_nudge` is already delivered above.
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: plan_guard::stagnation_system(user_zh),
                ..Default::default()
            });
            // Clear the streak so the same stall does not re-fire on the very
            // next iteration, before the model has had a chance to react.
            consecutive_empty_results = 0;
        }

        // ── Error escalation: stop after 3 consecutive errors ──
        if consecutive_errors >= 3 {
            crate::chat_file_log::log_agent(&format!(
                "error_escalation: {} consecutive tool errors — stopping", consecutive_errors));
            emit_agent_event(app_handle, AgentEvent::Thinking {
                message: plan_guard::recovery_escalate_thinking(user_zh),
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

// ── Tests ──────────────────────────────────────────────────────────
// These cover the loop's *live* recovery path. It had no coverage before:
// the only tests that existed were in `agent_recovery`, a module with zero
// call sites, so they asserted the behaviour of code that never ran.

#[cfg(test)]
mod tests {
    use super::*;

    // ── Retry-grace classifier ─────────────────────────────────────

    #[test]
    fn transient_network_shapes_are_worth_one_retry() {
        for c in [
            "Error: error sending request for url",
            "Error: connection reset by peer",
            "Error: database is locked",
            "Error: 503 Service Unavailable",
            "error: Tool 'fetch_web_content' timed out after 30 seconds.",
        ] {
            assert!(is_transient_tool_error(c), "should retry: {c}");
        }
    }

    #[test]
    fn deterministic_failures_are_never_retried() {
        for c in [
            "Error: note not found",
            "Error: invalid argument 'path'",
            "Error: unknown tool",
            "Error: User rejected this edit.",
            "Error: invalid json in arguments",
        ] {
            assert!(!is_transient_tool_error(c), "should not retry: {c}");
        }
    }

    #[test]
    fn a_permanent_marker_wins_over_a_transient_one() {
        // Both vocabularies present: the deterministic cause decides, otherwise
        // we would burn a round-trip re-fetching a note that does not exist.
        assert!(!is_transient_tool_error(
            "Error: note not found (connection reset while probing)"
        ));
    }

    // ── Empty-result stagnation ─────────────────────────────────────

    #[test]
    fn json_fence_is_stripped_before_emptiness_check() {
        // The result loop wraps JSON in a ```json fence; the raw "[]" the old
        // detector looked for never actually arrives.
        assert_eq!(strip_json_fence("```json\n[]\n```"), "[]");
        assert_eq!(strip_json_fence("```\n{}\n```"), "{}");
        assert_eq!(strip_json_fence("plain text"), "plain text");
    }

    #[test]
    fn empty_shapes_are_detected_through_the_fence() {
        assert!(is_empty_tool_result("```json\n[]\n```"));
        assert!(is_empty_tool_result("[]"));
        assert!(is_empty_tool_result("{}"));
        assert!(is_empty_tool_result("null"));
        assert!(is_empty_tool_result(""));
        // Wrapper shape from web_search when nothing matched.
        assert!(is_empty_tool_result(
            r#"{"results": [], "message": "No results found. Try different keywords."}"#
        ));
    }

    #[test]
    fn non_empty_and_error_results_do_not_count_as_empty() {
        // Real content.
        assert!(!is_empty_tool_result(r#"{"results": [{"id": 1}]}"#));
        assert!(!is_empty_tool_result("```json\n[\n  {\n    \"id\": 1\n  }\n]\n```"));
        // A successful read that merely has no tags must not look empty.
        assert!(!is_empty_tool_result(r#"{"title": "n", "tags": []}"#));
        // Errors belong to the escalation path, never the empty streak.
        assert!(!is_empty_tool_result("Error: something broke"));
        assert!(!is_empty_tool_result("Error: []"));
    }

    #[test]
    fn empty_streak_advances_and_resets() {
        let mut streak = 0u32;
        streak = track_empty_result(streak, "[]");
        streak = track_empty_result(streak, "```json\n[]\n```");
        assert_eq!(streak, 2);
        // A non-empty result breaks the streak.
        streak = track_empty_result(streak, r#"{"results":[{"id":1}]}"#);
        assert_eq!(streak, 0);
    }

    #[test]
    fn stagnation_nudge_is_bounded() {
        // Fires only at/after the threshold.
        assert!(!should_nudge_stagnation(EMPTY_RESULT_STAGNATION_THRESHOLD - 1, 0));
        assert!(should_nudge_stagnation(EMPTY_RESULT_STAGNATION_THRESHOLD, 0));
        // Never exceeds the per-turn cap, no matter how long the stall runs.
        assert!(!should_nudge_stagnation(99, MAX_STAGNATION_NUDGES));
    }

    #[test]
    fn cjk_tool_results_are_handled_without_panicking() {
        // This repo has shipped several CJK-triggered panics from byte slicing.
        // The emptiness check must be slice-free and must not misread CJK prose.
        assert!(!is_empty_tool_result("这是一条中文笔记内容，不应被判定为空。"));
        assert!(!is_empty_tool_result("```json\n{\n  \"results\": [\n    \"机器学习\"\n  ]\n}\n```"));
        assert!(is_empty_tool_result("```json\n{\n  \"results\": [],\n  \"message\": \"未找到结果\"\n}\n```"));
    }

    #[test]
    fn stagnation_guidance_is_localized_and_non_empty() {
        // The nudge reuses the prompt text already in plan_guard rather than
        // reintroducing a second copy of it.
        let zh = plan_guard::stagnation_system(true);
        let en = plan_guard::stagnation_system(false);
        assert!(!zh.trim().is_empty() && !en.trim().is_empty());
        assert_ne!(zh, en);
        assert!(!plan_guard::stagnation_thinking_ui(true).trim().is_empty());
    }

    // ── Turn budgets ────────────────────────────────────────────────

    #[test]
    fn iteration_cap_is_enforced_and_not_off_by_one() {
        // `iteration` is 1-based and already incremented for the round about to
        // run, so the Nth round must still be allowed with max = N.
        assert_eq!(exhausted_budget(1, 1, 0, 100), None);
        assert_eq!(exhausted_budget(2, 1, 0, 100), Some(TurnLimit::Iterations));
        assert_eq!(exhausted_budget(50, 50, 0, 200), None);
        assert_eq!(exhausted_budget(51, 50, 0, 200), Some(TurnLimit::Iterations));
    }

    #[test]
    fn tool_call_cap_still_applies_independently() {
        // Round-trips fine, spend exhausted: the cost net must still fire, which
        // is why wiring max_iterations did not replace it.
        assert_eq!(exhausted_budget(3, 50, 200, 200), Some(TurnLimit::ToolCalls));
        assert_eq!(exhausted_budget(3, 50, 199, 200), None);
    }

    #[test]
    fn iterations_are_reported_first_when_both_are_exhausted() {
        // Deterministic message rather than "whichever check ran first".
        assert_eq!(exhausted_budget(99, 10, 500, 200), Some(TurnLimit::Iterations));
    }

    #[test]
    fn iteration_limit_copy_is_bilingual_and_distinct_from_the_tool_cap_copy() {
        let zh = plan_guard::iteration_limit_thinking(true, 50);
        let en = plan_guard::iteration_limit_thinking(false, 50);
        assert!(zh.contains("50") && en.contains("50"));
        assert_ne!(zh, en);
        // Telling the user "tool call limit" when they hit the round-trip limit
        // makes a working cap look like a bug.
        assert_ne!(zh, plan_guard::tool_limit_thinking(true, 50));
        assert!(!plan_guard::iteration_limit_nudge(true).trim().is_empty());
        assert_ne!(
            plan_guard::iteration_limit_nudge(true),
            plan_guard::iteration_limit_nudge(false)
        );
    }

    // ── Provider HTTP retry ─────────────────────────────────────────
    // Decision logic only — deliberately no network. The retry executor's
    // interesting behaviour (what to retry, how long to wait) lives in pure
    // functions precisely so it can be tested without a live provider.

    #[test]
    fn server_side_and_rate_limit_statuses_are_retried() {
        for s in [408, 425, 429, 500, 502, 503, 504, 529] {
            assert!(should_retry_http_status(s), "should retry: {s}");
        }
    }

    #[test]
    fn client_errors_are_never_retried() {
        // 401/403/400 are configuration mistakes: retrying burns quota and
        // prints the same error three times.
        for s in [400, 401, 402, 403, 404, 405, 409, 413, 422] {
            assert!(!should_retry_http_status(s), "should not retry: {s}");
        }
        // Success codes are not the retry path's business either.
        assert!(!should_retry_http_status(200));
        assert!(!should_retry_http_status(304));
    }

    #[test]
    fn transient_transport_failures_are_retried() {
        for e in [
            "error sending request for url (https://api.example.com/v1/chat)",
            "operation timed out",
            "connection reset by peer",
            "tcp connect error: Connection refused (os error 111)",
            "No connection could be made because the target machine actively refused it. (os error 10061)",
            "dns error: failed to lookup address information",
        ] {
            assert!(should_retry_transport_error(e), "should retry: {e}");
        }
    }

    #[test]
    fn non_transport_failures_are_not_retried() {
        for e in [
            "invalid api key",
            "builder error: relative URL without a base",
            "error decoding response body",
        ] {
            assert!(!should_retry_transport_error(e), "should not retry: {e}");
        }
    }

    #[test]
    fn backoff_increases_and_is_capped() {
        let d1 = backoff_base_delay(1);
        let d2 = backoff_base_delay(2);
        let d3 = backoff_base_delay(3);
        assert_eq!(d1.as_millis() as u64, LLM_RETRY_BASE_MS);
        assert!(d2 > d1, "backoff must grow: {d1:?} -> {d2:?}");
        assert!(d3 > d2, "backoff must grow: {d2:?} -> {d3:?}");
        // Never unbounded, no matter how the attempt counter is fed.
        assert_eq!(
            backoff_base_delay(30).as_millis() as u64,
            LLM_RETRY_MAX_DELAY_MS
        );
        // No overflow panic on an absurd attempt number.
        assert!(backoff_base_delay(u32::MAX) <= std::time::Duration::from_millis(LLM_RETRY_MAX_DELAY_MS));
    }

    #[test]
    fn jitter_stays_within_a_quarter_of_the_base() {
        let base = std::time::Duration::from_millis(1000);
        assert_eq!(apply_jitter(base, 0.0).as_millis(), 750);
        assert_eq!(apply_jitter(base, 0.5).as_millis(), 1000);
        assert_eq!(apply_jitter(base, 1.0).as_millis(), 1250);
        // Out-of-range factors are clamped, not wrapped into nonsense.
        assert_eq!(apply_jitter(base, -5.0).as_millis(), 750);
        assert_eq!(apply_jitter(base, 5.0).as_millis(), 1250);
        // The real seed always lands inside the same window.
        let j = apply_jitter(base, jitter_seed());
        assert!(j.as_millis() >= 750 && j.as_millis() <= 1250, "{j:?}");
    }

    #[test]
    fn retry_after_is_honoured_but_clamped() {
        assert_eq!(
            parse_retry_after("2"),
            Some(std::time::Duration::from_millis(2000))
        );
        assert_eq!(
            parse_retry_after(" 1.5 "),
            Some(std::time::Duration::from_millis(1500))
        );
        // A provider asking for 5 minutes must not park the turn for 5 minutes.
        assert_eq!(
            parse_retry_after("300"),
            Some(std::time::Duration::from_millis(LLM_RETRY_MAX_DELAY_MS))
        );
        // HTTP-date form is unsupported by design (needs a trusted clock).
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after("-3"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    #[test]
    fn attempt_budget_is_bounded() {
        // A regression guard on the constants themselves: "at most 3 attempts"
        // and "total wait has a ceiling" are the two promises made to the user.
        assert_eq!(LLM_MAX_ATTEMPTS, 3);
        let worst: u64 = (1..LLM_MAX_ATTEMPTS)
            .map(|a| (backoff_base_delay(a).as_millis() as f64 * 1.25) as u64)
            .sum();
        assert!(
            worst <= LLM_RETRY_TOTAL_BUDGET_MS,
            "worst-case backoff {worst}ms must fit the {LLM_RETRY_TOTAL_BUDGET_MS}ms budget",
        );
    }

    #[test]
    fn error_bodies_are_truncated_on_char_boundaries() {
        // UTF-8 rule: byte slicing a CJK provider error is a panic, and provider
        // errors in this project are frequently Chinese.
        let cjk = "错误：模型服务返回了一个很长的中文错误信息".repeat(200);
        let out = truncate_error_body(&cjk, 50);
        assert_eq!(out.chars().count(), 51, "50 chars plus the ellipsis");
        assert!(out.ends_with('…'));
        // Short bodies pass through untouched — no gratuitous ellipsis.
        assert_eq!(truncate_error_body("短", 50), "短");
    }

    #[test]
    fn retry_progress_is_visible_and_counted() {
        // "retrying (2/3)" rather than a spinner that looks frozen.
        let zh = plan_guard::llm_retry_detail(true, 2, 3);
        let en = plan_guard::llm_retry_detail(false, 2, 3);
        assert!(zh.contains("2") && zh.contains("3"));
        assert!(en.contains("2") && en.contains("3"));
        assert_ne!(zh, en);
    }

    #[test]
    fn connection_refused_gets_actionable_local_deployment_guidance() {
        // Many users point this app at a local Ollama / LM Studio. A bare
        // "connection refused" sends them looking for a network fault that does
        // not exist; the real cause is almost always "the server isn't running".
        let msg = format_llm_user_error(
            "error sending request for url: tcp connect error: Connection refused (os error 111)",
        );
        assert!(msg.contains("Ollama"), "{msg}");
        assert!(msg.contains("11434"), "port hint must be present: {msg}");
        // Bilingual, per project convention.
        assert!(msg.contains("连接被拒绝"));
        assert!(msg.contains("connection refused"));
    }

    #[test]
    fn timeout_guidance_mentions_slow_local_model_loads() {
        // A local model's first load can take tens of seconds; "check your
        // network" is the wrong advice for that case.
        let msg = format_llm_user_error("operation timed out");
        assert!(msg.contains("Ollama"), "{msg}");
        assert!(msg.contains("数十秒") || msg.contains("tens of seconds"), "{msg}");
    }

    #[test]
    fn retry_message_language_follows_the_last_user_message() {
        let en = vec![ChatMessage {
            role: "user".to_string(),
            content: "summarize my notes".to_string(),
            ..Default::default()
        }];
        let zh = vec![ChatMessage {
            role: "user".to_string(),
            content: "帮我整理笔记".to_string(),
            ..Default::default()
        }];
        assert!(!zh_from_messages(&en));
        assert!(zh_from_messages(&zh));
        // No user turn yet (system-only) must not panic; English is the default.
        assert!(!zh_from_messages(&[]));
    }
}
