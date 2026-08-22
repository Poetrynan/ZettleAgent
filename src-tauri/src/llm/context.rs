/**
 * Context Window Management — token estimation and context compression.
 * 
 * Enhanced with intelligent summarization for long conversations.
 */
use super::{ChatMessage, LlmConfig, ToolDef};

/// Estimate token count from text (rough heuristic: ~4 chars per token for English/ASCII, ~1.8 tokens per CJK char).
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut tokens: f64 = 0.0;
    for ch in text.chars() {
        if ch.is_ascii() {
            tokens += 0.25;
        } else {
            tokens += 1.8;
        }
    }
    // Add overhead for message framing
    tokens.ceil() as usize + 4
}

// ── Budget accounting ──────────────────────────────────────────────
//
// Every estimator below deliberately errs on the HIGH side. The asymmetry
// matters: under-counting means we ship a request the provider rejects with
// `context_length_exceeded` (the turn dies, the user loses work), while
// over-counting only means we compact slightly earlier than strictly needed.
// So whenever a rounding choice exists, we round up.

/// Fixed per-message overhead: the role tag plus whatever separator tokens the
/// provider wraps around each message. Real values are model-specific (OpenAI's
/// own cookbook uses 3–4); this is an estimate, not an exact figure, and we take
/// the upper bound for the reason described above.
pub const PER_MESSAGE_OVERHEAD_TOKENS: usize = 4;

/// Fraction of the context window at which compaction is allowed to run.
///
/// Why gate at all: compaction rewrites the *front* of the transcript, which
/// invalidates the provider's prompt-cache prefix (see the prefix-stability
/// tests in `prompts.rs`). Running it every iteration therefore costs both CPU
/// and cache hits for no benefit. 0.75 leaves ~25% of the window as headroom
/// for the next tool result plus the model's reply — enough that a single large
/// tool output cannot overshoot the hard limit before the next gate check.
pub const COMPRESSION_TRIGGER_RATIO: f64 = 0.75;

/// Conservative fallback when neither `LlmConfig.context_window` nor the model
/// name tells us the real window. 32k is the smallest window still common among
/// supported providers, so assuming it never over-fills a larger model.
pub const DEFAULT_CONTEXT_WINDOW_TOKENS: usize = 32_000;

/// How many of the most recent tool-calling turns keep their full tool output
/// during MicroCompact. The model almost always only needs the latest results to
/// decide its next action; older ones are recoverable by calling the tool again.
pub const MICRO_COMPACT_KEEP_RECENT_TURNS: usize = 3;

/// Tool results shorter than this are left alone — replacing them with a
/// placeholder would reclaim nothing while still burning cache locality.
const MICRO_COMPACT_MIN_CHARS: usize = 200;

/// Marker prefix for an aged-out tool result. Also used as an idempotency guard
/// so repeated MicroCompact passes do not re-age (and re-shrink) the same
/// message, which would otherwise churn the transcript every gate hit.
const AGED_MARKER: &str = "[aged]";

/// Estimate the tokens a single message contributes to the request body.
///
/// Counts the parts the old accounting silently dropped: the `tool_calls`
/// envelope (name + the arguments JSON, which for edit/write tools is often
/// larger than the visible content) and the `tool_call_id` correlation string.
pub fn estimate_message_tokens(msg: &ChatMessage) -> usize {
    let mut total = estimate_tokens(&msg.content) + PER_MESSAGE_OVERHEAD_TOKENS;
    if let Some(ref calls) = msg.tool_calls {
        for call in calls {
            total += estimate_tokens(&call.id)
                + estimate_tokens(&call.function.name)
                + estimate_tokens(&call.function.arguments);
        }
    }
    if let Some(ref id) = msg.tool_call_id {
        total += estimate_tokens(id);
    }
    total
}

