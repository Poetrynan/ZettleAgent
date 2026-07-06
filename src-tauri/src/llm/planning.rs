//! Planning module — agent planning and reasoning strategies.

use super::ToolDef;

/// List of greeting / small-talk prefixes that should never trigger tool calls.
const GREETINGS: &[&str] = &[
    "你好", "您好", "hello", "hi", "hey", "早上好", "下午好", "晚上好",
    "good morning", "good afternoon", "good evening", "how are you",
    "thanks", "thank you", "谢谢", "再见", "bye", "ok", "好的",
];

/// True if the query is pure greeting/small-talk with no actionable request.
/// Used to hard-disable tool access for the turn — regardless of what the
/// model itself decides — so a friendly "你好" can never trigger a random
/// tool call like `get_vault_stats` just because the tool was available.
pub fn is_greeting_or_chitchat(query: &str) -> bool {
    let lower = query.trim().to_lowercase();
    GREETINGS.iter().any(|g| lower == *g || lower.starts_with(*g))
}

/// Classify whether a query is simple (can be answered directly) or complex (needs planning).
/// Returns true for simple queries that skip the planner step.
pub fn classify_query_complexity(query: &str, tools: &[ToolDef]) -> bool {
    let trimmed = query.trim();

    // 问候语和闲聊 —— 不算"简单查询"，走正常规划流程
    // 规划器会生成"直接回复"步骤（实际工具调用已在上层被硬性禁用）
    if is_greeting_or_chitchat(trimmed) {
        return false; // 走规划器 → 生成"直接回复"步骤
    }

    // Simple heuristic: short queries with few tools are likely simple
    let word_count = trimmed.split_whitespace().count();
    let tool_count = tools.len();

    // Very short queries are almost always simple
    if word_count <= 5 {
        return true;
    }

    // If there are very few tools, the query is likely simple
    if tool_count <= 2 {
        return true;
    }

    // Queries that are questions about existing data are simple
    let lower = query.to_lowercase();
    if lower.starts_with("what")
        || lower.starts_with("how many")
        || lower.starts_with("list")
        || lower.starts_with("show")
        || lower.starts_with("find")
        || lower.starts_with("search")
    {
        return true;
    }

    // Complex queries: multi-step, comparative, or analytical
    false
}
