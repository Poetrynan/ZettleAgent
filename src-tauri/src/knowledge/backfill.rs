//! 幂等、可恢复的 backfill / the idempotent, resumable backfill.
//!
//! 把已有的 `files` 行提升为 `document` 对象。三条约束决定了它长这个样子：
//!
//! 1. **不能阻塞启动。** 一个几千篇笔记的 vault 不该让应用卡在启动画面，所以工作
//!    单元是 `ingestion_jobs` 里的行，由调用方按批推进。
//! 2. **失败要能重试。** 每个 job 记 `attempt` 和指数退避的 `next_attempt_at_ms`，
//!    失败原因留在 `last_error`，不静默丢弃。
//! 3. **重复跑是 no-op。** 入队靠 `idempotency_key` 唯一约束，建对象靠
//!    `idx_knowledge_objects_source` 唯一索引。跑十次和跑一次结果相同。
//!
//! `chunks` → `block` 对象**不做全量 backfill**：一个 vault 的 chunk 数是笔记数的
//! 一到两个数量级，为每个 chunk 预建对象会让对象表变成第二份索引却没人读。block
//! 对象按需创建（[`ensure_block_object`]），只有真正被 evidence 或 relation 引用
//! 的块才获得稳定身份。

use rusqlite::{params, Connection, OptionalExtension};

use super::object_store::{self, NewObject};
use super::types::*;

/// backfill 的 pipeline 版本 / the pipeline version stamped on backfill jobs.
///
/// 改动 backfill 语义时必须 +1：这样能查出"哪些对象是旧逻辑建的"，而不用猜。
pub const BACKFILL_PIPELINE_VERSION: &str = "document-backfill/1";

const JOB_TYPE_DOCUMENT: &str = "backfill_document";

/// 一批 backfill 的结果 / what one batch did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackfillBatch {
    pub processed: usize,
    pub created: usize,
    /// 已有对象、直接标完成的 job 数。
    pub already_present: usize,
    pub failed: usize,
    /// 仍待处理的 job 数，调用方据此决定要不要再来一批。
    pub remaining: i64,
}

/// 为还没有对象的笔记入队 / enqueue a job per file that has no document object yet.
///
/// 返回新入队的数量。已入队或已完成的不会重复计数。
pub fn enqueue_document_backfill(conn: &Connection) -> anyhow::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT f.path, f.hash FROM files f
         WHERE NOT EXISTS (
             SELECT 1 FROM knowledge_objects o
             WHERE o.source_type = 'file' AND o.source_id = f.path
         )",
    )?;
    let pending: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let now = now_ms();
    let mut enqueued = 0usize;
    for (path, hash) in pending {
        let key = format!("{JOB_TYPE_DOCUMENT}:{path}");
        let changed = conn.execute(
            "INSERT OR IGNORE INTO ingestion_jobs
                (id, idempotency_key, job_type, source_type, source_id, source_checksum,
                 status, progress, attempt, next_attempt_at_ms, pipeline_version,
                 created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, 'file', ?4, ?5, 'pending', 0.0, 0, ?6, ?7, ?6, ?6)",
            params![
                new_object_id(),
                key,
                JOB_TYPE_DOCUMENT,
                path,
                hash,
                now,
                BACKFILL_PIPELINE_VERSION,
            ],
        )?;
        enqueued += changed;
    }

    Ok(enqueued)
}

