//! 记忆生命周期 / the memory lifecycle.
//!
//! 旧的替代语义是 `DELETE old + INSERT new`（`memory_store::delete_matching`）。
//! 那让"用户以前说过什么"、"为什么改的"、"两条说法冲突"全部消失。这里把替代改成
//! 一条链：
//!
//! ```text
//! candidate → verified / active → superseded / expired / archived → forgotten
//! ```
//!
//! ## 与旧层的关系
//!
//! `ai_memory` 不动，继续是 **legacy recall 的后端**——旧命令、旧 prompt 注入路径
//! 都照原样工作。本层是事实源，确认后向 `ai_memory` 投影一行；`forget` 时把投影行
//! 删掉。所以两层永远一致，但历史只存在本层。
//!
//! ## 一条纪律
//!
//! 模型自己不能把自己升级成 `verified`。`confirmed_by` 只由用户动作写入，
//! [`requires_confirmation`] 决定哪些提案必须先进 Memory Inbox。

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::evidence::{self, NewEvidence};
use super::object_store::{self, NewObject, ObjectError, ObjectResult};
use super::types::*;

/// 召回时进入 prompt 的上限 / cap on memories entering one prompt.
///
/// 与 `memory_store::RECALL_LIMIT` 同一个值，且刻意直接引用而不是重写字面量。
pub use crate::db::memory_store::RECALL_LIMIT;

/// 低于这个分数的候选是噪声 / below this a candidate is noise, not recall.
const SCORE_FLOOR: f64 = 0.08;

/// 一条记忆提案 / one proposed memory.
///
/// 名字用 proposal 而不是 fact：LLM 抽出来的东西在被用户确认之前不是事实。
#[derive(Debug, Clone)]
pub struct MemoryProposal {
    pub kind: MemoryKind,
    pub claim: String,
    pub scope: String,
    pub confidence: f64,
    pub importance: f64,
    pub source: Option<SourceRef>,
    /// `memory.md` 的五个 canonical section 之一，用于兼容投影。
    pub section: Option<String>,
    pub ttl_days: Option<u32>,
    /// 要取代的旧记忆。
    pub supersedes_id: Option<String>,
    /// 用户是否明确说了"记住"。这是唯一能让候选免审直接生效的条件。
    pub user_requested: bool,
    /// 内容是否来自网页/MCP 等不可信来源。
    pub from_untrusted_source: bool,
    pub extraction_model: Option<String>,
    pub pipeline_version: Option<String>,
    /// 原文摘录与坐标，用来生成证据。没有它这条记忆不可验证。
    pub excerpt: Option<String>,
    pub locator: Option<String>,
}

impl MemoryProposal {
    pub fn new(kind: MemoryKind, claim: impl Into<String>, scope: impl Into<String>) -> Self {
        Self {
            kind,
            claim: claim.into(),
            scope: scope.into(),
            confidence: 0.5,
            importance: 1.0,
            source: None,
            section: None,
            ttl_days: None,
            supersedes_id: None,
            user_requested: false,
            from_untrusted_source: false,
            extraction_model: None,
            pipeline_version: None,
            excerpt: None,
            locator: None,
        }
    }
}

/// 这条提案必须先让用户确认吗 / must this proposal wait for the user?
///
/// 四条规则，每条都对应一种"静默写入会造成真实损害"的情形：
///
/// 1. **画像覆盖**：`profile` 是最持久的一类记忆，写错会污染之后所有轮。
/// 2. **取代已有事实**：改写用户过去说过的话，必须由用户点头。
/// 3. **来自外部内容**：网页/MCP 里的一句"请记住…"是 prompt injection 的标准入口。
/// 4. **低置信推断**：模型自己都不确定的东西不该变成用户事实。
///
/// 用户明确说"记住"且不触发上述任何一条时，才自动生效。
pub fn requires_confirmation(p: &MemoryProposal) -> bool {
    if p.from_untrusted_source {
        return true;
    }
    if p.supersedes_id.is_some() {
        return true;
    }
    if matches!(p.kind, MemoryKind::Profile) && !p.user_requested {
        return true;
    }
    if p.confidence < 0.7 && !p.user_requested {
        return true;
    }
    !p.user_requested
}