/// Estimate the tokens contributed by the whole message array.
///
/// NOTE: the system message is included here. Its cost is real (and with skill
/// injection it is one of the largest single blocks in the request), so the
/// budget must see it even though compaction is never allowed to touch it.
pub fn estimate_messages_tokens(messages: &[ChatMessage]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Estimate the tokens spent on the tool *schemas* sent with every request.
///
/// This is the block the previous accounting missed entirely: ~60 tool
/// definitions, each with a JSON-Schema parameter object, is a five-figure token
/// constant that is present on *every* call. Serializing the actual struct is
/// the closest cheap proxy for what goes on the wire.
pub fn estimate_tool_schema_tokens(tools: &[ToolDef]) -> usize {
    tools
        .iter()
        .map(|t| match serde_json::to_string(t) {
            Ok(json) => estimate_tokens(&json),
            // Serialization of a ToolDef cannot realistically fail, but if it
            // did, fall back to the parts we can see rather than counting zero.
            Err(_) => estimate_tokens(&t.function.name) + estimate_tokens(&t.function.description),
        })
        .sum()
}

/// Total estimated request size: messages (text + tool_calls + system/skill
/// prompt) plus the tool schema block.
pub fn estimate_request_tokens(messages: &[ChatMessage], tools: &[ToolDef]) -> usize {
    estimate_messages_tokens(messages) + estimate_tool_schema_tokens(tools)
}

/// Token count above which compaction is allowed to run.
pub fn compression_trigger_threshold(max_tokens: usize) -> usize {
    let window = if max_tokens == 0 {
        DEFAULT_CONTEXT_WINDOW_TOKENS
    } else {
        max_tokens
    };
    (window as f64 * COMPRESSION_TRIGGER_RATIO) as usize
}

/// The gate. `true` only when the estimated request actually approaches the
/// window; otherwise the transcript is returned untouched so the cached prefix
/// survives.
///
/// `user_query` is counted as *reply headroom* rather than as content (the query
/// itself is already inside `messages`): reserving roughly its size approximates
/// the answer the model is about to generate on top of the prompt.
pub fn should_compress(
    messages: &[ChatMessage],
    tools: &[ToolDef],
    user_query: &str,
    max_tokens: usize,
) -> bool {
    let used = estimate_request_tokens(messages, tools) + estimate_tokens(user_query);
    used > compression_trigger_threshold(max_tokens)
}

/// Get the maximum context tokens for the given config.
/// Uses the `context_window` field if set, otherwise falls back to model-based heuristics.
pub fn get_max_context_tokens(config: &LlmConfig) -> usize {
    if let Some(window) = config.context_window {
        return window as usize;
    }

    // Heuristic based on model name
    let model_lower = config.model.to_lowercase();
    if model_lower.contains("gpt-4o") || model_lower.contains("claude-3") {
        128_000
    } else if model_lower.contains("gpt-4") || model_lower.contains("claude-2") {
        32_000
    } else if model_lower.contains("gemini") {
        1_000_000
    } else if model_lower.contains("deepseek") {
        64_000
    } else if model_lower.contains("qwen") {
        128_000
    } else {
        32_000 // conservative default
    }
}

/// Compress the context window to fit within the token limit.
///
/// Two-stage, cheapest-first:
///   1. **MicroCompact** — age out older `tool` results in place. Nothing is
///      removed from the transcript, so turn structure and message count stay
///      valid, and only the bulky payloads the model has already acted on go
///      away. This is almost always enough.
///   2. **Full fold** — only if stage 1 still leaves us over the threshold: drop
///      whole older turns (whitelist + turn atomicity preserved).
///
/// The system message is never rewritten by either stage — see the fold notice
/// handling at the bottom of this function.
pub async fn compress_context_window(
    _config: &LlmConfig,
    messages: &mut Vec<ChatMessage>,
    tools: &[ToolDef],
    user_query: &str,
    max_tokens: usize,
) {
    // ── Gate ─────────────────────────────────────────────────────────
    // Previously this function ran on every agent iteration. That burned CPU
    // and, worse, rewrote the head of the transcript, invalidating the
    // provider's prompt-cache prefix on every turn. Now it is a no-op until the
    // estimated request actually approaches the window.
    let threshold = compression_trigger_threshold(max_tokens);
    let schema_tokens = estimate_tool_schema_tokens(tools);
    let reply_reserve = estimate_tokens(user_query); // headroom for the answer
    let fixed = schema_tokens + reply_reserve;

    if estimate_messages_tokens(messages) + fixed <= threshold {
        return; // comfortably within budget — leave the transcript byte-identical
    }

    // ── Stage 1: MicroCompact ────────────────────────────────────────
    let aged = micro_compact_tool_results(messages, MICRO_COMPACT_KEEP_RECENT_TURNS);
    if aged > 0 {
        log::info!("MicroCompact: aged out {} older tool result(s)", aged);
    }
    if estimate_messages_tokens(messages) + fixed <= threshold {
        return; // reclaiming tool payloads was enough; no turns dropped
    }

    // ── Stage 2: full fold ───────────────────────────────────────────
    let budget = threshold.saturating_sub(fixed);

    // ── Memory flush before fold ──────────────────────────────────────
    // Older turns are about to be dropped. Extract high-signal facts
    // (preferences / decisions / findings) into the vault's core memory
    // FIRST so the fold does not silently discard them. Heuristic-only —
    // no extra LLM call, so this is safe to run on every compression.
    if let Some(vault) = super::tool_hooks::active_vault_path() {
        let flushed = super::tool_hooks::flush_memory_before_fold(messages, &vault);
        if flushed > 0 {
            log::info!("Context fold: flushed {} item(s) to core memory", flushed);
            if let Some(app) = super::tool_hooks::active_app_handle() {
                super::emit_agent_event(&app, super::AgentEvent::MemoryFlushed { count: flushed });
            }
        }
    }

    // Keep system message (first) and recent messages, remove oldest middle messages
    if messages.len() <= 2 {
        return; // nothing to compress
    }

    let system_msg = messages.first().cloned();
    let original_len = messages.len();

    // The system prompt is undroppable, so its cost comes out of the budget
    // before the history walk. Floor the remainder: a huge injected system
    // prompt must not starve the walk into dropping the turn currently in
    // flight, which would leave the model with no idea what it was doing.
    let system_tokens = system_msg.as_ref().map(estimate_message_tokens).unwrap_or(0);
    let budget = budget.saturating_sub(system_tokens).max(1_024);

    // ── Build the keep-set (indices into `messages`, excluding system at 0) ──
    // Two rules layered on top of the plain "newest fits first" walk:
    //   1. WHITELIST — protected messages survive regardless of budget.
    //   2. TURN ATOMICITY — an assistant message carrying `tool_calls` and all
    //      of its `tool` replies are kept or dropped together. Splitting them
    //      produces a history that OpenAI/Claude reject ("tool message without
    //      preceding tool_calls"), which is why this needs to be enforced here
    //      rather than left to chance.
    let mut keep: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut used_tokens = 0usize;

    for idx in (1..original_len).rev() {
        let msg = &messages[idx];
        let msg_tokens = estimate_message_tokens(msg);
        if is_protected(msg) {
            // Whitelisted: keep it even if it blows the budget. Losing an image
            // or a cancelled-operation marker silently corrupts the transcript.
            used_tokens = used_tokens.saturating_add(msg_tokens);
            keep.insert(idx);
            continue;
        }
        if used_tokens + msg_tokens > budget {
            continue; // too big — but keep scanning, a later small msg may fit
        }
        used_tokens += msg_tokens;
        keep.insert(idx);
    }

    enforce_turn_atomicity(messages, &mut keep);

    // ── Reconstruct: system + kept messages in original order ──
    let kept: Vec<ChatMessage> = (1..original_len)
        .filter(|i| keep.contains(i))
        .map(|i| messages[i].clone())
        .collect();

    messages.clear();
    if let Some(sys) = system_msg {
        let removed = original_len.saturating_sub(kept.len() + 1); // +1 for system msg
        // The system message goes back VERBATIM. Appending a fold notice to it
        // (which is what this used to do) changes the very first bytes of the
        // request and therefore misses the provider's prompt cache for the rest
        // of the session — the exact failure `prompts.rs` has prefix-stability
        // tests for. The notice instead rides in its own message *after* the
        // static prefix, where it costs a few tokens and nothing else.
        messages.push(sys);
        if removed > 0 {
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "[System note] Context compressed: {} older message(s) removed to stay within the token budget.",
                    removed
                ),
                ..Default::default()
            });
        }
    }
    messages.extend(kept);
}

