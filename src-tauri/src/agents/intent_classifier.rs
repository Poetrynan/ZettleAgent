//! Three-layer hybrid intent classifier.
//!
//! Pipeline: L0 (rules) → L1 (keyword scoring) → L2 (LLM fallback)
//!
//! Cost model:
//! - ~30% of queries hit L0 (greetings, vault stats) → 0 LLM calls
//! - ~50% hit L1 with high confidence → 0 LLM calls
//! - ~20% need LLM fallback → 1 short classification call (~1-5% of main turn cost)

use crate::agents::intent::{
    ClassificationLayer, IntentClassification, TurnIntent,
};
use crate::llm::{chat_completion_with_params, ChatMessage, LlmConfig};

/// Main entry point: classify user query through L0 → L1 → L2 cascade.
///
/// `chat_history` — prior turns (excluding the current user message). When present,
/// social fast paths (chitchat/help/short utterance) are disabled so follow-ups
/// route through L1/L2 with conversation context instead of phrase hardcoding.
pub async fn classify(
    config: &LlmConfig,
    query: &str,
    chat_history: Option<&[ChatMessage]>,
) -> IntentClassification {
    let multi_turn = has_prior_assistant_turns(chat_history);

    // L0: High-confidence rule fast path (zero cost)
    if let Some(result) = classify_l0(query, multi_turn) {
        return result;
    }

    // L1: Structured keyword scoring (<1ms)
    let l1_result = classify_l1(query);

    // L2: LLM fallback when L1 uncertain, or multi-turn with low L1 confidence
    let needs_l2 = l1_result.needs_llm_fallback()
        || (multi_turn && l1_result.confidence < 0.7);

    if needs_l2 {
        match classify_l2(config, query, chat_history).await {
            Ok(llm_result) => return llm_result,
            Err(e) => {
                log::warn!(
                    "[IntentClassifier] L2 LLM classification failed, falling back to L1: {}",
                    e
                );
            }
        }
    }

    l1_result
}

/// Prior assistant content in history → current message may reference it.
pub fn has_prior_assistant_turns(history: Option<&[ChatMessage]>) -> bool {
    history.is_some_and(|msgs| {
        msgs.iter()
            .any(|m| m.role == "assistant" && !m.content.trim().is_empty())
    })
}

// ═══════════════════════════════════════════════════════════════════════
// L0: Rule-Based Fast Path (0ms, zero cost)
// ═══════════════════════════════════════════════════════════════════════

fn classify_l0(query: &str, multi_turn: bool) -> Option<IntentClassification> {
    let q = query.trim().to_lowercase();

    // ── Chitchat: exact greeting match (always, even mid-conversation) ──
    let chitchat_exact = [
        "你好", "您好", "hello", "hi", "hey",
        "早上好", "下午好", "晚上好",
        "good morning", "good afternoon", "good evening",
        "thanks", "thank you", "谢谢", "再见", "bye",
        "ok", "好的", "how are you",
    ];
    if chitchat_exact.iter().any(|g| q == g.trim()) {
        return Some(
            IntentClassification::new(
                TurnIntent::Chitchat,
                1.0,
                ClassificationLayer::L0,
            )
            .with_reasoning("L0: exact greeting match"),
        );
    }

    // ── VaultStats: statistical queries ──
    let stats_patterns = [
        "多少篇", "笔记数量", "库有多大", "多少条", "统计",
        "how many notes", "vault size", "note count", "total notes",
        "how big is", "how many items",
    ];
    if stats_patterns.iter().any(|p| q.contains(p)) {
        let metric = if q.contains("篇") || q.contains("notes") {
            "note_count"
        } else if q.contains("条") || q.contains("items") {
            "item_count"
        } else {
            "general_stats"
        };
        return Some(
            IntentClassification::new(
                TurnIntent::VaultStats,
                0.95,
                ClassificationLayer::L0,
            )
            .with_entities(serde_json::json!({ "metric": metric }))
            .with_reasoning("L0: stats keyword match"),
        );
    }

    // ── Help / banter / emotion: single-turn social fast paths only ──
    if !multi_turn {
        let help_patterns = [
            "你能干什么", "你能做什么", "你有什么功能", "help",
            "what can you do", "capabilities", "what are you",
        ];
        if help_patterns.iter().any(|p| q.contains(p)) {
            return Some(
                IntentClassification::new(
                    TurnIntent::Chitchat,
                    0.95,
                    ClassificationLayer::L0,
                )
                .with_reasoning("L0: help/capability query (single-turn)"),
            );
        }

        if let Some(result) = classify_l0_chitchat_social(&q, query.trim()) {
            return Some(result);
        }
    }

    None
}

