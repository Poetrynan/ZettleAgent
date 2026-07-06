//! Plan / execution coupling — prevents "todo_write only" turns from exiting early.
//!
//! `todo_write` is UI metadata; real work happens via substantive tools (run_lint, etc.).
//! This module enforces that gap at orchestration time.

use super::{context, ChatMessage, PlanStep};
use serde_json::json;

/// Task-type hint for pipeline branching (diagnose → synthesize, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    General,
    DiagnosticReport,
    SearchAnalysis,
    WriteAction,
    CurateAction,
}

pub fn user_prefers_zh(query: &str) -> bool {
    query.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// Pick localized orchestration string (zh when query contains CJK, else en).
#[inline]
pub fn pick_lang(zh: bool, zh_text: &str, en_text: &str) -> String {
    if zh {
        zh_text.to_string()
    } else {
        en_text.to_string()
    }
}

pub fn synthesis_thinking_ui(zh: bool) -> String {
    pick_lang(zh, "正在整理完整报告…", "Compiling the full report…")
}

pub fn budget_warning_thinking(zh: bool, pct: u32) -> String {
    if zh {
        format!("工具调用预算已用 {}%，即将收尾…", pct)
    } else {
        format!("Tool call budget at {}% — wrapping up soon.", pct)
    }
}

pub fn budget_warning_system(zh: bool, used: usize, max: usize, pct: u32) -> String {
    if zh {
        format!(
            "⚠️ 预算提醒：已使用 {used}/{max} 次工具调用（{pct}%）。\
             请开始将已有发现综合成完整最终回答，此后仅调用绝对必要的工具。"
        )
    } else {
        format!(
            "⚠️ Budget Alert: You have used {used}/{max} tool calls ({pct}%). \
             Start synthesizing your findings into a comprehensive final answer. \
             Only make absolutely essential tool calls from here."
        )
    }
}

pub fn tool_limit_thinking(zh: bool, max: usize) -> String {
    if zh {
        format!("已达工具调用上限（{max}），正在综合最终回答…")
    } else {
        format!("Reached maximum tool call limit ({max}). Synthesizing final answer.")
    }
}

pub fn tool_limit_nudge(zh: bool) -> String {
    pick_lang(
        zh,
        "已达到工具调用次数上限。请根据目前已收集的信息综合最终回答，请勿再调用任何工具。",
        "You have reached the maximum number of tool calls. Please synthesize a final answer \
         from all the information gathered so far. Do NOT call any more tools.",
    )
}

pub fn empty_plan_thinking_ui(zh: bool) -> String {
    pick_lang(zh, "计划已更新，正在执行下一步工具…", "Plan updated — executing next tool…")
}

pub fn empty_plan_nudge(zh: bool) -> String {
    pick_lang(
        zh,
        "你通过 todo_write 更新了计划，但尚未执行必需的工具。\
         请立即调用当前 in_progress 步骤对应的工具（如 run_lint、get_vault_stats）。\
         在该工具完成前，请勿再次调用 todo_write。",
        "You updated the plan via todo_write but have not executed the required tools yet. \
         Call the tool for the current in_progress step NOW (e.g. run_lint, get_vault_stats). \
         Do NOT call todo_write again until that step's tool has finished and returned results.",
    )
}

pub fn empty_thinking_swallowed_ui(zh: bool) -> String {
    pick_lang(
        zh,
        "模型未输出正文，正在请求最终答案…",
        "No visible answer yet — requesting final response…",
    )
}

pub fn empty_thinking_swallowed_nudge(zh: bool) -> String {
    pick_lang(
        zh,
        "你上一条回复只有 <thought> 推理，没有可见正文。\
         请现在用 plain text 写出给用户的最终回答（放在 <thought> 之外），不要调用任何工具。",
        "Your previous reply contained only <thought> reasoning and no visible answer. \
         Now write your FINAL ANSWER for the user as plain text, OUTSIDE of any <thought> tags. \
         Do not call any tools.",
    )
}

pub fn truncation_nudge(zh: bool) -> String {
    pick_lang(
        zh,
        "请立即执行工具调用，不要只描述计划——请实际调用相应工具。",
        "Please proceed with the tool calls now. Do not just describe what you plan to do — \
         actually call the appropriate tools.",
    )
}

pub fn tool_error_recovery(zh: bool, tool_name: &str, error_snippet: &str) -> String {
    if zh {
        format!(
            "⚠️ 工具 `{tool_name}` 执行失败。错误：{error_snippet}\n\n\
             恢复选项：\n\
             1. 修正参数后重试（如文件路径、查询条件）\n\
             2. 换用其他工具达成相同目标\n\
             3. 若无法恢复，告知用户并基于已有数据继续\n\
             请勿用完全相同的参数重复调用。"
        )
    } else {
        format!(
            "⚠️ Tool '{tool_name}' failed. Error: {error_snippet}\n\n\
             Recovery options:\n\
             1. Retry with corrected arguments (e.g., fix file path, adjust query)\n\
             2. Use an alternative tool to achieve the same goal\n\
             3. If the error is unrecoverable, inform the user and continue with available data\n\
             Do NOT repeat the exact same call that just failed."
        )
    }
}

pub fn stagnation_thinking_ui(zh: bool) -> String {
    pick_lang(zh, "检测到搜索循环，正在切换策略…", "Detected search loop — switching strategy…")
}

pub fn stagnation_system(zh: bool) -> String {
    pick_lang(
        zh,
        "⚠️ 检测到停滞：已连续多次搜索但无进展。\n\
         请改变策略：\n\
         1. **阅读**具体笔记以获取深度上下文，而非继续搜索\n\
         2. **综合**已有信息给出回答\n\
         3. 尝试**完全不同**的查询或工具（如 get_graph、get_backlinks）\n\
         4. 若确实找不到，直接告知用户\n\
         请勿重复相似搜索。",
        "⚠️ Stagnation detected: You have made multiple consecutive search calls without progress.\n\
         Change your approach:\n\
         1. **Read** a specific note to get deep context instead of searching again\n\
         2. **Synthesize** an answer from the information you already have\n\
         3. Try a **completely different** query or tool (e.g., get_graph, get_backlinks)\n\
         4. If you truly cannot find what you need, tell the user directly\n\
         Do NOT repeat similar searches.",
    )
}

pub fn tool_observation(zh: bool, tool_names: &str) -> String {
    if zh {
        format!("观察：工具执行已完成 [{tool_names}]。请继续下一步。")
    } else {
        format!(
            "Observation: Tool execution completed [{tool_names}]. Proceed with the next step."
        )
    }
}

pub fn recovery_adjust_thinking(zh: bool) -> String {
    pick_lang(zh, "检测到停滞，正在调整策略…", "Detected a stall — adjusting approach.")
}

pub fn recovery_escalate_thinking(zh: bool) -> String {
    pick_lang(
        zh,
        "多次工具错误，需要你的指引…",
        "Encountered repeated errors — handing back to the user for guidance.",
    )
}

/// True when the answer looks like a meta stub rather than a real report.
pub fn is_meta_stub_answer(answer: &str) -> bool {
    let a = answer.trim();
    if a.is_empty() {
        return false;
    }
    a.starts_with("I have completed")
        || a.contains("analysis is complete and ready for your review")
        || a.starts_with("Do not repeat")
        || a.starts_with("我已完成")
        || a.starts_with("我已经完成")
        || a.contains("分析已完成")
        || a.contains("报告已就绪")
        || a.contains("扫描已完成")
        || a.contains("ready for your review")
}

/// Classify user query for orchestration (zero LLM cost).
pub fn classify_task_kind(query: &str) -> TaskKind {
    let q = query.to_lowercase();
    let diagnostic = [
        "扫描", "诊断", "盲区", "健康检查", "结构", "审计", "lint", "孤立", "冗余",
        "scan", "diagnos", "audit", "blind spot", "health check", "structural",
        "orphan", "fragment",
    ];
    if diagnostic.iter().any(|k| q.contains(k)) {
        return TaskKind::DiagnosticReport;
    }
    let curate = [
        "整理", "清理", "合并", "重命名", "去重", "修复链接",
        "organize", "clean up", "merge", "rename", "deduplicate",
    ];
    if curate.iter().any(|k| q.contains(k)) {
        return TaskKind::CurateAction;
    }
    let write = [
        "写", "创建", "新建", "起草", "撰写", "编辑笔记",
        "write", "create", "draft", "compose", "new note",
    ];
    if write.iter().any(|k| q.contains(k)) {
        return TaskKind::WriteAction;
    }
    let search = [
        "搜索", "查找", "查询", "分析", "比较", "图谱", "关联", "有哪些",
        "search", "find", "analyze", "compare", "graph", "explore",
    ];
    if search.iter().any(|k| q.contains(k)) {
        return TaskKind::SearchAnalysis;
    }
    TaskKind::General
}

/// Count executed tools excluding todo_write (UI-only).
pub fn substantive_tool_count(executed: &[(String, String)]) -> usize {
    executed
        .iter()
        .filter(|(n, _)| n != "todo_write")
        .count()
}

/// Whether to run a dedicated synthesis pass after the tool loop (not stub-dependent).
pub fn needs_mandatory_synthesis(
    task_kind: TaskKind,
    substantive_count: usize,
    total_tool_calls: usize,
    plan: &Option<Vec<PlanStep>>,
    executed: &[(String, String)],
) -> bool {
    if substantive_count == 0 {
        return false;
    }
    // When the plan is complete and at least one substantive tool ran, always synthesize.
    if plan_is_complete(plan, executed) {
        return true;
    }
    match task_kind {
        TaskKind::DiagnosticReport => total_tool_calls >= 2,
        TaskKind::SearchAnalysis => total_tool_calls >= 2,
        TaskKind::CurateAction => total_tool_calls >= 2,
        TaskKind::WriteAction => false,
        TaskKind::General => total_tool_calls >= 1 && substantive_count >= 1,
    }
}

/// Localized duplicate-tool warning returned to the model.
pub fn duplicate_tool_warning(tool_name: &str, args: &str, zh: bool) -> String {
    if zh {
        format!(
            "错误：重复的工具调用已被拦截。你已执行过 `{tool_name}`（参数 `{args}`）。\
             请基于已有结果综合回答，或使用不同参数。"
        )
    } else {
        format!(
            "Error: Duplicate tool execution blocked. You have already executed tool '{tool_name}' \
             with arguments '{args}'. Synthesize an answer from previous results or try different arguments."
        )
    }
}

/// True if this message is orchestration noise that should not enter the synthesis pass.
pub fn is_orchestration_noise(content: &str) -> bool {
    let c = content.trim();
    c.contains("Plan enforcement")
        || c.contains("Plan note:")
        || c.contains("计划约束")
        || c.contains("计划提示")
        || c.contains("⛔")
        || c.contains("Budget Alert")
        || c.contains("预算提醒")
        || c.contains("Do NOT call todo_write")
        || c.contains("请勿再次调用 todo_write")
        || c.starts_with("You called todo_write")
        || c.starts_with("你调用了 todo_write")
        || c.starts_with("You updated the plan")
        || c.starts_with("你通过 todo_write")
        || c.starts_with("Step in_progress:")
        || c.starts_with("当前 in_progress")
        || c.starts_with("Your answer is too short")
        || c.starts_with("回答过短")
        || c.contains("Duplicate tool execution blocked")
        || c.contains("重复的工具调用已被拦截")
        || c.contains("You have reached the maximum number of tool calls")
        || c.contains("已达到工具调用次数上限")
        || c.contains("You have finished calling tools")
        || c.contains("工具调用已全部完成")
        || c.contains("Stagnation detected")
        || c.contains("检测到停滞")
        || c.starts_with("Your previous reply contained only")
        || c.starts_with("你上一条回复只有")
        || c.starts_with("Now write your FINAL ANSWER")
        || c.starts_with("请现在用 plain text")
        || c.starts_with("Observation: Tool execution completed")
        || c.starts_with("观察：工具执行已完成")
}

/// Build a clean message list for the mandatory synthesis pass (no enforcement noise).
/// Tool-loop history uses `tool` role + assistant `tool_calls`; those are illegal when
/// the synthesis request sends no tools — consolidate tool output into user messages.
/// The final list alternates roles (no two consecutive same-role messages) so strict
/// providers (Zhipu/GLM, OpenAI) don't reject with 400.
pub fn build_synthesis_context(
    messages: &[ChatMessage],
    user_query: &str,
    task_kind: TaskKind,
) -> Vec<ChatMessage> {
    let zh = user_prefers_zh(user_query);
    let mut out: Vec<ChatMessage> = Vec::new();

    if let Some(sys) = messages.iter().find(|m| {
        m.role == "system" && !is_orchestration_noise(&m.content)
    }) {
        out.push(sys.clone());
    }

    // Merge the user_query and the tool result blocks into a SINGLE user message
    // (previously they were two consecutive user messages → 400 on strict providers).
    let mut merged_user = user_query.to_string();
    let mut tool_blocks: Vec<String> = Vec::new();
    for msg in messages {
        if msg.role == "tool" && !msg.content.trim().is_empty() {
            tool_blocks.push(compress_tool_content_for_synthesis(&msg.content));
        }
    }
    if !tool_blocks.is_empty() {
        let header = if zh {
            "## 工具执行结果（供综合报告使用）\n\n"
        } else {
            "## Tool results (for your final report)\n\n"
        };
        merged_user.push_str("\n\n");
        merged_user.push_str(header);
        merged_user.push_str(&tool_blocks.join("\n\n---\n\n"));
    }
    out.push(ChatMessage {
        role: "user".to_string(),
        content: merged_user,
        ..Default::default()
    });

    for msg in messages {
        if msg.role != "assistant" || msg.tool_calls.is_some() {
            continue;
        }
        if is_orchestration_noise(&msg.content) {
            continue;
        }
        let trimmed = msg.content.trim();
        if trimmed.len() < 40 {
            continue;
        }
        out.push(ChatMessage {
            role: "assistant".to_string(),
            content: trimmed.to_string(),
            tool_calls: None,
            tool_call_id: None,
        });
    }

    // Merge additional context + synthesis instruction into a SINGLE user message.
    let mut merged_instruction = String::new();
    if let Some(ctx) = messages.iter().find(|m| {
        m.role == "system" && m.content.starts_with("## Additional Context")
    }) {
        merged_instruction.push_str(&ctx.content);
        merged_instruction.push_str("\n\n");
    }
    merged_instruction.push_str(&synthesis_instruction(task_kind, zh));
    out.push(ChatMessage {
        role: "user".to_string(),
        content: merged_instruction,
        ..Default::default()
    });

    // Final safety: merge any remaining consecutive same-role messages.
    merge_consecutive_same_role(&mut out);
    out
}

/// Merge adjacent messages with the same role into one (content joined by a blank line).
fn merge_consecutive_same_role(msgs: &mut Vec<ChatMessage>) {
    let mut i = 1;
    while i < msgs.len() {
        if msgs[i].role == msgs[i - 1].role {
            // Move the content out of msgs[i] first so we don't hold an immutable
            // borrow of msgs[i] while mutating msgs[i - 1].
            let next_content = std::mem::take(&mut msgs[i].content);
            if !msgs[i - 1].content.trim().is_empty() {
                msgs[i - 1].content.push_str("\n\n");
            }
            msgs[i - 1].content.push_str(&next_content);
            msgs.remove(i);
        } else {
            i += 1;
        }
    }
}

/// Shrink large tool JSON before synthesis (preserve `_summary` + key stats).
pub fn compress_tool_content_for_synthesis(content: &str) -> String {
    const MAX: usize = 6000;
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.chars().count() <= MAX {
        return content.to_string();
    }

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let mut parts: Vec<String> = Vec::new();
        if let Some(summary) = val.get("_summary").and_then(|s| s.as_str()) {
            parts.push(format!("[Tool summary]\n{summary}"));
        }
        for key in [
            "cluster_count",
            "node_count",
            "edge_count",
            "orphan_count",
            "folder",
            "steps_total",
            "steps_done",
        ] {
            if let Some(v) = val.get(key) {
                parts.push(format!("{key}: {v}"));
            }
        }
        if let Some(clusters) = val.get("clusters").and_then(|c| c.as_array()) {
            let labels: Vec<String> = clusters
                .iter()
                .take(8)
                .filter_map(|c| {
                    c.get("label")
                        .and_then(|l| l.as_str())
                        .map(|l| format!("{}({})", l, c.get("node_count").and_then(|n| n.as_u64()).unwrap_or(0)))
                })
                .collect();
            if !labels.is_empty() {
                parts.push(format!("clusters: {}", labels.join(", ")));
            }
        }
        if let Some(notes) = val.get("notes").and_then(|n| n.as_array()) {
            parts.push(format!("notes: {} total", notes.len()));
            let titles: Vec<&str> = notes
                .iter()
                .take(12)
                .filter_map(|n| n.get("title").and_then(|t| t.as_str()))
                .collect();
            if !titles.is_empty() {
                parts.push(format!("sample titles: {}", titles.join("; ")));
            }
        }
        if let Some(broken) = val.get("broken").and_then(|b| b.as_array()) {
            parts.push(format!("broken_links: {} items", broken.len()));
        }
        if !parts.is_empty() {
            let joined = parts.join("\n");
            if joined.chars().count() <= MAX {
                return joined;
            }
        }
        return context::compress_tool_result("synthesis", trimmed, MAX);
    }

    context::compress_tool_result("synthesis", trimmed, MAX)
}