/// MicroCompact: age out the payloads of older `tool` results in place.
///
/// Rationale: a finished tool result is the cheapest thing in the transcript to
/// give up — the model has already read it and acted on it, and it can re-run
/// the tool if it truly needs the detail again. Doing this *before* the full
/// fold means we usually never have to drop a whole turn, which keeps the
/// user/assistant narrative (and the model's sense of what it was doing) intact.
///
/// Preserved as-is:
/// - the tool results of the most recent `keep_recent_turns` tool-calling turns,
/// - anything on the compaction whitelist (`is_protected`),
/// - short results (aging them reclaims nothing),
/// - already-aged results (idempotent, so repeated gate hits don't churn).
///
/// Returns how many messages were aged.
fn micro_compact_tool_results(messages: &mut [ChatMessage], keep_recent_turns: usize) -> usize {
    // tool_call_id → tool name, so the placeholder can still name the tool.
    let mut call_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // Indices of assistant messages that issued tool calls == turn boundaries.
    let mut turn_starts: Vec<usize> = Vec::new();
    for (idx, msg) in messages.iter().enumerate() {
        if let Some(ref calls) = msg.tool_calls {
            if !calls.is_empty() {
                turn_starts.push(idx);
            }
            for call in calls {
                call_names.insert(call.id.clone(), call.function.name.clone());
            }
        }
    }

    if turn_starts.len() <= keep_recent_turns {
        return 0; // not enough history to have anything "older"
    }
    // Everything before this index belongs to an older turn.
    let boundary = turn_starts[turn_starts.len() - keep_recent_turns];

    let mut aged = 0usize;
    for idx in 0..boundary {
        if messages[idx].role != "tool" {
            continue;
        }
        if is_protected(&messages[idx]) {
            continue;
        }
        if messages[idx].content.starts_with(AGED_MARKER) {
            continue;
        }
        // chars(), never byte slicing — this content is frequently CJK and
        // `&s[..n]` panics mid-codepoint (this repo has been bitten 6 times).
        let char_count = messages[idx].content.chars().count();
        if char_count <= MICRO_COMPACT_MIN_CHARS {
            continue;
        }
        let name = messages[idx]
            .tool_call_id
            .as_ref()
            .and_then(|id| call_names.get(id))
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        messages[idx].content = format!(
            "{} tool `{}` result ({} chars) — 内容已老化回收 / aged out to reclaim context. Re-run the tool if the detail is needed again.",
            AGED_MARKER, name, char_count
        );
        aged += 1;
    }
    aged
}

/// Messages that must never be dropped by compaction.
///
/// Mirrors AutoClaw's compaction whitelist: dropping any of these leaves the
/// transcript actively misleading rather than merely shorter.
fn is_protected(msg: &ChatMessage) -> bool {
    // Images — the model cannot re-fetch them, and a dangling reference is worse
    // than a longer context.
    if msg.content.contains("data:image/")
        || msg.content.contains("![](")
        || msg.content.contains("\"type\":\"image\"")
    {
        return true;
    }
    // Cancelled / interrupted operation markers — needed so the model does not
    // re-attempt an operation the user explicitly stopped.
    let lower = msg.content.to_lowercase();
    if lower.contains("cancelled")
        || lower.contains("user rejected")
        || lower.contains("approval timed out")
        || lower.contains("tool call cancelled")
    {
        return true;
    }
    false
}

