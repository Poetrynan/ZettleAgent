/// Memory Extraction Pipeline
///
/// After each conversation this module asks a light LLM call what is worth
/// remembering, and files each answer as a **proposal** in the knowledge
/// memory layer.
///
/// ## Why proposals and not writes
///
/// An LLM inference is not a user fact. The old version of this file wrote
/// straight into `memory.md` and `ai_memory`: the model's guess became an
/// always-injected "fact" with no `claim_id`, no evidence, no way for the user
/// to see it arrive or to say no. That is exactly the failure mode the memory
/// layer exists to prevent, so extraction now ends at
/// [`crate::knowledge::memory::propose`] and the four confirmation gates in
/// `requires_confirmation` decide what may take effect immediately.
///
/// Projection into `memory.md` and `ai_memory` still happens — but on
/// confirmation, which is where it belongs.

use crate::knowledge::memory::{self, MemoryProposal};
use crate::knowledge::types::{MemoryKind, SourceRef};
use crate::llm::{ChatMessage, LlmConfig};
use crate::tools::internal_tools::workspace_ops::parse_structured_memory;

/// Stamped onto every proposal so a later model change can re-evaluate what
/// this pipeline produced.
const PIPELINE_VERSION: &str = "memory_extractor/2-proposals";

/// A fact the model proposes remembering.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExtractedFact {
    pub section: String,
    pub content: String,
    #[serde(default)]
    pub replaces: Option<String>,
    /// LLM-assigned importance in `[1, 10]`. Scales recall weight.
    #[serde(default = "default_importance")]
    pub importance: u8,
    /// How sure the model is, in `[0, 1]`. Below 0.7 the proposal waits for the
    /// user — see `memory::requires_confirmation`.
    ///
    /// Kept separate from `importance` on purpose: "this matters a lot" and
    /// "I am sure of this" are different claims, and deriving one from the
    /// other would manufacture a confidence signal that nothing measured.
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// True only when the user said in so many words to remember this.
    #[serde(default)]
    pub user_requested: bool,
    /// The verbatim line from the conversation this was drawn from. Without it
    /// the memory has no evidence row and cannot be checked against its source.
    #[serde(default)]
    pub evidence: Option<String>,
    /// Optional time-to-live in days. Transient state ("reading X right now")
    /// should carry a short one. `null`/absent = durable.
    #[serde(default)]
    pub ttl_days: Option<u32>,
}

fn default_importance() -> u8 {
    5
}

/// Absent confidence is *not* treated as certainty: 0.5 sits below the 0.7 bar,
/// so a model that omits the field gets a candidate, not an active memory.
fn default_confidence() -> f64 {
    0.5
}

/// What one extraction run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExtractionOutcome {
    /// Proposals filed (including ones deduplicated onto an existing memory).
    pub proposed: usize,
    /// Of those, how many took effect immediately.
    pub active_now: usize,
    /// Of those, how many are waiting in the user's inbox.
    pub awaiting: usize,
}


