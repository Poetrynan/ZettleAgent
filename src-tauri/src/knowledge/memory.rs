//! 记忆生命周期 / the memory lifecycle.
//!
//! 旧的替代语义是 `DELETE old + INSERT new`（那个按子串匹配删行的函数已删掉）。
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
/// 这是唯一还该真删行的场合：用户说"忘掉这件事"。
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
    // 精确匹配 claim，不做子串匹配：子串匹配会误删别的事实。
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
/// 找到一条可以被取代的旧记忆 / the active memory an update would supersede.
///
/// 抽取器给的 `replaces` 是一段**近似的旧文本**，不是 id。所以这里按归一化后的
/// 包含关系找，取最近确认的那一条。
///
/// 三个刻意的收窄：
///
/// - 只找 `active` / `verified`。取代一条用户从没确认过的候选没有意义，而动到
///   `archived` / `forgotten` 等于把用户否掉的东西又翻出来。
/// - 找不到就返回 `None`，调用方据此把 `supersedes_id` 留空——旧实现在这里执行的是
///   `DELETE ... LIKE`，一个模型随口写的短语就能删掉一条它根本没打算碰的记忆。
/// - 空串直接返回 `None`：否则"包含空串"匹配所有记忆。
pub fn find_supersedable(
    conn: &Connection,
    approximate_old_claim: &str,
    scope: &str,
) -> ObjectResult<Option<MemoryItem>> {
    let needle = crate::db::memory_store::normalize(approximate_old_claim);
    if needle.trim().is_empty() {
        return Ok(None);
    }

    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE scope = ?1 AND lifecycle IN ('active', 'verified')
         ORDER BY updated_at_ms DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![scope], |row| Ok(map_memory(row)))?
        .collect::<Result<Vec<_>, _>>()?;
    for row in rows {
        let item = row?;
        let existing = crate::db::memory_store::normalize(&item.claim);
        if existing.contains(&needle) || needle.contains(&existing) {
            return Ok(Some(item));
        }
    }
    Ok(None)
}

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

// ── Memory Center：全量视图 / the whole memory, not just the inbox ───────────

/// 列表筛选条件 / what the Memory Center is asking for.
///
/// 空的 `lifecycles` 表示"全部生命周期"，而不是"没有"：Memory Center 的默认视图就
/// 是全部，用户勾选之后才收窄。
#[derive(Debug, Clone, Default)]
pub struct MemoryFilter {
    pub lifecycles: Vec<MemoryLifecycle>,
    pub kinds: Vec<MemoryKind>,
    pub scope: Option<String>,
    /// 对 claim 的子串匹配，归一化后比较（大小写/标点无关）。
    pub search: Option<String>,
    pub limit: usize,
}