/// 记下一条提案 / record a proposal.
///
/// 内容重复（按 `memory_store::normalize` 的同一条规则）时不新建，返回已有那条并
/// 刷新 `last_accessed_ms`。这样后台抽取反复看到同一句话不会把表撑爆。
pub fn propose(conn: &Connection, p: MemoryProposal) -> ObjectResult<MemoryItem> {
    let claim = p.claim.trim().to_string();
    if claim.is_empty() {
        return Err(ObjectError::UnknownEnum {
            column: "claim",
            value: "an empty claim cannot be remembered".into(),
        });
    }

    if let Some(existing) = find_duplicate(conn, &claim, &p.scope)? {
        touch(conn, &existing.id)?;
        return Ok(existing);
    }

    let needs_confirmation = requires_confirmation(&p);
    let now = now_ms();
    let expires_at = p
        .ttl_days
        .map(|d| now + i64::from(d) * 24 * 60 * 60 * 1000);
    let (source_type, source_id) = match &p.source {
        Some(s) => (Some(s.source_type.clone()), Some(s.source_id.clone())),
        None => (None, None),
    };

    // 每条记忆背后有一个 `memory` 对象。这不是多余的一层：证据、关系、审计都挂在
    // 对象 ID 上，没有它这条记忆就没法被引用，也没法带证据。
    //
    // 刻意**不**给这个对象设 `source`。`knowledge_objects.(source_type, source_id)`
    // 上有唯一索引，语义是"这个对象投影自哪一行 legacy backing"——一篇笔记一个对象、
    // 一个 chunk 一个对象。而一场对话会产出很多条记忆，把 `chat_session:s-1` 写进去
    // 会让第二条记忆撞唯一索引。记忆的来源属于 `memory_items.source_*` 和 evidence 行
    // （后者还带 locator，是真正能点回原文的那一层）。
    let mut object_spec = NewObject::new(ObjectKind::Memory, p.scope.clone(), "agent")
        .with_title(truncate_title(&claim))
        .with_content(claim.clone());
    object_spec.confidence = p.confidence.clamp(0.0, 1.0);
    object_spec.valid_from_ms = Some(now);
    object_spec.valid_to_ms = expires_at;
    let object = object_store::create_object(conn, object_spec)?;

    let id = new_object_id();
    conn.execute(
        "INSERT INTO memory_items
            (id, object_id, kind, lifecycle, claim, scope, confidence, importance,
             source_type, source_id, valid_from_ms, supersedes_id,
             requires_user_confirmation, expires_at_ms, section,
             created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, 'candidate', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
        params![
            id,
            object.id,
            p.kind.as_str(),
            claim,
            p.scope,
            p.confidence.clamp(0.0, 1.0),
            p.importance.clamp(0.1, 2.0),
            source_type,
            source_id,
            now,
            p.supersedes_id,
            i64::from(needs_confirmation),
            expires_at,
            p.section,
            now,
        ],
    )?;

    // 证据先落地，再决定是否自动生效：自动生效的那条也必须可追溯。
    if let (Some(source), Some(excerpt)) = (&p.source, &p.excerpt) {
        let mut spec = NewEvidence::new(source.clone()).with_excerpt(excerpt.clone());
        if let Some(locator) = &p.locator {
            spec = spec.with_locator(locator.clone());
        }
        if let (Some(model), Some(pipeline)) = (&p.extraction_model, &p.pipeline_version) {
            spec = spec.with_model(model.clone(), pipeline.clone());
        }
        let evidence_id = evidence::record_evidence(conn, spec)?;
        evidence::attach_evidence(conn, &object.id, &evidence_id, "source", p.confidence)?;
    }

    if !needs_confirmation {
        activate(conn, &id, None)?;
    }

    get(conn, &id)?.ok_or_else(|| ObjectError::NotFound(id))
}

/// 长 claim 截成可读标题 / a readable title for a long claim.
fn truncate_title(claim: &str) -> String {
    const MAX_CHARS: usize = 60;
    if claim.chars().count() <= MAX_CHARS {
        return claim.to_string();
    }
    // 按字符而不是字节截断：中文 claim 按字节切会切出半个字。
    let head: String = claim.chars().take(MAX_CHARS).collect();
    format!("{head}…")
}

/// 用户确认 / the user confirms a candidate.
///
/// 只有这条路径会写 `confirmed_by`，也只有这条路径会把取代链闭合。
pub fn confirm(conn: &Connection, id: &str, by: &str) -> ObjectResult<MemoryItem> {
    let item = get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))?;
    let now = now_ms();

    conn.execute(
        "UPDATE memory_items
         SET lifecycle = 'active', confirmed_by = ?2, confirmed_at_ms = ?3,
             requires_user_confirmation = 0, updated_at_ms = ?3
         WHERE id = ?1",
        params![id, by, now],
    )?;

    if let Some(old) = &item.supersedes_id {
        supersede(conn, old, id)?;
    }
    project_to_legacy(conn, id)?;

    get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))
}

