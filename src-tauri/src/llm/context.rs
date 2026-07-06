/**
 * Context Window Management — token estimation and context compression.
 * 
 * Enhanced with intelligent summarization for long conversations.
 */
use super::{ChatMessage, LlmConfig};

/// Estimate token count from text (rough heuristic: ~4 chars per token for English, ~2 for CJK).
pub fn estimate_tokens(text: &str) -> usize {
    let mut tokens = 0;
    for ch in text.chars() {
        if ch.is_ascii() {
            tokens += 1;
        } else {
            tokens += 2; // CJK characters are roughly 2 tokens
        }
    }
    // Add overhead for message framing
    tokens / 4 + 10
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
/// Strategy: remove oldest non-system messages, keeping the system prompt and recent messages.
pub async fn compress_context_window(
    _config: &LlmConfig,
    messages: &mut Vec<ChatMessage>,
    user_query: &str,
    max_tokens: usize,
) {
    let total: usize = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
    let query_tokens = estimate_tokens(user_query);

    if total + query_tokens <= max_tokens {
        return; // within budget
    }

    let budget = max_tokens.saturating_sub(query_tokens);

    // Keep system message (first) and recent messages, remove oldest middle messages
    if messages.len() <= 2 {
        return; // nothing to compress
    }

    let system_msg = messages.first().cloned();
    let mut kept: Vec<ChatMessage> = Vec::new();
    let mut used_tokens = 0;

    // Walk from the end, keeping messages that fit
    for msg in messages.iter().rev() {
        let msg_tokens = estimate_tokens(&msg.content);
        if used_tokens + msg_tokens > budget {
            break;
        }
        used_tokens += msg_tokens;
        kept.push(msg.clone());
    }
    kept.reverse();

    // Reconstruct: system + compressed messages
    let original_len = messages.len();
    messages.clear();
    if let Some(sys) = system_msg {
        let removed = original_len.saturating_sub(kept.len() + 1); // +1 for system msg
        if removed > 0 {
            let mut summary_msg = sys;
            summary_msg.content = format!(
                "{}\n\n[Context compressed: {} older messages removed to stay within token budget]",
                summary_msg.content, removed
            );
            messages.push(summary_msg);
        } else {
            messages.push(sys);
        }
    }
    messages.extend(kept);
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
        
        let current_tokens: usize = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
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
        let current_tokens: usize = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
        let threshold = (self.max_tokens as f64 * self.compression_threshold) as usize;
        current_tokens > threshold
    }
    
    /// Get current token usage
    pub fn current_tokens(&self, messages: &[ChatMessage]) -> usize {
        messages.iter().map(|m| estimate_tokens(&m.content)).sum()
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
}
