use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use anyhow::{bail, Result};
use rusqlite::Connection;

use super::engine::BudgetTracker;
use super::types::*;
use crate::knowledge::changeset::{self, NewChangeSet, NewOp};
use crate::knowledge::types::{ChangeOpKind, ObjectKind};

/// 执行新资料入库整理流水线 / Run Source Ingestion Pipeline
pub fn run_source_ingestion(
    conn: &Connection,
    vault_path: &str,
    config: &WorkflowConfig,
    dry_run: bool,
    tracker: &mut BudgetTracker,
    cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<WorkflowRunResult> {
    let vault = Path::new(vault_path);
    let sources_dir = vault.join("_sources");

    let mut actions = Vec::new();
    let mut items_processed = 0;
    let mut ops_to_stage = Vec::new();

    // 扫描待入库文件 (优先 _sources 目录，若不存在则回退至 vault 根目录按 scope 匹配)
    let search_dir = if sources_dir.exists() {
        sources_dir.clone()
    } else {
        vault.to_path_buf()
    };

    let mut candidate_files = Vec::new();
    collect_source_files(&search_dir, &mut candidate_files, config)?;

    for source_file in candidate_files {
        if let Some(cancel) = cancel_flag {
            if cancel.load(Ordering::SeqCst) {
                bail!("Workflow execution cancelled by user");
            }
        }

        tracker.check_timeout()?;

        let rel_path = match source_file.strip_prefix(vault) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        // 检查该资料是否已被处理过（例如已有对应文献笔记）
        if is_already_ingested(conn, &rel_path) {
            continue;
        }

        // 读取文件内容进行有界分析
        let content = match std::fs::read_to_string(&source_file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // 记入预算消耗 (每次抽取评估预估消耗 1 次内部 API/处理单元及 ~500 tokens)
        tracker.record_api_call(content.len().min(1000))?;
        items_processed += 1;

        let filename = source_file.file_name().and_then(|n| n.to_str()).unwrap_or("source");
        let slug = slugify(filename);
        let title = extract_title(&content, filename);

        let target_note_path = format!("literature/{}.md", slug);
        let note_content = format!(
            "---\ntitle: \"{}\"\nsource_path: \"{}\"\ntype: literature\nstatus: pending_review\ngenerated_by: system:workflow:source_ingestion\ntags:\n  - literature\n  - auto-ingested\n---\n\n# {}\n\n> 来源文件: [[{}]]\n\n## 提炼核心主张候选\n- {}\n\n## 摘录概要\n{}\n",
            title,
            rel_path,
            title,
            rel_path,
            extract_key_claim(&content),
            extract_summary(&content)
        );

        let action = ActionSummary {
            action_type: "create_literature_note".to_string(),
            target: target_note_path.clone(),
            description: format!("从新资料 [{}] 自动提炼文献笔记与核心主张", rel_path),
            diff_preview: Some(format!("+ [New File] {}\n{}", target_note_path, note_content)),
        };
        actions.push(action);

        let mut op = NewOp::new(ChangeOpKind::Create, "source_ingestion_pipeline");
        op.legacy_path = Some(target_note_path);
        op.new_content = Some(note_content);
        op.reason = Some(format!("Auto-ingested literature note from {}", rel_path));
        op.target_kind = ObjectKind::Document;
        ops_to_stage.push(op);

        // 如果达到单次批处理上限或单次预算上限，提前收尾
        if items_processed >= 10 {
            break;
        }
    }

    let mut changeset_id = None;
    if !dry_run && !ops_to_stage.is_empty() {
        let mut req = NewChangeSet::new("system:workflow:source_ingestion");
        req.intent = Some("新资料入库整理：新建文献笔记与主张候选待审提案".to_string());
        req.scopes = vec!["".to_string(), "literature".to_string()];

        let cs = changeset::propose(conn, &req)?;
        changeset_id = Some(cs.id.clone());

        for op in ops_to_stage {
            let _ = changeset::add_op(conn, &cs.id, &req.scopes, &op);
        }
    }

    let summary = format!(
        "新资料入库整理完成。扫描处理了 {} 个新来源资料，生成了 {} 项待审提案草稿。",
        items_processed,
        actions.len()
    );

    Ok(WorkflowRunResult {
        run_id: format!("run_si_{}", chrono::Utc::now().timestamp_millis()),
        workflow_id: config.id.clone(),
        kind: WorkflowKind::SourceIngestion,
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

fn collect_source_files(dir: &Path, out: &mut Vec<PathBuf>, config: &WorkflowConfig) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with('.') && name != "node_modules" && name != "_archive" {
                collect_source_files(&p, out, config)?;
            }
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if ext == "md" || ext == "txt" || ext == "pdf" {
                out.push(p);
            }
        }
    }
    Ok(())
}

fn is_already_ingested(conn: &Connection, rel_path: &str) -> bool {
    // 检查是否有任何文献笔记的前置元数据引用了该 source_path
    let pattern = format!("%source_path: \"{rel_path}\"%");
    let pattern2 = format!("%source_path: '{rel_path}'%");
    let pattern3 = format!("%source_path: {rel_path}%");

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE content LIKE ?1 OR content LIKE ?2 OR content LIKE ?3",
        rusqlite::params![pattern, pattern2, pattern3],
        |row| row.get(0),
    ).unwrap_or(0);

    count > 0
}

fn slugify(name: &str) -> String {
    let clean = name.trim_end_matches(".md")
        .trim_end_matches(".txt")
        .trim_end_matches(".pdf");
    clean.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_lowercase()
}

fn extract_title(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            return trimmed.trim_start_matches("# ").trim().to_string();
        }
        if trimmed.to_lowercase().starts_with("title:") {
            let t = trimmed.split_once(':').map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'')).unwrap_or("");
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.trim_end_matches(".md").replace('_', " ")
}

fn extract_key_claim(content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.len() > 15 && (
            trimmed.contains("表明")
            || trimmed.contains("提出")
            || trimmed.contains("发现")
            || trimmed.contains("结论")
            || trimmed.to_lowercase().contains("conclude")
            || trimmed.to_lowercase().contains("demonstrate")
            || trimmed.to_lowercase().contains("argues that")
        ) {
            return trimmed.chars().take(120).collect();
        }
    }
    "待人工阅读标注关键主张".to_string()
}

fn extract_summary(content: &str) -> String {
    let mut paras = Vec::new();
    for p in content.split("\n\n") {
        let trimmed = p.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with("---") {
            paras.push(trimmed);
            if paras.len() >= 2 {
                break;
            }
        }
    }
    if paras.is_empty() {
        "暂无正文概要".to_string()
    } else {
        paras.join("\n\n").chars().take(300).collect()
    }
}