/// 用户拒绝 / the user rejects a candidate.
///
/// 归档而不是删除：同一条错误提案反复出现时，`find_duplicate` 会命中这条归档记录，
/// 于是不会再次打扰用户。
pub fn reject(conn: &Connection, id: &str) -> ObjectResult<MemoryItem> {
    set_lifecycle(conn, id, MemoryLifecycle::Archived)?;
    unproject_from_legacy(conn, id)?;
    get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))
}

/// 永久遗忘 / the explicit permanent-forget path.
///
/// 这是 `delete_matching` 唯一还该扮演的角色：用户说"忘掉这件事"。
pub fn forget(conn: &Connection, id: &str) -> ObjectResult<MemoryItem> {
    set_lifecycle(conn, id, MemoryLifecycle::Forgotten)?;
    unproject_from_legacy(conn, id)?;
    get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))
}

/// 取代：旧的标 superseded，双向留链 / supersede, keeping the chain both ways.
///
/// 旧记忆的 claim、证据、置信度全部保留，只是不再参与召回，并且拿到一个 `valid_to_ms`。
/// 这是本模块存在的核心理由——旧实现在这里执行 `DELETE`。
pub fn supersede(conn: &Connection, old_id: &str, new_id: &str) -> ObjectResult<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE memory_items
         SET lifecycle = 'superseded', valid_to_ms = COALESCE(valid_to_ms, ?2), updated_at_ms = ?2
         WHERE id = ?1",
        params![old_id, now],
    )?;
    conn.execute(
        "UPDATE memory_items SET supersedes_id = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![new_id, old_id, now],
    )?;
    unproject_from_legacy(conn, old_id)?;
    Ok(())
}

/// 标记两条互相矛盾 / mark two memories as mutually conflicting.
///
/// 双向写：只写一边的话，从另一条读出来时看不到冲突，UI 就会把一个有争议的事实
/// 显示成确定的。两条都留着，谁对由用户裁决。
pub fn mark_conflict(conn: &Connection, a: &str, b: &str) -> ObjectResult<()> {
    let now = now_ms();
    for (x, y) in [(a, b), (b, a)] {
        conn.execute(
            "UPDATE memory_items
             SET conflicts_with_id = ?2, requires_user_confirmation = 1, updated_at_ms = ?3
             WHERE id = ?1",
            params![x, y, now],
        )?;
    }
    Ok(())
}

/// TTL 到期 / expire memories whose validity has passed.
///
/// 标 `expired` 而不是 `DELETE`——`memory_store::prune_expired` 会真删 `ai_memory`
/// 的行，那是投影层，删掉无所谓；本层的历史必须留着。返回过期条数。
pub fn expire_due(conn: &Connection) -> ObjectResult<usize> {
    let now = now_ms();
    let n = conn.execute(
        "UPDATE memory_items
         SET lifecycle = 'expired', updated_at_ms = ?1
         WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?1
           AND lifecycle IN ('candidate', 'verified', 'active')",
        params![now],
    )?;
    // 投影层同步清掉，否则旧 recall 还会捞到已过期的事实。
    crate::db::memory_store::prune_expired(conn)?;
    Ok(n)
}

fn activate(conn: &Connection, id: &str, confirmed_by: Option<&str>) -> ObjectResult<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE memory_items
         SET lifecycle = 'active', confirmed_by = ?2,
             confirmed_at_ms = CASE WHEN ?2 IS NULL THEN confirmed_at_ms ELSE ?3 END,
             updated_at_ms = ?3
         WHERE id = ?1",
        params![id, confirmed_by, now],
    )?;
    project_to_legacy(conn, id)?;
    Ok(())
}