/// System prompt for the extraction LLM call
fn extraction_system_prompt() -> String {
    r#"You are a memory extraction agent. Given a conversation between a user and an AI assistant, extract ONLY genuinely important facts that should be remembered across future conversations.

## What to Extract
- User preferences (language, style, methodology, tools they use)
- Workflow habits (daily routines, how they organize notes)
- Important decisions (methodology changes, model choices, feature toggles)
- Vault/project context (vault structure, key folders, naming conventions)
- Research topics (subjects, projects, or areas the user is currently working on or interested in)

## What NOT to Extract
- Conversation-specific details (what notes were searched, specific edits made)
- Trivial information (greetings, acknowledgements)
- Information already present in existing memory (avoid duplicates)
- Technical debugging details

## Output Format
Return a JSON array of objects. Each object has:
- "section": one of "preferences", "habits", "decisions", "vault", "research"
- "content": the fact to remember (concise, single line)
- "evidence": the verbatim line from the conversation this fact comes from. Quote it exactly — do not paraphrase. This is what lets the user check the memory against what was actually said.
- "confidence": number 0.0-1.0. How sure are you this is really true and really worth keeping? Use 0.9+ only when the user stated it outright. Use 0.5 or less when you are inferring it from behaviour.
- "user_requested": true ONLY if the user explicitly asked for this to be remembered ("remember that…", "记住…", "from now on…"). Never true for something you inferred.
- "replaces": (optional) if this fact supersedes an existing memory item, quote the old item's text here
- "importance": integer 1-10. 9-10 = the user explicitly asked to remember it. 7-8 = a stable preference or decision. 4-6 = useful context. 1-3 = marginal (prefer not to emit at all).
- "ttl_days": (optional) integer. Set this ONLY for facts that are true right now but will expire — "currently reading X" (30), "working on Y this sprint" (14). Omit entirely for durable facts like language preference or vault layout.

Be honest about "confidence" and "user_requested". Anything below 0.7 confidence, and anything you inferred rather than were told, goes to the user for approval instead of taking effect — which is the correct outcome, not a failure.

If there is NOTHING worth extracting, return an empty array: []

IMPORTANT: Be very selective. Most conversations produce 0-2 facts worth remembering. Quality over quantity."#.to_string()
}

/// Build the user message for extraction
fn extraction_user_message(messages: &[ChatMessage], existing_memory: &str) -> String {
    // Only include user and assistant messages, skip tool calls/results
    let conversation: String = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .filter(|m| m.tool_calls.is_none() && m.tool_call_id.is_none())
        .map(|m| format!("[{}]: {}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n");

    // Truncate very long conversations to last ~3000 chars.
    // Must count chars (not bytes) — byte slicing panics mid-codepoint on CJK text.
    let conversation = if conversation.chars().count() > 3000 {
        let tail: String = {
            let chars: Vec<char> = conversation.chars().collect();
            chars[chars.len() - 3000..].iter().collect()
        };
        format!("...(truncated)\n{}", tail)
    } else {
        conversation
    };

    format!(
        "## Existing Memory\n{}\n\n## Conversation to Analyze\n{}",
        if existing_memory.is_empty() { "(empty)" } else { existing_memory },
        conversation
    )
}

/// Extract memories from a conversation and file each one as a proposal.
///
/// `db` stays optional so the function is callable without a store, but note
/// what that means now: with no store there is no proposal layer, and this
/// returns zeros rather than falling back to writing `memory.md` directly.
/// That fallback *was* the bug.
///
/// `taint` is the untrusted-content provenance of the turn, captured by the
/// caller **before** spawning this task — `tool_hooks`' taint slot is global and
/// gets cleared when the next run starts, so reading it from here would race.
async fn extract_and_merge(
    config: &LlmConfig,
    messages: &[ChatMessage],
    vault_path: &str,
    db: Option<std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>>,
    run_id: Option<&str>,
    taint: Option<&str>,
) -> anyhow::Result<ExtractionOutcome> {
    // Skip if conversation is too short (< 4 messages)
    let meaningful_messages: Vec<_> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .filter(|m| m.tool_calls.is_none() && m.tool_call_id.is_none())
        .collect();

    if meaningful_messages.len() < 4 {
        return Ok(ExtractionOutcome::default());
    }

    let Some(db) = db else {
        log::warn!("memory extraction skipped: no database, and writing memory.md directly is not an option");
        return Ok(ExtractionOutcome::default());
    };

    // Existing Core Memory is the dedup hint given to the model. It is the
    // confirmed surface on purpose — showing the model unconfirmed candidates
    // would invite it to build on guesses.
    let memory_path = memory::memory_file_path(vault_path);
    let existing_raw = if memory_path.exists() {
        std::fs::read_to_string(&memory_path).unwrap_or_default()
    } else {
        String::new()
    };

    let existing_memory_str = if existing_raw.trim().is_empty() {
        String::new()
    } else {
        let mem = parse_structured_memory(&existing_raw);
        let mut out = String::new();
        for (section, items) in &mem.sections {
            if !items.is_empty() {
                out.push_str(&format!("### {}\n", section));
                for item in items {
                    out.push_str(&format!("- {}\n", item));
                }
            }
        }
        out
    };

    let extraction_messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: extraction_system_prompt(),
            ..Default::default()
        },
        ChatMessage {
            role: "user".to_string(),
            content: extraction_user_message(messages, &existing_memory_str),
            ..Default::default()
        },
    ];

    // Use a lighter config (lower temperature, lower max_tokens)
    let mut extract_config = config.clone();
    extract_config.temperature = 0.1;
    extract_config.max_tokens = Some(700);

    let response = crate::llm::chat_completion(&extract_config, &extraction_messages).await?;
    let facts = parse_extraction_response(&response)?;

    if facts.is_empty() {
        return Ok(ExtractionOutcome::default());
    }

    let conn = db
        .lock()
        .map_err(|e| anyhow::anyhow!("memory store lock poisoned: {e}"))?;

    let mut outcome = ExtractionOutcome::default();
    for fact in &facts {
        // `replaces` names old text, not an id. Resolve it to a real memory or
        // drop the claim: the old code ran DELETE on a substring match, which
        // could silently erase a memory the model never meant to touch.
        let supersedes_id = fact
            .replaces
            .as_deref()
            .and_then(|old| memory::find_supersedable(&conn, old, MEMORY_SCOPE).ok().flatten())
            .map(|item| item.id);

        let proposal = proposal_from(fact, supersedes_id, &config.model, run_id, taint);
        match memory::propose(&conn, proposal) {
            Ok(item) => {
                outcome.proposed += 1;
                if item.requires_user_confirmation {
                    outcome.awaiting += 1;
                } else {
                    outcome.active_now += 1;
                }
            }
            Err(e) => log::warn!("memory proposal rejected by the store: {e}"),
        }
    }

    Ok(outcome)
}