/// 推进一批 backfill / process up to `limit` due jobs.
///
/// 单个 job 失败只影响自己：记 `last_error`、退避、继续下一个。一篇坏笔记不能挡住
/// 整个 vault 的对象化。
pub fn run_backfill_batch(conn: &Connection, limit: usize) -> anyhow::Result<BackfillBatch> {
    let now = now_ms();
    let mut stmt = conn.prepare(
        "SELECT id, source_id, source_checksum, attempt FROM ingestion_jobs
         WHERE job_type = ?1 AND status IN ('pending', 'failed')
           AND COALESCE(next_attempt_at_ms, 0) <= ?2
         ORDER BY created_at_ms
         LIMIT ?3",
    )?;
    let due: Vec<(String, String, Option<String>, i64)> = stmt
        .query_map(params![JOB_TYPE_DOCUMENT, now, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut batch = BackfillBatch::default();

    for (job_id, path, hash, attempt) in due {
        batch.processed += 1;
        match backfill_one_document(conn, &path, hash.as_deref()) {
            Ok(true) => {
                batch.created += 1;
                mark_job_done(conn, &job_id)?;
            }
            Ok(false) => {
                batch.already_present += 1;
                mark_job_done(conn, &job_id)?;
            }
            Err(e) => {
                batch.failed += 1;
                mark_job_failed(conn, &job_id, attempt, &e.to_string())?;
            }
        }
    }

    batch.remaining = pending_job_count(conn)?;
    Ok(batch)
}

/// 建一个 document 对象；已存在返回 `false` / create the object, `false` if it already existed.
fn backfill_one_document(
    conn: &Connection,
    path: &str,
    hash: Option<&str>,
) -> anyhow::Result<bool> {
    let source = SourceRef::file(path);
    if object_store::find_by_source(conn, &source)?.is_some() {
        return Ok(false);
    }

    // 标题取 `files.title`，为空时退回文件名——`files.title` 允许为 NULL，而对象层
    // 的标题会直接出现在面包屑和审批卡上。
    let title: Option<String> = conn
        .query_row(
            "SELECT title FROM files WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| {
        std::path::Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    });

    let mut spec = NewObject::new(ObjectKind::Document, vault_scope_of(path), "migration")
        .with_source(source)
        .with_title(title);
    // 内容不复制进对象层：Markdown 是唯一内容权威。`files.hash` 作为校验和，
    // 后续 `expected_checksum` 比对拿它和磁盘现状比。
    spec.checksum_override = hash.map(|h| h.to_string());
    spec.metadata_json = Some(
        serde_json::json!({ "backfilled_by": BACKFILL_PIPELINE_VERSION }).to_string(),
    );

    object_store::create_object(conn, spec)?;
    Ok(true)
}

/// 从笔记路径推出 vault scope / derive the vault scope from a note path.
///
/// 现有 schema 没有 vault 表，`files.path` 是绝对路径，多 vault 的区分靠前缀
/// (`db::wikilink::LinkResolver` 也是这么判同 vault 的)。这里取父目录作为 scope，
/// 够 warning「跨 scope 召回」用，等真有 vault registry 再收紧。
fn vault_scope_of(path: &str) -> String {
    std::path::Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

// ── job 状态 / job bookkeeping ──────────────────────────────────────────────

fn mark_job_done(conn: &Connection, job_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE ingestion_jobs
         SET status = 'succeeded', progress = 1.0, last_error = NULL,
             next_attempt_at_ms = NULL, updated_at_ms = ?2
         WHERE id = ?1",
        params![job_id, now_ms()],
    )?;
    Ok(())
}

/// 退避：30s、120s、270s…上限 1 小时 / quadratic backoff capped at one hour.
///
/// 二次而不是指数：backfill 的失败多半是坏文件或短暂锁竞争，指数退避会让第 10 次
/// 重试落在几天以后，而这件事应该在一次会话里收敛。
fn mark_job_failed(
    conn: &Connection,
    job_id: &str,
    attempt: i64,
    error: &str,
) -> anyhow::Result<()> {
    let next_attempt = attempt + 1;
    let delay_ms = (30_000i64 * next_attempt * next_attempt).min(3_600_000);
    conn.execute(
        "UPDATE ingestion_jobs
         SET status = 'failed', attempt = ?2, last_error = ?3,
             next_attempt_at_ms = ?4, updated_at_ms = ?5
         WHERE id = ?1",
        params![job_id, next_attempt, error, now_ms() + delay_ms, now_ms()],
    )?;
    Ok(())
}

fn pending_job_count(conn: &Connection) -> anyhow::Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM ingestion_jobs
         WHERE job_type = ?1 AND status IN ('pending', 'failed')",
        params![JOB_TYPE_DOCUMENT],
        |row| row.get(0),
    )?)
}

// ── 按需 block 对象 / block objects on demand ───────────────────────────────