/// 列出记忆 / list memories under a filter.
///
/// `lifecycle` / `kind` 用 SQL 过滤，`search` 在 Rust 里按归一化文本比对——归一化
/// 规则（`memory_store::normalize`）和去重、取代解析用的是同一套，所以搜索结果和
/// "这两条算不算同一条"的判断不会打架。SQL 的 `LIKE` 做不到这一点。
pub fn list(conn: &Connection, filter: &MemoryFilter) -> ObjectResult<Vec<MemoryItem>> {
    let mut sql = format!("SELECT {MEMORY_COLUMNS} FROM memory_items WHERE 1 = 1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if !filter.lifecycles.is_empty() {
        let marks = placeholders(filter.lifecycles.len(), args.len());
        sql.push_str(&format!(" AND lifecycle IN ({marks})"));
        for l in &filter.lifecycles {
            args.push(Box::new(l.as_str().to_string()));
        }
    }
    if !filter.kinds.is_empty() {
        let marks = placeholders(filter.kinds.len(), args.len());
        sql.push_str(&format!(" AND kind IN ({marks})"));
        for k in &filter.kinds {
            args.push(Box::new(k.as_str().to_string()));
        }
    }
    if let Some(scope) = filter.scope.as_ref().filter(|s| !s.is_empty()) {
        args.push(Box::new(scope.clone()));
        sql.push_str(&format!(" AND scope = ?{}", args.len()));
    }
    sql.push_str(" ORDER BY updated_at_ms DESC");

    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows: Vec<_> = stmt
        .query_map(params.as_slice(), |row| Ok(map_memory(row)))?
        .collect::<Result<Vec<_>, _>>()?;

    let needle = filter
        .search
        .as_ref()
        .map(|s| crate::db::memory_store::normalize(s))
        .filter(|s| !s.trim().is_empty());

    let limit = if filter.limit == 0 { 100 } else { filter.limit };
    let mut out = Vec::new();
    for row in rows {
        let item = row?;
        if let Some(needle) = &needle {
            if !crate::db::memory_store::normalize(&item.claim).contains(needle.as_str()) {
                continue;
            }
        }
        out.push(item);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// `?n, ?n+1, …` —— 从 `offset` 之后接着编号。
fn placeholders(count: usize, offset: usize) -> String {
    (1..=count)
        .map(|i| format!("?{}", i + offset))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 一条记忆的完整来历 / one memory with everything that explains it.
///
/// 取代链和冲突对必须和记忆本身一起给：用户看到"这条替换了那条"时要能立刻读到被
/// 替换的原文，否则那句话是无法验证的断言。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDetail {
    pub item: MemoryItem,
    /// 它取代掉的那条（更旧）。
    pub supersedes: Option<MemoryItem>,
    /// 取代了它的那条（更新）。为 `Some` 说明这条已经是历史。
    pub superseded_by: Option<MemoryItem>,
    pub conflicts_with: Option<MemoryItem>,
    /// 挂在它对象上的证据。没有对象或没有证据都会是空——UI 据此说"无法验证"。
    pub evidence: Vec<Evidence>,
}

/// 取一条记忆的全部来历 / fetch one memory plus its chain and evidence.
pub fn detail(conn: &Connection, id: &str) -> ObjectResult<Option<MemoryDetail>> {
    let Some(item) = get(conn, id)? else {
        return Ok(None);
    };

    let supersedes = match &item.supersedes_id {
        Some(old) => get(conn, old)?,
        None => None,
    };
    let conflicts_with = match &item.conflicts_with_id {
        Some(other) => get(conn, other)?,
        None => None,
    };
    // 反向找：谁的 `supersedes_id` 指着我。取最新的一条——理论上只会有一条，但真
    // 出现多条时显示最新的比随机挑一条可解释。
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE supersedes_id = ?1 ORDER BY created_at_ms DESC LIMIT 1"
    );
    let superseded_by = conn
        .query_row(&sql, params![id], |row| Ok(map_memory(row)))
        .optional()?
        .transpose()?;

    let evidence = match &item.object_id {
        Some(object_id) => super::evidence::evidence_for_object(conn, object_id)?
            .into_iter()
            .map(|(e, _role, _confidence)| e)
            .collect(),
        None => Vec::new(),
    };

    Ok(Some(MemoryDetail {
        item,
        supersedes,
        superseded_by,
        conflicts_with,
        evidence,
    }))
}

/// 改写一条记忆 / rewrite a memory's claim.
///
/// **不原地改 `claim`。** 改成新提一条用户亲笔的记忆去取代旧的：
///
/// - 旧那条的原文还在，`superseded_by` 能一路读回去。原地覆盖等于把"Agent 原本记
///   的是什么"这段历史抹掉，而那恰恰是用户日后想核对的东西。
/// - 新那条 `user_requested = true`，所以它不需要再确认——本来就是用户写的。
/// - 证据不继承：旧证据支撑的是旧说法。新说法的来源是"用户在 Memory Center 里改
///   的"，如实记成 `user_edit`。
pub fn edit(conn: &Connection, id: &str, new_claim: &str, by: &str) -> ObjectResult<MemoryItem> {
    let claim = new_claim.trim();
    if claim.is_empty() {
        return Err(ObjectError::Invalid(
            "记忆内容不能为空 / claim cannot be empty".to_string(),
        ));
    }
    let Some(old) = get(conn, id)? else {
        return Err(ObjectError::NotFound(id.to_string()));
    };
    if crate::db::memory_store::normalize(&old.claim) == crate::db::memory_store::normalize(claim) {
        // 没有实质变化就什么都不做，别在链上留一条毫无信息量的记录。
        return Ok(old);
    }

    let proposal = MemoryProposal {
        kind: old.kind,
        claim: claim.to_string(),
        scope: old.scope.clone(),
        confidence: 1.0,
        importance: old.importance,
        source: Some(SourceRef {
            source_type: "user_edit".to_string(),
            source_id: old.id.clone(),
        }),
        section: old.section.clone(),
        ttl_days: None,
        supersedes_id: Some(old.id.clone()),
        user_requested: true,
        from_untrusted_source: false,
        extraction_model: None,
        pipeline_version: None,
        excerpt: None,
        locator: None,
    };
    let fresh = propose(conn, proposal)?;
    // `propose` 对"取代已有记忆"一律要求确认——那条规则防的是模型悄悄改写用户说过
    // 的话。但这一条正是用户自己写下的，所以立刻按 `by` 记成已确认：否则他改完之
    // 后旧说法还在生效，新说法却要等他再点一次确认自己刚写的东西，而这中间记忆层
    // 处于"两条都不作数"的状态。`confirm` 顺手闭合取代链并更新投影。
    if fresh.lifecycle == MemoryLifecycle::Candidate {
        return confirm(conn, &fresh.id, by);
    }
    Ok(fresh)
}

/// 撤回一次拒绝或遗忘 / undo a reject/forget decision.
///
/// `reject` / `forget` 都只改生命周期、不删行，所以撤回是可能的：把它放回
/// `candidate` 并重新要求确认，也就是回到"等你裁决"的状态。
///
/// 刻意**不**恢复成 `active`：我们没有存"当初是什么状态"，猜一个 active 等于替用户
/// 做了一个他没做过的确认。回到收件箱是唯一如实的落点。
pub fn restore(conn: &Connection, id: &str) -> ObjectResult<MemoryItem> {
    let Some(item) = get(conn, id)? else {
        return Err(ObjectError::NotFound(id.to_string()));
    };
    if !matches!(
        item.lifecycle,
        MemoryLifecycle::Archived | MemoryLifecycle::Forgotten
    ) {
        return Err(ObjectError::Invalid(
            "只有被拒绝或遗忘的记忆可以撤回 / only a rejected or forgotten memory can be restored"
                .to_string(),
        ));
    }
    conn.execute(
        "UPDATE memory_items
         SET lifecycle = 'candidate', requires_user_confirmation = 1,
             confirmed_by = NULL, confirmed_at_ms = NULL, updated_at_ms = ?2
         WHERE id = ?1",
        params![id, now_ms()],
    )?;
    get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))
}


