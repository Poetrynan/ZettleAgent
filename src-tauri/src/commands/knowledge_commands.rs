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
///
/// 给了 `vault_path` 就顺手把它追加进 `memory.md`：那是永远在 prompt 里的 Core
/// Memory，确认过的偏好本该稳定在场，而不是只能靠召回碰巧命中。
///
/// 投影失败不回滚确认——确认已经落库，报错会让用户以为白点了一下。失败只记日志，
/// 下一次确认或 `knowledge_sync_memory_file` 会再试。
#[tauri::command]
pub async fn knowledge_memory_confirm(
    state: State<'_, AppState>,
    memory_id: String,
    vault_path: Option<String>,
) -> Result<types::MemoryItem, ZettelError> {
    let conn = state.db.lock()?;
    let item = memory::confirm(&conn, &memory_id, "user")?;
    if let Some(vault) = vault_path.as_deref() {
        if let Err(e) = memory::project_to_markdown(&conn, vault, &memory_id) {
            log::warn!("memory {memory_id} confirmed but not projected into memory.md: {e}");
        }
    }
    Ok(item)
}


/// 把 `memory.md` 的手工编辑吸收回记忆层 / absorb hand edits to `memory.md`.
///
/// 用户直接改那个文件也是在说话。不回流的话，他手写的那一行只活在一个文件里，
/// 检索、证据、冲突检查全都看不见它。
#[tauri::command]
pub async fn knowledge_sync_memory_file(
    state: State<'_, AppState>,
    vault_path: String,
) -> Result<memory::MarkdownSync, ZettelError> {
    let conn = state.db.lock()?;
    Ok(memory::reconcile_from_markdown(&conn, &vault_path)?)
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

// ── 统一收件箱 / the unified inbox ──────────────────────────────────────────
//
// 四种"等用户判断的东西"本来分散在四张表里，用户得点四个地方才知道有没有活。这两个
// 命令把它们合成一条流，但**不**在这里新增业务语义：每一项都还是原表的那一行，动作
// 也还是原来那几个命令。这里只做汇总和排序。
//
// 文案不在这里。返回的是稳定的 `reason`/`actions` 代码，中英文由前端 i18n 映射——
// 后端硬编码中文会让英文界面缺一半信息。
//
// `active` 承诺不进收件箱：它已经被接受了，属于 Task Center 的工作量，不是待裁决项。

/// 各类待处理数量 / how much is waiting, by kind.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxCounts {
    /// 等确认的候选记忆。
    pub memory: i64,
    /// 还没落地的变更批次。
    pub changes: i64,
    /// 等裁决的承诺（只有 `proposed`）。
    pub tasks: i64,
    /// 需要人管的索引故障。
    pub health: i64,
    pub total: i64,
}

/// 角标要的那个数 / the number behind the nav badge.
///
/// 单独于 `knowledge_index_health` 存在，因为角标会被轮询：这里只有四个 `COUNT(*)`，
/// 不刷新投影健康、不写任何表。
#[tauri::command]
pub async fn knowledge_inbox_counts(
    state: State<'_, AppState>,
) -> Result<InboxCounts, ZettelError> {
    let conn = state.db.lock()?;
    Ok(inbox_counts(&conn)?)
}

fn inbox_counts(conn: &rusqlite::Connection) -> rusqlite::Result<InboxCounts> {
    let count = |sql: &str| -> rusqlite::Result<i64> { conn.query_row(sql, [], |r| r.get(0)) };

    let memory = count(
        "SELECT COUNT(*) FROM memory_items
         WHERE requires_user_confirmation = 1 AND lifecycle = 'candidate'",
    )?;
    let changes = count(
        "SELECT COUNT(*) FROM changesets
         WHERE state IN ('proposed', 'previewed', 'awaiting_approval', 'approved')",
    )?;
    let tasks = count("SELECT COUNT(*) FROM task_commitments WHERE status = 'proposed'")?;
    let health = count("SELECT COUNT(*) FROM ingestion_jobs WHERE status = 'failed'")?;

    Ok(InboxCounts { memory, changes, tasks, health, total: memory + changes + tasks + health })
}

/// 收件箱里的一项 / one thing waiting on the user.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// 原表主键。动作命令要用它，所以不能改写。
    pub id: String,
    /// `memory` / `change` / `task` / `health`。
    pub kind: String,
    pub title: String,
    /// 一句人话摘要。空字符串表示没有比标题更多的信息。
    pub summary: String,
    /// 原表的状态值，给高级详情看的。
    pub status: String,
    pub risk: Option<String>,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    /// 为什么需要现在处理，稳定代码，前端翻译。
    pub reason: String,
    /// 可用动作的稳定代码。
    pub actions: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 排序权重 / how urgent this kind is, for the merged sort.