/// Ensure no assistant/tool turn is split across the fold boundary.
///
/// Providers require that every `tool` message be preceded by an assistant
/// message whose `tool_calls` contains the matching id, AND that every
/// `tool_call` in a kept assistant message has a matching `tool` reply.
/// Anything that cannot satisfy both is removed as a unit.
fn enforce_turn_atomicity(
    messages: &[ChatMessage],
    keep: &mut std::collections::HashSet<usize>,
) {
    // Map tool_call_id → index of the assistant message that issued it.
    let mut issuer: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    // Map assistant index → indices of its tool replies.
    let mut replies: std::collections::HashMap<usize, Vec<usize>> =
        std::collections::HashMap::new();

    for (idx, msg) in messages.iter().enumerate() {
        if let Some(ref calls) = msg.tool_calls {
            for call in calls {
                issuer.insert(call.id.clone(), idx);
            }
        }
    }
    for (idx, msg) in messages.iter().enumerate() {
        if let Some(ref id) = msg.tool_call_id {
            if let Some(&owner) = issuer.get(id) {
                replies.entry(owner).or_default().push(idx);
            } else {
                // Orphan tool message with no issuer anywhere in history —
                // it can never be valid, so never keep it.
                keep.remove(&idx);
            }
        }
    }

    // Iterate to a fixed point: dropping a group can orphan another.
    loop {
        let mut changed = false;

        // A kept tool reply requires its issuing assistant message.
        for (id, &owner) in issuer.iter().map(|(k, v)| (k, v)).collect::<Vec<_>>() {
            let _ = id;
            let owner_kept = keep.contains(&owner);
            let owned = replies.get(&owner).cloned().unwrap_or_default();
            let any_reply_kept = owned.iter().any(|i| keep.contains(i));

            if any_reply_kept && !owner_kept {
                // Prefer keeping the parent (it is usually short — just the
                // tool_calls envelope) over discarding real tool output.
                keep.insert(owner);
                changed = true;
            }
            if owner_kept && owned.iter().any(|i| !keep.contains(i)) {
                // A partially-answered assistant turn is invalid. Drop the whole
                // group rather than send a malformed history.
                keep.remove(&owner);
                for i in &owned {
                    keep.remove(i);
                }
                changed = true;
            }
        }

        if !changed {
            break;
        }
    }
}

// ── Tool Result Compression ───────────────────────────────────────────

/// Deterministic, non-LLM compression of a tool result destined for the
/// LLM context. The full result is still emitted to the frontend via the
/// `ToolResult` event — this only shrinks the copy that goes back into the
/// message history so the context window stays lean without extra API calls.
///
/// Strategy by shape:
/// - JSON array  → keep first N items + "[+K more items]" note
/// - JSON object → keep keys, truncate long scalar values
/// - other text  → head + tail + total char count
/// - short output → returned unchanged
pub fn compress_tool_result(tool_name: &str, result: &str, threshold: usize) -> String {
    let char_count = result.chars().count();
    if char_count <= threshold {
        return result.to_string();
    }

    // Try to parse as JSON for structured compression.
    let trimmed = result.trim();
    let starts_json = trimmed.starts_with('[') || trimmed.starts_with('{');
    if starts_json {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(result) {
            return compress_json(&val, threshold);
        }
    }

    // Fallback: head + tail with a char-count note. Keep tool name so the
    // model still knows which tool produced the truncated output.
    let head: String = result.chars().take(threshold / 2).collect();
    let tail: String = result.chars().skip(char_count.saturating_sub(threshold / 2)).collect();
    format!(
        "{}\n\n[...truncated, total {} chars — tool `{}` output compressed...]\n\n{}",
        head, char_count, tool_name, tail
    )
}