/// Banter / provocation / pure emotion — single-turn only, no phrase lists for task follow-ups.
fn classify_l0_chitchat_social(q_lower: &str, original: &str) -> Option<IntentClassification> {
    let banter_patterns = [
        "傻逼", "弱智", "笨蛋", "去死", "滚蛋", "草泥马", "他妈的", "神经病",
        "你爹", "叫爸爸", "我是你爹", "你是我儿", "傻b", "sb", "nmsl",
        "fuck", "shit", "stupid", "idiot", "dumbass", "moron",
    ];
    if banter_patterns.iter().any(|p| q_lower.contains(p)) {
        return Some(
            IntentClassification::new(
                TurnIntent::Chitchat,
                0.95,
                ClassificationLayer::L0,
            )
            .with_reasoning("L0: banter/provocation"),
        );
    }

    let emotional_patterns = [
        "哈哈", "呵呵", "hhh", "lol", "lmao", "emm", "嗯嗯", "啊啊", "呜呜",
        "好烦", "无聊", "累了", "开心", "难过",
    ];
    let char_count = original.chars().count();
    if char_count <= 24
        && emotional_patterns.iter().any(|p| q_lower.contains(p))
        && !l0_has_task_signal(q_lower)
    {
        return Some(
            IntentClassification::new(
                TurnIntent::Chitchat,
                0.9,
                ClassificationLayer::L0,
            )
            .with_reasoning("L0: emotional utterance (single-turn)"),
        );
    }

    None
}

/// Task keywords — emotional L0 only; vault/task queries fall through to L1/L2.
fn l0_has_task_signal(q: &str) -> bool {
    const TASK_SIGNALS: &[&str] = &[
        "整理", "清理", "合并", "重命名", "移动", "分类", "归档", "删除", "去重",
        "organize", "clean up", "merge", "rename", "archive", "delete", "dedup",
        "写", "创建", "新建", "记录", "起草", "撰写", "编辑",
        "write", "create", "draft", "compose", "new note", "edit note",
        "扫描", "诊断", "盲区", "健康检查", "审计", "孤立",
        "scan", "diagnos", "audit", "health check", "orphan", "lint",
        "分析", "对比", "图谱", "关系", "比较",
        "analyze", "compare", "graph", "relationship", "versus", "vs ",
        "搜索", "查找", "查询", "找一下", "有没有", "有哪些",
        "search", "find", "query", "look for", "where is", "show me",
        "多少篇", "笔记数量", "库有多大", "多少条", "统计",
        "how many notes", "vault size", "note count", "total notes",
        "笔记", "note", "vault", "知识库", "标签", "tag",
        "帮我", "help me", "please",
    ];
    TASK_SIGNALS.iter().any(|s| q.contains(s))
}

// ═══════════════════════════════════════════════════════════════════════
// L1: Structured Keyword Scoring (<1ms)
// ═══════════════════════════════════════════════════════════════════════

