//! 对象读写 / the object store.
//!
//! 这是知识层唯一允许写 `knowledge_objects` / `object_versions` / `relations_v2`
//! 的地方。所有写入都会：
//!
//! - 追加一条 `object_versions`（谁改的、哪一轮、哪个 changeset、内容校验和）；
//! - 校验 `expected_version` / `expected_checksum`，不匹配返回
//!   [`ObjectError::VersionConflict`] / [`ObjectError::ChecksumConflict`]，
//!   **绝不静默覆盖**；
//! - 只做墓碑式归档/删除，物理行保留，撤销才有东西可回。

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::types::*;

/// 对象层的失败模式 / the ways an object write can fail.
///
/// 冲突是独立变体而不是一句字符串错误：上层要能区分"写不进去"和"别人先改了"，
/// 后者在 UI 上必须给出重新生成/放弃的选择，而不是重试。
#[derive(Debug, thiserror::Error)]
pub enum ObjectError {
    #[error("knowledge object {0} not found")]
    NotFound(String),

    #[error("version conflict on {object_id}: caller expected v{expected}, store has v{actual}")]
    VersionConflict {
        object_id: String,
        expected: i64,
        actual: i64,
    },

    #[error("checksum conflict on {object_id}: content changed since it was read")]
    ChecksumConflict {
        object_id: String,
        expected: String,
        actual: String,
    },

    #[error("unknown enum value {value:?} in column {column}")]
    UnknownEnum { column: &'static str, value: String },

    /// `db::search` 用 `anyhow`，本层用具体错误类型。检索失败不是对象层的问题，
    /// 但调用方需要一个统一的 `Result`，所以在边界上转成这一个变体。
    #[error("retrieval failed: {0}")]
    Search(String),

    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}

pub type ObjectResult<T> = Result<T, ObjectError>;

/// 新建对象的入参 / the arguments for creating an object.
///
/// 独立结构体而不是十五个位置参数：字段还会继续长，而位置参数一旦顺序写错编译器
/// 抓不到（全是 `Option<String>`）。
#[derive(Debug, Clone)]
pub struct NewObject {
    pub kind: ObjectKind,
    pub scope: String,
    pub parent_id: Option<String>,
    pub source: Option<SourceRef>,
    pub title: Option<String>,
    /// `Document`/`Block` 传 `None`：内容权威在 Markdown，这里存副本会产生第二事实源。
    pub content: Option<String>,
    /// 内容不在本层时的校验和来源（如 `files.hash`）。
    pub checksum_override: Option<String>,
    pub content_format: String,
    pub confidence: f64,
    pub user_confirmed: bool,
    pub valid_from_ms: Option<i64>,
    pub valid_to_ms: Option<i64>,
    pub supersedes_id: Option<String>,
    pub metadata_json: Option<String>,
    pub actor: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub changeset_id: Option<String>,
}

impl NewObject {
    /// 最小构造 / the minimum an object needs.
    pub fn new(kind: ObjectKind, scope: impl Into<String>, actor: impl Into<String>) -> Self {
        Self {
            kind,
            scope: scope.into(),
            parent_id: None,
            source: None,
            title: None,
            content: None,
            checksum_override: None,
            content_format: "markdown".into(),
            confidence: 1.0,
            user_confirmed: false,
            valid_from_ms: None,
            valid_to_ms: None,
            supersedes_id: None,
            metadata_json: None,
            actor: actor.into(),
            run_id: None,
            session_id: None,
            changeset_id: None,
        }
    }

