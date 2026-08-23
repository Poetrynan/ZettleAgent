//! 版本化、幂等、可重入的知识对象层迁移 / the versioned knowledge-layer migration runner.
//!
//! 现有 `db::schema` 的迁移是「一堆 `let _ = ALTER TABLE`」：能用，但没有版本、
//! 没有失败边界、也无法回答"这个库跑到第几步了"。新表数量足够多，因此这里引入
//! 一个最小 runner，但**不接管**旧迁移——`setup_database_schema`、
//! `migrate_schema_columns`、`migrate_add_update_cascade`、`migrate_links_to_relations`
//! 全部原样保留并继续先执行。
//!
//! 三条硬性保证：
//!
//! 1. **幂等**：已应用的版本记录在 `knowledge_schema_migrations`，重复启动是 no-op。
//! 2. **原子**：每个版本在一个事务里跑完；SQLite 的 DDL 是事务性的，所以一个版本
//!    中途失败不会留下半张表，也不会记版本号。
//! 3. **非破坏**：只 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。
//!    没有 `DROP`、没有 `DELETE`、不触碰 `files`/`chunks`/`ai_memory`/FTS/vec 表。

use rusqlite::Connection;

/// 当前期望的知识层 schema 版本 / the knowledge-layer schema version this build expects.
pub const KNOWLEDGE_SCHEMA_VERSION: i64 = 1;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

/// 一次迁移运行的结果 / what one migration run did.
///
/// 返回而不是只打日志：`projection_health` 和启动自检需要真实数字，Index Health
/// 面板不允许显示写死的值。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MigrationReport {
    /// 本次真正应用的版本号 / versions applied by this call.
    pub applied: Vec<i64>,
    /// 运行结束后库里的版本 / the schema version after this call.
    pub version: i64,
}

impl MigrationReport {
    pub fn is_noop(&self) -> bool {
        self.applied.is_empty()
    }
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "knowledge_object_layer",
    sql: V1_KNOWLEDGE_OBJECT_LAYER,
}];

/// 应用所有未应用的知识层迁移 / apply every not-yet-applied knowledge migration.
///
/// 失败时返回 `Err` 并保持库可用（上一个成功版本的状态），调用方应记录警告后继续
/// 启动：对象层缺失只让新功能降级，不能让用户打不开笔记。
pub fn run_knowledge_migrations(conn: &Connection) -> anyhow::Result<MigrationReport> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_schema_migrations (
            version       INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
        );",
        [],
    )?;

    let mut report = MigrationReport::default();

    for m in MIGRATIONS {
        let already: i64 = conn.query_row(
            "SELECT COUNT(*) FROM knowledge_schema_migrations WHERE version = ?1",
            [m.version],
            |row| row.get(0),
        )?;
        if already > 0 {
            continue;
        }

        // BEGIN IMMEDIATE：迁移要写，直接拿写锁，避免与 scheduler 的后台写抢到一半
        // 才升级成写事务而失败。
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let outcome = conn.execute_batch(m.sql).and_then(|()| {
            conn.execute(
                "INSERT INTO knowledge_schema_migrations (version, name, applied_at_ms)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![m.version, m.name, super::types::now_ms()],
            )
            .map(|_| ())
        });

        match outcome {
            Ok(()) => {
                conn.execute_batch("COMMIT;")?;
                log::info!("knowledge migration {} ({}) applied", m.version, m.name);
                report.applied.push(m.version);
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(anyhow::anyhow!(
                    "knowledge migration {} ({}) failed and was rolled back: {}",
                    m.version,
                    m.name,
                    e
                ));
            }
        }
    }

    report.version = current_version(conn)?;
    Ok(report)
}