fn classify_l1(query: &str) -> IntentClassification {
    let q = query.to_lowercase();

    // Composite detection: sequential action signals
    let composite_signals = [
        "然后", "接着", "之后再", "之后", "and then", "after that", "then ",
    ];
    let has_composite = composite_signals.iter().any(|s| q.contains(s));

    // Score each intent category
    let mut scores: Vec<(TurnIntent, f32)> = Vec::new();

    // ── Curate signals ──
    let curate_keywords = [
        "整理", "清理", "合并", "重命名", "移动", "分类", "归档", "删除", "去重",
        "organize", "clean up", "merge", "rename", "tidy", "archive",
        "delete", "deduplicate", "dedup",
    ];
    let curate_hits = curate_keywords.iter().filter(|k| q.contains(*k)).count();
    if curate_hits > 0 {
        let confidence = 0.6 + (curate_hits as f32 * 0.1).min(0.3);
        scores.push((TurnIntent::Curate, confidence));
    }

    // ── Write signals ──
    let write_keywords = [
        "写", "创建", "新建", "记录", "起草", "撰写", "编辑笔记", "帮我写",
        "write", "create", "draft", "compose", "new note", "save as",
        "edit note", "make a note", "write up",
    ];
    let write_hits = write_keywords.iter().filter(|k| q.contains(*k)).count();
    if write_hits > 0 {
        let confidence = 0.6 + (write_hits as f32 * 0.1).min(0.3);
        scores.push((TurnIntent::Write, confidence));
    }

    // ── Diagnose signals ──
    let diagnose_keywords = [
        "扫描", "诊断", "盲区", "健康检查", "结构", "审计", "孤立", "冗余",
        "scan", "diagnos", "audit", "blind spot", "health check",
        "structural", "orphan", "fragment", "lint",
    ];
    let diagnose_hits = diagnose_keywords.iter().filter(|k| q.contains(*k)).count();
    if diagnose_hits > 0 {
        let confidence = 0.65 + (diagnose_hits as f32 * 0.1).min(0.25);
        scores.push((TurnIntent::Diagnose, confidence));
    }

    // ── Analyze signals ──
    let analyze_keywords = [
        "分析", "对比", "图谱", "关系", "联系", "比较", "区别",
        "analyze", "compare", "graph", "relationship", "difference",
        "versus", "vs ",
    ];
    let analyze_hits = analyze_keywords.iter().filter(|k| q.contains(*k)).count();
    if analyze_hits > 0 {
        let confidence = 0.65 + (analyze_hits as f32 * 0.1).min(0.25);
        scores.push((TurnIntent::Analyze, confidence));
    }

    // ── Search signals ──
    let search_keywords = [
        "搜索", "查找", "查询", "找一下", "有没有", "有哪些", "是什么",
        "search", "find", "query", "look for", "where is", "show me",
    ];
    let search_hits = search_keywords.iter().filter(|k| q.contains(*k)).count();
    if search_hits > 0 {
        let confidence = 0.6 + (search_hits as f32 * 0.1).min(0.3);
        scores.push((TurnIntent::Search, confidence));
    }

    // ── Handle composite ──
    if has_composite && scores.len() >= 2 {
        let top_two: Vec<TurnIntent> = scores
            .iter()
            .take(2)
            .map(|(intent, _)| intent.clone())
            .collect();
        return IntentClassification::new(
            TurnIntent::Composite(top_two),
            0.75,
            ClassificationLayer::L1,
        )
        .with_reasoning("L1: composite signal detected");
    }

    // ── Return highest-scoring intent ──
    if let Some((intent, confidence)) = scores
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
    {
        IntentClassification::new(intent, confidence, ClassificationLayer::L1)
            .with_reasoning("L1: keyword scoring")
    } else {
        IntentClassification::new(
            TurnIntent::Unknown,
            0.0,
            ClassificationLayer::L1,
        )
        .with_reasoning("L1: no keyword match")
    }
}

// ═══════════════════════════════════════════════════════════════════════
// L2: LLM Classification (~200-800ms, only when L0/L1 uncertain)
// ═══════════════════════════════════════════════════════════════════════

fn format_l2_user_payload(query: &str, history: Option<&[ChatMessage]>) -> String {
    const MAX_TURNS: usize = 4;
    const MAX_CHARS: usize = 400;

    let Some(msgs) = history else {
        return query.to_string();
    };

    let tail: Vec<&ChatMessage> = msgs
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .rev()
        .take(MAX_TURNS * 2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    if tail.is_empty() {
        return query.to_string();
    }

    let mut block = String::from("Recent conversation:\n");
    for m in tail {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        let text = trunc_for_l2(&m.content, MAX_CHARS);
        block.push_str(&format!("{role}: {text}\n"));
    }
    block.push_str("\nCurrent user message:\n");
    block.push_str(query);
    block
}

fn trunc_for_l2(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max_chars).collect::<String>())
    }
}

