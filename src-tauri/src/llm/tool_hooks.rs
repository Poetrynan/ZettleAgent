//! Tool Hook System — three-stage tool call interception.
//!
//! Inspired by Mybuddy's `tool_hooks.py`, redesigned for knowledge-management
//! workloads in Rust. Every tool call fans through three optional stages:
//!
//! - **PRE**  — inspect args, veto destructive ops, upgrade risk on hub-node
//!              writes, or rewrite args before execution.
//! - **POST** — sanitize output (credential redaction), compress structured
//!              output by tool kind, and shrink long payloads deterministically.
//! - **ABORT**— record terminal state when the user cancels mid-flight.
//!
//! The design is pure/stateless — no locks, no DB — so it composes cleanly
//! with `join_all` parallel tool execution in `mod.rs`.

use std::sync::OnceLock;

use super::ChatMessage;

// ── Stage & Outcome ──────────────────────────────────────────────────

/// The three lifecycle stages a tool call passes through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookStage {
    Pre,
    Post,
    Abort,
}

/// Result of running a hook chain.
///
/// A hook can:
/// - `blocked`: veto the tool call outright (PRE only)
/// - `risk_upgrade`: elevate to hard-confirmation (PRE only)
/// - `replace_args`: rewrite tool arguments before execution (PRE only)
/// - `replace_content`: rewrite tool output before it enters context (POST only)
/// - `redactions`: number of secrets scrubbed (POST only)
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct HookOutcome {
    pub blocked: bool,
    pub risk_upgrade: bool,
    pub reason: String,
    pub replace_args: Option<String>,
    pub replace_content: Option<String>,
    pub redactions: u32,
}

impl HookOutcome {
    fn is_noop(&self) -> bool {
        !self.blocked
            && !self.risk_upgrade
            && self.reason.is_empty()
            && self.replace_args.is_none()
            && self.replace_content.is_none()
            && self.redactions == 0
    }

    /// Fold `other` into `self`. Later hooks in the chain layer on top of earlier ones.
    fn merge(&mut self, other: HookOutcome) {
        if other.blocked {
            self.blocked = true;
        }
        if other.risk_upgrade {
            self.risk_upgrade = true;
        }
        if !other.reason.is_empty() {
            if self.reason.is_empty() {
                self.reason = other.reason;
            } else {
                self.reason.push_str(" · ");
                self.reason.push_str(&other.reason);
            }
        }
        if other.replace_args.is_some() {
            self.replace_args = other.replace_args;
        }
        if other.replace_content.is_some() {
            self.replace_content = other.replace_content;
        }
        self.redactions = self.redactions.saturating_add(other.redactions);
    }
}

// ── Ambient vault path (folded-context memory flush) ───────────────

fn vault_slot() -> &'static std::sync::Mutex<Option<String>> {
    static SLOT: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Register the active vault path for the current agent turn. Called by
/// `agent_chat` right before entering the orchestrator so hooks and the
/// context compressor can flush memories without threading the path
/// through every function.
pub fn set_active_vault_path(path: &str) {
    if let Ok(mut guard) = vault_slot().lock() {
        *guard = if path.is_empty() { None } else { Some(path.to_string()) };
    }
}

/// Retrieve the currently registered vault path, if any.
pub fn active_vault_path() -> Option<String> {
    vault_slot().lock().ok().and_then(|g| g.clone())
}

// ── Ambient AppHandle (for events emitted from non-Tauri code paths) ─