pub fn synthesis_instruction(task_kind: TaskKind, zh: bool) -> String {
    match (task_kind, zh) {
        (TaskKind::DiagnosticReport, true) => {
            "工具调用已全部完成。请根据上述工具返回的结果，为用户撰写一份完整的知识库结构性诊断报告（Markdown）。\
             必须包含：执行摘要、关键发现（孤立卡片/断裂链接/冗余话题/MOC 机会）、数据不一致说明（如有）、\
             编号的即时行动计划。使用与用户问题相同的语言。禁止调用任何工具。\
             禁止复述系统指令（如「请勿重复调用工具」）。禁止用一句话 meta 摘要敷衍——写完整分析。"
                .to_string()
        }
        (TaskKind::DiagnosticReport, false) => {
            "All tool calls are complete. Write a FULL structural diagnostic report (Markdown) from the tool results above. \
             Include: executive summary, key findings (orphans, broken links, redundant topics, MOC opportunities), \
             data inconsistencies if any, and a numbered action plan. Same language as the user. \
             Do NOT call tools. Do NOT echo system instructions. No one-line meta summaries."
                .to_string()
        }
        (TaskKind::SearchAnalysis | TaskKind::CurateAction, true) => {
            "工具调用已全部完成。请根据上述工具结果，为用户撰写完整、结构化的最终回答（Markdown）。\
             包含关键发现与具体建议。禁止调用工具，禁止复述系统指令，禁止一句话 meta 摘要。"
                .to_string()
        }
        (TaskKind::SearchAnalysis | TaskKind::CurateAction, false) => {
            "All tool calls are complete. Write a complete structured final answer (Markdown) from the tool results. \
             Include key findings and concrete recommendations. Do NOT call tools or echo system instructions."
                .to_string()
        }
        (_, true) => {
            "工具调用已全部完成。请根据上述信息撰写完整的最终回答。禁止调用工具，禁止复述系统指令。"
                .to_string()
        }
        (_, false) => {
            "All tool calls are complete. Write the complete final answer from the information above. \
             Do NOT call tools or echo system instructions."
                .to_string()
        }
    }
}