// ── memory.md 手工编辑回流 / hand edits to memory.md ────────────────────────

/// `memory.md` 在 vault 里的位置 / where the projection lives.
///
/// 与 `workspace_ops` 用的是同一条路径，写和读不能各算一次。
pub fn memory_file_path(vault_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(vault_path)
        .join(".zettelagent")
        .join("memory.md")
}

/// 一次回流的结果 / what one reconciliation did.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSync {
    /// 文件里新出现、因此被采纳为用户事实的条数。
    pub adopted: usize,
    /// 文件里有、库里已经生效的条数。
    pub unchanged: usize,
    /// 之前从这个文件采纳过、现在被用户删掉的条数。
    pub forgotten: usize,
}

/// 把 `memory.md` 的手工编辑吸收回记忆层 / absorb hand edits to `memory.md`.
///
/// 用户直接改这个文件是一条一等公民的输入通道：那是他自己写下的话，所以采纳时直接
/// 记成已确认的用户事实（`confirmed_by`），不再走候选收件箱——让用户确认他刚亲手
/// 打的一行字是没有意义的。
///
/// 删除只作用于**当初就是从这个文件采纳的**那些条目：从对话里抽出来的记忆不因为
/// 没出现在 `memory.md` 里就被忘掉。`memory.md` 是投影，不是全集，把它当全集会
/// 让一次手工整理静默清空整个记忆库。
///
/// 文件不存在不是错误——只是还没人写过。
pub fn reconcile_from_markdown(conn: &Connection, vault_path: &str) -> ObjectResult<MarkdownSync> {
    let path = memory_file_path(vault_path);
    if !path.exists() {
        return Ok(MarkdownSync::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        ObjectError::Search(format!("cannot read {}: {e}", path.display()))
    })?;
    let source_id = path.to_string_lossy().to_string();
    let parsed = crate::tools::internal_tools::workspace_ops::parse_structured_memory(&raw);

    let mut report = MarkdownSync::default();
    let mut present: Vec<String> = Vec::new();

    for (section, items) in &parsed.sections {
        for claim in items {
            let claim = claim.trim();
            if claim.is_empty() {
                continue;
            }
            // 没有 frontmatter 的老格式会被 `parse_structured_memory` 整体迁移进
            // "User Preferences"，标题行也一起进来。把 `## 小标题` 当成一条记忆，
            // 用户会在召回里看到自己写的标题——那不是他的意思。
            if claim.starts_with('#') || claim.chars().all(|c| c == '-' || c == '=') {
                continue;
            }

            present.push(crate::db::memory_store::normalize(claim));

            if let Some(existing) = find_duplicate(conn, claim, "global")? {
                if existing.lifecycle == MemoryLifecycle::Active
                    || existing.lifecycle == MemoryLifecycle::Verified
                {
                    touch(conn, &existing.id)?;
                    report.unchanged += 1;
                    continue;
                }
                // 用户亲手把一条被拒/过期的记忆写回文件里，那是他改了主意。
                confirm(conn, &existing.id, CONFIRMED_BY_FILE)?;
                report.adopted += 1;
                continue;
            }

            let mut proposal = MemoryProposal::new(kind_for_section(section), claim, "global");
            proposal.confidence = 1.0;
            proposal.importance = 1.5;
            proposal.user_requested = true;
            proposal.section = Some(section.clone());
            proposal.source = Some(SourceRef {
                source_type: "file".to_string(),
                source_id: source_id.clone(),
            });
            proposal.excerpt = Some(claim.to_string());
            proposal.locator = Some(format!("memory.md#{section}"));
            let item = propose(conn, proposal)?;
            confirm(conn, &item.id, CONFIRMED_BY_FILE)?;
            report.adopted += 1;
        }
    }

    report.forgotten = forget_removed_from_file(conn, &source_id, &present)?;
    Ok(report)
}