/// Chat-learned memories are not vault-specific, so they share the scope the
/// `memory.md` reconciler uses. Two writers of the same conceptual set must not
/// disagree about where it lives.
const MEMORY_SCOPE: &str = "global";

/// Turn one extracted fact into a proposal.
///
/// Pure, and separate from the LLM call, so every mapping decision below is
/// testable without a model: the kind, the confidence that decides whether the
/// user is asked, and the evidence that makes the memory checkable.
fn proposal_from(
    fact: &ExtractedFact,
    supersedes_id: Option<String>,
    model: &str,
    run_id: Option<&str>,
    taint: Option<&str>,
) -> MemoryProposal {
    let section = resolve_section_name(&fact.section);
    let mut p = MemoryProposal::new(kind_for_section(&section), &fact.content, MEMORY_SCOPE);

    p.section = Some(section);
    p.confidence = fact.confidence.clamp(0.0, 1.0);
    // The store's band is [0.1, 2.0] and 5/10 lands on 1.0 — the same scaling
    // the archival weight used, so recall ranking does not shift under this change.
    p.importance = (fact.importance.clamp(1, 10) as f64) / 5.0;
    p.ttl_days = fact.ttl_days;
    p.supersedes_id = supersedes_id;
    p.user_requested = fact.user_requested;
    // A turn that read a web page or an MCP result may be carrying someone
    // else's "please remember…". Flagging it forces confirmation regardless of
    // how confident the model claims to be.
    p.from_untrusted_source = taint.is_some();
    p.extraction_model = Some(model.to_string());
    p.pipeline_version = Some(PIPELINE_VERSION.to_string());
    p.excerpt = fact.evidence.clone();
    if let Some(run) = run_id {
        // `agent_run`, not `SourceRef::session` — a run id is not a session id,
        // and `project_to_legacy` keys the legacy session column off
        // `chat_session`. Better an empty column than a wrong one.
        p.source = Some(SourceRef {
            source_type: "agent_run".to_string(),
            source_id: run.to_string(),
        });
        p.locator = Some(format!("chat:run/{run}"));
    }
    p
}