    pub fn with_source(mut self, source: SourceRef) -> Self {
        self.source = Some(source);
        self
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_content(mut self, content: impl Into<String>) -> Self {
        self.content = Some(content.into());
        self
    }

    pub fn with_checksum(mut self, checksum: impl Into<String>) -> Self {
        self.checksum_override = Some(checksum.into());
        self
    }

    pub fn with_parent(mut self, parent_id: impl Into<String>) -> Self {
        self.parent_id = Some(parent_id.into());
        self
    }

    fn resolved_checksum(&self) -> String {
        match (&self.checksum_override, &self.content) {
            (Some(c), _) => c.clone(),
            (None, Some(body)) => checksum(body),
            (None, None) => checksum(""),
        }
    }
}

// ── 行映射 / row mapping ────────────────────────────────────────────────────

const OBJECT_COLUMNS: &str = "id, kind, scope, parent_id, source_type, source_id, title,
     canonical_content, content_format, status, current_version, created_at_ms, updated_at_ms,
     valid_from_ms, valid_to_ms, supersedes_id, confidence, user_confirmed, metadata_json";

fn parse_enum<T>(
    column: &'static str,
    raw: String,
    f: impl Fn(&str) -> Option<T>,
) -> ObjectResult<T> {
    f(&raw).ok_or(ObjectError::UnknownEnum { column, value: raw })
}

fn map_object(row: &Row<'_>) -> ObjectResult<KnowledgeObject> {
    let source_type: Option<String> = row.get(4)?;
    let source_id: Option<String> = row.get(5)?;
    Ok(KnowledgeObject {
        id: row.get(0)?,
        kind: parse_enum("kind", row.get(1)?, ObjectKind::parse)?,
        scope: row.get(2)?,
        parent_id: row.get(3)?,
        source: match (source_type, source_id) {
            (Some(source_type), Some(source_id)) => Some(SourceRef { source_type, source_id }),
            _ => None,
        },
        title: row.get(6)?,
        canonical_content: row.get(7)?,
        content_format: row.get(8)?,
        status: parse_enum("status", row.get(9)?, ObjectStatus::parse)?,
        current_version: row.get(10)?,
        created_at_ms: row.get(11)?,
        updated_at_ms: row.get(12)?,
        valid_from_ms: row.get(13)?,
        valid_to_ms: row.get(14)?,
        supersedes_id: row.get(15)?,
        confidence: row.get(16)?,
        user_confirmed: row.get::<_, i64>(17)? != 0,
        metadata_json: row.get(18)?,
    })
}

// ── 读 / reads ──────────────────────────────────────────────────────────────

/// 按 ID 取对象 / fetch one object by its stable id.
pub fn get_object(conn: &Connection, id: &str) -> ObjectResult<Option<KnowledgeObject>> {
    let sql = format!("SELECT {OBJECT_COLUMNS} FROM knowledge_objects WHERE id = ?1");
    conn.query_row(&sql, params![id], |row| Ok(map_object(row)))
        .optional()?
        .transpose()
}

/// 按 legacy source 取对象 / fetch by the row it was backfilled from.
///
/// backfill 的幂等性靠这个函数 + `idx_knowledge_objects_source` 唯一索引，
/// 而不是靠"跑一次就别再跑"。
pub fn find_by_source(
    conn: &Connection,
    source: &SourceRef,
) -> ObjectResult<Option<KnowledgeObject>> {
    let sql = format!(
        "SELECT {OBJECT_COLUMNS} FROM knowledge_objects
         WHERE source_type = ?1 AND source_id = ?2"
    );
    conn.query_row(&sql, params![source.source_type, source.source_id], |row| {
        Ok(map_object(row))
    })
    .optional()?
    .transpose()
}

/// 取某个历史版本 / fetch one historical version.
pub fn get_object_version(
    conn: &Connection,
    object_id: &str,
    version: i64,
) -> ObjectResult<Option<ObjectVersion>> {
    conn.query_row(
        "SELECT object_id, version, content, checksum, actor, run_id, session_id, changeset_id,
                created_at_ms, valid_from_ms, valid_to_ms
         FROM object_versions WHERE object_id = ?1 AND version = ?2",
        params![object_id, version],
        |row| {
            Ok(ObjectVersion {
                object_id: row.get(0)?,
                version: row.get(1)?,
                content: row.get(2)?,
                checksum: row.get(3)?,
                actor: row.get(4)?,
                run_id: row.get(5)?,
                session_id: row.get(6)?,
                changeset_id: row.get(7)?,
                created_at_ms: row.get(8)?,
                valid_from_ms: row.get(9)?,
                valid_to_ms: row.get(10)?,
            })
        },
    )
    .optional()
    .map_err(ObjectError::from)
}

/// 子对象 / the children of an object, oldest first.
pub fn list_children(conn: &Connection, parent_id: &str) -> ObjectResult<Vec<KnowledgeObject>> {
    let sql = format!(
        "SELECT {OBJECT_COLUMNS} FROM knowledge_objects
         WHERE parent_id = ?1 AND status != 'deleted'
         ORDER BY created_at_ms, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![parent_id], |row| Ok(map_object(row)))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().collect()
}

/// 从对象往上到根的路径 / the ancestor chain, root first.
///
/// 带环保护：`parent_id` 是自引用外键，理论上不该成环，但一次坏迁移就能造出环，
/// 而面包屑是 UI 每次渲染都要走的路径。
pub fn get_breadcrumb(conn: &Connection, id: &str) -> ObjectResult<Vec<KnowledgeObject>> {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cursor = Some(id.to_string());

    while let Some(current) = cursor {
        if !seen.insert(current.clone()) {
            log::warn!("knowledge object parent cycle detected at {current}");
            break;
        }
        let Some(obj) = get_object(conn, &current)? else { break };
        cursor = obj.parent_id.clone();
        chain.push(obj);
    }

    chain.reverse();
    Ok(chain)
}

// ── 写 / writes ─────────────────────────────────────────────────────────────

/// 新建对象，并写下 v1 / create an object and its first version row.
pub fn create_object(conn: &Connection, spec: NewObject) -> ObjectResult<KnowledgeObject> {
    let id = new_object_id();
    let now = now_ms();
    let sum = spec.resolved_checksum();
    let (source_type, source_id) = match &spec.source {
        Some(s) => (Some(s.source_type.clone()), Some(s.source_id.clone())),
        None => (None, None),
    };

    conn.execute(
        "INSERT INTO knowledge_objects
            (id, kind, scope, parent_id, source_type, source_id, title, canonical_content,
             content_format, status, current_version, created_at_ms, updated_at_ms,
             valid_from_ms, valid_to_ms, supersedes_id, confidence, user_confirmed, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', 1, ?10, ?10,
                 ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            spec.kind.as_str(),
            spec.scope,
            spec.parent_id,
            source_type,
            source_id,
            spec.title,
            spec.content,
            spec.content_format,
            now,
            spec.valid_from_ms,
            spec.valid_to_ms,
            spec.supersedes_id,
            spec.confidence,
            i64::from(spec.user_confirmed),
            spec.metadata_json,
        ],
    )?;

    insert_version(
        conn,
        &id,
        1,
        spec.content.as_deref(),
        &sum,
        &spec.actor,
        spec.run_id.as_deref(),
        spec.session_id.as_deref(),
        spec.changeset_id.as_deref(),
        now,
        spec.valid_from_ms,
        spec.valid_to_ms,
    )?;

    // 取代关系是链，不是覆盖：旧对象保留内容与证据，只改状态。
    if let Some(old) = &spec.supersedes_id {
        conn.execute(
            "UPDATE knowledge_objects SET status = 'superseded', updated_at_ms = ?2,
                    valid_to_ms = COALESCE(valid_to_ms, ?2)
             WHERE id = ?1 AND status = 'active'",
            params![old, now],
        )?;
    }

    get_object(conn, &id)?.ok_or_else(|| ObjectError::NotFound(id))
}

#[allow(clippy::too_many_arguments)]
fn insert_version(
    conn: &Connection,
    object_id: &str,
    version: i64,
    content: Option<&str>,
    sum: &str,
    actor: &str,
    run_id: Option<&str>,
    session_id: Option<&str>,
    changeset_id: Option<&str>,
    created_at_ms: i64,
    valid_from_ms: Option<i64>,
    valid_to_ms: Option<i64>,
) -> ObjectResult<()> {
    conn.execute(
        "INSERT INTO object_versions
            (object_id, version, content, checksum, actor, run_id, session_id, changeset_id,
             created_at_ms, valid_from_ms, valid_to_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            object_id,
            version,
            content,
            sum,
            actor,
            run_id,
            session_id,
            changeset_id,
            created_at_ms,
            valid_from_ms,
            valid_to_ms
        ],
    )?;
    Ok(())
}

/// 一次带乐观并发检查的更新 / one optimistically-checked update.
#[derive(Debug, Clone, Default)]
pub struct ObjectPatch {
    pub title: Option<String>,
    pub content: Option<String>,
    /// 内容不在本层时的新校验和（如重新读到的 `files.hash`）。
    pub checksum_override: Option<String>,
    pub metadata_json: Option<String>,
    pub confidence: Option<f64>,
    pub user_confirmed: Option<bool>,
    pub valid_from_ms: Option<i64>,
    pub valid_to_ms: Option<i64>,
    /// 调用方读到的版本。`Some` 时不匹配即冲突。
    pub expected_version: Option<i64>,
    /// 调用方读到的内容校验和。`Some` 时不匹配即冲突。
    pub expected_checksum: Option<String>,
    pub actor: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub changeset_id: Option<String>,
}

/// 更新对象并递增版本 / patch an object, bumping its version.
///
/// 两道并发检查按"先版本后校验和"的顺序：版本不匹配说明有人提交过，校验和不匹配
/// 说明磁盘内容变了但没走本层（用户在编辑器里改的）。两种都返回冲突，让上层去问
/// 用户，而不是赌一把覆盖。
pub fn update_object_patch(
    conn: &Connection,
    object_id: &str,
    patch: ObjectPatch,
) -> ObjectResult<KnowledgeObject> {
    let current = get_object(conn, object_id)?
        .ok_or_else(|| ObjectError::NotFound(object_id.to_string()))?;

    if let Some(expected) = patch.expected_version {
        if expected != current.current_version {
            return Err(ObjectError::VersionConflict {
                object_id: object_id.to_string(),
                expected,
                actual: current.current_version,
            });
        }
    }

    let stored_checksum = get_object_version(conn, object_id, current.current_version)?
        .map(|v| v.checksum)
        .unwrap_or_default();

    if let Some(expected) = &patch.expected_checksum {
        if expected != &stored_checksum {
            return Err(ObjectError::ChecksumConflict {
                object_id: object_id.to_string(),
                expected: expected.clone(),
                actual: stored_checksum,
            });
        }
    }

    let next_version = current.current_version + 1;
    let now = now_ms();
    let new_content = patch.content.clone().or(current.canonical_content.clone());
    let new_sum = match (&patch.checksum_override, &patch.content) {
        (Some(c), _) => c.clone(),
        (None, Some(body)) => checksum(body),
        // 只改了标题/元数据：内容没动，校验和跟着不动。
        (None, None) => stored_checksum,
    };

    conn.execute(
        "UPDATE knowledge_objects SET
            title = COALESCE(?2, title),
            canonical_content = ?3,
            metadata_json = COALESCE(?4, metadata_json),
            confidence = COALESCE(?5, confidence),
            user_confirmed = COALESCE(?6, user_confirmed),
            valid_from_ms = COALESCE(?7, valid_from_ms),
            valid_to_ms = COALESCE(?8, valid_to_ms),
            current_version = ?9,
            updated_at_ms = ?10
         WHERE id = ?1",
        params![
            object_id,
            patch.title,
            new_content,
            patch.metadata_json,
            patch.confidence,
            patch.user_confirmed.map(i64::from),
            patch.valid_from_ms,
            patch.valid_to_ms,
            next_version,
            now,
        ],
    )?;

    insert_version(
        conn,
        object_id,
        next_version,
        new_content.as_deref(),
        &new_sum,
        &patch.actor,
        patch.run_id.as_deref(),
        patch.session_id.as_deref(),
        patch.changeset_id.as_deref(),
        now,
        patch.valid_from_ms,
        patch.valid_to_ms,
    )?;

    get_object(conn, object_id)?.ok_or_else(|| ObjectError::NotFound(object_id.to_string()))
}

/// 改父节点 / reparent an object.
///
/// 拒绝把对象挂到自己的子孙下面：那会造出一个从根不可达的环，面包屑和树形 UI 都会
/// 挂在上面。
pub fn move_object(
    conn: &Connection,
    object_id: &str,
    new_parent_id: Option<&str>,
) -> ObjectResult<KnowledgeObject> {
    if get_object(conn, object_id)?.is_none() {
        return Err(ObjectError::NotFound(object_id.to_string()));
    }

    if let Some(parent) = new_parent_id {
        if parent == object_id {
            return Err(ObjectError::UnknownEnum {
                column: "parent_id",
                value: "an object cannot be its own parent".into(),
            });
        }
        let ancestors = get_breadcrumb(conn, parent)?;
        if ancestors.iter().any(|a| a.id == object_id) {
            return Err(ObjectError::UnknownEnum {
                column: "parent_id",
                value: format!("{parent} is a descendant of {object_id}"),
            });
        }
    }

    conn.execute(
        "UPDATE knowledge_objects SET parent_id = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![object_id, new_parent_id, now_ms()],
    )?;
    get_object(conn, object_id)?.ok_or_else(|| ObjectError::NotFound(object_id.to_string()))
}

/// 归档 / archive: 从默认召回里消失，但对象、版本、证据全部保留。
pub fn archive_object(conn: &Connection, object_id: &str) -> ObjectResult<KnowledgeObject> {
    set_status(conn, object_id, ObjectStatus::Archived)
}

/// 恢复 / restore an archived or tombstoned object.
pub fn restore_object(conn: &Connection, object_id: &str) -> ObjectResult<KnowledgeObject> {
    set_status(conn, object_id, ObjectStatus::Active)
}

/// 墓碑式删除 / tombstone an object.
///
/// 不写 `DELETE`：撤销一轮 Agent 变更需要对象身份还在，否则 evidence、relation、
/// changeset 全部指向空气。物理清理是 reconcile 的活，不是这里的。
pub fn tombstone_object(conn: &Connection, object_id: &str) -> ObjectResult<KnowledgeObject> {
    set_status(conn, object_id, ObjectStatus::Deleted)
}

fn set_status(
    conn: &Connection,
    object_id: &str,
    status: ObjectStatus,
) -> ObjectResult<KnowledgeObject> {
    let changed = conn.execute(
        "UPDATE knowledge_objects SET status = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![object_id, status.as_str(), now_ms()],
    )?;
    if changed == 0 {
        return Err(ObjectError::NotFound(object_id.to_string()));
    }
    get_object(conn, object_id)?.ok_or_else(|| ObjectError::NotFound(object_id.to_string()))
}

/// 重新绑定 legacy source / repoint an object at a moved backing row.
///
/// 重命名笔记时调用：对象 ID 不变，只有 `source_id` 跟着新路径走。这正是对象 ID
/// 不能等于 `file_path` 的原因。
pub fn rebind_source(
    conn: &Connection,
    object_id: &str,
    source: &SourceRef,
) -> ObjectResult<()> {
    conn.execute(
        "UPDATE knowledge_objects SET source_type = ?2, source_id = ?3, updated_at_ms = ?4
         WHERE id = ?1",
        params![object_id, source.source_type, source.source_id, now_ms()],
    )?;
    Ok(())
}

// ── 关系 / relations ────────────────────────────────────────────────────────

/// 连边 / link two objects.
///
/// `UNIQUE(source, target, type, provenance)` 让重复调用是 no-op，但**不同
/// provenance 的同一条边并存**：文本里真实存在的 wikilink 和模型推断出来的关联是
/// 两件事，UI 必须能分开显示。
pub fn link_objects(
    conn: &Connection,
    source_object_id: &str,
    target_object_id: &str,
    relation_type: &str,
    provenance: RelationProvenance,
    confidence: f64,
    evidence_ids: &[String],
) -> ObjectResult<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM relations_v2
             WHERE source_object_id = ?1 AND target_object_id = ?2
               AND relation_type = ?3 AND provenance = ?4",
            params![
                source_object_id,
                target_object_id,
                relation_type,
                provenance.as_str()
            ],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let id = new_object_id();
    let evidence_json = serde_json::to_string(evidence_ids).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO relations_v2
            (id, source_object_id, target_object_id, relation_type, provenance, confidence,
             status, evidence_ids, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8)",
        params![
            id,
            source_object_id,
            target_object_id,
            relation_type,
            provenance.as_str(),
            confidence,
            evidence_json,
            now_ms(),
        ],
    )?;
    Ok(id)
}