fn app_slot() -> &'static std::sync::Mutex<Option<tauri::AppHandle>> {
    static SLOT: OnceLock<std::sync::Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Register the AppHandle for the active turn so background paths (context
/// compressor, deferred flushers) can emit events without an explicit handle.
pub fn set_active_app_handle(handle: tauri::AppHandle) {
    if let Ok(mut guard) = app_slot().lock() {
        *guard = Some(handle);
    }
}

/// Retrieve a clone of the currently registered AppHandle, if any.
pub fn active_app_handle() -> Option<tauri::AppHandle> {
    app_slot().lock().ok().and_then(|g| g.clone())
}

// ── PRE hooks ─────────────────────────────────────────────────────────

/// Heuristic risk-upgrade for knowledge-graph write operations.
///
/// The existing `approval::is_write_tool` already forces a human confirmation
/// for every write. This hook adds a *reason* that surfaces in the approval
/// card so users see WHY the operation is flagged — batch size, merge
/// divergence, or a rename that would break wikilinks.
pub fn knowledge_write_guard(tool_name: &str, args_json: &str) -> HookOutcome {
    let parsed: serde_json::Value =
        serde_json::from_str(args_json).unwrap_or(serde_json::Value::Null);

    match tool_name {
        "delete_note" => {
            let path = parsed.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() {
                return HookOutcome::default();
            }
            // Flag notes whose file stem hints at hub/index/MOC status.
            let lower = path.to_lowercase();
            let is_hub = lower.contains("index")
                || lower.contains("moc")
                || lower.contains("map-of-content")
                || lower.contains("structure")
                || lower.contains("hub");
            if is_hub {
                return HookOutcome {
                    risk_upgrade: true,
                    reason: format!(
                        "⚠️ Deleting `{}` — path hints at a hub/index/MOC note. Backlinks across the vault will break.",
                        path
                    ),
                    ..Default::default()
                };
            }
            HookOutcome::default()
        }
        "merge_notes" => {
            let source = parsed.get("source_path").and_then(|v| v.as_str()).unwrap_or("");
            let target = parsed.get("target_path").and_then(|v| v.as_str()).unwrap_or("");
            HookOutcome {
                risk_upgrade: true,
                reason: format!(
                    "⚠️ Merging notes rewrites `{}` into `{}` and updates every backlink. This action cannot be auto-reverted.",
                    source, target
                ),
                ..Default::default()
            }
        }
        "batch_link_notes" => {
            let count = parsed
                .get("links")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if count > 5 {
                return HookOutcome {
                    risk_upgrade: true,
                    reason: format!(
                        "⚠️ Batch linking {} pairs — large graph mutation. Review carefully before approving.",
                        count
                    ),
                    ..Default::default()
                };
            }
            HookOutcome::default()
        }
        "rename_note" => {
            let old = parsed.get("old_path").and_then(|v| v.as_str()).unwrap_or("");
            HookOutcome {
                risk_upgrade: true,
                reason: format!(
                    "⚠️ Renaming `{}` will update every wikilink pointing to its title.",
                    old
                ),
                ..Default::default()
            }
        }
        _ => HookOutcome::default(),
    }
}

/// Veto shell-like destructive patterns that should never run through a tool.
///
/// The current tool surface does not expose a raw shell tool, but this guard
/// runs on ALL tools so an accidentally-added shell tool cannot bypass it.
pub fn destructive_command_guard(_tool_name: &str, args_json: &str) -> HookOutcome {
    // Common destructive shell shapes — cheap substring checks (no regex bootstrap cost).
    const PATTERNS: &[&str] = &[
        "rm -rf /",
        "rm -rf ~",
        "rm -rf $HOME",
        "mkfs",
        ":(){ :|:& };:",   // classic fork bomb
        "dd if=/dev/zero",
        "dd if=/dev/random of=/dev/sda",
        "> /dev/sda",
        "chmod -R 777 /",
        "wget http",       // arbitrary code fetch — flag only, not veto
    ];
    let lower = args_json.to_lowercase();
    for pat in PATTERNS.iter().take(9) {
        if lower.contains(pat) {
            return HookOutcome {
                blocked: true,
                reason: format!(
                    "🚫 Destructive command pattern detected (`{}`). Tool call was refused before execution.",
                    pat
                ),
                ..Default::default()
            };
        }
    }
    HookOutcome::default()
}

// ── POST hooks ────────────────────────────────────────────────────────

/// Scan tool output for API keys/tokens/passwords and redact in place.
///
/// This is the last line of defence before the string enters the LLM context
/// window and, from there, a third-party inference endpoint.
pub fn secret_redaction(_tool_name: &str, output: &str) -> HookOutcome {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str, bool)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        // (regex, replacement, is_assignment_capture)
        vec![
            (
                regex::Regex::new(r"sk-ant-[A-Za-z0-9_\-]{16,}").unwrap(),
                "[ANTHROPIC_KEY_REDACTED]",
                false,
            ),
            (
                regex::Regex::new(r"sk-[A-Za-z0-9_\-]{16,}").unwrap(),
                "[API_KEY_REDACTED]",
                false,
            ),
            (
                regex::Regex::new(r"gh[pousr]_[A-Za-z0-9]{16,}").unwrap(),
                "[GITHUB_TOKEN_REDACTED]",
                false,
            ),
            (
                regex::Regex::new(r"xox[baprs]-[A-Za-z0-9\-]{10,}").unwrap(),
                "[SLACK_TOKEN_REDACTED]",
                false,
            ),
            (
                regex::Regex::new(r"AKIA[0-9A-Z]{16}").unwrap(),
                "[AWS_KEY_REDACTED]",
                false,
            ),
            (
                regex::Regex::new(
                    r#"(?i)(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{8,})"#,
                )
                .unwrap(),
                "$1=[REDACTED]",
                true,
            ),
        ]
    });

    let mut cleaned = output.to_string();
    let mut total: u32 = 0;
    for (re, replacement, _is_assign) in patterns {
        let count = re.find_iter(&cleaned).count() as u32;
        if count > 0 {
            cleaned = re.replace_all(&cleaned, *replacement).to_string();
            total = total.saturating_add(count);
        }
    }

    if total > 0 {
        HookOutcome {
            replace_content: Some(cleaned),
            redactions: total,
            reason: format!("Redacted {} secret-shaped value(s) from tool output.", total),
            ..Default::default()
        }
    } else {
        HookOutcome::default()
    }
}

