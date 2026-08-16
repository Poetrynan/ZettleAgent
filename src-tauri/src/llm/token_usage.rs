//! Four-way token accounting.
//!
//! A single "total tokens" number hides the two things you actually need to
//! know: which side of the request is expensive, and whether prompt caching is
//! working. Splitting into four buckets makes both visible:
//!
//! - `input`       — uncached prompt tokens (billed at full input rate)
//! - `output`      — generated tokens (usually the most expensive rate)
//! - `cache_read`  — prompt tokens served from cache (heavily discounted)
//! - `cache_write` — tokens written into the cache (small premium over input)
//!
//! Cache hit rate = `cache_read / (cache_read + input)`. If that stays near
//! zero across a long session, prompt caching is misconfigured — which is
//! invisible when you only track a single total.
//!
//! Provider schemas differ, so `parse_provider_usage` normalizes all three.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Token counts for one request, or accumulated across a turn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl TokenUsage {
    /// Every token the request touched, cached or not.
    pub fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    /// Fraction of prompt tokens served from cache, in `[0, 1]`.
    /// Returns 0.0 when there were no prompt tokens at all.
    pub fn cache_hit_rate(&self) -> f64 {
        let prompt = self.cache_read.saturating_add(self.input);
        if prompt == 0 {
            return 0.0;
        }
        self.cache_read as f64 / prompt as f64
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }

    fn add(&mut self, other: &TokenUsage) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
    }

    /// Field-wise maximum. This is the correct merge for *streaming* usage,
    /// where a provider may report the same counter repeatedly (Gemini's
    /// `usageMetadata` is cumulative) or split fields across separate events
    /// (Anthropic sends `input_tokens` on `message_start` and `output_tokens`
    /// on `message_delta`). Summing would double-count the cumulative case;
    /// taking the max handles both without needing per-provider branches.
    pub fn merge_max(&mut self, other: &TokenUsage) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_read = self.cache_read.max(other.cache_read);
        self.cache_write = self.cache_write.max(other.cache_write);
    }
}

// ── Per-turn accumulator ──────────────────────────────────────────────

fn turn_usage_slot() -> &'static std::sync::Mutex<TokenUsage> {
    static SLOT: OnceLock<std::sync::Mutex<TokenUsage>> = OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(TokenUsage::default()))
}

/// Zero the accumulator. Called from `begin_agent_run`.
pub fn reset_turn_usage() {
    if let Ok(mut g) = turn_usage_slot().lock() {
        *g = TokenUsage::default();
    }
}

/// Fold one request's usage into the running turn total.
pub fn record(usage: &TokenUsage) {
    if usage.is_empty() {
        return;
    }
    if let Ok(mut g) = turn_usage_slot().lock() {
        g.add(usage);
    }
}

/// Snapshot of the running turn total.
pub fn turn_usage() -> TokenUsage {
    turn_usage_slot().lock().map(|g| *g).unwrap_or_default()
}

// ── Provider schema normalization ─────────────────────────────────────

/// Extract token counts from a provider payload, handling all three schemas.
///
/// Accepts either the whole response object or just its usage sub-object, and
/// returns `None` when no recognizable counts are present (so a streaming
/// chunk without usage is cheaply skipped).
///
/// Schemas handled:
/// - **OpenAI-compatible**: `usage.prompt_tokens` / `completion_tokens`,
///   cache in `usage.prompt_tokens_details.cached_tokens`. Note that
///   `prompt_tokens` here is *inclusive* of cached tokens, so cache_read is
///   subtracted back out to keep the buckets disjoint.
/// - **Anthropic**: `usage.input_tokens` / `output_tokens` /
///   `cache_read_input_tokens` / `cache_creation_input_tokens`. Already
///   disjoint — `input_tokens` excludes cached.
/// - **Gemini**: `usageMetadata.promptTokenCount` / `candidatesTokenCount` /
///   `cachedContentTokenCount`.
pub fn parse_provider_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    // Locate the usage object — top level, `usage`, or `usageMetadata`.
    let u = value
        .get("usage")
        .or_else(|| value.get("usageMetadata"))
        .unwrap_or(value);

    let num = |key: &str| -> u64 { u.get(key).and_then(|v| v.as_u64()).unwrap_or(0) };

    // ── Anthropic ──
    let anthropic_in = num("input_tokens");
    let anthropic_out = num("output_tokens");
    let cache_read_a = num("cache_read_input_tokens");
    let cache_write_a = num("cache_creation_input_tokens");
    if anthropic_in > 0 || anthropic_out > 0 || cache_read_a > 0 || cache_write_a > 0 {
        return Some(TokenUsage {
            input: anthropic_in,
            output: anthropic_out,
            cache_read: cache_read_a,
            cache_write: cache_write_a,
        });
    }

    // ── OpenAI-compatible ──
    let prompt = num("prompt_tokens");
    let completion = num("completion_tokens");
    if prompt > 0 || completion > 0 {
        let cached = u
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        // `prompt_tokens` includes cached tokens; keep buckets disjoint.
        return Some(TokenUsage {
            input: prompt.saturating_sub(cached),
            output: completion,
            cache_read: cached,
            cache_write: 0,
        });
    }

    // ── Gemini ──
    let g_prompt = num("promptTokenCount");
    let g_out = num("candidatesTokenCount");
    let g_cached = num("cachedContentTokenCount");
    if g_prompt > 0 || g_out > 0 || g_cached > 0 {
        return Some(TokenUsage {
            input: g_prompt.saturating_sub(g_cached),
            output: g_out,
            cache_read: g_cached,
            cache_write: 0,
        });
    }

    None
}

