use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use anyhow::{bail, Result};
use rusqlite::Connection;

use super::engine::BudgetTracker;
use super::types::*;
use crate::knowledge::changeset::{self, NewChangeSet, NewOp};
use crate::knowledge::types::{ChangeOpKind, ObjectKind};

/// 执行每周知识回顾流水线 / Run Weekly Review Digest Pipeline
pub fn run_weekly_review(
    conn: &Connection,
    _vault_path: &str,
    config: &WorkflowConfig,
    dry_run: bool,
    tracker: &mut BudgetTracker,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<WorkflowRunResult> {
    if let Some(cancel) = cancel_flag {
        if cancel.load(Ordering::SeqCst) {
            bail!("Workflow execution cancelled by user");
        }
    }

    tracker.check_timeout()?;
    tracker.record_api_call(1200)?;

    let now = chrono::Utc::now();
    let week_str = now.format("%Y-W%V").to_string();
    let date_str = now.format("%Y-%m-%d").to_string();

    // 1. 统计近 7 天变更笔记数
    let recent_notes = get_recent_notes(conn, 7)?;
    let items_processed = recent_notes.len();

    // 2. 统计活跃研究项目与未决问题
    let active_projects = get_active_research_projects(conn)?;

    // 3. 统计争议/待核验主张
    let contested_claims = get_contested_claims(conn)?;

    // 4. 统计 FSRS 到期卡片
    let due_cards_count = get_fsrs_due_cards_count(conn);

    // 5. 拼装结构化周报 Markdown
    let mut doc = String::new();
    doc.push_str(&format!(
        "---\ntitle: \"知识周回顾 {}\"\ndate: {}\ntype: review_digest\ngenerated_by: system:workflow:weekly_review\ntags:\n  - weekly-review\n  - digest\n---\n\n",
        week_str, date_str
    ));

    doc.push_str(&format!("# 知识周回顾 ({})\n\n", week_str));
    doc.push_str(&format!("> 生成时间: {} | 知识库范围: 全库扫描\n\n", now.to_rfc3339()));

    doc.push_str("## 1. 本周知识增长与活跃度\n");
    doc.push_str(&format!("- **近 7 天活跃笔记数**: {} 篇\n", recent_notes.len()));
    doc.push_str(&format!("- **活跃研究项目数**: {} 个\n", active_projects.len()));
    doc.push_str(&format!("- **争议/待核验主张数**: {} 条\n", contested_claims.len()));
    doc.push_str(&format!("- **FSRS 到期复习卡片**: {} 张\n\n", due_cards_count));

    doc.push_str("### 最近演化笔记列表 (Top 10)\n");
    if recent_notes.is_empty() {
        doc.push_str("- 本周暂无明显笔记修改。\n");
    } else {
        for (path, title) in recent_notes.iter().take(10) {
            doc.push_str(&format!("- [[{}]] - {}\n", path, title));
        }
    }
    doc.push('\n');

    doc.push_str("## 2. 活跃研究项目与未决问题 (Open Questions)\n");
    if active_projects.is_empty() {
        doc.push_str("- 当前无进行中的专题研究项目。\n");
    } else {
        for (p_id, p_title, open_q_count) in &active_projects {
            doc.push_str(&format!("- **{}** (ID: `{}`): 包含 {} 个未决疑问\n", p_title, p_id, open_q_count));
        }
    }
    doc.push('\n');

    doc.push_str("## 3. 争议主张与待核验证据\n");
    if contested_claims.is_empty() {
        doc.push_str("- 本周未检测到存在冲突或证据不足的孤立主张，知识图谱结构稳健。\n");
    } else {
        for (c_id, c_title) in &contested_claims {
            doc.push_str(&format!("- 待核验主张: **{}** (`{}`)\n", c_title, c_id));
        }
    }
    doc.push('\n');

    doc.push_str("## 4. 下周行动建议 (Next Actions)\n");
    if due_cards_count > 0 {
        doc.push_str(&format!("1. 优先完成 {} 张到期 FSRS 记忆卡片复习，巩固长期记忆。\n", due_cards_count));
    }
    if !active_projects.is_empty() {
        doc.push_str("2. 针对上述活跃研究项目的未决问题，使用 `verify_quote` 与 `read_source_range` 补充一手证据。\n");
    }
    doc.push_str("3. 对收件箱 `_inbox/` 与新资料 `_sources/` 执行分流归档。\n");

    let target_review_path = format!("_reviews/{}-review.md", week_str);

    let action = ActionSummary {
        action_type: "generate_weekly_review".to_string(),
        target: target_review_path.clone(),
        description: format!("生成本周 ({}) 结构化知识回顾报告草稿", week_str),
        diff_preview: Some(format!("+ [New File] {}\n{}", target_review_path, doc)),
    };
    let actions = vec![action];

    let mut changeset_id = None;
    if !dry_run {
        let mut req = NewChangeSet::new("system:workflow:weekly_review");
        req.intent = Some(format!("知识周回顾：创建 {} 周报草案", week_str));
        req.scopes = vec!["".to_string(), "_reviews".to_string()];

        let cs = changeset::propose(conn, &req)?;
        changeset_id = Some(cs.id.clone());

        let mut op = NewOp::new(ChangeOpKind::Create, "weekly_review_pipeline");
        op.legacy_path = Some(target_review_path);
        op.new_content = Some(doc.clone());
        op.reason = Some(format!("Generated weekly knowledge review digest for {}", week_str));
        op.target_kind = ObjectKind::Document;

        let _ = changeset::add_op(conn, &cs.id, &req.scopes, &op);
    }

    let summary = format!(
        "每周知识回顾完成。盘点了 {} 篇活跃笔记、{} 个研究项目与 {} 张到期记忆卡片，生成了 {} 周报提案。",
        items_processed,
        active_projects.len(),
        due_cards_count,
        week_str
    );

    Ok(WorkflowRunResult {
        run_id: format!("run_wr_{}", chrono::Utc::now().timestamp_millis()),
        workflow_id: config.id.clone(),
        kind: WorkflowKind::WeeklyReview,
        status: WorkflowRunStatus::Completed,
        is_dry_run: dry_run,
        items_processed,
        api_calls_used: tracker.api_calls,
        tokens_used: tracker.tokens_used,
        changeset_id,
        summary_markdown: summary,
        actions,
    })
}

fn get_recent_notes(conn: &Connection, days: i64) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT path, title
         FROM files
         WHERE last_synced >= datetime('now', ?1)
         ORDER BY last_synced DESC
         LIMIT 50",
    )?;
    let days_param = format!("-{} days", days);
    let rows = stmt.query_map(rusqlite::params![days_param], |row| {
        let p: String = row.get(0)?;
        let t: Option<String> = row.get(1)?;
        Ok((p.clone(), t.unwrap_or(p)))
    })?;

    let mut out = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            out.push(item);
        }
    }
    Ok(out)
}

fn get_active_research_projects(conn: &Connection) -> Result<Vec<(String, String, usize)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, metadata_json
         FROM knowledge_objects
         WHERE kind = 'collection' AND status != 'deleted'
         LIMIT 10",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let meta: Option<String> = row.get(2)?;
        Ok((id, title.unwrap_or_default(), meta.unwrap_or_default()))
    })?;

    let mut out = Vec::new();
    for r in rows {
        if let Ok((id, title, meta)) = r {
            let open_q_count = if meta.contains("open_questions") {
                meta.matches("question").count()
            } else {
                0
            };
            out.push((id, title, open_q_count));
        }
    }
    Ok(out)
}

fn get_contested_claims(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title
         FROM knowledge_objects
         WHERE kind = 'claim' AND status = 'contested'
         LIMIT 10",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        Ok((id.clone(), title.unwrap_or(id)))
    })?;

    let mut out = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            out.push(item);
        }
    }
    Ok(out)
}

fn get_fsrs_due_cards_count(conn: &Connection) -> usize {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_cards WHERE due_at_ms <= ?1",
        rusqlite::params![chrono::Utc::now().timestamp_millis()],
        |row| row.get(0),
    ).unwrap_or(0);
    count as usize
}