/// Tool-kind-aware output compression. Runs *before* the generic length-based
/// truncation in `mod.rs` so structured knowledge outputs get purpose-built
/// representations instead of head/tail cuts.
pub fn structured_output_compression(tool_name: &str, output: &str) -> HookOutcome {
    let len = output.chars().count();
    match tool_name {
        "read_note" | "batch_read_notes" if len > 3000 => HookOutcome {
            replace_content: Some(compress_note_output(output)),
            ..Default::default()
        },
        "search_notes" | "find_similar_notes" | "search_by_tag" if len > 2000 => HookOutcome {
            replace_content: Some(compress_search_output(output)),
            ..Default::default()
        },
        "get_graph" | "get_local_graph" | "get_vault_stats" if len > 4000 => HookOutcome {
            replace_content: Some(compress_graph_output(output)),
            ..Default::default()
        },
        _ => HookOutcome::default(),
    }
}

/// Note-body compression: keep the frontmatter and heading skeleton intact,
/// truncate prose after ~800 chars.
fn compress_note_output(content: &str) -> String {
    let mut result = String::with_capacity(1500);
    let mut in_frontmatter = false;
    let mut body_chars: usize = 0;
    const BODY_LIMIT: usize = 800;

    for (i, line) in content.lines().enumerate() {
        if line.trim() == "---" {
            in_frontmatter = !in_frontmatter;
            result.push_str(line);
            result.push('\n');
            // A leading "---" on line 0 means frontmatter opens; toggle already correct.
            let _ = i;
            continue;
        }
        if in_frontmatter || line.starts_with('#') {
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if body_chars >= BODY_LIMIT {
            result.push_str("\n... [note body truncated — call `read_note` on the full path to retrieve it] ...\n");
            break;
        }
        // A single very long line must still be clamped, otherwise a
        // one-paragraph note would sail past BODY_LIMIT untouched.
        let remaining = BODY_LIMIT.saturating_sub(body_chars);
        let line_len = line.chars().count();
        if line_len > remaining {
            let clamped: String = line.chars().take(remaining).collect();
            result.push_str(&clamped);
            result.push_str("\n... [note body truncated — call `read_note` on the full path to retrieve it] ...\n");
            break;
        }
        result.push_str(line);
        result.push('\n');
        body_chars = body_chars.saturating_add(line_len);
    }
    result
}

/// Search-result compression: JSON-aware Top-5 keep with total count.
fn compress_search_output(content: &str) -> String {
    // Try JSON array
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(arr) = val.as_array() {
            let total = arr.len();
            let top: Vec<&serde_json::Value> = arr.iter().take(5).collect();
            let pretty = serde_json::to_string_pretty(&top).unwrap_or_default();
            if total > 5 {
                return format!(
                    "🔍 {} results total — showing Top-5:\n```json\n{}\n```\n... {} more result(s) omitted",
                    total,
                    pretty,
                    total - 5
                );
            }
            return format!("```json\n{}\n```", pretty);
        }
    }
    // Fallback: head-truncate
    let head: String = content.chars().take(1200).collect();
    format!("{}\n... [search output truncated]", head)
}