/// 库里已应用的最高版本 / the highest applied version, 0 for a fresh database.
pub fn current_version(conn: &Connection) -> anyhow::Result<i64> {
    let v: Option<i64> = conn
        .query_row(
            "SELECT MAX(version) FROM knowledge_schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(None);
    Ok(v.unwrap_or(0))
}

// ── v1 ──────────────────────────────────────────────────────────────────────
//
// 为什么这些表都不对 `files(path)` 建外键：一个对象的 source 可能是文件、chunk、
// 对话、网页或 MCP 结果，`source_id` 是多态列，没法用单一外键约束。删除笔记时对象
// 不应级联消失——撤销一轮 Agent 变更需要对象身份仍然在。孤儿由 `projection_health`
// 统计并由 reconcile 清理，而不是由 SQLite 静默删除。
const V1_KNOWLEDGE_OBJECT_LAYER: &str = r#"
CREATE TABLE IF NOT EXISTS knowledge_objects (
    id                 TEXT PRIMARY KEY,
    kind               TEXT NOT NULL,
    scope              TEXT NOT NULL DEFAULT '',
    parent_id          TEXT REFERENCES knowledge_objects(id) ON DELETE SET NULL,
    source_type        TEXT,
    source_id          TEXT,
    title              TEXT,
    canonical_content  TEXT,
    content_format     TEXT NOT NULL DEFAULT 'markdown',
    status             TEXT NOT NULL DEFAULT 'active',
    current_version    INTEGER NOT NULL DEFAULT 1,
    created_at_ms      INTEGER NOT NULL,
    updated_at_ms      INTEGER NOT NULL,
    valid_from_ms      INTEGER,
    valid_to_ms        INTEGER,
    supersedes_id      TEXT,
    confidence         REAL NOT NULL DEFAULT 1.0,
    user_confirmed     INTEGER NOT NULL DEFAULT 0,
    metadata_json      TEXT
);
-- backfill 的幂等锚点：同一个 (source_type, source_id) 只能有一个活对象。
--
-- 只对"投影自某一行 legacy backing"的对象有意义：一篇笔记一个 document、一个 chunk
-- 一个 block。原生于本层的对象（memory / fact / claim / task）**必须留 NULL**——
-- 一场对话会产出很多条记忆，把 session id 填进来第二条就撞索引了。它们的来源记在
-- 各自表的 source_* 列和 evidence 行上。索引是 partial 的，所以留 NULL 不占约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_objects_source
    ON knowledge_objects(source_type, source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_objects_kind ON knowledge_objects(kind, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_objects_parent ON knowledge_objects(parent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_objects_scope ON knowledge_objects(scope);

CREATE TABLE IF NOT EXISTS object_versions (
    object_id      TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    content        TEXT,
    checksum       TEXT NOT NULL,
    actor          TEXT NOT NULL,
    run_id         TEXT,
    session_id     TEXT,
    changeset_id   TEXT,
    created_at_ms  INTEGER NOT NULL,
    valid_from_ms  INTEGER,
    valid_to_ms    INTEGER,
    PRIMARY KEY (object_id, version)
);
CREATE INDEX IF NOT EXISTS idx_object_versions_run ON object_versions(run_id);
CREATE INDEX IF NOT EXISTS idx_object_versions_changeset ON object_versions(changeset_id);

CREATE TABLE IF NOT EXISTS evidence (
    id                TEXT PRIMARY KEY,
    source_type       TEXT NOT NULL,
    source_id         TEXT NOT NULL,
    locator           TEXT,
    excerpt           TEXT,
    checksum          TEXT,
    captured_at_ms    INTEGER NOT NULL,
    author            TEXT,
    extraction_model  TEXT,
    pipeline_version  TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source_type, source_id);

CREATE TABLE IF NOT EXISTS object_evidence (
    object_id    TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    evidence_id  TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'supports',
    confidence   REAL NOT NULL DEFAULT 0.5,
    PRIMARY KEY (object_id, evidence_id, role)
);
CREATE INDEX IF NOT EXISTS idx_object_evidence_evidence ON object_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS relations_v2 (
    id                 TEXT PRIMARY KEY,
    source_object_id   TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    target_object_id   TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    relation_type      TEXT NOT NULL,
    provenance         TEXT NOT NULL DEFAULT 'extracted',
    confidence         REAL NOT NULL DEFAULT 0.5,
    valid_from_ms      INTEGER,
    valid_to_ms        INTEGER,
    status             TEXT NOT NULL DEFAULT 'active',
    evidence_ids       TEXT NOT NULL DEFAULT '[]',
    supersedes_id      TEXT,
    conflicts_with_id  TEXT,
    created_at_ms      INTEGER NOT NULL,
    UNIQUE(source_object_id, target_object_id, relation_type, provenance)
);
CREATE INDEX IF NOT EXISTS idx_relations_v2_source ON relations_v2(source_object_id, status);
CREATE INDEX IF NOT EXISTS idx_relations_v2_target ON relations_v2(target_object_id, status);

CREATE TABLE IF NOT EXISTS memory_items (
    id                          TEXT PRIMARY KEY,
    object_id                   TEXT REFERENCES knowledge_objects(id) ON DELETE SET NULL,
    kind                        TEXT NOT NULL DEFAULT 'semantic',
    lifecycle                   TEXT NOT NULL DEFAULT 'candidate',
    claim                       TEXT NOT NULL,
    scope                       TEXT NOT NULL DEFAULT '',
    confidence                  REAL NOT NULL DEFAULT 0.5,
    importance                  REAL NOT NULL DEFAULT 1.0,
    source_type                 TEXT,
    source_id                   TEXT,
    valid_from_ms               INTEGER,
    valid_to_ms                 INTEGER,
    supersedes_id               TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
    conflicts_with_id           TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
    confirmed_by                TEXT,
    confirmed_at_ms             INTEGER,
    requires_user_confirmation  INTEGER NOT NULL DEFAULT 0,
    last_accessed_ms            INTEGER,
    expires_at_ms               INTEGER,
    section                     TEXT,
    created_at_ms               INTEGER NOT NULL,
    updated_at_ms               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_items_lifecycle ON memory_items(lifecycle, kind);
CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope);
CREATE INDEX IF NOT EXISTS idx_memory_items_expiry ON memory_items(expires_at_ms);
-- Memory Inbox 的查询就是这一个索引：待确认的按时间倒序。
CREATE INDEX IF NOT EXISTS idx_memory_items_inbox
    ON memory_items(requires_user_confirmation, created_at_ms);

CREATE TABLE IF NOT EXISTS changesets (
    id                TEXT PRIMARY KEY,
    actor             TEXT NOT NULL,
    session_id        TEXT,
    run_id            TEXT,
    intent            TEXT,
    state             TEXT NOT NULL DEFAULT 'proposed',
    risk              TEXT NOT NULL DEFAULT 'low',
    requires_approval INTEGER NOT NULL DEFAULT 1,
    dry_run           INTEGER NOT NULL DEFAULT 1,
    evidence_ids      TEXT NOT NULL DEFAULT '[]',
    created_at_ms     INTEGER NOT NULL,
    updated_at_ms     INTEGER NOT NULL,
    commit_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_changesets_run ON changesets(run_id);
CREATE INDEX IF NOT EXISTS idx_changesets_state ON changesets(state, updated_at_ms);

CREATE TABLE IF NOT EXISTS changeset_ops (
    id                 TEXT PRIMARY KEY,
    changeset_id       TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    seq                INTEGER NOT NULL,
    target_object_id   TEXT,
    legacy_path        TEXT,
    legacy_chunk_id    INTEGER,
    op_kind            TEXT NOT NULL,
    old_version        INTEGER,
    expected_checksum  TEXT,
    new_content        TEXT,
    patch              TEXT,
    reason             TEXT,
    evidence_ids       TEXT NOT NULL DEFAULT '[]',
    affected_objects   TEXT NOT NULL DEFAULT '[]',
    side_effects       TEXT,
    UNIQUE(changeset_id, seq)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id              TEXT PRIMARY KEY,
    actor           TEXT NOT NULL,
    run_id          TEXT,
    session_id      TEXT,
    event           TEXT NOT NULL,
    object_id       TEXT,
    tool_name       TEXT,
    scope           TEXT,
    before_version  INTEGER,
    after_version   INTEGER,
    result          TEXT NOT NULL DEFAULT 'ok',
    metadata_json   TEXT,
    created_at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_run ON audit_events(run_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_audit_events_object ON audit_events(object_id, created_at_ms);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id                   TEXT PRIMARY KEY,
    idempotency_key      TEXT NOT NULL UNIQUE,
    job_type             TEXT NOT NULL,
    source_type          TEXT NOT NULL,
    source_id            TEXT NOT NULL,
    source_checksum      TEXT,
    status               TEXT NOT NULL DEFAULT 'pending',
    progress             REAL NOT NULL DEFAULT 0.0,
    attempt              INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms   INTEGER,
    last_error           TEXT,
    pipeline_version     TEXT,
    created_at_ms        INTEGER NOT NULL,
    updated_at_ms        INTEGER NOT NULL
);
-- 取下一批可跑的任务：状态 + 退避时间。
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_claim
    ON ingestion_jobs(status, next_attempt_at_ms);

CREATE TABLE IF NOT EXISTS task_commitments (
    id                      TEXT PRIMARY KEY,
    object_id               TEXT REFERENCES knowledge_objects(id) ON DELETE SET NULL,
    commitment_type         TEXT NOT NULL DEFAULT 'commitment',
    title                   TEXT NOT NULL,
    source_type             TEXT,
    source_id               TEXT,
    evidence_ids            TEXT NOT NULL DEFAULT '[]',
    owner                   TEXT,
    status                  TEXT NOT NULL DEFAULT 'proposed',
    priority                INTEGER NOT NULL DEFAULT 0,
    due_at_ms               INTEGER,
    remind_at_ms            INTEGER,
    dedupe_key              TEXT NOT NULL UNIQUE,
    proactive_enabled       INTEGER NOT NULL DEFAULT 1,
    last_notified_at_ms     INTEGER,
    notify_count            INTEGER NOT NULL DEFAULT 0,
    completion_evidence_id  TEXT REFERENCES evidence(id) ON DELETE SET NULL,
    return_target           TEXT,
    created_at_ms           INTEGER NOT NULL,
    updated_at_ms           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_commitments_status ON task_commitments(status, due_at_ms);
CREATE INDEX IF NOT EXISTS idx_task_commitments_remind ON task_commitments(remind_at_ms);

CREATE TABLE IF NOT EXISTS projection_health (
    projection      TEXT PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 1,
    total_count     INTEGER NOT NULL DEFAULT 0,
    indexed_count   INTEGER NOT NULL DEFAULT 0,
    pending_count   INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    last_run_at_ms  INTEGER,
    last_error      TEXT,
    updated_at_ms   INTEGER NOT NULL
);
"#;