/// 采纳一行手写记忆时记的 `confirmed_by` / who confirmed a hand-written line.
const CONFIRMED_BY_FILE: &str = "user:memory.md";

/// section 名字决定种类 / the section decides the kind.
///
/// 未知 section 落到 `Semantic`：宁可分类粗一点，也不能因为用户自己加了个小标题
/// 就把那几行丢掉。
fn kind_for_section(section: &str) -> MemoryKind {
    match section {
        "User Preferences" => MemoryKind::Profile,
        "Workflow Habits" => MemoryKind::Procedural,
        "Research Topics" => MemoryKind::Resource,
        _ => MemoryKind::Semantic,
    }
}

/// 反过来：种类决定它该落在哪个 section / where a kind belongs in the file.
fn section_for_kind(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Profile => "User Preferences",
        MemoryKind::Procedural => "Workflow Habits",
        MemoryKind::Resource => "Research Topics",
        _ => "Important Decisions",
    }
}

/// 把一条已生效的记忆写进 `memory.md` / project one active memory into the file.
///
/// `memory.md` 是永远在 prompt 里的 Core Memory。一条记忆只进 `ai_memory` 而不进这个
/// 文件，就只能靠召回命中，不会稳定地在场——用户确认过的偏好本该稳定在场。
///
/// **只在确认那一刻追加一次**，不做全量重写。全量重写会把用户手工删掉的行又贴回去，
/// 那是最让人恼火的一种"软件不听话"；而反向的手工删除由
/// [`reconcile_from_markdown`] 负责解释。代价是文件和库对来自对话的条目可能漂移——
/// 这是刻意的：`memory.md` 是投影，不是记忆的全集。
///
/// 返回是否真的写了盘（已经在文件里的不重复追加）。
pub fn project_to_markdown(
    conn: &Connection,
    vault_path: &str,
    id: &str,
) -> ObjectResult<bool> {
    let item = get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))?;
    if item.lifecycle != MemoryLifecycle::Active && item.lifecycle != MemoryLifecycle::Verified {
        return Ok(false);
    }

    use crate::tools::internal_tools::workspace_ops::{
        parse_structured_memory, serialize_structured_memory, StructuredMemory,
    };

    let path = memory_file_path(vault_path);
    let mut memory: StructuredMemory = match std::fs::read_to_string(&path) {
        Ok(raw) => parse_structured_memory(&raw),
        Err(_) => StructuredMemory::default(),
    };

    let target = crate::db::memory_store::normalize(&item.claim);
    let already = memory
        .sections
        .iter()
        .any(|(_, items)| items.iter().any(|l| crate::db::memory_store::normalize(l) == target));
    if already {
        return Ok(false);
    }

    let section = item
        .section
        .clone()
        .unwrap_or_else(|| section_for_kind(item.kind).to_string());
    match memory.sections.iter_mut().find(|(name, _)| name == &section) {
        Some((_, items)) => items.push(item.claim.clone()),
        None => memory.sections.push((section, vec![item.claim.clone()])),
    }
    memory.last_updated = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            ObjectError::Search(format!("cannot create {}: {e}", parent.display()))
        })?;
    }
    std::fs::write(&path, serialize_structured_memory(&memory))
        .map_err(|e| ObjectError::Search(format!("cannot write {}: {e}", path.display())))?;
    Ok(true)
}


/// 用户从文件里删掉的那些，忘掉 / forget what the user deleted from the file.
fn forget_removed_from_file(
    conn: &Connection,
    source_id: &str,
    present: &[String],
) -> ObjectResult<usize> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memory_items
         WHERE source_type = 'file' AND source_id = ?1
           AND lifecycle IN ('active', 'verified')"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<_> = stmt
        .query_map(params![source_id], |row| Ok(map_memory(row)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut forgotten = 0usize;
    for row in rows {
        let item = row?;
        let normalized = crate::db::memory_store::normalize(&item.claim);
        if present.iter().any(|p| p == &normalized) {
            continue;
        }
        forget(conn, &item.id)?;
        forgotten += 1;
    }
    Ok(forgotten)
}