/// Which kind of memory a `memory.md` section holds.
///
/// Only "User Preferences" maps to `Profile`, and that is load-bearing:
/// `requires_confirmation` treats profile writes as always needing the user,
/// because a wrong one contaminates every later turn.
fn kind_for_section(section: &str) -> MemoryKind {
    match section {
        "User Preferences" => MemoryKind::Profile,
        "Workflow Habits" => MemoryKind::Procedural,
        _ => MemoryKind::Semantic,
    }
}


/// Parse the LLM extraction response into structured facts
fn parse_extraction_response(response: &str) -> anyhow::Result<Vec<ExtractedFact>> {
    let trimmed = response.trim();

    // Try to extract JSON array from response (may have markdown code fences)
    let json_str = if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            &trimmed[start..=end]
        } else {
            return Ok(Vec::new());
        }
    } else {
        return Ok(Vec::new());
    };

    let facts: Vec<ExtractedFact> = serde_json::from_str(json_str)
        .unwrap_or_default();

    Ok(facts)
}

/// Map section aliases to canonical names (mirrors workspace_ops logic)
fn resolve_section_name(section: &str) -> String {
    match section.to_lowercase().as_str() {
        "preferences" | "prefs" | "user preferences" => "User Preferences".to_string(),
        "habits" | "workflow" | "workflow habits" => "Workflow Habits".to_string(),
        "decisions" | "important decisions" => "Important Decisions".to_string(),
        "vault" | "vault context" | "context" => "Vault Context".to_string(),
        "research" | "research topics" | "topics" => "Research Topics".to_string(),
        other => {
            let mut c = other.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        }
    }
}

// ── Enhanced Memory Extraction ─────────────────────────────────────

/// Check if a message is meaningful for memory extraction
pub fn is_meaningful_message(message: &ChatMessage) -> bool {
    // Skip tool calls and results
    if message.tool_calls.is_some() || message.tool_call_id.is_some() {
        return false;
    }
    
    let content = message.content.trim();
    
    // Skip empty or very short messages
    if content.len() < 20 {
        return false;
    }
    
    // Skip pure greetings
    let greetings = [
        "你好", "hello", "hi", "hey", "好的", "ok", "okay",
        "谢谢", "thanks", "thank you", "不客气", "you're welcome",
    ];
    let content_lower = content.to_lowercase();
    if greetings.iter().any(|g| content_lower.starts_with(g)) && content.len() < 30 {
        return false;
    }
    
    // Skip pure tool result acknowledgments
    if content.starts_with("✓") || content.starts_with("✅") || content.starts_with("[") {
        return false;
    }
    
    true
}

/// Calculate importance score for a message (0-10)
pub fn message_importance(message: &ChatMessage) -> u8 {
    let content = &message.content;
    let mut score: u8 = 5; // Base score
    
    // User messages with preferences get higher score
    if message.role == "user" {
        let preference_keywords = [
            "prefer", "like", "want", "always", "never", "usually",
            "偏好", "喜欢", "想要", "总是", "从不", "通常",
        ];
        if preference_keywords.iter().any(|k| content.to_lowercase().contains(k)) {
            score += 2;
        }
        
        // Explicit memory triggers
        let memory_triggers = [
            "remember", "记住", "以后", "from now on", "always do",
            "save this", "note that", "请注意",
        ];
        if memory_triggers.iter().any(|k| content.to_lowercase().contains(k)) {
            score += 3;
        }
    }
    
    // Assistant conclusions get higher score
    if message.role == "assistant" {
        let conclusion_keywords = [
            "therefore", "结论", "总结", "in summary", "to summarize",
            "decision", "decided", "决定",
        ];
        if conclusion_keywords.iter().any(|k| content.to_lowercase().contains(k)) {
            score += 1;
        }
    }
    
    score.min(10)
}

