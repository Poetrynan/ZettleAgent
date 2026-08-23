//! 知识对象层的命令 / the knowledge-object layer's Tauri commands.
//!
//! 这批命令刻意只做真实查询和有界的批处理：
//!
//! - `knowledge_index_health` 每一个数字都来自 `COUNT(*)`，没有一个是写死的；
//! - `knowledge_run_backfill` 一次只推进有限个 job，前端可以循环调用并显示进度，
//!   而不是发一个请求然后等一个不知道多久的批处理；
//! - 读命令返回 `null`/空数组而不是伪造对象，backfill 没跑到的笔记就是还没有对象。

use serde::Serialize;
use tauri::State;

use crate::error::ZettelError;
use crate::knowledge::memory::{self, RecalledMemory};
use crate::knowledge::{backfill, changeset, commitments, evidence, object_store, types};
use crate::AppState;

/// 一次 backfill 推进的上限 / the hard cap on one backfill call.
///
/// 前端循环调用是刻意的设计：单次调用持有 DB 锁的时间有上界，UI 能在每批之间更新
/// 进度，用户也能中途停。
const MAX_BACKFILL_BATCH: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIndexHealth {
    pub schema_version: i64,
    /// vault 里的笔记数（`files`）。
    pub total_files: i64,
    /// 已经有稳定对象身份的笔记数。
    pub indexed_documents: i64,
    /// 按需创建出来的块对象数。
    pub block_objects: i64,
    pub pending_jobs: i64,
    pub failed_jobs: i64,
    pub last_error: Option<String>,
    pub last_run_at_ms: Option<i64>,
    pub memory_items: i64,
    pub memory_inbox: i64,
    pub open_changesets: i64,
    pub open_commitments: i64,
}