async fn classify_l2(
    config: &LlmConfig,
    query: &str,
    chat_history: Option<&[ChatMessage]>,
) -> anyhow::Result<IntentClassification> {
    let system_prompt = r#"Classify the user request into exactly one intent category.

Categories:
- chitchat: greetings, thanks, small talk, jokes, banter, provocation, pure emotion (only when NO actionable request)
- vault_stats: asking about vault statistics (note count, size, etc.)
- search: searching or finding notes/content
- analyze: analysis, comparison, graph exploration, relationships
- write: creating or editing notes
- curate: organizing, merging, cleaning, deleting, renaming
- diagnose: health checks, scanning for issues, audits
- composite: requires multiple sequential actions (search+write, etc.)

When conversation history is included, use it to resolve follow-ups (pronouns, continuations, questions about prior results). Follow-ups that build on earlier assistant output are NOT chitchat unless purely social.

Respond with JSON only, no other text:
{"intent": "<category>", "confidence": <0.0-1.0>, "entities": {}}"#;

    let user_content = format_l2_user_payload(query, chat_history);

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
            ..Default::default()
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
            ..Default::default()
        },
    ];

    // Short, deterministic classification call
    let response = chat_completion_with_params(
        config,
        &messages,
        0.1,   // Low temperature for deterministic output
        150,   // Max tokens — classification is short
    )
    .await?;

    // Parse JSON response, handling possible markdown code blocks
    let json_str = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    #[derive(serde::Deserialize)]
    struct LlmClassification {
        intent: String,
        confidence: f32,
        #[serde(default)]
        entities: serde_json::Value,
    }

    let parsed: LlmClassification = serde_json::from_str(json_str)?;

    let intent = match parsed.intent.as_str() {
        "chitchat" => TurnIntent::Chitchat,
        "vault_stats" => TurnIntent::VaultStats,
        "search" => TurnIntent::Search,
        "analyze" => TurnIntent::Analyze,
        "write" => TurnIntent::Write,
        "curate" => TurnIntent::Curate,
        "diagnose" => TurnIntent::Diagnose,
        "composite" => TurnIntent::Composite(vec![]), // L2 doesn't decompose further
        _ => TurnIntent::Unknown,
    };

    Ok(
        IntentClassification::new(intent, parsed.confidence, ClassificationLayer::L2)
            .with_entities(parsed.entities)
            .with_reasoning("L2: LLM classification"),
    )
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l0_detects_greeting() {
        let result = classify_l0("你好", false).unwrap();
        assert_eq!(result.intent, TurnIntent::Chitchat);
        assert_eq!(result.confidence, 1.0);
        assert_eq!(result.layer, ClassificationLayer::L0);
    }

    #[test]
    fn l0_detects_vault_stats() {
        let result = classify_l0("多少篇笔记", false).unwrap();
        assert_eq!(result.intent, TurnIntent::VaultStats);
        assert!(result.confidence >= 0.9);
    }

    #[test]
    fn l0_detects_english_stats() {
        let result = classify_l0("how many notes do I have", false).unwrap();
        assert_eq!(result.intent, TurnIntent::VaultStats);
    }

    #[test]
    fn l0_detects_help() {
        let result = classify_l0("你能干什么", false).unwrap();
        assert_eq!(result.intent, TurnIntent::Chitchat);
    }

    #[test]
    fn l0_detects_banter() {
        let result = classify_l0("我是你爹", false).unwrap();
        assert_eq!(result.intent, TurnIntent::Chitchat);
        assert_eq!(result.layer, ClassificationLayer::L0);
    }

    #[test]
    fn l0_detects_insult() {
        let result = classify_l0("你是傻逼吗", false).unwrap();
        assert_eq!(result.intent, TurnIntent::Chitchat);
    }

    #[test]
    fn l0_multi_turn_skips_social_fast_path() {
        assert!(classify_l0("你可以基于以上干嘛", true).is_none());
        assert!(classify_l0("你能干什么", true).is_none());
    }

    #[test]
    fn l0_short_task_falls_through() {
        assert!(classify_l0("整理笔记", false).is_none());
    }

    #[test]
    fn has_prior_assistant_turns_detects_history() {
        use crate::llm::ChatMessage;
        let history = vec![ChatMessage {
            role: "assistant".to_string(),
            content: "库里有 14 篇笔记".to_string(),
            ..Default::default()
        }];
        assert!(has_prior_assistant_turns(Some(&history)));
        assert!(!has_prior_assistant_turns(None));
    }

    #[test]
    fn l0_returns_none_for_ambiguous() {
        assert!(classify_l0("something random", false).is_none());
    }

    #[test]
    fn l1_detects_curate() {
        let result = classify_l1("帮我整理一下笔记");
        assert_eq!(result.intent, TurnIntent::Curate);
        assert!(result.confidence >= 0.6);
    }

    #[test]
    fn l1_detects_write() {
        let result = classify_l1("写一篇关于机器学习的笔记");
        assert_eq!(result.intent, TurnIntent::Write);
    }

    #[test]
    fn l1_detects_diagnose() {
        let result = classify_l1("扫描知识库盲区");
        assert_eq!(result.intent, TurnIntent::Diagnose);
    }

    #[test]
    fn l1_detects_composite() {
        let result = classify_l1("搜索AI笔记然后写一篇总结");
        // Should detect composite (search + write)
        match &result.intent {
            TurnIntent::Composite(intents) => {
                assert!(intents.len() >= 2);
            }
            _ => {
                // If not composite, at least one of the intents should match
                assert!(
                    result.intent == TurnIntent::Search
                        || result.intent == TurnIntent::Write
                );
            }
        }
    }

    #[test]
    fn l1_returns_unknown_for_no_match() {
        let result = classify_l1("xyzabc123");
        assert_eq!(result.intent, TurnIntent::Unknown);
        assert!(result.needs_llm_fallback());
    }

    #[test]
    fn l1_confidence_scoring() {
        let single = classify_l1("整理");
        let multi = classify_l1("整理笔记并清理重复内容");
        assert!(multi.confidence >= single.confidence);
    }
}