fn set_lifecycle(
    conn: &Connection,
    id: &str,
    lifecycle: MemoryLifecycle,
) -> ObjectResult<()> {
    let changed = conn.execute(
        "UPDATE memory_items SET lifecycle = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![id, lifecycle.as_str(), now_ms()],
    )?;
    if changed == 0 {
        return Err(ObjectError::NotFound(id.to_string()));
    }
    Ok(())
}

fn touch(conn: &Connection, id: &str) -> ObjectResult<()> {
    conn.execute(
        "UPDATE memory_items SET last_accessed_ms = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

// ── legacy 投影 / the `ai_memory` projection ────────────────────────────────

/// 把一条生效的记忆投影进 `ai_memory` / project an active memory into the legacy table.
///
/// 让旧的 recall 路径、旧命令、旧 prompt 注入完全不用改就能看到新记忆。
fn project_to_legacy(conn: &Connection, id: &str) -> ObjectResult<()> {
    let Some(item) = get(conn, id)? else { return Ok(()) };
    if item.lifecycle != MemoryLifecycle::Active {
        return Ok(());
    }
    let ttl_days = item.expires_at_ms.map(|expires| {
        let remaining_ms = (expires - now_ms()).max(0);
        (remaining_ms / (24 * 60 * 60 * 1000)).clamp(1, u32::MAX as i64) as u32
    });
    let session = item
        .source
        .as_ref()
        .filter(|s| s.source_type == "chat_session")
        .map(|s| s.source_id.clone());

    // `upsert_fact` 自己去重，所以重复投影是 no-op。
    crate::db::memory_store::upsert_fact(
        conn,
        &item.claim,
        item.kind.as_str(),
        item.importance,
        ttl_days,
        session.as_deref(),
    )?;
    Ok(())
}

/// 撤下投影 / remove the legacy projection for one memory.
fn unproject_from_legacy(conn: &Connection, id: &str) -> ObjectResult<()> {
    let Some(item) = get(conn, id)? else { return Ok(()) };
    // 精确匹配 claim，不用 `delete_matching` 的子串匹配：子串匹配会误删别的事实。
    conn.execute(
        "DELETE FROM ai_memory WHERE content = ?1",
        params![item.claim],
    )?;
    Ok(())
}

// ── 读 / reads ──────────────────────────────────────────────────────────────

const MEMORY_COLUMNS: &str = "id, object_id, kind, lifecycle, claim, scope, confidence, importance,
     source_type, source_id, valid_from_ms, valid_to_ms, supersedes_id, conflicts_with_id,
     confirmed_by, confirmed_at_ms, requires_user_confirmation, last_accessed_ms,
     expires_at_ms, section, created_at_ms, updated_at_ms";

fn map_memory(row: &Row<'_>) -> ObjectResult<MemoryItem> {
    let kind_raw: String = row.get(2)?;
    let lifecycle_raw: String = row.get(3)?;
    let source_type: Option<String> = row.get(8)?;
    let source_id: Option<String> = row.get(9)?;
    Ok(MemoryItem {
        id: row.get(0)?,
        object_id: row.get(1)?,
        kind: MemoryKind::parse(&kind_raw).ok_or(ObjectError::UnknownEnum {
            column: "kind",
            value: kind_raw,
        })?,
        lifecycle: MemoryLifecycle::parse(&lifecycle_raw).ok_or(ObjectError::UnknownEnum {
            column: "lifecycle",
            value: lifecycle_raw,
        })?,
        claim: row.get(4)?,
        scope: row.get(5)?,
        confidence: row.get(6)?,
        importance: row.get(7)?,
        source: match (source_type, source_id) {
            (Some(source_type), Some(source_id)) => Some(SourceRef { source_type, source_id }),
            _ => None,
        },
        valid_from_ms: row.get(10)?,
        valid_to_ms: row.get(11)?,
        supersedes_id: row.get(12)?,
        conflicts_with_id: row.get(13)?,
        confirmed_by: row.get(14)?,
        confirmed_at_ms: row.get(15)?,
        requires_user_confirmation: row.get::<_, i64>(16)? != 0,
        last_accessed_ms: row.get(17)?,
        expires_at_ms: row.get(18)?,
        section: row.get(19)?,
        created_at_ms: row.get(20)?,
        updated_at_ms: row.get(21)?,
    })
}

/// 按 ID 取一条记忆 / fetch one memory item.
pub fn get(conn: &Connection, id: &str) -> ObjectResult<Option<MemoryItem>> {
    let sql = format!("SELECT {MEMORY_COLUMNS} FROM memory_items WHERE id = ?1");
    conn.query_row(&sql, params![id], |row| Ok(map_memory(row)))
        .optional()?
        .transpose()
}

/// 同 scope 下语义等同的已有记忆 / an existing memory with the same normalized claim.
///
/// 包含已归档和已拒绝的：用户拒绝过的提案不该被反复推到 Inbox。
fn find_duplicate(
    conn: &Connection,
    claim: &str,
    scope: &str,
) -> ObjectResult<Option<MemoryItem>> {
    let target = crate::db::memory_store::normalize(claim);
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE scope = ?1 AND lifecycle != 'forgotten'
         ORDER BY created_at_ms"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![scope], |row| Ok(map_memory(row)))?
        .collect::<Result<Vec<_>, _>>()?;
    for row in rows {
        let item = row?;
        if crate::db::memory_store::normalize(&item.claim) == target {
            return Ok(Some(item));
        }
    }
    Ok(None)
}

/// Memory Inbox：等用户裁决的候选 / the candidates awaiting the user.
pub fn inbox(conn: &Connection, limit: usize) -> ObjectResult<Vec<MemoryItem>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE requires_user_confirmation = 1 AND lifecycle = 'candidate'
         ORDER BY created_at_ms DESC
         LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![limit as i64], |row| Ok(map_memory(row)))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().collect()
}

