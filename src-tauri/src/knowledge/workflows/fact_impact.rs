use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use anyhow::{bail, Result};
use rusqlite::Connection;

use super::engine::BudgetTracker;
use super::types::*;
use crate::knowledge::changeset::{self, NewChangeSet, NewOp};
use crate::knowledge::types::{ChangeOpKind, ObjectKind};

/// 执行事实修改联动审查流水线 / Run Fact Impact Sentinel Pipeline
pub fn run_fact_impact_sentinel(
    conn: &Connection,
    _vault_path: &str,
    config: &WorkflowConfig,
    target_id_or_path: Option<&str>,
    dry_run: bool,
    tracker: &mut BudgetTracker,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<WorkflowRunResult> {
    let mut actions = Vec::new();
    let mut items_processed = 0;
    let mut ops_to_stage = Vec::new();

    // 1. 确定审查目标（若未指定，则检索最近被标记或更新的前 10 个主张/笔记）
    let targets: Vec<(String, String)> = if let Some(target) = target_id_or_path {
        vec![(target.to_string(), target.to_string())]
    } else {
        find_recently_modified_claims_or_notes(conn, 10)?
    };

    for (target_id, target_title) in targets {
        if let Some(cancel) = cancel_flag {
            if cancel.load(Ordering::SeqCst) {
                bail!("Workflow execution cancelled by user");
            }
        }

        tracker.check_timeout()?;
        tracker.record_api_call(400)?;
        items_processed += 1;

        // 2. 检索下游受影响的项目与笔记 (反向依赖追踪)
        let dependents = find_dependent_artifacts(conn, &target_id)?;

        if dependents.is_empty() {
            continue;
        }

        for (_dep_id, dep_type, dep_title) in dependents {
            let desc = format!(
                "下游{} [{}] 依赖了已变更的主张/笔记 [{}]，提议标记待复核并在文末添加影响提示",
                dep_type, dep_title, target_title
            );

            let diff_note = format!(
                "\n\n> [!WARNING] 前提事实已变动 (Fact Impact Sentinel)\n> 本条目所依赖的主张/事实 `[[{}]]` 发生了更新，请复核上下文并核对引文有效性。\n",
                target_id
            );

            let action = ActionSummary {
                action_type: "flag_impacted_dependent".to_string(),
                target: dep_title.clone(),
                description: desc.clone(),
                diff_preview: Some(diff_note.clone()),
            };
            actions.push(action);

            let mut op = NewOp::new(ChangeOpKind::Patch, "fact_impact_sentinel");
            op.legacy_path = Some(dep_title.clone());
            op.patch = Some(diff_note);
            op.reason = Some(desc);
            op.target_kind = ObjectKind::Document;
            ops_to_stage.push(op);
        }
    }

    let mut changeset_id = None;
    if !dry_run && !ops_to_stage.is_empty() {
        let mut req = NewChangeSet::new("system:workflow:fact_impact_sentinel");
        req.intent = Some("事实修改联动审查：向下游受影响笔记添加待复核提醒".to_string());
        req.scopes = vec!["".to_string()];

        let cs = changeset::propose(conn, &req)?;
        changeset_id = Some(cs.id.clone());

        for op in ops_to_stage {
            let _ = changeset::add_op(conn, &cs.id, &req.scopes, &op);
        }
    }

    let summary = format!(
        "事实修改联动审查完成。审查了 {} 个目标主张/事实，识别并生成了 {} 项下游受影响笔记的联动提议草稿。",
        items_processed,
        actions.len()
    );

    Ok(WorkflowRunResult {
        run_id: format!("run_fi_{}", chrono::Utc::now().timestamp_millis()),
        workflow_id: config.id.clone(),
        kind: WorkflowKind::FactImpactSentinel,
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

fn find_recently_modified_claims_or_notes(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title
         FROM knowledge_objects
         WHERE kind IN ('claim', 'fact', 'document') AND status != 'deleted'
         ORDER BY updated_at_ms DESC
         LIMIT ?1",
    )?;

    let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
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

    // 若 knowledge_objects 为空，则回退检索 files 表
    if out.is_empty() {
        let mut f_stmt = conn.prepare(
            "SELECT path, title
             FROM files
             ORDER BY last_synced DESC
             LIMIT ?1",
        )?;
        let f_rows = f_stmt.query_map(rusqlite::params![limit as i64], |row| {
            let path: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            Ok((path.clone(), title.unwrap_or(path)))
        })?;
        for r in f_rows {
            if let Ok(item) = r {
                out.push(item);
            }
        }
    }

    Ok(out)
}

fn find_dependent_artifacts(conn: &Connection, target: &str) -> Result<Vec<(String, String, String)>> {
    let mut results = Vec::new();

    // 1. 查找关系表中的关联对象
    let mut rel_stmt = conn.prepare(
        "SELECT target_object_id, relation_type
         FROM relations_v2
         WHERE source_object_id = ?1 AND status != 'deleted'
         LIMIT 20",
    )?;
    let rel_rows = rel_stmt.query_map(rusqlite::params![target], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for r in rel_rows {
        if let Ok((target_obj, rtype)) = r {
            results.push((target_obj.clone(), rtype, target_obj));
        }
    }

    // 2. 查找引用了该 target 的研究项目 (collection)
    let pattern = format!("%{target}%");
    let mut proj_stmt = conn.prepare(
        "SELECT id, title
         FROM knowledge_objects
         WHERE kind = 'collection' AND status != 'deleted' AND metadata_json LIKE ?1
         LIMIT 10",
    )?;
    let proj_rows = proj_stmt.query_map(rusqlite::params![pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for r in proj_rows {
        if let Ok((pid, title)) = r {
            results.push((pid, "研究项目".to_string(), title.unwrap_or_default()));
        }
    }

    // 3. 查找引用了该名称的双向链接笔记 (wikilink)
    let link_pattern = format!("%[[{}]]%", target);
    let mut link_stmt = conn.prepare(
        "SELECT file_path
         FROM chunks
         WHERE content LIKE ?1
         LIMIT 10",
    )?;
    let link_rows = link_stmt.query_map(rusqlite::params![link_pattern], |row| {
        Ok(row.get::<_, String>(0)?)
    })?;
    for r in link_rows {
        if let Ok(fpath) = r {
            if fpath != target {
                results.push((fpath.clone(), "关联笔记".to_string(), fpath));
            }
        }
    }

    Ok(results)
}