/// Extraction entry point: gate on conversation substance, then extract.
///
/// The only entry point. The importance gate exists so a session of "ok",
/// "thanks", "do that" never triggers a paid LLM call and never dilutes memory
/// with filler — bypassing it was never something a caller should want.
pub async fn extract_and_merge_enhanced(
    config: &LlmConfig,
    messages: &[ChatMessage],
    vault_path: &str,
    db: Option<std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>>,
    run_id: Option<&str>,
    taint: Option<&str>,
) -> anyhow::Result<ExtractionOutcome> {
    // Filter meaningful messages
    let meaningful_messages: Vec<&ChatMessage> = messages
        .iter()
        .filter(|m| is_meaningful_message(m))
        .collect();

    if meaningful_messages.len() < 4 {
        return Ok(ExtractionOutcome::default());
    }

    // Calculate average importance
    let avg_importance: f64 = meaningful_messages
        .iter()
        .map(|m| message_importance(m) as f64)
        .sum::<f64>() / meaningful_messages.len() as f64;

    // Skip if average importance is too low (most messages are trivial)
    if avg_importance < 4.0 {
        return Ok(ExtractionOutcome::default());
    }

    // Use the original extraction logic with filtered messages
    extract_and_merge(
        config,
        &meaningful_messages.into_iter().cloned().collect::<Vec<_>>(),
        vault_path,
        db,
        run_id,
        taint,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_meaningful_message() {
        let meaningful = ChatMessage {
            role: "user".to_string(),
            content: "I prefer using Zettelkasten methodology for my notes".to_string(),
            ..Default::default()
        };
        assert!(is_meaningful_message(&meaningful));
        
        let trivial = ChatMessage {
            role: "user".to_string(),
            content: "你好".to_string(),
            ..Default::default()
        };
        assert!(!is_meaningful_message(&trivial));
    }

    #[test]
    fn test_message_importance() {
        let preference_msg = ChatMessage {
            role: "user".to_string(),
            content: "I prefer to write notes in Chinese and always tag them".to_string(),
            ..Default::default()
        };
        let score = message_importance(&preference_msg);
        assert!(score >= 7);
    }

    #[test]
    fn test_resolve_section_name() {
        assert_eq!(resolve_section_name("preferences"), "User Preferences");
        assert_eq!(resolve_section_name("habits"), "Workflow Habits");
        assert_eq!(resolve_section_name("unknown"), "Unknown");
    }

    // ── 抽取结果落成提案 / extraction lands as a proposal ────────────────

    fn fact(over: impl FnOnce(&mut ExtractedFact)) -> ExtractedFact {
        let mut f = ExtractedFact {
            section: "preferences".into(),
            content: "用户偏好中文回答".into(),
            replaces: None,
            importance: default_importance(),
            confidence: default_confidence(),
            user_requested: false,
            evidence: None,
            ttl_days: None,
        };
        over(&mut f);
        f
    }

    /// 模型没给置信度时不能当成"很确定" / a missing confidence is not certainty.
    ///
    /// 默认值落在 0.7 这道门之下，所以漏字段的模型得到的是候选，不是生效记忆。
    #[test]
    fn an_omitted_confidence_still_needs_the_user() {
        let parsed: Vec<ExtractedFact> = serde_json::from_str(
            r#"[{"section":"preferences","content":"用户偏好中文回答"}]"#,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);

        let p = proposal_from(&parsed[0], None, "m", None, None);
        assert!(p.confidence < 0.7);
        assert!(memory::requires_confirmation(&p));
    }

    /// 推断出来的偏好一律等用户点头 / an inferred preference always waits.
    ///
    /// 偏好落在 `Profile`，而画像写错会污染之后每一轮，所以这条映射是有承重作用的。
    #[test]
    fn an_inferred_preference_is_filed_as_a_profile_candidate() {
        let p = proposal_from(
            &fact(|f| {
                f.confidence = 0.95;
                f.user_requested = false;
            }),
            None,
            "m",
            None,
            None,
        );
        assert!(matches!(p.kind, MemoryKind::Profile));
        assert_eq!(p.section.as_deref(), Some("User Preferences"));
        assert!(
            memory::requires_confirmation(&p),
            "模型再自信，没被用户说出口的画像也不能自动生效"
        );
    }

    /// 用户明说"记住"才可能直接生效 / only an explicit ask can take effect at once.
    #[test]
    fn an_explicit_ask_can_take_effect_without_the_inbox() {
        let p = proposal_from(
            &fact(|f| {
                f.section = "decisions".into();
                f.content = "以后一律用 Zettelkasten".into();
                f.confidence = 0.95;
                f.user_requested = true;
            }),
            None,
            "m",
            None,
            None,
        );
        assert!(matches!(p.kind, MemoryKind::Semantic));
        assert!(!memory::requires_confirmation(&p));
    }

    /// 这一轮读了外部内容，抽出来的记忆就必须等确认 / taint forces the inbox.
    ///
    /// 网页或 MCP 结果里的一句"请记住…"不是用户说的话。
    #[test]
    fn a_memory_from_a_tainted_turn_never_takes_effect_on_its_own() {
        let p = proposal_from(
            &fact(|f| {
                f.confidence = 1.0;
                f.user_requested = true;
            }),
            None,
            "m",
            None,
            Some("web_search"),
        );
        assert!(p.from_untrusted_source);
        assert!(memory::requires_confirmation(&p));
    }

    /// 证据与出处要跟着记忆走 / provenance travels with the memory.
    #[test]
    fn the_verbatim_quote_and_the_run_become_provenance() {
        let p = proposal_from(
            &fact(|f| f.evidence = Some("我以后都用中文".into())),
            None,
            "qwen-max",
            Some("run-7"),
            None,
        );
        assert_eq!(p.excerpt.as_deref(), Some("我以后都用中文"));
        assert_eq!(p.locator.as_deref(), Some("chat:run/run-7"));
        assert_eq!(p.extraction_model.as_deref(), Some("qwen-max"));
        assert_eq!(p.pipeline_version.as_deref(), Some(PIPELINE_VERSION));
        // run id 不是 session id，别把它写进 session 那一列。
        assert_eq!(p.source.as_ref().unwrap().source_type, "agent_run");
    }

    /// importance 的换算不能改召回排序 / the weight scaling is unchanged.
    ///
    /// 旧路径写 `ai_memory` 时用的是 `importance / 5.0`。换成提案层之后仍然是同一条
    /// 换算，否则这次改动会顺带把所有记忆的召回排序挪一遍。
    #[test]
    fn importance_maps_onto_the_same_weight_band_as_before() {
        assert_eq!(proposal_from(&fact(|f| f.importance = 5), None, "m", None, None).importance, 1.0);
        assert_eq!(proposal_from(&fact(|f| f.importance = 10), None, "m", None, None).importance, 2.0);
        // 越界值被夹住而不是算出一个 0 权重（0 权重等于永远召不回来）。
        assert_eq!(proposal_from(&fact(|f| f.importance = 0), None, "m", None, None).importance, 0.2);
    }

    /// 取代必须指向一条真实记忆 / a supersede must name a real memory.
    #[test]
    fn a_supersede_is_only_recorded_when_the_old_memory_was_found() {
        let without = proposal_from(&fact(|f| f.replaces = Some("旧的偏好".into())), None, "m", None, None);
        assert!(
            without.supersedes_id.is_none(),
            "找不到旧记忆就留空，绝不按文本猜着删"
        );

        let with = proposal_from(
            &fact(|f| f.replaces = Some("旧的偏好".into())),
            Some("mem-old".into()),
            "m",
            None,
            None,
        );
        assert_eq!(with.supersedes_id.as_deref(), Some("mem-old"));
        assert!(
            memory::requires_confirmation(&with),
            "改写用户过去说过的话必须由用户点头"
        );
    }
}