/// Graph-data compression: keep aggregate stats + top nodes.
fn compress_graph_output(content: &str) -> String {
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        let nodes = val
            .get("nodes")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let edges = val
            .get("edges")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let mut top_titles: Vec<String> = Vec::new();
        if let Some(arr) = val.get("nodes").and_then(|v| v.as_array()) {
            for n in arr.iter().take(5) {
                if let Some(title) = n.get("title").and_then(|v| v.as_str()) {
                    top_titles.push(title.to_string());
                }
            }
        }
        let head = format!(
            "📊 Knowledge graph — {} nodes, {} edges.",
            nodes, edges
        );
        if top_titles.is_empty() {
            return head;
        }
        return format!("{}\nTop nodes: {}", head, top_titles.join(", "));
    }
    let head: String = content.chars().take(1500).collect();
    format!("{}\n... [graph output truncated]", head)
}

// ── ABORT hook ────────────────────────────────────────────────────────

/// Record cancellation of an in-flight tool call for diagnostics.
///
/// Kept side-effect-only (logging) so the ABORT stage never mutates state.
pub fn record_abort_state(tool_name: &str, reason: &str) {
    crate::chat_file_log::log_agent(&format!(
        "tool_abort: tool='{}' reason='{}'",
        tool_name, reason
    ));
}

// ── Public entry points ──────────────────────────────────────────────

/// Run all PRE hooks in order and fold their outcomes.
pub fn run_pre_hooks(tool_name: &str, args_json: &str) -> HookOutcome {
    let mut outcome = HookOutcome::default();
    outcome.merge(destructive_command_guard(tool_name, args_json));
    if outcome.blocked {
        return outcome;
    }
    outcome.merge(knowledge_write_guard(tool_name, args_json));
    outcome
}

/// Run all POST hooks in order and fold their outcomes.
///
/// The order matters: redaction runs FIRST so structured compressors see
/// already-scrubbed content and cannot accidentally leak a secret via a
/// preserved frontmatter or JSON value.
pub fn run_post_hooks(tool_name: &str, output: &str) -> HookOutcome {
    let mut outcome = HookOutcome::default();
    let redact = secret_redaction(tool_name, output);
    let after_redact = redact
        .replace_content
        .clone()
        .unwrap_or_else(|| output.to_string());
    outcome.merge(redact);

    let compress = structured_output_compression(tool_name, &after_redact);
    outcome.merge(compress);
    outcome
}

/// Run the ABORT hook.
pub fn run_abort_hook(tool_name: &str, reason: &str) {
    record_abort_state(tool_name, reason);
}

/// Check whether a hook chain produced any observable effect.
#[allow(dead_code)]
pub fn is_noop(outcome: &HookOutcome) -> bool {
    outcome.is_noop()
}

// ── Memory flush before context fold ─────────────────────────────────