/// Compress a JSON value deterministically.
fn compress_json(val: &serde_json::Value, threshold: usize) -> String {
    match val {
        serde_json::Value::Array(arr) => {
            let total = arr.len();
            // Keep up to ~5 items or what fits in half the threshold.
            let keep = 5.min(total);
            let kept: Vec<&serde_json::Value> = arr.iter().take(keep).collect();
            let mut out = serde_json::to_string_pretty(&kept).unwrap_or_default();
            if total > keep {
                out.push_str(&format!("\n[+{} more items omitted]", total - keep));
            }
            if out.chars().count() > threshold {
                // Still too long: keep only the count summary.
                format!("Array with {} items (first {} shown; full content omitted to save context).", total, keep)
            } else {
                format!("```json\n{}\n```", out)
            }
        }
        serde_json::Value::Object(obj) => {
            // Keep keys with truncated scalar values; summarize nested.
            let mut lines: Vec<String> = vec!["{".to_string()];
            for (k, v) in obj.iter() {
                let v_repr = match v {
                    serde_json::Value::String(s) => {
                        let s_trim = s.chars().take(200).collect::<String>();
                        if s.chars().count() > 200 {
                            format!("\"{}...\"", s_trim.replace('"', "\\\""))
                        } else {
                            format!("\"{}\"", s_trim.replace('"', "\\\""))
                        }
                    }
                    serde_json::Value::Array(a) => format!("[array of {} items]", a.len()),
                    serde_json::Value::Object(o) => format!("{{object with {} keys}}", o.len()),
                    other => other.to_string(),
                };
                lines.push(format!("  \"{}\": {}", k, v_repr));
            }
            lines.push("}".to_string());
            let out = lines.join("\n");
            if out.chars().count() > threshold {
                let keys: Vec<String> = obj.keys().cloned().collect();
                format!("Object with keys: {} (full content omitted to save context).", keys.join(", "))
            } else {
                format!("```json\n{}\n```", out)
            }
        }
        other => {
            let s = other.to_string();
            let cc = s.chars().count();
            if cc > threshold {
                let head: String = s.chars().take(threshold).collect();
                format!("{}\n[+{} more chars omitted]", head, cc - threshold)
            } else {
                s
            }
        }
    }
}

// ── Enhanced Context Manager ───────────────────────────────────────

/// Context manager with intelligent summarization
pub struct ContextManager {
    max_tokens: usize,
    compression_threshold: f64, // 0.8 = compress at 80% capacity
}

impl ContextManager {
    /// Create a new context manager
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            compression_threshold: 0.8,
        }
    }
    
    /// Create with custom compression threshold
    pub fn with_threshold(max_tokens: usize, threshold: f64) -> Self {
        Self {
            max_tokens,
            compression_threshold: threshold.clamp(0.5, 0.95),
        }
    }
    
    /// Manage context: add message and compress if needed
    pub fn manage_context(&self, messages: &mut Vec<ChatMessage>, new_message: ChatMessage) {
        messages.push(new_message);
        
        let current_tokens: usize = estimate_messages_tokens(messages);
        let threshold = (self.max_tokens as f64 * self.compression_threshold) as usize;
        
        if current_tokens > threshold {
            self.compress_context(messages);
        }
    }
    
    /// Compress context by summarizing middle messages
    fn compress_context(&self, messages: &mut Vec<ChatMessage>) {
        if messages.len() <= 3 {
            return; // Too few to compress
        }
        
        // 1. Always keep System Prompt (first message)
        let system_msg = messages.first().cloned();
        
        // 2. Keep recent N messages (last 5)
        let recent_count = 5.min(messages.len() - 1);
        let recent_messages: Vec<ChatMessage> = messages.iter()
            .rev()
            .take(recent_count)
            .cloned()
            .collect();
        
        // 3. Middle messages to summarize
        let middle_start = 1; // Skip system
        let middle_end = messages.len() - recent_count;
        
        if middle_end <= middle_start {
            return; // No middle messages to compress
        }
        
        let middle_messages: Vec<ChatMessage> = messages.iter()
            .skip(middle_start)
            .take(middle_end - middle_start)
            .cloned()
            .collect();
        
        // 4. Generate summary of middle messages
        let summary = Self::generate_summary(&middle_messages);
        
        // 5. Rebuild message list
        let mut compressed = Vec::new();
        if let Some(sys) = system_msg {
            compressed.push(sys);
        }
        
        // Add summary as system message
        if !summary.is_empty() {
            compressed.push(ChatMessage {
                role: "system".to_string(),
                content: format!("## Previous Conversation Summary\n\n{}", summary),
                ..Default::default()
            });
        }
        
        // Add recent messages (reversed back to order)
        compressed.extend(recent_messages.into_iter().rev());
        
        *messages = compressed;
    }
    
    /// Generate a summary of middle messages
    fn generate_summary(messages: &[ChatMessage]) -> String {
        if messages.is_empty() {
            return String::new();
        }
        
        // Extract key information from messages
        let mut key_points: Vec<String> = Vec::new();
        let mut tool_results: Vec<String> = Vec::new();
        let mut user_intents: Vec<String> = Vec::new();
        
        for msg in messages {
            let content_preview: String = msg.content.chars().take(150).collect::<String>();
            
            match msg.role.as_str() {
                "user" => {
                    user_intents.push(content_preview);
                }
                "assistant" => {
                    // Extract key conclusions (first 100 chars)
                    if !content_preview.trim().is_empty() {
                        key_points.push(content_preview);
                    }
                }
                "tool" | "function" => {
                    // Extract tool result summaries
                    if content_preview.len() > 20 {
                        tool_results.push(content_preview);
                    }
                }
                _ => {}
            }
        }
        
        // Build summary
        let mut summary_parts: Vec<String> = Vec::new();
        
        if !user_intents.is_empty() {
            summary_parts.push(format!(
                "**User requests**: {}",
                user_intents.join("; ")
            ));
        }
        
        if !key_points.is_empty() {
            // Take last 3 key points (most recent)
            let recent_points: Vec<String> = key_points.iter()
                .rev()
                .take(3)
                .cloned()
                .collect();
            let points_str: String = recent_points.into_iter().rev().collect::<Vec<_>>().join("; ");
            summary_parts.push(format!(
                "**Key outcomes**: {}",
                points_str
            ));
        }
        
        if !tool_results.is_empty() {
            summary_parts.push(format!(
                "**Tool results**: {} operations performed",
                tool_results.len()
            ));
        }
        
        summary_parts.join("\n\n")
    }
    
    /// Check if context needs compression
    pub fn needs_compression(&self, messages: &[ChatMessage]) -> bool {
        let current_tokens: usize = estimate_messages_tokens(messages);
        let threshold = (self.max_tokens as f64 * self.compression_threshold) as usize;
        current_tokens > threshold
    }
    
    /// Get current token usage
    pub fn current_tokens(&self, messages: &[ChatMessage]) -> usize {
        // Uses the full per-message estimate (content + tool_calls envelope +
        // role overhead), not just the visible text.
        estimate_messages_tokens(messages)
    }
    
    /// Get usage percentage (0.0 to 1.0)
    pub fn usage_percentage(&self, messages: &[ChatMessage]) -> f64 {
        let current = self.current_tokens(messages) as f64;
        let max = self.max_tokens as f64;
        if max > 0.0 {
            (current / max).min(1.0)
        } else {
            0.0
        }
    }
}

