//! 统一知识对象层 / the unified knowledge-object layer.
//!
//! ## 这一层是什么
//!
//! Agent 需要一个稳定的东西可以指着说"就是它"：加证据、连关系、提改动、要审批、
//! 回滚。`files.path` 做不到（重命名就换身份），`chunks.id` 做不到（重新分块就
//! 失效），LLM 输出的字符串更做不到。所以有了 `knowledge_objects`。
//!
//! ## 这一层不是什么
//!
//! 不是新的存储。原始 Markdown 仍然是唯一内容权威，`files` / `chunks` / FTS5 /
//! sqlite-vec / `ai_memory` / `note_relations` 全部原样保留并继续被旧代码读写。
//! 本层的每一行都可以从 vault 重建，`document` 和 `block` 对象甚至不存内容副本，
//! 只存校验和。
//!
//! ## 模块分工
//!
//! - [`types`]：对象、证据、关系、记忆、changeset、job、承诺的类型。
//! - [`migration`]：版本化、幂等、单版本原子的建表 runner。
//! - [`object_store`]：唯一的对象写入口，负责版本追加与冲突检测。
//! - [`evidence`]：内容寻址的证据登记与绑定。
//! - [`memory`]：记忆生命周期，把 `DELETE + INSERT` 换成取代链与冲突集。
//! - [`backfill`]：`files` → `document` 对象的可恢复批处理与真实进度统计。
//! - [`retrieval`]：在 `db::search` 之上加 provenance 与 scope 的统一召回。
//! - [`changeset`]：Agent 写入的提议、预演、冲突检测与提交记账。

pub mod backfill;
pub mod changeset;
pub mod evidence;
pub mod memory;
pub mod migration;
pub mod object_store;
pub mod retrieval;
pub mod types;

use rusqlite::Connection;

/// 启动时知识层做了什么 / what the knowledge layer did at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapReport {
    pub schema_version: i64,
    pub migrations_applied: Vec<i64>,
    /// 新入队的 backfill job 数。
    pub backfill_enqueued: usize,
    pub backfill_pending: i64,
}

/// 建表 + 入队 backfill，但不在启动时跑 backfill / migrate and enqueue, never process.
///
/// 刻意只入队不处理：`enqueue_document_backfill` 是一次 `NOT EXISTS` 扫描，
/// 而处理要读文件、算校验和、写对象。前者可以放在启动路径上，后者必须交给
/// scheduler，否则一个大 vault 的第一次升级会让应用看起来卡死。
pub fn bootstrap(conn: &Connection) -> anyhow::Result<BootstrapReport> {
    let migration_report = migration::run_knowledge_migrations(conn)?;
    let enqueued = backfill::enqueue_document_backfill(conn)?;
    let health = backfill::refresh_document_projection_health(conn)?;

    Ok(BootstrapReport {
        schema_version: migration_report.version,
        migrations_applied: migration_report.applied,
        backfill_enqueued: enqueued,
        backfill_pending: health.pending_count + health.failed_count,
    })
}

#[cfg(test)]
mod tests;