/// 真实的索引健康 / the real index health.
#[tauri::command]
pub async fn knowledge_index_health(
    state: State<'_, AppState>,
) -> Result<KnowledgeIndexHealth, ZettelError> {
    let conn = state.db.lock()?;
    let health = backfill::refresh_document_projection_health(&conn)?;

    let count = |sql: &str| -> Result<i64, ZettelError> {
        Ok(conn.query_row(sql, [], |r| r.get(0))?)
    };

    Ok(KnowledgeIndexHealth {
        schema_version: crate::knowledge::migration::current_version(&conn)?,
        total_files: health.total_count,
        indexed_documents: health.indexed_count,
        block_objects: count("SELECT COUNT(*) FROM knowledge_objects WHERE kind = 'block'")?,
        pending_jobs: health.pending_count,
        failed_jobs: health.failed_count,
        last_error: health.last_error,
        last_run_at_ms: health.last_run_at_ms,
        memory_items: count("SELECT COUNT(*) FROM memory_items")?,
        memory_inbox: count(
            "SELECT COUNT(*) FROM memory_items
             WHERE requires_user_confirmation = 1 AND lifecycle = 'candidate'",
        )?,
        open_changesets: count(
            "SELECT COUNT(*) FROM changesets
             WHERE state IN ('proposed', 'previewed', 'awaiting_approval', 'approved')",
        )?,
        open_commitments: count(
            "SELECT COUNT(*) FROM task_commitments WHERE status IN ('proposed', 'active')",
        )?,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillProgress {
    pub processed: usize,
    pub created: usize,
    pub failed: usize,
    pub remaining: i64,
    /// 还有活可干，前端据此决定要不要再来一批。
    pub has_more: bool,
}

/// 推进一批对象化 / advance the document backfill by one bounded batch.
#[tauri::command]
pub async fn knowledge_run_backfill(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<BackfillProgress, ZettelError> {
    let conn = state.db.lock()?;
    // 每次都先入队：用户新建的笔记会在这里被发现，不需要单独的钩子。
    backfill::enqueue_document_backfill(&conn)?;

    let limit = limit.unwrap_or(50).clamp(1, MAX_BACKFILL_BATCH);
    let batch = backfill::run_backfill_batch(&conn, limit)?;
    backfill::refresh_document_projection_health(&conn)?;

    Ok(BackfillProgress {
        processed: batch.processed,
        created: batch.created,
        failed: batch.failed,
        remaining: batch.remaining,
        has_more: batch.remaining > 0,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetail {
    pub object: types::KnowledgeObject,
    /// 根在前的祖先链，含对象自身。
    pub breadcrumb: Vec<types::KnowledgeObject>,
    pub children: Vec<types::KnowledgeObject>,
    pub backlinks: Vec<types::RelationV2>,
    pub evidence: Vec<EvidenceView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceView {
    #[serde(flatten)]
    pub evidence: types::Evidence,
    /// `supports` / `contradicts` / `source` / `completion`。
    pub role: String,
    pub confidence: f64,
}

/// 一个对象的全部可解释信息 / everything the UI needs to explain one object.
///
/// 对象不存在返回 `None`，不返回占位对象：backfill 没跑到的笔记就是还没有稳定身份，
/// 伪造一个 ID 会让后续所有引用都指向一个下次启动就变的东西。
#[tauri::command]
pub async fn knowledge_get_object(
    state: State<'_, AppState>,
    object_id: Option<String>,
    file_path: Option<String>,
) -> Result<Option<ObjectDetail>, ZettelError> {
    let conn = state.db.lock()?;

    let object = match (&object_id, &file_path) {
        (Some(id), _) => object_store::get_object(&conn, id)?,
        (None, Some(path)) => {
            object_store::find_by_source(&conn, &types::SourceRef::file(path))?
        }
        (None, None) => {
            return Err(ZettelError::System(
                "knowledge_get_object needs either objectId or filePath".into(),
            ))
        }
    };

    let Some(object) = object else { return Ok(None) };

    let breadcrumb = object_store::get_breadcrumb(&conn, &object.id)?;
    let children = object_store::list_children(&conn, &object.id)?;
    let backlinks = object_store::get_backlinks(&conn, &object.id)?;
    let evidence = evidence::evidence_for_object(&conn, &object.id)?
        .into_iter()
        .map(|(evidence, role, confidence)| EvidenceView { evidence, role, confidence })
        .collect();

    Ok(Some(ObjectDetail { object, breadcrumb, children, backlinks, evidence }))
}

/// 某个对象的版本历史 / an object's version history, newest first.
#[tauri::command]
pub async fn knowledge_object_versions(
    state: State<'_, AppState>,
    object_id: String,
    limit: Option<usize>,
) -> Result<Vec<types::ObjectVersion>, ZettelError> {
    let conn = state.db.lock()?;
    let current = object_store::get_object(&conn, &object_id)?
        .ok_or_else(|| ZettelError::System(format!("object {object_id} not found")))?;

    let take = limit.unwrap_or(20).clamp(1, 200) as i64;
    let lowest = (current.current_version - take + 1).max(1);

    let mut out = Vec::new();
    for version in (lowest..=current.current_version).rev() {
        if let Some(v) = object_store::get_object_version(&conn, &object_id, version)? {
            out.push(v);
        }
    }
    Ok(out)
}

/// 某一轮 / 某个对象的审计明细 / the audit trail for one run or object.
#[tauri::command]
pub async fn knowledge_audit_trail(
    state: State<'_, AppState>,
    run_id: Option<String>,
    object_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<types::AuditEvent>, ZettelError> {
    let conn = state.db.lock()?;
    let take = limit.unwrap_or(50).clamp(1, 500) as i64;

    let mut stmt = conn.prepare(
        "SELECT id, actor, run_id, session_id, event, object_id, tool_name, scope,
                before_version, after_version, result, metadata_json, created_at_ms
         FROM audit_events
         WHERE (?1 IS NULL OR run_id = ?1) AND (?2 IS NULL OR object_id = ?2)
         ORDER BY created_at_ms DESC
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![run_id, object_id, take], |row| {
            Ok(types::AuditEvent {
                id: row.get(0)?,
                actor: row.get(1)?,
                run_id: row.get(2)?,
                session_id: row.get(3)?,
                event: row.get(4)?,
                object_id: row.get(5)?,
                tool_name: row.get(6)?,
                scope: row.get(7)?,
                before_version: row.get(8)?,
                after_version: row.get(9)?,
                result: row.get(10)?,
                metadata_json: row.get(11)?,
                created_at_ms: row.get(12)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ── Memory Inbox ────────────────────────────────────────────────────────────
//
// 这四个命令是"不得让未经确认的 LLM 推断伪装成用户事实"在 UI 上的落点：候选记忆
// 必须有一个地方让用户看见、确认或否掉。`confirm` 是唯一会写 `confirmed_by` 的路径。

/// 等用户裁决的候选记忆 / candidate memories awaiting the user.
#[tauri::command]
pub async fn knowledge_memory_inbox(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<types::MemoryItem>, ZettelError> {
    let conn = state.db.lock()?;
    Ok(memory::inbox(&conn, limit.unwrap_or(50).clamp(1, 200))?)
}

/// 用户确认一条候选 / the user confirms a candidate.
#[tauri::command]
pub async fn knowledge_memory_confirm(
    state: State<'_, AppState>,
    memory_id: String,
) -> Result<types::MemoryItem, ZettelError> {
    let conn = state.db.lock()?;
    Ok(memory::confirm(&conn, &memory_id, "user")?)
}

/// 用户否掉一条候选 / the user rejects a candidate.
///
/// 归档而不是删除，所以同一条错误提案不会反复回到 Inbox。
#[tauri::command]
pub async fn knowledge_memory_reject(
    state: State<'_, AppState>,
    memory_id: String,
) -> Result<types::MemoryItem, ZettelError> {
    let conn = state.db.lock()?;
    Ok(memory::reject(&conn, &memory_id)?)
}

/// 永久遗忘 / permanently forget one memory.
#[tauri::command]
pub async fn knowledge_memory_forget(
    state: State<'_, AppState>,
    memory_id: String,
) -> Result<types::MemoryItem, ZettelError> {
    let conn = state.db.lock()?;
    Ok(memory::forget(&conn, &memory_id)?)
}

/// 按当前问题召回记忆，并带上为什么可疑 / recall memories with their warnings.
///
/// 供 Context Inspector 展示"这一轮为什么注入了这些记忆"。
#[tauri::command]
pub async fn knowledge_memory_recall(
    state: State<'_, AppState>,
    query: String,
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<RecalledMemory>, ZettelError> {
    let conn = state.db.lock()?;
    let limit = limit.unwrap_or(memory::RECALL_LIMIT).clamp(1, 50);
    Ok(memory::recall(&conn, &query, scope.as_deref(), limit)?)
}

// ── ChangeSet ───────────────────────────────────────────────────────────────
//
// 这三个命令是 Change Preview UI 的后端：列出待决批次、看一个批次会改什么、
// 记录用户的裁决。真实写回不在这里——见 `knowledge::changeset` 的模块文档。

/// 一个待决批次的摘要 / one pending change set, summarised.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangeSet {
    pub id: String,
    pub actor: String,
    pub run_id: Option<String>,
    pub intent: Option<String>,
    pub state: String,
    pub op_count: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub commit_error: Option<String>,
}

/// 还没落地的批次 / change sets that have not landed yet.
#[tauri::command]
pub async fn knowledge_pending_changesets(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<PendingChangeSet>, ZettelError> {
    let conn = state.db.lock()?;
    let limit = limit.unwrap_or(50).clamp(1, 200) as i64;

    let mut stmt = conn.prepare(
        "SELECT c.id, c.actor, c.run_id, c.intent, c.state, c.created_at_ms, c.updated_at_ms,
                c.commit_error, (SELECT COUNT(*) FROM changeset_ops o WHERE o.changeset_id = c.id)
         FROM changesets c
         WHERE c.state NOT IN ('committed', 'rejected', 'rolled_back')
         ORDER BY c.updated_at_ms DESC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(PendingChangeSet {
                id: r.get(0)?,
                actor: r.get(1)?,
                run_id: r.get(2)?,
                intent: r.get(3)?,
                state: r.get(4)?,
                created_at_ms: r.get(5)?,
                updated_at_ms: r.get(6)?,
                commit_error: r.get(7)?,
                op_count: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 预演一个批次 / preview what a change set would do.
///
/// 只读。跑完批次状态变成 `previewed` 或 `conflicted`——"看过了"本身是提交的前置条件。
#[tauri::command]
pub async fn knowledge_preview_changeset(
    state: State<'_, AppState>,
    changeset_id: String,
) -> Result<changeset::DryRunReport, ZettelError> {
    let conn = state.db.lock()?;
    Ok(changeset::dry_run(&conn, &changeset_id)?)
}

/// 记录用户对一个批次的裁决 / record the user's decision on a change set.
///
/// 只改状态，不写文件。批准之后真实写回由 Agent 的工具路径完成，然后由
/// `changeset::record_commit` 记账。
#[tauri::command]
pub async fn knowledge_decide_changeset(
    state: State<'_, AppState>,
    changeset_id: String,
    approved: bool,
) -> Result<types::ChangeSet, ZettelError> {
    let conn = state.db.lock()?;
    Ok(changeset::record_decision(&conn, &changeset_id, approved)?)
}

// ── 承诺 / commitments ──────────────────────────────────────────────────────
//
// 这组命令是 Task/Commitment View 的后端。全部走 `knowledge::commitments`，所以
// 四道克制闸门（总开关、免打扰、日上限、最小间隔）在 UI 这条路上同样生效。

/// 收件箱里等用户处理的承诺 / commitments waiting on the user.
#[tauri::command]
pub async fn knowledge_commitment_inbox(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<types::TaskCommitment>, ZettelError> {
    let conn = state.db.lock()?;
    Ok(commitments::inbox(&conn, limit.unwrap_or(50).clamp(1, 200))?)
}

/// 用户对一条承诺的裁决 / the user's decision on one commitment.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentDecision {
    pub commitment_id: String,
    /// `activate` / `dismiss` / `snooze` / `complete`。
    pub action: String,
    /// `snooze` 用：推迟到什么时候。
    pub until_ms: Option<i64>,
    /// `complete` 用：做完了什么。没有它就不算做完。
    pub result_summary: Option<String>,
}

/// 处理一条承诺 / act on one commitment.
///
/// `complete` 走 `deliver_result`：登记结果证据、绑回源对象、留审计。只把状态改成
/// done 的路径这里刻意不提供——那正是这套东西最容易滑向的失败模式。
#[tauri::command]
pub async fn knowledge_decide_commitment(
    state: State<'_, AppState>,
    decision: CommitmentDecision,
) -> Result<types::TaskCommitment, ZettelError> {
    let conn = state.db.lock()?;
    let id = &decision.commitment_id;

    match decision.action.as_str() {
        "activate" => Ok(commitments::activate(&conn, id)?),
        "dismiss" => Ok(commitments::dismiss(&conn, id)?),
        "snooze" => {
            let until = decision.until_ms.ok_or_else(|| {
                ZettelError::System("snoozing a commitment needs untilMs".into())
            })?;
            Ok(commitments::snooze(&conn, id, until)?)
        }
        "complete" => {
            let summary = decision.result_summary.unwrap_or_default();
            Ok(commitments::deliver_result(&conn, id, &summary, "user")?)
        }
        other => Err(ZettelError::System(format!(
            "unknown commitment action `{other}`"
        ))),
    }
}

/// 这一轮该不该提醒，以及为什么 / what may be surfaced now, or why nothing is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProactiveDigest {
    pub items: Vec<types::TaskCommitment>,
    /// 被闸门挡住的原因：`disabled` / `quiet_hours` / `daily_cap` / `too_soon`。
    /// 为 `None` 表示闸门放行了。
    pub silenced: Option<String>,
    /// 刚才转成 expired 的条数。逾期任务不能继续打扰。
    pub expired: usize,
}

/// 取这一轮允许露面的提醒 / the reminders the policy allows right now.
///
/// 调用方拿到 `items` 之后必须自己决定要不要真的展示。真的展示了就该调
/// `knowledge_mark_notified`，否则日上限与最小间隔永远不会推进。
#[tauri::command]
pub async fn knowledge_proactive_digest(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<ProactiveDigest, ZettelError> {
    let conn = state.db.lock()?;
    let now = types::now_ms();

    // 先清逾期再挑提醒：顺序反了的话逾期任务会先被提醒一次再被标记过期。
    let expired = commitments::expire_overdue(&conn, now, 86_400_000)?;

    let policy = commitments::load_policy(&conn);
    let hour = commitments::local_hour_now();
    let limit = limit.unwrap_or(3).clamp(1, 20);

    match commitments::due_notifications(&conn, &policy, now, hour, limit)? {
        Ok(items) => Ok(ProactiveDigest { items, silenced: None, expired }),
        Err(reason) => Ok(ProactiveDigest {
            items: Vec::new(),
            silenced: Some(
                match reason {
                    commitments::Silenced::Disabled => "disabled",
                    commitments::Silenced::QuietHours(_) => "quiet_hours",
                    commitments::Silenced::DailyCap(_) => "daily_cap",
                    commitments::Silenced::TooSoon { .. } => "too_soon",
                }
                .to_string(),
            ),
            expired,
        }),
    }
}

/// 记下"这条真的提醒过了" / record that a reminder was actually shown.
#[tauri::command]
pub async fn knowledge_mark_notified(
    state: State<'_, AppState>,
    commitment_id: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    Ok(commitments::record_notified(&conn, &commitment_id, types::now_ms())?)
}

/// 扫一遍笔记里的带日期待办 / harvest dated todos from the vault.
///
/// 只收带 `YYYY-MM-DD` 的未打勾条目，扫出来一律进 `proposed`。理由见
/// `commitments::scan_notes` 的文档。
#[tauri::command]
pub async fn knowledge_scan_commitments(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<CommitmentScan, ZettelError> {
    let conn = state.db.lock()?;
    let report = commitments::scan_notes(&conn, limit.unwrap_or(50).clamp(1, 500))?;
    Ok(CommitmentScan { found: report.found, created: report.created })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentScan {
    pub found: usize,
    pub created: usize,
}