/// User-visible status line (zh) + model nudge (en).
pub struct PlanEnforcement {
    pub thinking_ui: String,
    pub model_nudge: String,
}

/// Tools referenced in a plan step, e.g. `(run_lint)` or `(get_vault_stats, get_graph)`.
pub fn tools_in_step(text: &str) -> Vec<String> {
    if let Some(start) = text.rfind('(') {
        if let Some(end) = text.rfind(')') {
            if end > start {
                return text[start + 1..end]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| {
                        !s.is_empty()
                            && s.chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    })
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Extract a tool name from step text like `运行健康检查(run_lint)`.
pub fn extract_tool_from_step(text: &str) -> Option<String> {
    tools_in_step(text).into_iter().next()
}

/// After a substantive tool succeeds, mark matching plan step(s) done and advance in_progress.
pub fn advance_plan_after_tool(
    steps: &mut Vec<PlanStep>,
    tool_name: &str,
    executed: &[(String, String)],
    success: bool,
) -> bool {
    if !success || tool_name == "todo_write" {
        return false;
    }

    let mut changed = false;

    for step in steps.iter_mut() {
        if step.status == "done" {
            continue;
        }
        let required = tools_in_step(&step.text);
        if required.is_empty() || !required.iter().any(|t| t == tool_name) {
            continue;
        }
        let all_satisfied = required
            .iter()
            .all(|t| executed.iter().any(|(n, _)| n == t));
        if all_satisfied {
            step.status = "done".to_string();
            changed = true;
        }
    }

    if !steps.iter().any(|s| s.status == "in_progress") {
        if let Some(next) = steps.iter_mut().find(|s| s.status == "pending") {
            next.status = "in_progress".to_string();
            changed = true;
        }
    }

    changed
}

fn in_progress_step<'a>(steps: &'a [PlanStep]) -> Option<&'a PlanStep> {
    steps.iter().find(|s| s.status == "in_progress")
}

fn open_plan_steps(steps: &[PlanStep]) -> bool {
    steps.iter().any(|s| s.status == "in_progress" || s.status == "pending")
}

/// True when every plan step is marked done (status-based, no text parsing).
/// No plan = no constraint. Any step not done = incomplete. This avoids the
/// premature-exit bug where pure-text plans (no `(tool)` annotations) had all
/// steps skipped and immediately returned true.
pub fn plan_is_complete(
    plan: &Option<Vec<PlanStep>>,
    _executed: &[(String, String)],
) -> bool {
    let Some(steps) = plan else {
        return true;
    };
    if steps.is_empty() {
        return true;
    }
    steps.iter().all(|s| s.status == "done")
}

/// Once all tool-bearing steps are done and their tools ran, auto-mark tool-less
/// meta steps (e.g. "Synthesize findings") as done. Pure-text plans (no tool-bearing
/// steps) are left for the model to drive via todo_write. Does NOT depend on
/// `plan_is_complete` (which now requires *every* step done) so it can break the
/// chicken-and-egg where the final synthesis step can only finish once synthesis runs.
pub fn finalize_meta_plan_steps(
    steps: &mut Vec<PlanStep>,
    executed: &[(String, String)],
) -> bool {
    let has_tool_step = steps.iter().any(|s| !tools_in_step(&s.text).is_empty());
    if !has_tool_step {
        return false;
    }
    let all_tool_steps_done = steps.iter().all(|s| {
        let required = tools_in_step(&s.text);
        required.is_empty()
            || (s.status == "done"
                && required
                    .iter()
                    .all(|t| executed.iter().any(|(n, _)| n == t)))
    });
    if !all_tool_steps_done {
        return false;
    }
    let mut changed = false;
    for step in steps.iter_mut() {
        if tools_in_step(&step.text).is_empty() && step.status != "done" {
            step.status = "done".to_string();
            changed = true;
        }
    }
    changed
}

/// Nudge the model to finish remaining plan steps before synthesis / final answer.
pub fn incomplete_plan_enforcement(
    user_query: &str,
    plan: &Option<Vec<PlanStep>>,
    executed: &[(String, String)],
) -> Option<PlanEnforcement> {
    if plan_is_complete(plan, executed) {
        return None;
    }
    let Some(steps) = plan else {
        return None;
    };
    if steps.is_empty() {
        return None;
    }
    let zh = user_prefers_zh(user_query);
    let done = steps.iter().filter(|s| s.status == "done").count();
    let total = steps.len();
    let next = steps.iter().find(|s| s.status == "in_progress" || s.status == "pending");
    let missing_tool = steps.iter().find_map(|step| {
        tools_in_step(&step.text)
            .into_iter()
            .find(|t| !executed.iter().any(|(n, _)| n == t))
    });
    let next_hint = next
        .and_then(|s| tools_in_step(&s.text).into_iter().next())
        .or(missing_tool)
        .unwrap_or_else(|| {
            if zh {
                "下一步工具".to_string()
            } else {
                "the next tool".to_string()
            }
        });
    Some(PlanEnforcement {
        thinking_ui: if zh {
            format!("计划未完成（{done}/{total}），继续执行…")
        } else {
            format!("Plan incomplete ({done}/{total}) — continuing…")
        },
        model_nudge: if zh {
            format!(
                "计划尚有 {done}/{total} 步未完成。请继续执行剩余步骤对应的真实工具\
                 （建议下一步：`{next_hint}`）。全部步骤完成后才能撰写最终报告；\
                 现在不要输出最终报告或结束本轮。"
            )
        } else {
            format!(
                "Plan progress: {done}/{total} steps done. Execute the remaining plan steps \
                 with real tool calls (suggested next: `{next_hint}`) before writing the final report. \
                 Do NOT produce the final report or end the turn yet."
            )
        },
    })
}

/// Suppress todo_write until a substantive tool runs for the current in_progress
/// step. Based on step status and substantive tool count — no text parsing.
pub fn should_suppress_todo_write(
    last_plan: &Option<Vec<PlanStep>>,
    executed: &[(String, String)],
) -> bool {
    let Some(steps) = last_plan else {
        return false;
    };
    if steps.is_empty() {
        return false;
    }
    let has_in_progress = steps.iter().any(|s| s.status == "in_progress");
    if !has_in_progress {
        return false;
    }
    let done_count = steps.iter().filter(|s| s.status == "done").count();
    let substantive = substantive_tool_count(executed);
    // No substantive tool has run beyond the already-done steps → the model is
    // updating the plan without executing the in_progress step's real tool.
    substantive <= done_count
}

/// System message injected when todo_write is temporarily removed from the tool list.
pub fn suppress_todo_write_system_message(last_plan: &Option<Vec<PlanStep>>, zh: bool) -> String {
    if let Some(steps) = last_plan {
        if let Some(step) = in_progress_step(steps) {
            if let Some(tool) = extract_tool_from_step(&step.text) {
                if zh {
                    return format!(
                        "Plan note: `todo_write` is temporarily disabled — run `{tool}` first. \
                         Marking in_progress does not execute the tool; call `{tool}` now."
                    );
                }
                return format!(
                    "Plan note: `todo_write` is temporarily disabled until you execute `{tool}`. \
                     Marking a step in_progress does NOT run it — call `{tool}` with real arguments now."
                );
            }
        }
    }
    if zh {
        "计划提示：请先执行当前 in_progress 步骤对应的工具，在此之前 `todo_write` 已暂时禁用。".to_string()
    } else {
        "Plan note: execute the tool for the current in_progress step before calling `todo_write` again.".to_string()
    }
}

/// JSON returned to the model (and logged) instead of bare "ok".
pub fn format_todo_write_result(steps: &[PlanStep], _zh: bool) -> String {
    let done_count = steps.iter().filter(|s| s.status == "done").count();

    json!({
        "status": "plan_updated",
        "steps_total": steps.len(),
        "steps_done": done_count,
        "message": "Plan updated. Continue with your next step."
    })
    .to_string()
}

/// Block loop exit when the model only updated the plan or skipped the in_progress tool.
pub fn check_premature_exit(
    user_query: &str,
    last_plan: &Option<Vec<PlanStep>>,
    executed: &[(String, String)],
    total_tool_calls: usize,
    answer_chars: usize,
) -> Option<PlanEnforcement> {
    if total_tool_calls == 0 {
        return None;
    }

    let zh = user_prefers_zh(user_query);
    let only_todo_write = executed.is_empty();

    let Some(steps) = last_plan else {
        if only_todo_write && total_tool_calls > 0 {
            return Some(PlanEnforcement {
                thinking_ui: if zh {
                    "尚未执行任何工具，正在要求执行…".to_string()
                } else {
                    "No tools executed yet — requesting execution…".to_string()
                },
                model_nudge: if zh {
                    "你调用了 todo_write，但尚未执行任何真实工具。请立即调用第一个必需工具（如 run_lint、get_vault_stats）。\
                     在该工具返回结果前，请勿再次调用 todo_write。".to_string()
                } else {
                    "You called todo_write but no real tools have run. \
                     Call the first required tool now (e.g. run_lint, get_vault_stats). \
                     Do NOT call todo_write again until that tool returns."
                        .to_string()
                },
            });
        }
        return None;
    };

    if steps.len() < 2 && !steps.iter().any(|s| s.status == "in_progress") {
        return None;
    }

    // Substantive tools ran but multi-step plan still open — block exit (including synthesis path).
    if !only_todo_write && open_plan_steps(steps) && !steps.iter().all(|s| s.status == "done") {
        if let Some(enforcement) = incomplete_plan_enforcement(user_query, last_plan, executed) {
            return Some(enforcement);
        }
    }

    // in_progress step names a concrete tool that must run first
    if let Some(step) = in_progress_step(steps) {
        if let Some(required) = extract_tool_from_step(&step.text) {
            if !executed.iter().any(|(n, _)| n == &required) {
                return Some(PlanEnforcement {
                    thinking_ui: if zh {
                        format!("计划步骤未完成，正在要求执行 {required}…")
                    } else {
                        format!("Plan step incomplete — requesting `{required}`…")
                    },
                    model_nudge: if zh {
                        format!(
                            "当前 in_progress 步骤：「{}」。必须立即调用 `{required}`。\
                             todo_write 只更新 UI 清单，不会执行 `{required}`。\
                             在 `{required}` 返回结果前，请勿再次调用 todo_write。",
                            step.text, required = required
                        )
                    } else {
                        format!(
                            "Step in_progress: \"{}\". You MUST call `{required}` NOW. \
                             todo_write only updates the UI checklist — it does NOT run `{required}`. \
                             Do NOT call todo_write again until `{required}` returns results.",
                            step.text, required = required
                        )
                    },
                });
            }
        }
    }

    // Multi-step plan but zero substantive tools
    if only_todo_write && open_plan_steps(steps) {
        return Some(PlanEnforcement {
            thinking_ui: if zh {
                "仅更新了计划，正在要求执行工具…".to_string()
            } else {
                "Plan updated only — requesting tool execution…".to_string()
            },
            model_nudge: if zh {
                "你通过 todo_write 创建/更新了多步计划，但尚未执行任何真实工具。\
                 请立即调用当前 in_progress 或第一个 pending 步骤对应的工具。\
                 在真实工具完成前，请勿再次调用 todo_write。".to_string()
            } else {
                "You created/updated a multi-step plan via todo_write but have not executed \
                 any real tools. Call the tool for the current in_progress or first pending step now. \
                 Do NOT call todo_write again until a real tool completes."
                    .to_string()
            },
        });
    }

    // Short premature answer while plan still open
    if open_plan_steps(steps) && answer_chars > 0 && answer_chars < 400 && only_todo_write {
        return Some(PlanEnforcement {
            thinking_ui: if zh {
                "回答过早结束，正在继续执行计划…".to_string()
            } else {
                "Answer ended too early — continuing the plan…".to_string()
            },
            model_nudge: if zh {
                "回答过短且计划尚未完成。请先执行剩余计划步骤（真实工具调用），再撰写最终报告。".to_string()
            } else {
                "Your answer is too short and the plan is not complete. \
                 Execute the remaining plan steps with real tool calls before writing the final report."
                    .to_string()
            },
        });
    }

    None
}

/// Strip system-instruction leaks, duplicate-tool warnings, orchestration nudges and
/// `<thought>` blocks from the user-visible answer.
pub fn sanitize_user_visible_answer(s: &str) -> String {
    let stripped = strip_thought_blocks(s);
    let mut out = stripped.trim().to_string();
    const LEAKS: &[&str] = &[
        "Do not repeat the same tool calls.",
        "Do not repeat the same tool calls",
        "Do not repeat similar searches.",
        "Please do not repeat this call",
        "Do NOT repeat the exact same call that just failed.",
        "请勿再次调用 todo_write",
        "请勿重复调用",
        "请勿重复相似搜索",
        "请勿用完全相同的参数重复调用",
        "Plan enforcement",
        "计划约束",
        "Plan note:",
        "计划提示",
        "Budget Alert",
        "预算提醒",
        "Stagnation Detected",
        "检测到停滞",
        "Duplicate tool execution blocked",
        "重复工具执行已阻止",
        "Do NOT call todo_write",
    ];
    for leak in LEAKS {
        while out.starts_with(leak) {
            out = out[leak.len()..].trim_start().to_string();
        }
    }
    for leak in LEAKS {
        out = out.replace(leak, "");
    }
    // Drop ⚠️ lines that carry orchestration keywords.
    const ORCH_KEYWORDS: &[&str] = &[
        "Budget",
        "预算",
        "Stagnation",
        "停滞",
        "Duplicate",
        "重复",
        "Plan enforcement",
        "计划约束",
        "Plan note",
        "计划提示",
        "todo_write",
        "tool call",
        "工具调用",
    ];
    out.lines()
        .map(str::trim)
        .filter(|line| {
            if line.is_empty() {
                return false;
            }
            if line.starts_with("⚠️") && ORCH_KEYWORDS.iter().any(|k| line.contains(k)) {
                return false;
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Remove `<thought>...</thought>` blocks (and any trailing unclosed `<thought>`)
/// from text. Thinking belongs in the timeline, not the user-visible answer.
fn strip_thought_blocks(s: &str) -> String {
    const START: &str = "<thought>";
    const END: &str = "</thought>";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(START) {
        out.push_str(&rest[..start]);
        let after = &rest[start + START.len()..];
        if let Some(end) = after.find(END) {
            rest = &after[end + END.len()..];
        } else {
            // Unclosed thought — discard the remainder.
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// Extract the most substantive assistant answer from the loop history.
/// Used as a fallback when the dedicated synthesis pass fails, instead of the raw
/// (possibly empty/noisy) loop reply. Returns sanitized text, or empty if none found.
pub fn extract_best_loop_answer(messages: &[ChatMessage]) -> String {
    let mut best = String::new();
    for msg in messages {
        if msg.role != "assistant" {
            continue;
        }
        let trimmed = msg.content.trim();
        if trimmed.is_empty() || is_orchestration_noise(trimmed) {
            continue;
        }
        if trimmed.chars().count() > best.chars().count() {
            best = trimmed.to_string();
        }
    }
    sanitize_user_visible_answer(&best)
}

/// After a multi-tool diagnostic turn, detect meta-only stubs that should be expanded.
pub fn needs_report_synthesis(
    user_query: &str,
    total_tool_calls: usize,
    executed_tool_count: usize,
    answer: &str,
) -> bool {
    if total_tool_calls < 2 || executed_tool_count == 0 {
        return false;
    }
    let answer = answer.trim();
    if answer.is_empty() {
        return true;
    }
    let q = user_query.to_lowercase();
    let report_like = q.contains("扫描")
        || q.contains("分析")
        || q.contains("报告")
        || q.contains("诊断")
        || q.contains("盲区")
        || q.contains("scan")
        || q.contains("diagnos")
        || q.contains("report")
        || q.contains("audit");
    if !report_like {
        return false;
    }
    let char_count = answer.chars().count();
    let meta_stub = is_meta_stub_answer(answer);
    char_count < 400 || (char_count < 1200 && meta_stub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_tool_from_parens() {
        assert_eq!(
            extract_tool_from_step("运行全面的知识库健康检查(run_lint)").as_deref(),
            Some("run_lint")
        );
    }

    #[test]
    fn suppresses_todo_until_tool_runs() {
        let plan = vec![PlanStep {
            text: "健康检查(run_lint)".to_string(),
            status: "in_progress".to_string(),
        }];
        assert!(should_suppress_todo_write(&Some(plan.clone()), &[]));
        assert!(!should_suppress_todo_write(
            &Some(plan),
            &[("run_lint".to_string(), "{}".to_string())]
        ));
    }

    #[test]
    fn classifies_diagnostic_task() {
        assert_eq!(
            classify_task_kind("对我的知识库做结构性盲区扫描"),
            TaskKind::DiagnosticReport
        );
    }

    #[test]
    fn mandatory_synthesis_for_diagnostic() {
        // Plan complete (None) + substantive tool → always synthesize.
        assert!(needs_mandatory_synthesis(
            TaskKind::DiagnosticReport,
            1,
            2,
            &None,
            &[],
        ));
        // WriteAction with an INCOMPLETE plan stays false (no synthesis gate).
        let pending_plan = Some(vec![PlanStep {
            text: "draft note".to_string(),
            status: "pending".to_string(),
        }]);
        assert!(!needs_mandatory_synthesis(
            TaskKind::WriteAction,
            1,
            5,
            &pending_plan,
            &[],
        ));
    }

    #[test]
    fn filters_orchestration_noise() {
        assert!(is_orchestration_noise("⛔ Plan enforcement: todo_write disabled"));
        assert!(is_orchestration_noise("Plan note: todo_write is temporarily disabled"));
        assert!(is_orchestration_noise("⚠️ 预算提醒：已使用 8/10 次工具调用"));
        assert!(!is_orchestration_noise("Vault health: 0 orphans"));
    }

    #[test]
    fn meta_stub_bilingual() {
        assert!(is_meta_stub_answer("I have completed the scan."));
        assert!(is_meta_stub_answer("我已完成知识库结构性扫描。"));
    }

    #[test]
    fn compresses_large_graph_for_synthesis() {
        let nodes: String = (0..400)
            .map(|i| format!(r#"{{"id":{i},"title":"note-{i}","body":"{}"}}"#, "y".repeat(24)))
            .collect::<Vec<_>>()
            .join(",");
        let huge = format!(
            r#"{{"_summary":"Knowledge graph: 400 nodes, 84 edges","cluster_count":3,"clusters":[{{"label":"A","node_count":6}},{{"label":"B","node_count":5}}],"nodes":[{nodes}]}}"#
        );
        assert!(huge.chars().count() > 6000);
        let out = compress_tool_content_for_synthesis(&huge);
        assert!(out.contains("[Tool summary]"));
        assert!(out.chars().count() < huge.chars().count());
    }

    #[test]
    fn advances_plan_when_tool_completes() {
        let mut plan = vec![
            PlanStep {
                text: "Run lint (run_lint)".to_string(),
                status: "in_progress".to_string(),
            },
            PlanStep {
                text: "Get stats (get_vault_stats)".to_string(),
                status: "pending".to_string(),
            },
        ];
        let executed = vec![("run_lint".to_string(), "{}".to_string())];
        assert!(advance_plan_after_tool(&mut plan, "run_lint", &executed, true));
        assert_eq!(plan[0].status, "done");
        assert_eq!(plan[1].status, "in_progress");
    }

    #[test]
    fn compound_step_needs_all_tools() {
        let mut plan = vec![PlanStep {
            text: "Stats and graph (get_vault_stats, get_graph)".to_string(),
            status: "in_progress".to_string(),
        }];
        let after_stats = vec![("get_vault_stats".to_string(), "{}".to_string())];
        assert!(!advance_plan_after_tool(
            &mut plan,
            "get_vault_stats",
            &after_stats,
            true
        ));
        assert_eq!(plan[0].status, "in_progress");

        let after_both = vec![
            ("get_vault_stats".to_string(), "{}".to_string()),
            ("get_graph".to_string(), "{}".to_string()),
        ];
        assert!(advance_plan_after_tool(
            &mut plan,
            "get_graph",
            &after_both,
            true
        ));
        assert_eq!(plan[0].status, "done");
    }

    #[test]
    fn plan_incomplete_blocks_synthesis_gate() {
        let plan = vec![
            PlanStep {
                text: "Run lint (run_lint)".to_string(),
                status: "done".to_string(),
            },
            PlanStep {
                text: "Get stats (get_vault_stats)".to_string(),
                status: "pending".to_string(),
            },
        ];
        let executed = vec![("run_lint".to_string(), "{}".to_string())];
        assert!(!plan_is_complete(&Some(plan.clone()), &executed));
        assert!(incomplete_plan_enforcement("scan vault", &Some(plan), &executed).is_some());
    }

    #[test]
    fn plan_marked_done_is_complete_by_status() {
        // plan_is_complete is now status-based: every step "done" → complete,
        // regardless of whether a named tool was actually executed.
        let plan = vec![
            PlanStep {
                text: "Run lint (run_lint)".to_string(),
                status: "done".to_string(),
            },
            PlanStep {
                text: "Get stats (get_vault_stats)".to_string(),
                status: "done".to_string(),
            },
        ];
        let executed = vec![("run_lint".to_string(), "{}".to_string())];
        assert!(plan_is_complete(&Some(plan.clone()), &executed));
        assert!(incomplete_plan_enforcement("scan vault", &Some(plan), &executed).is_none());
    }

    #[test]
    fn plan_complete_when_all_steps_done_and_tools_ran() {
        let plan = vec![
            PlanStep {
                text: "Run lint (run_lint)".to_string(),
                status: "done".to_string(),
            },
            PlanStep {
                text: "Get stats (get_vault_stats)".to_string(),
                status: "done".to_string(),
            },
        ];
        let executed = vec![
            ("run_lint".to_string(), "{}".to_string()),
            ("get_vault_stats".to_string(), "{}".to_string()),
        ];
        assert!(plan_is_complete(&Some(plan), &executed));
        assert!(incomplete_plan_enforcement("scan vault", &None, &[]).is_none());
    }

    #[test]
    fn no_plan_means_synthesis_allowed() {
        assert!(plan_is_complete(&None, &[]));
    }

    #[test]
    fn plan_complete_when_tool_steps_done_meta_step_pending() {
        let plan = vec![
            PlanStep {
                text: "Run lint (run_lint)".to_string(),
                status: "done".to_string(),
            },
            PlanStep {
                text: "Synthesize findings into action plan".to_string(),
                status: "pending".to_string(),
            },
        ];
        let executed = vec![("run_lint".to_string(), "{}".to_string())];
        // Meta step still pending → not complete yet (status-based check).
        assert!(!plan_is_complete(&Some(plan.clone()), &executed));
        let mut plan_mut = plan;
        assert!(finalize_meta_plan_steps(&mut plan_mut, &executed));
        assert!(plan_mut.iter().all(|s| s.status == "done"));
        // After finalizing meta steps, the plan is complete.
        assert!(plan_is_complete(&Some(plan_mut), &executed));
    }

    #[test]
    fn synthesis_context_omits_tool_roles_and_tool_calls() {
        use super::super::ToolCall;
        use super::super::ToolCallFunction;

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "You are ZettelAgent.".to_string(),
                ..Default::default()
            },
            ChatMessage {
                role: "user".to_string(),
                content: "scan my vault".to_string(),
                ..Default::default()
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: String::new(),
                tool_calls: Some(vec![ToolCall {
                    id: "c1".to_string(),
                    call_type: "function".to_string(),
                    function: ToolCallFunction {
                        name: "run_lint".to_string(),
                        arguments: "{}".to_string(),
                    },
                }]),
                ..Default::default()
            },
            ChatMessage {
                role: "tool".to_string(),
                content: r#"{"_summary":"0 orphans"}"#.to_string(),
                tool_call_id: Some("c1".to_string()),
                ..Default::default()
            },
        ];
        let out = build_synthesis_context(&messages, "scan my vault", TaskKind::DiagnosticReport);
        assert!(!out.iter().any(|m| m.role == "tool"));
        assert!(out.iter().all(|m| m.tool_calls.is_none()));
        assert!(out.iter().any(|m| m.content.contains("0 orphans")));
    }
}