impl Default for ContextManager {
    fn default() -> Self {
        Self::new(32_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_tokens() {
        assert!(estimate_tokens("hello") > 0);
        assert!(estimate_tokens("你好") > estimate_tokens("hi"));
    }

    #[test]
    fn test_context_manager_needs_compression() {
        let manager = ContextManager::new(100);
        
        let messages = vec![
            ChatMessage { role: "system".to_string(), content: "System prompt".to_string(), ..Default::default() },
            ChatMessage { role: "user".to_string(), content: "A".repeat(50), ..Default::default() },
            ChatMessage { role: "assistant".to_string(), content: "B".repeat(50), ..Default::default() },
        ];
        
        // Should need compression if over threshold
        let total_tokens: usize = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
        if total_tokens > 80 { // 80% of 100
            assert!(manager.needs_compression(&messages));
        }
    }

    #[test]
    fn test_context_manager_manage_context() {
        let manager = ContextManager::new(1000);
        let mut messages = vec![
            ChatMessage { role: "system".to_string(), content: "System".to_string(), ..Default::default() },
        ];
        
        manager.manage_context(&mut messages, ChatMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
            ..Default::default()
        });
        
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn test_generate_summary() {
        let messages = vec![
            ChatMessage { role: "user".to_string(), content: "Search for AI notes".to_string(), ..Default::default() },
            ChatMessage { role: "assistant".to_string(), content: "Found 5 notes about AI".to_string(), ..Default::default() },
            ChatMessage { role: "tool".to_string(), content: r#"[{"title": "AI Basics"}]"#.to_string(), ..Default::default() },
        ];
        
        let summary = ContextManager::generate_summary(&messages);
        assert!(summary.contains("User requests") || summary.contains("Key outcomes"));
    }

    // ── Test helpers ─────────────────────────────────────────────────
    use super::super::{ToolCall, ToolCallFunction, ToolDef, ToolFunction};

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.to_string(), content: content.to_string(), ..Default::default() }
    }

    fn assistant_with_call(id: &str, name: &str, args: &str) -> ChatMessage {
        ChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls: Some(vec![ToolCall {
                id: id.to_string(),
                call_type: "function".to_string(),
                function: ToolCallFunction { name: name.to_string(), arguments: args.to_string() },
            }]),
            tool_call_id: None,
        }
    }