///
/// 索引故障排最前：它会让后面所有判断都基于不完整的知识库。
fn inbox_weight(kind: &str) -> u8 {
    match kind {
        "health" => 0,
        "change" => 1,
        "memory" => 2,
        _ => 3,
    }
}

/// 合并后的收件箱 / the merged inbox.
///
/// 每类各取 `limit`，合并后再截到 `limit`——所以一类爆量不会把其他类挤出视野之外的
/// 顺序，但总数仍然有界。
#[tauri::command]
pub async fn knowledge_inbox(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<InboxItem>, ZettelError> {
    let conn = state.db.lock()?;
    Ok(build_inbox(&conn, limit.unwrap_or(50).clamp(1, 200))?)
}

/// 收件箱的全部逻辑 / everything the inbox actually decides.
///
/// 与命令分开是为了能测：它只要一个 `Connection`，不需要 Tauri 的 `State`。
fn build_inbox(
    conn: &rusqlite::Connection,
    per_kind: usize,
) -> Result<Vec<InboxItem>, ZettelError> {
    let mut items = Vec::new();


    for m in memory::inbox(&conn, per_kind)? {
        let reason = if m.conflicts_with_id.is_some() {
            "memory_conflicts"
        } else if m.supersedes_id.is_some() {
            "memory_supersedes"
        } else if m.source.as_ref().is_some_and(|s| s.source_type == "web" || s.source_type == "mcp")
        {
            "memory_external_source"
        } else if m.confidence < 0.7 {
            "memory_low_confidence"
        } else {
            "memory_unconfirmed"
        };
        items.push(InboxItem {
            id: m.id,
            kind: "memory".into(),
            title: m.claim,
            summary: String::new(),
            status: m.lifecycle.as_str().to_string(),
            risk: None,
            source_type: m.source.as_ref().map(|s| s.source_type.clone()),
            source_id: m.source.as_ref().map(|s| s.source_id.clone()),
            reason: reason.into(),
            // 只列出现在真的有命令支撑的动作。写一个还没有后端的按钮，用户点一次就
            // 学会不再信任这个界面。
            actions: vec!["confirm".into(), "reject".into(), "forget".into()],
            created_at_ms: m.created_at_ms,
            updated_at_ms: m.updated_at_ms,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT c.id, c.actor, c.intent, c.state, c.risk, c.commit_error,
                c.created_at_ms, c.updated_at_ms,
                (SELECT COUNT(*) FROM changeset_ops o WHERE o.changeset_id = c.id)
         FROM changesets c
         WHERE c.state IN ('proposed', 'previewed', 'awaiting_approval', 'approved')
         ORDER BY c.updated_at_ms DESC
         LIMIT ?1",
    )?;
    let changes = stmt
        .query_map([per_kind as i64], |r| {
            let state: String = r.get(3)?;
            let commit_error: Option<String> = r.get(5)?;
            let ops: i64 = r.get(8)?;
            let reason = if commit_error.is_some() {
                "change_failed"
            } else if state == "approved" {
                "change_approved_pending_write"
            } else {
                "change_awaiting_approval"
            };
            Ok(InboxItem {
                id: r.get(0)?,
                kind: "change".into(),
                title: r.get::<_, Option<String>>(2)?.unwrap_or_else(|| {
                    r.get::<_, String>(1).unwrap_or_else(|_| "change set".into())
                }),
                summary: ops.to_string(),
                status: state,
                risk: r.get(4)?,
                source_type: None,
                source_id: None,
                reason: reason.into(),
                // 不在收件箱里直接给"批准"：批准的前置条件是看过 dry-run 的逐行
                // 改动，而那是变更页的事。一个不看 diff 就能点的批准按钮，等于
                // 把审批降级成走过场。
                actions: vec!["preview".into()],
                created_at_ms: r.get(6)?,
                updated_at_ms: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    items.extend(changes);

    let now = types::now_ms();
    for c in commitments::inbox(&conn, per_kind)? {
        // `active` 已经被接受过一次了，它属于 Task Center 的待办，不是待裁决项。
        if !matches!(c.status, types::CommitmentStatus::Proposed) {
            continue;
        }
        let reason = match c.due_at_ms {
            Some(due) if due < now => "task_overdue",
            Some(due) if due - now < 86_400_000 => "task_due_soon",
            _ => "task_proposed",
        };
        items.push(InboxItem {
            id: c.id,
            kind: "task".into(),
            title: c.title,
            summary: String::new(),
            status: c.status.as_str().to_string(),
            risk: None,
            source_type: c.source.as_ref().map(|s| s.source_type.clone()),
            source_id: c.source.as_ref().map(|s| s.source_id.clone()),
            reason: reason.into(),
            actions: vec![
                "activate".into(),
                "snooze".into(),
                "complete".into(),
                "dismiss".into(),
            ],
            created_at_ms: c.created_at_ms,
            updated_at_ms: c.updated_at_ms,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT id, job_type, source_id, last_error, attempt, created_at_ms, updated_at_ms
         FROM ingestion_jobs
         WHERE status = 'failed'
         ORDER BY updated_at_ms DESC
         LIMIT ?1",
    )?;
    let jobs = stmt
        .query_map([per_kind as i64], |r| {
            Ok(InboxItem {
                id: r.get(0)?,
                kind: "health".into(),
                title: r.get(1)?,
                // 失败原因是这一项唯一有用的内容，所以它就是摘要。
                summary: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                status: "failed".into(),
                risk: None,
                source_type: Some("file".into()),
                source_id: r.get(2)?,
                reason: "health_job_failed".into(),
                // 重试单个 job 还没有命令，所以这里只给"打开健康页"。
                actions: vec!["open_health".into()],
                created_at_ms: r.get(5)?,
                updated_at_ms: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    items.extend(jobs);

    items.sort_by(|a, b| {
        inbox_weight(&a.kind)
            .cmp(&inbox_weight(&b.kind))
            .then(b.updated_at_ms.cmp(&a.updated_at_ms))
    });
    items.truncate(per_kind);
    Ok(items)
}

#[cfg(test)]
mod inbox_tests {
    use super::*;
    use rusqlite::{params, Connection};

    /// 与生产同一条建库路径 / the same schema path production runs.
    fn db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        crate::knowledge::migration::run_knowledge_migrations(&conn).unwrap();
        conn
    }

    fn add_candidate(conn: &Connection, id: &str, claim: &str, confidence: f64, at: i64) {
        conn.execute(
            "INSERT INTO memory_items
                (id, kind, lifecycle, claim, scope, confidence, importance,
                 requires_user_confirmation, created_at_ms, updated_at_ms)
             VALUES (?1, 'semantic', 'candidate', ?2, 'global', ?3, 1.0, 1, ?4, ?4)",
            params![id, claim, confidence, at],
        )
        .unwrap();
    }

    fn add_changeset(conn: &Connection, id: &str, state: &str, at: i64) {
        conn.execute(
            "INSERT INTO changesets (id, actor, intent, state, risk, created_at_ms, updated_at_ms)
             VALUES (?1, 'agent', 'tidy the note', ?2, 'low', ?3, ?3)",
            params![id, state, at],
        )
        .unwrap();
    }

    fn add_commitment(conn: &Connection, id: &str, status: &str, due: Option<i64>, at: i64) {
        conn.execute(
            "INSERT INTO task_commitments
                (id, commitment_type, title, status, priority, due_at_ms, dedupe_key,
                 created_at_ms, updated_at_ms)
             VALUES (?1, 'commitment', 'ship the thing', ?2, 0, ?3, ?1, ?4, ?4)",
            params![id, status, due, at],
        )
        .unwrap();
    }

    fn add_failed_job(conn: &Connection, id: &str, error: &str, at: i64) {
        conn.execute(
            "INSERT INTO ingestion_jobs
                (id, idempotency_key, job_type, source_type, source_id, status,
                 last_error, created_at_ms, updated_at_ms)
             VALUES (?1, ?1, 'objectify', 'file', 'notes/a.md', 'failed', ?2, ?3, ?3)",
            params![id, error, at],
        )
        .unwrap();
    }

    /// 空库不撒谎 / an empty database reports zero, not a placeholder.
    #[test]
    fn inbox_counts_are_zero_on_a_fresh_database() {
        let conn = db();
        let counts = inbox_counts(&conn).unwrap();
        assert_eq!(
            counts,
            InboxCounts { memory: 0, changes: 0, tasks: 0, health: 0, total: 0 }
        );
        assert!(build_inbox(&conn, 50).unwrap().is_empty());
    }

    /// 角标数就是四类之和 / the badge number is the sum of the four kinds.
    #[test]
    fn inbox_counts_sum_the_four_kinds() {
        let conn = db();
        add_candidate(&conn, "m1", "prefers conclusions first", 0.5, 1_000);
        add_changeset(&conn, "c1", "awaiting_approval", 2_000);
        add_commitment(&conn, "t1", "proposed", None, 3_000);
        add_failed_job(&conn, "j1", "embedding model unavailable", 4_000);

        let counts = inbox_counts(&conn).unwrap();
        assert_eq!(
            counts,
            InboxCounts { memory: 1, changes: 1, tasks: 1, health: 1, total: 4 }
        );
    }

    /// 已经落地或已经被接受的东西不再占用收件箱。
    ///
    /// `committed` 变更、`active` 承诺、非 candidate 记忆都是"处理过了"，如果它们
    /// 继续留在收件箱里，角标就永远清不掉，用户会学会忽略角标。
    #[test]
    fn inbox_excludes_settled_and_already_accepted_work() {
        let conn = db();
        add_changeset(&conn, "c-done", "committed", 1_000);
        add_changeset(&conn, "c-open", "proposed", 2_000);
        add_commitment(&conn, "t-active", "active", None, 3_000);
        add_commitment(&conn, "t-new", "proposed", None, 4_000);
        conn.execute(
            "INSERT INTO memory_items
                (id, kind, lifecycle, claim, scope, confidence, importance,
                 requires_user_confirmation, created_at_ms, updated_at_ms)
             VALUES ('m-active', 'semantic', 'active', 'already confirmed', 'global',
                     0.9, 1.0, 0, 5000, 5000)",
            [],
        )
        .unwrap();

        let counts = inbox_counts(&conn).unwrap();
        assert_eq!(counts.changes, 1);
        assert_eq!(counts.tasks, 1);
        assert_eq!(counts.memory, 0);

        let ids: Vec<String> = build_inbox(&conn, 50).unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["c-open".to_string(), "t-new".to_string()]);
    }

    /// 索引故障排在最前 / a broken index outranks everything else.
    ///
    /// 它不是"又一条待办"：知识库不完整的时候，用户对其他每一项的判断都建立在
    /// 缺失的信息上。
    #[test]
    fn inbox_puts_index_failures_first() {
        let conn = db();
        add_candidate(&conn, "m1", "a claim", 0.5, 9_000);
        add_commitment(&conn, "t1", "proposed", None, 8_000);
        add_changeset(&conn, "c1", "previewed", 7_000);
        add_failed_job(&conn, "j1", "checksum mismatch", 1_000);

        let kinds: Vec<String> =
            build_inbox(&conn, 50).unwrap().into_iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec!["health", "change", "memory", "task"]);
    }

    /// 每一项都要说清"为什么现在需要你" / every item carries its own reason.
    #[test]
    fn inbox_reasons_describe_why_the_item_needs_a_human() {
        let conn = db();
        add_candidate(&conn, "m-low", "a guess", 0.4, 1_000);
        conn.execute(
            "INSERT INTO memory_items
                (id, kind, lifecycle, claim, scope, confidence, importance,
                 requires_user_confirmation, conflicts_with_id, created_at_ms, updated_at_ms)
             VALUES ('m-conflict', 'semantic', 'candidate', 'contradicts', 'global',
                     0.9, 1.0, 1, 'm-low', 2000, 2000)",
            [],
        )
        .unwrap();
        let now = crate::knowledge::types::now_ms();
        add_commitment(&conn, "t-late", "proposed", Some(now - 60_000), 3_000);
        add_failed_job(&conn, "j1", "boom", 4_000);

        let items = build_inbox(&conn, 50).unwrap();
        let reason = |id: &str| {
            items.iter().find(|i| i.id == id).map(|i| i.reason.clone()).unwrap_or_default()
        };
        assert_eq!(reason("m-low"), "memory_low_confidence");
        assert_eq!(reason("m-conflict"), "memory_conflicts");
        assert_eq!(reason("t-late"), "task_overdue");
        assert_eq!(reason("j1"), "health_job_failed");

        // 失败原因就是那一项的摘要，否则用户得再点一次才知道坏在哪。
        let job = items.iter().find(|i| i.id == "j1").unwrap();
        assert_eq!(job.summary, "boom");
    }

    /// 一类爆量不能把其他类挤掉 / one noisy kind cannot starve the others.
    #[test]
    fn inbox_keeps_every_kind_visible_under_a_small_limit() {
        let conn = db();
        for i in 0..40 {
            add_candidate(&conn, &format!("m{i}"), "noise", 0.5, 1_000 + i);
        }
        add_changeset(&conn, "c1", "proposed", 500);
        add_failed_job(&conn, "j1", "boom", 400);

        let items = build_inbox(&conn, 3).unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].kind, "health");
        assert_eq!(items[1].kind, "change");
        assert_eq!(items[2].kind, "memory");
    }
}