/// 反向链接 / the objects pointing at this one.
pub fn get_backlinks(conn: &Connection, object_id: &str) -> ObjectResult<Vec<RelationV2>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_object_id, target_object_id, relation_type, provenance, confidence,
                valid_from_ms, valid_to_ms, status, evidence_ids, supersedes_id,
                conflicts_with_id, created_at_ms
         FROM relations_v2
         WHERE target_object_id = ?1 AND status = 'active'
         ORDER BY confidence DESC, created_at_ms",
    )?;
    let rows: Vec<_> = stmt
        .query_map(params![object_id], |row| {
            let provenance_raw: String = row.get(4)?;
            let status_raw: String = row.get(8)?;
            let evidence_raw: String = row.get(9)?;
            Ok((|| -> ObjectResult<RelationV2> {
                Ok(RelationV2 {
                    id: row.get(0)?,
                    source_object_id: row.get(1)?,
                    target_object_id: row.get(2)?,
                    relation_type: row.get(3)?,
                    provenance: parse_enum(
                        "provenance",
                        provenance_raw,
                        RelationProvenance::parse,
                    )?,
                    confidence: row.get(5)?,
                    valid_from_ms: row.get(6)?,
                    valid_to_ms: row.get(7)?,
                    status: parse_enum("status", status_raw, ObjectStatus::parse)?,
                    evidence_ids: serde_json::from_str(&evidence_raw).unwrap_or_default(),
                    supersedes_id: row.get(10)?,
                    conflicts_with_id: row.get(11)?,
                    created_at_ms: row.get(12)?,
                })
            })())
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().collect()
}

// ── 审计 / audit ────────────────────────────────────────────────────────────

/// 记一条审计事件 / append one audit event.
///
/// `metadata_json` 必须由调用方脱敏后再传进来：这里不做二次清理，也不该做——
/// 脱敏的上下文在 `tool_hooks` 那一层，不在 SQL 这一层。
#[allow(clippy::too_many_arguments)]
pub fn record_audit(
    conn: &Connection,
    actor: &str,
    event: &str,
    result: &str,
    object_id: Option<&str>,
    tool_name: Option<&str>,
    run_id: Option<&str>,
    session_id: Option<&str>,
    scope: Option<&str>,
    before_version: Option<i64>,
    after_version: Option<i64>,
    metadata_json: Option<&str>,
) -> ObjectResult<String> {
    let id = new_object_id();
    conn.execute(
        "INSERT INTO audit_events
            (id, actor, run_id, session_id, event, object_id, tool_name, scope,
             before_version, after_version, result, metadata_json, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            actor,
            run_id,
            session_id,
            event,
            object_id,
            tool_name,
            scope,
            before_version,
            after_version,
            result,
            metadata_json,
            now_ms(),
        ],
    )?;
    Ok(id)
}
