//! 证据 / evidence.
//!
//! 一条事实如果说不出"这话是从哪儿来的"，在这套系统里就不算事实。这个模块只做两
//! 件事：登记证据，把证据绑到对象上。
//!
//! 证据是**内容寻址**的：同一段原文被两条 claim 引用时不会存两份，`(source_type,
//! source_id, locator, checksum)` 相同即视为同一条证据。这让 memory extractor
//! 反复处理同一段对话时不会把证据表撑爆。

use rusqlite::{params, Connection, OptionalExtension};

use super::object_store::{ObjectError, ObjectResult};
use super::types::*;

/// 新证据的入参 / the arguments for recording evidence.
#[derive(Debug, Clone)]
pub struct NewEvidence {
    pub source_type: String,
    pub source_id: String,
    /// 回到原文的可点击坐标，如 `notes/a.md#L12-L18` 或 `chunk:41`。
    pub locator: Option<String>,
    pub excerpt: Option<String>,
    pub author: Option<String>,
    /// 抽取它的模型。换模型后旧结论要能被重新评估，所以这不是可选的装饰。
    pub extraction_model: Option<String>,
    pub pipeline_version: Option<String>,
}

impl NewEvidence {
    pub fn new(source: SourceRef) -> Self {
        Self {
            source_type: source.source_type,
            source_id: source.source_id,
            locator: None,
            excerpt: None,
            author: None,
            extraction_model: None,
            pipeline_version: None,
        }
    }

    pub fn with_locator(mut self, locator: impl Into<String>) -> Self {
        self.locator = Some(locator.into());
        self
    }

    pub fn with_excerpt(mut self, excerpt: impl Into<String>) -> Self {
        self.excerpt = Some(excerpt.into());
        self
    }

    pub fn with_model(
        mut self,
        model: impl Into<String>,
        pipeline_version: impl Into<String>,
    ) -> Self {
        self.extraction_model = Some(model.into());
        self.pipeline_version = Some(pipeline_version.into());
        self
    }

    /// 摘录的校验和 / the checksum of the excerpt.
    ///
    /// 原文后来被改掉时，这个值让 UI 能说"证据已过期"而不是继续假装引用成立。
    fn excerpt_checksum(&self) -> Option<String> {
        self.excerpt.as_deref().map(checksum)
    }
}

/// 登记一条证据，已存在则返回原 ID / record evidence, returning the existing id if any.
pub fn record_evidence(conn: &Connection, spec: NewEvidence) -> ObjectResult<String> {
    let sum = spec.excerpt_checksum();

    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM evidence
             WHERE source_type = ?1 AND source_id = ?2
               AND COALESCE(locator, '') = COALESCE(?3, '')
               AND COALESCE(checksum, '') = COALESCE(?4, '')",
            params![spec.source_type, spec.source_id, spec.locator, sum],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let id = new_object_id();
    conn.execute(
        "INSERT INTO evidence
            (id, source_type, source_id, locator, excerpt, checksum, captured_at_ms,
             author, extraction_model, pipeline_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            spec.source_type,
            spec.source_id,
            spec.locator,
            spec.excerpt,
            sum,
            now_ms(),
            spec.author,
            spec.extraction_model,
            spec.pipeline_version,
        ],
    )?;
    Ok(id)
}

/// 把证据绑到对象上 / bind evidence to an object.
///
/// `role` 区分 `supports` 与 `contradicts`：冲突的证据必须能和支持的证据一起存，
/// 否则"冲突事实同时保留"就无从实现。
pub fn attach_evidence(
    conn: &Connection,
    object_id: &str,
    evidence_id: &str,
    role: &str,
    confidence: f64,
) -> ObjectResult<()> {
    conn.execute(
        "INSERT INTO object_evidence (object_id, evidence_id, role, confidence)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(object_id, evidence_id, role) DO UPDATE SET confidence = ?4",
        params![object_id, evidence_id, role, confidence],
    )?;
    Ok(())
}

/// 某个对象的全部证据 / all evidence attached to an object.
pub fn evidence_for_object(
    conn: &Connection,
    object_id: &str,
) -> ObjectResult<Vec<(Evidence, String, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.source_type, e.source_id, e.locator, e.excerpt, e.checksum,
                e.captured_at_ms, e.author, e.extraction_model, e.pipeline_version,
                oe.role, oe.confidence
         FROM object_evidence oe
         JOIN evidence e ON e.id = oe.evidence_id
         WHERE oe.object_id = ?1
         ORDER BY oe.confidence DESC, e.captured_at_ms",
    )?;
    let rows = stmt
        .query_map(params![object_id], |row| {
            Ok((
                Evidence {
                    id: row.get(0)?,
                    source_type: row.get(1)?,
                    source_id: row.get(2)?,
                    locator: row.get(3)?,
                    excerpt: row.get(4)?,
                    checksum: row.get(5)?,
                    captured_at_ms: row.get(6)?,
                    author: row.get(7)?,
                    extraction_model: row.get(8)?,
                    pipeline_version: row.get(9)?,
                },
                row.get::<_, String>(10)?,
                row.get::<_, f64>(11)?,
            ))
        })?
        .collect::<Result<Vec<_>, rusqlite::Error>>()
        .map_err(ObjectError::from)?;
    Ok(rows)
}