/// 拿到某个 chunk 的稳定对象身份，没有就建 / get or create the block object for a chunk.
///
/// 只在真的需要给块一个可引用身份时调用（evidence locator、块级关系）。这样对象表
/// 里的 block 数量反映"被引用过的块"，而不是"存在过的块"。
pub fn ensure_block_object(conn: &Connection, chunk_id: i64) -> anyhow::Result<String> {
    let source = SourceRef::chunk(chunk_id);
    if let Some(existing) = object_store::find_by_source(conn, &source)? {
        return Ok(existing.id);
    }

    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT file_path, chunk_index, content FROM chunks WHERE id = ?1",
            params![chunk_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((file_path, chunk_index, content)) = row else {
        anyhow::bail!("chunk {chunk_id} does not exist");
    };

    // 父对象是所属笔记。笔记还没 backfill 到就先建它——block 没有父就丢了面包屑。
    let parent_id = match object_store::find_by_source(conn, &SourceRef::file(&file_path))? {
        Some(doc) => doc.id,
        None => {
            let hash: Option<String> = conn
                .query_row(
                    "SELECT hash FROM files WHERE path = ?1",
                    params![file_path],
                    |r| r.get(0),
                )
                .optional()?;
            backfill_one_document(conn, &file_path, hash.as_deref())?;
            object_store::find_by_source(conn, &SourceRef::file(&file_path))?
                .map(|d| d.id)
                .ok_or_else(|| anyhow::anyhow!("failed to create document object for {file_path}"))?
        }
    };

    let mut spec = NewObject::new(ObjectKind::Block, vault_scope_of(&file_path), "migration")
        .with_source(source)
        .with_parent(parent_id)
        .with_checksum(checksum(&content));
    spec.metadata_json =
        Some(serde_json::json!({ "chunk_index": chunk_index }).to_string());

    Ok(object_store::create_object(conn, spec)?.id)
}

// ── 投影健康 / projection health ────────────────────────────────────────────

/// 重算并写入 document 对象化的真实进度 / recompute the real document-projection health.
///
/// 每一个数字都是 `COUNT(*)`。这张表存在的全部意义就是 Index Health 面板不能显示
/// 编出来的进度。
pub fn refresh_document_projection_health(conn: &Connection) -> anyhow::Result<ProjectionHealth> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    let indexed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM knowledge_objects WHERE kind = 'document' AND source_type = 'file'",
        [],
        |r| r.get(0),
    )?;
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ingestion_jobs WHERE job_type = ?1 AND status = 'pending'",
        params![JOB_TYPE_DOCUMENT],
        |r| r.get(0),
    )?;
    let failed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ingestion_jobs WHERE job_type = ?1 AND status = 'failed'",
        params![JOB_TYPE_DOCUMENT],
        |r| r.get(0),
    )?;
    let last_error: Option<String> = conn
        .query_row(
            "SELECT last_error FROM ingestion_jobs
             WHERE job_type = ?1 AND last_error IS NOT NULL
             ORDER BY updated_at_ms DESC LIMIT 1",
            params![JOB_TYPE_DOCUMENT],
            |r| r.get(0),
        )
        .optional()?
        .flatten();

    let now = now_ms();
    let health = ProjectionHealth {
        projection: "knowledge_documents".into(),
        version: 1,
        total_count: total,
        indexed_count: indexed,
        pending_count: pending,
        failed_count: failed,
        last_run_at_ms: Some(now),
        last_error,
        updated_at_ms: now,
    };

    conn.execute(
        "INSERT INTO projection_health
            (projection, version, total_count, indexed_count, pending_count, failed_count,
             last_run_at_ms, last_error, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(projection) DO UPDATE SET
            version = ?2, total_count = ?3, indexed_count = ?4, pending_count = ?5,
            failed_count = ?6, last_run_at_ms = ?7, last_error = ?8, updated_at_ms = ?9",
        params![
            health.projection,
            health.version,
            health.total_count,
            health.indexed_count,
            health.pending_count,
            health.failed_count,
            health.last_run_at_ms,
            health.last_error,
            health.updated_at_ms,
        ],
    )?;

    Ok(health)
}

/// 读回某个投影的健康状况 / read one projection's health back.
pub fn read_projection_health(
    conn: &Connection,
    projection: &str,
) -> anyhow::Result<Option<ProjectionHealth>> {
    Ok(conn
        .query_row(
            "SELECT projection, version, total_count, indexed_count, pending_count,
                    failed_count, last_run_at_ms, last_error, updated_at_ms
             FROM projection_health WHERE projection = ?1",
            params![projection],
            |row| {
                Ok(ProjectionHealth {
                    projection: row.get(0)?,
                    version: row.get(1)?,
                    total_count: row.get(2)?,
                    indexed_count: row.get(3)?,
                    pending_count: row.get(4)?,
                    failed_count: row.get(5)?,
                    last_run_at_ms: row.get(6)?,
                    last_error: row.get(7)?,
                    updated_at_ms: row.get(8)?,
                })
            },
        )
        .optional()?)
}