    fn tool_reply(id: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: "tool".to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: Some(id.to_string()),
        }
    }

    fn sample_tool(name: &str) -> ToolDef {
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: name.to_string(),
                description: "A sample tool for testing the schema token estimate.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "search query" },
                        "limit": { "type": "integer", "description": "max results" }
                    },
                    "required": ["query"]
                }),
            },
        }
    }

    // ── B: budget accounting includes every component ────────────────

    #[test]
    fn estimate_counts_ascii_cjk_and_mixed() {
        // Not asserting exact values — only that each is counted and CJK is
        // heavier per character than ASCII (matching the estimator's intent).
        let ascii = estimate_tokens("the quick brown fox jumps over the lazy dog");
        let cjk = estimate_tokens("你好世界这是一个测试字符串用来验证分词");
        let mixed = estimate_tokens("hello 你好 world 世界");
        assert!(ascii > 0 && cjk > 0 && mixed > 0);
        // Equal char counts: CJK weighs ~2x ASCII, so it must estimate higher.
        let ascii_20: String = "a".repeat(20);
        let cjk_20: String = "中".repeat(20);
        assert!(estimate_tokens(&cjk_20) > estimate_tokens(&ascii_20));
    }

    #[test]
    fn tool_calls_are_included_in_message_estimate() {
        let plain = msg("assistant", "");
        let with_args = assistant_with_call(
            "call_1",
            "write_note",
            r#"{"path":"a/very/long/note/path.md","content":"a fairly large body of text that would otherwise be invisible to the old accounting which only looked at the content field"}"#,
        );
        // The arguments JSON must push the estimate well above an empty message.
        assert!(
            estimate_message_tokens(&with_args) > estimate_message_tokens(&plain) + 20,
            "tool_calls arguments must be counted"
        );
    }

    #[test]
    fn tool_schema_tokens_grow_with_toolset() {
        let one = vec![sample_tool("search_notes")];
        let many: Vec<ToolDef> = (0..10).map(|i| sample_tool(&format!("tool_{i}"))).collect();
        let one_t = estimate_tool_schema_tokens(&one);
        let many_t = estimate_tool_schema_tokens(&many);
        assert!(one_t > 0);
        assert!(many_t > one_t * 5, "10 schemas should dwarf a single schema");
    }

    #[test]
    fn request_estimate_includes_schema_block() {
        let messages = vec![msg("system", "sys"), msg("user", "hi")];
        let no_tools = estimate_request_tokens(&messages, &[]);
        let tools: Vec<ToolDef> = (0..5).map(|i| sample_tool(&format!("t{i}"))).collect();
        let with_tools = estimate_request_tokens(&messages, &tools);
        assert!(with_tools > no_tools, "schema block must add to the request estimate");
    }

    // ── C: gate behaviour ────────────────────────────────────────────

    /// ChatMessage has no `PartialEq`, so the "byte-identical" assertions below
    /// compare the serialized form — which is also exactly what goes on the wire.
    fn wire(messages: &[ChatMessage]) -> String {
        serde_json::to_string(messages).unwrap()
    }

    #[tokio::test]
    async fn gate_below_threshold_leaves_messages_untouched() {
        let mut messages = vec![
            msg("system", "You are a helpful agent."),
            msg("user", "hello"),
            msg("assistant", "hi there"),
        ];
        let before = wire(&messages);
        // Huge window → nowhere near the gate.
        assert!(!should_compress(&messages, &[], "hello", 128_000));
        // Compression must be a no-op below the gate.
        compress_context_window(&LlmConfig::default(), &mut messages, &[], "hello", 128_000).await;
        assert_eq!(wire(&messages), before, "below threshold must not mutate the transcript");
    }

    #[test]
    fn gate_fires_when_over_threshold() {
        // Small window so a few big messages exceed 75%.
        let big = "词".repeat(4_000); // CJK → heavy
        let messages = vec![
            msg("system", "sys"),
            msg("user", &big),
            msg("assistant", &big),
        ];
        assert!(should_compress(&messages, &[], "q", 2_000));
    }

    #[test]
    fn tool_schemas_alone_can_trip_the_gate() {
        // The regression this guards: a short transcript plus a large toolset was
        // previously scored as "tiny" because schemas were not counted at all.
        let messages = vec![msg("system", "sys"), msg("user", "hi")];
        assert!(!should_compress(&messages, &[], "hi", 8_000));
        let tools: Vec<ToolDef> = (0..300).map(|i| sample_tool(&format!("tool_{i}"))).collect();
        assert!(should_compress(&messages, &tools, "hi", 8_000));
    }

    // ── C: system prefix must never be rewritten ─────────────────────

    #[tokio::test]
    async fn fold_never_rewrites_system_message() {
        let system_text = "STATIC SYSTEM PREFIX — must remain byte-identical for prompt caching.";
        let big = "x".repeat(6_000);
        let mut messages = vec![msg("system", system_text)];
        // Many turns of chatter to force a fold.
        for i in 0..8 {
            messages.push(msg("user", &format!("user turn {i} {big}")));
            messages.push(msg("assistant", &format!("assistant turn {i} {big}")));
        }
        let original_len = messages.len();
        compress_context_window(&LlmConfig::default(), &mut messages, &[], "q", 2_000).await;
        // System stays first and unchanged.
        assert_eq!(messages[0].role, "system");
        assert_eq!(
            messages[0].content, system_text,
            "system prefix was rewritten — that breaks the provider prompt cache"
        );
        // And the fold actually happened.
        assert!(messages.len() < original_len, "expected a fold at this budget");
    }

    // ── D: MicroCompact ──────────────────────────────────────────────

    /// Build a transcript of `turns` tool-calling turns, each with a bulky result.
    fn transcript_with_tool_turns(turns: usize, payload: &str) -> Vec<ChatMessage> {
        let mut messages = vec![msg("system", "sys"), msg("user", "do the thing")];
        for i in 0..turns {
            let id = format!("call_{i}");
            messages.push(assistant_with_call(&id, "search_notes", r#"{"query":"x"}"#));
            messages.push(tool_reply(&id, payload));
        }
        messages
    }

    #[test]
    fn micro_compact_keeps_recent_turns_and_ages_older_ones() {
        let payload = "R".repeat(3_000);
        let mut messages = transcript_with_tool_turns(6, &payload);
        let aged = micro_compact_tool_results(&mut messages, MICRO_COMPACT_KEEP_RECENT_TURNS);
        assert_eq!(aged, 6 - MICRO_COMPACT_KEEP_RECENT_TURNS, "only older turns age out");

        let tool_msgs: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "tool").collect();
        // The most recent N keep their full payload...
        for m in tool_msgs.iter().rev().take(MICRO_COMPACT_KEEP_RECENT_TURNS) {
            assert_eq!(m.content, payload, "recent tool results must stay intact");
        }
        // ...older ones become placeholders that still name the tool.
        for m in tool_msgs.iter().take(6 - MICRO_COMPACT_KEEP_RECENT_TURNS) {
            assert!(m.content.starts_with(AGED_MARKER));
            assert!(m.content.contains("search_notes"));
            assert!(m.content.contains("3000"), "placeholder records the reclaimed size");
        }
    }

    #[test]
    fn micro_compact_is_idempotent() {
        let mut messages = transcript_with_tool_turns(6, &"R".repeat(3_000));
        let first = micro_compact_tool_results(&mut messages, MICRO_COMPACT_KEEP_RECENT_TURNS);
        let snapshot = wire(&messages);
        let second = micro_compact_tool_results(&mut messages, MICRO_COMPACT_KEEP_RECENT_TURNS);
        assert!(first > 0);
        assert_eq!(second, 0, "already-aged results must not be re-aged");
        assert_eq!(wire(&messages), snapshot);
    }

    #[test]
    fn micro_compact_leaves_short_and_protected_results_alone() {
        let mut messages = vec![msg("system", "sys")];
        for i in 0..6 {
            let id = format!("call_{i}");
            messages.push(assistant_with_call(&id, "read_note", r#"{"path":"a.md"}"#));
            let content = if i == 0 {
                "short".to_string() // below MICRO_COMPACT_MIN_CHARS
            } else if i == 1 {
                format!("user rejected the operation {}", "P".repeat(3_000)) // whitelisted
            } else {
                "R".repeat(3_000)
            };
            messages.push(tool_reply(&id, &content));
        }
        micro_compact_tool_results(&mut messages, MICRO_COMPACT_KEEP_RECENT_TURNS);
        let tool_msgs: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "tool").collect();
        assert_eq!(tool_msgs[0].content, "short");
        assert!(tool_msgs[1].content.contains("user rejected"), "whitelist must survive MicroCompact");
    }

    #[tokio::test]
    async fn micro_compact_runs_before_any_turn_is_dropped() {
        // Window sized so that aging the older tool payloads alone gets us back
        // under the gate — the fold must therefore never run and no message may
        // disappear. (6 turns × ~1.1k tokens ≈ 6.5k used vs a 4.9k gate; aging
        // half the tool payloads drops it to ~3.6k.)
        let mut messages = transcript_with_tool_turns(6, &"R".repeat(4_000));
        let original_len = messages.len();
        let user_msg_before = messages[1].content.clone();

        compress_context_window(&LlmConfig::default(), &mut messages, &[], "do the thing", 6_500).await;

        assert_eq!(messages.len(), original_len, "MicroCompact should have sufficed — no turns dropped");
        assert_eq!(messages[1].content, user_msg_before, "user turn preserved");
        let aged_count = messages.iter().filter(|m| m.content.starts_with(AGED_MARKER)).count();
        assert_eq!(aged_count, 6 - MICRO_COMPACT_KEEP_RECENT_TURNS);
    }

    #[tokio::test]
    async fn full_fold_only_after_micro_compact_is_insufficient() {
        // Bulk lives in user/assistant text, which MicroCompact cannot touch, so
        // the second stage has to run.
        let big = "词".repeat(3_000);
        let mut messages = vec![msg("system", "sys")];
        for i in 0..6 {
            messages.push(msg("user", &format!("turn {i} {big}")));
            let id = format!("call_{i}");
            messages.push(assistant_with_call(&id, "search_notes", r#"{"query":"x"}"#));
            messages.push(tool_reply(&id, &"R".repeat(3_000)));
        }
        let original_len = messages.len();
        compress_context_window(&LlmConfig::default(), &mut messages, &[], "q", 2_000).await;
        assert!(messages.len() < original_len, "fold must engage when aging is not enough");
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, "sys");
    }

    // ── E: CJK safety ────────────────────────────────────────────────

    #[tokio::test]
    async fn cjk_heavy_transcript_does_not_panic() {
        // Every truncation path here must use chars(); byte slicing on these
        // strings panics mid-codepoint (this repo has hit that bug repeatedly).
        let cjk = "这是一段很长的中文文本，用于验证任何截断逻辑都不会在字符边界上panic。".repeat(200);
        let mut messages = vec![msg("system", "系统提示：你是一个中文助手。")];
        for i in 0..6 {
            messages.push(msg("user", &format!("第{i}轮：{cjk}")));
            let id = format!("call_{i}");
            messages.push(assistant_with_call(&id, "搜索笔记", r#"{"查询":"中文"}"#));
            messages.push(tool_reply(&id, &cjk));
        }
        compress_context_window(&LlmConfig::default(), &mut messages, &[], &cjk, 3_000).await;
        // Also exercise the tool-result compressor and the summarizer on CJK.
        let _ = compress_tool_result("搜索笔记", &cjk, 100);
        let _ = ContextManager::generate_summary(&messages);
        assert!(!messages.is_empty());
    }
}