/// 一条召回结果及其为什么可疑 / one recalled memory plus why it may not be trustworthy.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalledMemory {
    pub item: MemoryItem,
    pub score: f64,
    /// 供 UI 直接展示：低置信、未确认、有冲突、跨 scope。
    pub warnings: Vec<String>,
}

/// 召回与当前查询相关的记忆 / recall the memories worth spending tokens on.
///
/// 打分沿用 `memory_store` 的那一条规则（词面重叠 × 重要度 × 时间衰减），只是从
/// `memory_items` 取候选，并且额外产出 warning。低于 `SCORE_FLOOR` 的直接丢掉，
/// 不凑够 `limit`：一条不相关的记忆进 prompt 比没有更糟，模型会拿去用。
pub fn recall(
    conn: &Connection,
    query: &str,
    scope: Option<&str>,
    limit: usize,
) -> ObjectResult<Vec<RecalledMemory>> {
    let query_tokens = crate::db::memory_store::tokenize(query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_ms();
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE lifecycle IN ('active', 'verified')
           AND (expires_at_ms IS NULL OR expires_at_ms > ?1)"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![now], |row| Ok(map_memory(row)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut scored: Vec<RecalledMemory> = Vec::new();
    for row in rows {
        let item = row?;
        let overlap = crate::db::memory_store::lexical_overlap(&query_tokens, &item.claim);
        if overlap <= 0.0 {
            continue;
        }
        let age_days = (now - item.created_at_ms).max(0) as f64 / 86_400_000.0;
        let decay = crate::db::rerank::time_decay_factor(
            age_days,
            crate::db::memory_store::MEMORY_HALF_LIFE_DAYS,
        );
        let score = overlap * item.importance * decay;
        if score < SCORE_FLOOR {
            continue;
        }

        let mut warnings = Vec::new();
        if item.confidence < 0.6 {
            warnings.push("low_confidence".to_string());
        }
        if item.confirmed_by.is_none() {
            warnings.push("unconfirmed".to_string());
        }
        if item.conflicts_with_id.is_some() {
            warnings.push("conflicting".to_string());
        }
        if let Some(scope) = scope {
            if !item.scope.is_empty() && item.scope != scope {
                warnings.push("out_of_scope".to_string());
            }
        }

        scored.push(RecalledMemory { item, score, warnings });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    // 召回本身是一次访问，记下来供后续遗忘策略参考。
    for hit in &scored {
        touch(conn, &hit.item.id)?;
    }
    Ok(scored)
}

/// 按生命周期列出 / list memories in one lifecycle state, newest first.
pub fn list_by_lifecycle(
    conn: &Connection,
    lifecycle: MemoryLifecycle,
    limit: usize,
) -> ObjectResult<Vec<MemoryItem>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE lifecycle = ?1 ORDER BY updated_at_ms DESC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![lifecycle.as_str(), limit as i64], |row| {
            Ok(map_memory(row))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().collect()
}