/// Section label ← keyword. Sections match the canonical taxonomy defined by
/// `MEMORY_SECTIONS` in `workspace_ops.rs` so flushed items land alongside
/// items extracted by the LLM-based path in `memory_extractor.rs`.
const FLUSH_KEYWORDS: &[(&str, &[&str])] = &[
    ("User Preferences", &["偏好", "喜欢", "prefer", "always use", "习惯用", "更倾向"]),
    ("Workflow Habits", &["习惯", "每天", "每周", "workflow", "routine", "usually i"]),
    ("Important Decisions", &["决定", "选定", "选择", "decided", "we will", "we chose", "conclusion"]),
    ("Vault Context", &["笔记库", "vault", "folder structure", "命名约定", "naming convention"]),
    ("Research Topics", &["发现", "研究表明", "found that", "research shows", "结论是", "关注的方向"]),
];

/// Suffix appended to auto-flushed items so downstream tooling can tell them
/// apart from LLM-extracted or hand-written entries.
const FLUSH_TAG: &str = " ⟪auto·fold⟫";

/// Pick the sentence in `text` that contains one of `keywords` (case-
/// insensitive), returning it trimmed and clamped. Prefer a real sentence over
/// the leading N chars — a partial sentence is misleading in a memory item.
fn extract_sentence_with_keyword(text: &str, keywords: &[&str]) -> Option<String> {
    let lower_text = text.to_lowercase();
    for kw in keywords {
        let lower_kw = kw.to_lowercase();
        if let Some(pos) = lower_text.find(&lower_kw) {
            // Walk back to the previous sentence boundary; forward to the next.
            let start = text[..pos]
                .rfind(|c: char| c == '.' || c == '!' || c == '?' || c == '。' || c == '！' || c == '？' || c == '\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            let after = pos + lower_kw.len();
            let end_rel = text[after..]
                .find(|c: char| c == '.' || c == '!' || c == '?' || c == '。' || c == '！' || c == '？' || c == '\n')
                .map(|i| after + i + 1)
                .unwrap_or(text.len());
            let raw = &text[start..end_rel.min(text.len())];
            let trimmed = raw.trim();
            if trimmed.len() >= 8 {
                let clamped: String = trimmed.chars().take(180).collect();
                return Some(clamped);
            }
        }
    }
    None
}

/// Two items considered duplicates when either contains the other after
/// stripping the auto-fold tag and case-folding. Substring match catches the
/// common case where the LLM path already saved a longer version of the same
/// fact.
fn is_duplicate_of_existing(new_item: &str, existing: &[String]) -> bool {
    let strip = |s: &str| -> String {
        s.trim_end_matches(FLUSH_TAG)
            .trim()
            .to_lowercase()
    };
    let n = strip(new_item);
    if n.is_empty() {
        return true;
    }
    existing.iter().any(|e| {
        let ex = strip(e);
        ex == n || ex.contains(&n) || n.contains(&ex)
    })
}

/// Scan `messages` for high-signal lines (preferences, habits, decisions,
/// vault context, research topics) and merge them into the vault's core
/// `memory.md` BEFORE the surrounding context compressor drops older turns.
///
/// Heuristic-only — no LLM call — so this is safe on the compaction hot path.
/// The primary extraction path lives in `memory_extractor.rs` and runs
/// asynchronously after each conversation; this flush is the safety net that
/// catches facts about to be silently dropped mid-turn.
///
/// Returns the number of new items appended.
pub fn flush_memory_before_fold(messages: &[ChatMessage], vault_path: &str) -> u32 {
    use crate::tools::internal_tools::workspace_ops::{
        parse_structured_memory, serialize_structured_memory, StructuredMemory,
    };

    if vault_path.is_empty() {
        return 0;
    }

    // ── Pass 1: extract candidates from the tail of the conversation ──
    // Only user/assistant text (skip tool envelopes). Scan newest first so a
    // later turn's version of the same fact wins over an earlier draft.
    let mut candidates: Vec<(String, String)> = Vec::new(); // (section, sentence)
    for msg in messages.iter().rev().take(24) {
        if msg.role != "assistant" && msg.role != "user" {
            continue;
        }
        if msg.tool_call_id.is_some() || msg.tool_calls.is_some() {
            continue;
        }
        for (section, keywords) in FLUSH_KEYWORDS.iter() {
            if let Some(sentence) = extract_sentence_with_keyword(&msg.content, keywords) {
                candidates.push(((*section).to_string(), sentence));
                break; // one section per message keeps rebalance intent clear
            }
        }
    }

    if candidates.is_empty() {
        return 0;
    }

    // ── Pass 2: load current memory + write back the new items ────────
    let memory_path = std::path::PathBuf::from(vault_path)
        .join(".zettelagent")
        .join("memory.md");

    let mut mem: StructuredMemory = if memory_path.exists() {
        match std::fs::read_to_string(&memory_path) {
            Ok(raw) => parse_structured_memory(&raw),
            Err(_) => StructuredMemory::default(),
        }
    } else {
        StructuredMemory::default()
    };

    let mut added: u32 = 0;
    // Also track items added in this call to catch intra-batch dupes.
    let mut just_added: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    for (section, sentence) in candidates.into_iter() {
        if !mem.sections.iter().any(|(n, _)| n == &section) {
            mem.sections.push((section.clone(), Vec::new()));
        }
        let items = &mut mem
            .sections
            .iter_mut()
            .find(|(n, _)| n == &section)
            .unwrap()
            .1;

        let empty: Vec<String> = Vec::new();
        let existing_batch = just_added.get(&section).unwrap_or(&empty);
        if is_duplicate_of_existing(&sentence, items)
            || is_duplicate_of_existing(&sentence, existing_batch)
        {
            continue;
        }

        let tagged = format!("{}{}", sentence, FLUSH_TAG);
        items.push(tagged.clone());
        just_added.entry(section).or_default().push(tagged);
        added = added.saturating_add(1);
    }

    if added == 0 {
        return 0;
    }

    mem.last_updated = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
    if let Some(parent) = memory_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&memory_path, serialize_structured_memory(&mem));
    crate::chat_file_log::log_agent(&format!(
        "memory_flush: appended {} item(s) before context fold",
        added
    ));
    added
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_openai_key() {
        let out = secret_redaction("read_note", "here is my key sk-abcdefghij1234567890 ok");
        assert!(out.redactions >= 1);
        assert!(out.replace_content.unwrap().contains("[API_KEY_REDACTED]"));
    }

    #[test]
    fn redacts_assignment_form() {
        let out = secret_redaction("read_note", "password = MySecret1234");
        assert!(out.redactions >= 1);
    }

    #[test]
    fn merge_notes_flags_risk() {
        let out = knowledge_write_guard(
            "merge_notes",
            r#"{"source_path":"a.md","target_path":"b.md"}"#,
        );
        assert!(out.risk_upgrade);
        assert!(!out.reason.is_empty());
    }

    #[test]
    fn destructive_pattern_blocked() {
        let out = destructive_command_guard("run_shell", r#"{"cmd":"rm -rf /"}"#);
        assert!(out.blocked);
    }

    #[test]
    fn note_compression_keeps_headings() {
        let long = format!(
            "---\ntitle: X\n---\n# Heading\n{}",
            "a".repeat(3000)
        );
        let out = structured_output_compression("read_note", &long);
        let replaced = out.replace_content.expect("should compress");
        assert!(replaced.contains("# Heading"));
        assert!(replaced.contains("truncated"));
    }

    #[test]
    fn sentence_extraction_prefers_full_sentence() {
        let text = "Some intro. I always prefer using markdown over LaTeX. And then more.";
        let got = extract_sentence_with_keyword(text, &["prefer"]).expect("found");
        assert!(got.contains("prefer"));
        assert!(!got.contains("Some intro"));
    }

    #[test]
    fn dedup_catches_substring_matches() {
        let existing = vec!["I always prefer markdown over LaTeX ⟪auto·fold⟫".to_string()];
        assert!(is_duplicate_of_existing("I always prefer markdown", &existing));
        assert!(is_duplicate_of_existing("I ALWAYS PREFER MARKDOWN OVER LATEX", &existing));
        assert!(!is_duplicate_of_existing("I chose Postgres for the backend", &existing));
    }
}