/// Accumulate usage seen on one streaming chunk into a per-request tally.
///
/// Call this for every parsed SSE chunk; chunks without usage are a cheap
/// no-op. Merge is field-wise max (see [`TokenUsage::merge_max`]) so it is
/// safe to call on every chunk regardless of whether the provider reports
/// cumulative counters or one field per event.
pub fn observe_stream_usage(acc: &mut TokenUsage, chunk: &serde_json::Value) {
    if let Some(u) = parse_provider_usage(chunk) {
        acc.merge_max(&u);
    }
}

/// Fold a completed request's tally into the turn total. No-op when the
/// provider reported nothing (some gateways omit usage entirely).
pub fn record_request(usage: &TokenUsage) {
    if usage.is_empty() {
        return;
    }
    record(usage);
    crate::chat_file_log::log_agent(&format!(
        "token_usage in={} out={} cache_read={} cache_write={}",
        usage.input, usage.output, usage.cache_read, usage.cache_write
    ));
}

/// Parse a provider payload and fold it into the turn total in one step.
/// Returns the parsed delta so callers can log or emit it.
pub fn record_from_provider(value: &serde_json::Value) -> Option<TokenUsage> {
    let usage = parse_provider_usage(value)?;
    record(&usage);
    crate::chat_file_log::log_agent(&format!(
        "token_usage in={} out={} cache_read={} cache_write={}",
        usage.input, usage.output, usage.cache_read, usage.cache_write
    ));
    Some(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_schema_splits_cached_out_of_prompt() {
        let v = json!({
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 250,
                "prompt_tokens_details": { "cached_tokens": 800 }
            }
        });
        let u = parse_provider_usage(&v).unwrap();
        // prompt_tokens is inclusive of cached — buckets must stay disjoint.
        assert_eq!(u.input, 200);
        assert_eq!(u.cache_read, 800);
        assert_eq!(u.output, 250);
        assert_eq!(u.total(), 1250);
    }

    #[test]
    fn anthropic_schema_keeps_all_four_buckets() {
        let v = json!({
            "usage": {
                "input_tokens": 120,
                "output_tokens": 90,
                "cache_read_input_tokens": 4000,
                "cache_creation_input_tokens": 500
            }
        });
        let u = parse_provider_usage(&v).unwrap();
        assert_eq!(u.input, 120);
        assert_eq!(u.output, 90);
        assert_eq!(u.cache_read, 4000);
        assert_eq!(u.cache_write, 500);
    }

    #[test]
    fn gemini_schema_maps_metadata() {
        let v = json!({
            "usageMetadata": {
                "promptTokenCount": 500,
                "candidatesTokenCount": 60,
                "cachedContentTokenCount": 400
            }
        });
        let u = parse_provider_usage(&v).unwrap();
        assert_eq!(u.input, 100);
        assert_eq!(u.cache_read, 400);
        assert_eq!(u.output, 60);
    }

    #[test]
    fn bare_usage_object_is_accepted() {
        let v = json!({ "prompt_tokens": 10, "completion_tokens": 5 });
        let u = parse_provider_usage(&v).unwrap();
        assert_eq!(u.input, 10);
        assert_eq!(u.output, 5);
    }

    #[test]
    fn chunk_without_usage_returns_none() {
        let v = json!({ "choices": [ { "delta": { "content": "hi" } } ] });
        assert!(parse_provider_usage(&v).is_none());
    }

    #[test]
    fn cache_hit_rate_is_share_of_prompt_tokens() {
        let u = TokenUsage { input: 200, output: 50, cache_read: 800, cache_write: 0 };
        assert!((u.cache_hit_rate() - 0.8).abs() < 1e-9);
        // Output tokens must not dilute the rate.
        let u2 = TokenUsage { input: 0, output: 999, cache_read: 0, cache_write: 0 };
        assert_eq!(u2.cache_hit_rate(), 0.0);
    }

    #[test]
    fn accumulator_sums_and_resets() {
        reset_turn_usage();
        record(&TokenUsage { input: 10, output: 1, cache_read: 0, cache_write: 0 });
        record(&TokenUsage { input: 5, output: 2, cache_read: 7, cache_write: 3 });
        let t = turn_usage();
        assert_eq!(t.input, 15);
        assert_eq!(t.output, 3);
        assert_eq!(t.cache_read, 7);
        assert_eq!(t.cache_write, 3);
        reset_turn_usage();
        assert!(turn_usage().is_empty());
    }
}
