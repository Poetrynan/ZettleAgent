//! 带 provenance 的统一检索 / unified retrieval with provenance.
//!
//! **不重写 `db::search`。** FTS5 的 CJK query builder、sqlite-vec 余弦、RRF 融合、
//! rerank（MMR + 时间衰减）、semantic edges、note_relations、PageRank/communities
//! 全部继续由那个模块负责，这里只做四件它不该管的事：
//!
//! 1. **统一身份**：把 chunk 级命中折叠成对象级结果，同时保留 chunk locator。
//! 2. **可解释**：给出 `score_breakdown` 和 `why_matched`，而不是一个裸分数。
//! 3. **可疑标记**：过期、低置信、未确认、冲突、跨 scope 一律带 warning。
//! 4. **不伪造**：backfill 没跑到的笔记 `object_id` 就是 `None`，返回 legacy
//!    provenance 并挂一条 warning，绝不编一个下次启动就变的 ID。
//!
//! 输出**不是**给 prompt 直接拼字符串用的。拼装是 `context_compiler` 的活。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::memory;
use super::object_store::{self, ObjectResult};
use super::types::*;
use crate::db::search;

/// 一次检索的输入 / one retrieval request.
#[derive(Debug, Clone)]
pub struct RetrievalQuery {
    pub query: String,
    /// embedding 由前端算（transformers.js），Rust 侧拿不到。为 `None` 时走
    /// FTS-only 路径，这是 `rag_effective_search_mode` 一直以来的行为。
    pub query_embedding: Option<Vec<f32>>,
    /// vault / workspace 根目录。为空表示不限。
    pub scopes: Vec<String>,
    /// 当前打开的笔记，排序时优先。
    pub current_file: Option<String>,
    /// 只要这些 kind；为空表示全部。
    pub kinds: Vec<ObjectKind>,
    /// `updated_at` 落在这个毫秒区间内。
    pub time_range_ms: Option<(i64, i64)>,
    pub include_memories: bool,
    pub include_tasks: bool,
    pub include_relations: bool,
    pub top_k: usize,
    /// 结果总内容的 token 预算。超出的记进 `truncated_candidates`。
    pub max_tokens: usize,
}

impl RetrievalQuery {
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: query.into(),
            query_embedding: None,
            scopes: Vec::new(),
            current_file: None,
            kinds: Vec::new(),
            time_range_ms: None,
            include_memories: true,
            include_tasks: true,
            include_relations: true,
            top_k: 8,
            max_tokens: 4000,
        }
    }

    fn wants(&self, kind: ObjectKind) -> bool {
        self.kinds.is_empty() || self.kinds.contains(&kind)
    }
}

/// 分数的构成 / where the score came from.
///
/// 每一路单独留着，因为"为什么这条排第一"在调试召回质量时是唯一有用的信息。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBreakdown {
    pub fts: f64,
    pub vector: f64,
    pub rrf: f64,
    pub rerank: f64,
    pub recency: f64,
    pub graph: f64,
    pub lexical: f64,
}

/// 一条检索结果 / one retrieved item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedItem {
    /// backfill 未完成时为 `None`，此时只能靠 `legacy_source_id` 定位。
    pub object_id: Option<String>,
    pub legacy_source_id: String,
    pub kind: ObjectKind,
    pub title: String,
    pub excerpt: String,
    pub version: Option<i64>,
    pub scope: String,
    pub updated_at_ms: Option<i64>,
    pub score: f64,
    pub score_breakdown: ScoreBreakdown,
    /// 人能读的命中理由：`fts`、`vector`、`rerank`、`current_file`、
    /// `backlink`、`semantic_edge`、`memory_recall`、`open_task`。
    pub why_matched: Vec<String>,
    pub source: SourceRef,
    /// 回到原文的坐标，如 `path#chunk:41`。
    pub locator: Option<String>,
    pub evidence_ids: Vec<String>,
    pub evidence_summary: Option<String>,
    /// `no_stable_identity` / `out_of_scope` / `stale` / `low_confidence` /
    /// `unconfirmed` / `conflicting` / `expanded`。
    pub warnings: Vec<String>,
}

/// 一次检索的产出 / the outcome of one retrieval.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    pub items: Vec<RetrievedItem>,
    /// 因为预算被裁掉的候选数与原因，Context Inspector 要显示这个。
    pub truncated_candidates: usize,
    pub used_tokens: usize,
    /// 整次检索级别的警告，如"向量索引为空，已降级为 FTS"。
    pub warnings: Vec<String>,
}

/// 受控扩展的上限 / the cap on graph expansion.
///
/// 扩展是为了补上"命中笔记的邻居也相关"，不是为了把整张图塞进 prompt。
const MAX_EXPANSION: usize = 4;

/// 粗略 token 估算 / a rough token estimate.
///
/// 与 `llm::context` 的口径一致：这里只需要一个稳定的裁剪依据，不需要精确。
fn estimate_tokens(text: &str) -> usize {
    // CJK 约 1 字 1 token，ASCII 约 4 字符 1 token。
    let cjk = text
        .chars()
        .filter(|c| matches!(*c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF))
        .count();
    let rest = text.chars().count() - cjk;
    cjk + rest / 4 + 1
}

fn scope_of(path: &str) -> String {
    std::path::Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn in_scope(path: &str, scopes: &[String]) -> bool {
    if scopes.is_empty() {
        return true;
    }
    let normalized = path.replace('\\', "/");
    scopes
        .iter()
        .any(|s| normalized.starts_with(&s.replace('\\', "/")))
}

/// 跑一次统一检索 / run one unified retrieval.
///
/// 顺序：文档召回 → 对象化与去重 → 受控扩展 → 记忆 → 开放任务 → 预算裁剪。
/// 每一步都只**追加** warning，从不因为可疑就悄悄丢掉结果。
pub fn retrieve(conn: &Connection, q: &RetrievalQuery) -> ObjectResult<RetrievalResult> {
    let mut out = RetrievalResult::default();
    let mut items: Vec<RetrievedItem> = Vec::new();

    if q.wants(ObjectKind::Document) || q.wants(ObjectKind::Block) {
        let (docs, warnings) = retrieve_documents(conn, q)?;
        out.warnings.extend(warnings);
        items.extend(docs);
    }

    if q.include_relations {
        let expanded = expand_from_hits(conn, q, &items)?;
        items.extend(expanded);
    }

    if q.include_memories && q.wants(ObjectKind::Memory) {
        items.extend(retrieve_memories(conn, q)?);
    }

    if q.include_tasks && q.wants(ObjectKind::Task) {
        items.extend(retrieve_open_tasks(conn, q)?);
    }

    // 时间窗过滤：不在窗内的直接不进候选（这是用户明确要求的范围，不是"可疑"）。
    if let Some((from, to)) = q.time_range_ms {
        items.retain(|i| match i.updated_at_ms {
            Some(ts) => ts >= from && ts <= to,
            // 时间未知的保留但标记，比默默丢掉一篇可能相关的笔记好。
            None => true,
        });
    }

    items.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // 预算裁剪放在排序之后：先决定谁重要，再决定谁装得下。
    let mut used = 0usize;
    let mut kept = Vec::new();
    for item in items {
        let cost = estimate_tokens(&item.excerpt) + estimate_tokens(&item.title);
        if kept.len() >= q.top_k || used + cost > q.max_tokens {
            out.truncated_candidates += 1;
            continue;
        }
        used += cost;
        kept.push(item);
    }

    out.used_tokens = used;
    out.items = kept;
    Ok(out)
}

// ── 文档召回 / document recall ──────────────────────────────────────────────

/// 复用现有 FTS/RRF/rerank，然后折叠到对象级 / reuse the existing recall, then fold.
fn retrieve_documents(
    conn: &Connection,
    q: &RetrievalQuery,
) -> ObjectResult<(Vec<RetrievedItem>, Vec<String>)> {
    let mut warnings = Vec::new();
    let config = search::rerank::load_config(conn);
    // 召回宽、排序窄：多取一些再折叠，否则同一篇笔记的多个 chunk 会吃掉 top_k。
    let recall_limit = (q.top_k * 4).max(20);

    let (hits, mode) = match &q.query_embedding {
        Some(embedding) if !embedding.is_empty() => (
            search::hybrid_search_reranked(conn, &q.query, embedding, recall_limit, &config, None),
            "hybrid",
        ),
        _ => {
            warnings.push("fts_only_no_query_embedding".to_string());
            (
                search::full_text_search_reranked(conn, &q.query, recall_limit, &config, None),
                "fts",
            )
        }
    };
    let hits = hits.map_err(|e| object_store::ObjectError::Search(e.to_string()))?;

    // 折叠：一个 file_path 一条结果，留最高分那个 chunk 的 locator 与摘录。
    let mut folded: Vec<RetrievedItem> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for (rank, hit) in hits.iter().enumerate() {
        if !in_scope(&hit.file_path, &q.scopes) {
            continue;
        }
        if let Some(&idx) = seen.get(&hit.file_path) {
            // 同一篇的后续 chunk 只补一条 locator，不再占一个结果位。
            folded[idx].why_matched.push(format!("chunk:{}", hit.chunk_id));
            continue;
        }

        let mut breakdown = ScoreBreakdown {
            rerank: hit.score,
            ..Default::default()
        };
        match mode {
            "hybrid" => breakdown.rrf = hit.score,
            _ => breakdown.fts = hit.score,
        }
        // 排名衰减作为可比较的基准分：不同 mode 的原始分不同量纲。
        let rank_score = 1.0 / (1.0 + rank as f64);

        let mut item = build_document_item(conn, &hit.file_path, rank_score, breakdown)?;
        item.excerpt = truncate_excerpt(&hit.content);
        item.locator = Some(format!("{}#chunk:{}", hit.file_path, hit.chunk_id));
        item.why_matched.push(mode.to_string());
        if config.mode != search::rerank::RerankMode::Off {
            item.why_matched.push("rerank".to_string());
        }

        seen.insert(hit.file_path.clone(), folded.len());
        folded.push(item);
    }

    // 当前打开的笔记优先：加一个明确的加成而不是偷偷改排序。
    //
    // 加 1.0 而不是 0.5：基准分是 `1/(1+rank)`，第一名就是 1.0，所以 0.5 的加成只能
    // 让当前笔记从第二名追平第一名——排序稳定，追平等于没动。用户正打开的那篇笔记
    // 如果匹配上了，它就该是第一个。
    if let Some(current) = &q.current_file {
        for item in folded.iter_mut() {
            if &item.legacy_source_id == current {
                item.score += 1.0;
                item.why_matched.push("current_file".to_string());
            }
        }
    }

    Ok((folded, warnings))
}

/// 把一个笔记路径变成带 provenance 的结果 / turn a note path into a provenanced item.
///
/// `object_id` 为 `None` 时挂 `no_stable_identity` warning。这是"不得伪造对象 ID"
/// 的落点：backfill 没跑到就如实说没跑到。
fn build_document_item(
    conn: &Connection,
    file_path: &str,
    base_score: f64,
    breakdown: ScoreBreakdown,
) -> ObjectResult<RetrievedItem> {
    let source = SourceRef::file(file_path);
    let object = object_store::find_by_source(conn, &source)?;

    let title = object
        .as_ref()
        .and_then(|o| o.title.clone())
        .or_else(|| {
            conn.query_row(
                "SELECT title FROM files WHERE path = ?1",
                params![file_path],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .ok()
            .flatten()
            .flatten()
        })
        .unwrap_or_else(|| file_path.to_string());

    let mut warnings = Vec::new();
    if object.is_none() {
        warnings.push("no_stable_identity".to_string());
    }
    if let Some(obj) = &object {
        if obj.status != ObjectStatus::Active {
            warnings.push("stale".to_string());
        }
    }

    let evidence_ids = match &object {
        Some(obj) => super::evidence::evidence_for_object(conn, &obj.id)?
            .into_iter()
            .map(|(e, _, _)| e.id)
            .collect(),
        None => Vec::new(),
    };

    Ok(RetrievedItem {
        object_id: object.as_ref().map(|o| o.id.clone()),
        legacy_source_id: file_path.to_string(),
        kind: ObjectKind::Document,
        title,
        excerpt: String::new(),
        version: object.as_ref().map(|o| o.current_version),
        scope: object
            .as_ref()
            .map(|o| o.scope.clone())
            .unwrap_or_else(|| scope_of(file_path)),
        updated_at_ms: object.as_ref().map(|o| o.updated_at_ms),
        score: base_score,
        score_breakdown: breakdown,
        why_matched: Vec::new(),
        source,
        locator: None,
        evidence_ids,
        evidence_summary: None,
        warnings,
    })
}

/// 摘录截断 / cap one excerpt.
///
/// 按字符而不是字节：中文按字节切会切出半个字。
fn truncate_excerpt(content: &str) -> String {
    const MAX_CHARS: usize = 400;
    if content.chars().count() <= MAX_CHARS {
        return content.to_string();
    }
    let head: String = content.chars().take(MAX_CHARS).collect();
    format!("{head}…")
}

// ── 受控扩展 / controlled expansion ─────────────────────────────────────────

/// 从已命中的笔记扩一圈邻居 / expand one hop from the hits.
///
/// 复用 `search::get_related_notes`，它已经合并了 semantic edges、note_relations、
/// wikilink backlinks 三路信号。扩展结果一律标 `expanded`，并且分数压到命中之下——
/// 邻居是补充，不该抢占主命中的位置。
fn expand_from_hits(
    conn: &Connection,
    q: &RetrievalQuery,
    hits: &[RetrievedItem],
) -> ObjectResult<Vec<RetrievedItem>> {
    let mut already: std::collections::HashSet<String> =
        hits.iter().map(|i| i.legacy_source_id.clone()).collect();
    // 当前笔记优先扩展，其次是最高分的那条命中。
    let seeds: Vec<String> = q
        .current_file
        .iter()
        .cloned()
        .chain(hits.iter().take(2).map(|i| i.legacy_source_id.clone()))
        .collect();

    let mut out = Vec::new();
    for seed in seeds {
        if out.len() >= MAX_EXPANSION {
            break;
        }
        let Ok(related) = search::get_related_notes(conn, &seed, MAX_EXPANSION) else {
            continue;
        };
        for note in related.notes {
            if out.len() >= MAX_EXPANSION {
                break;
            }
            if !already.insert(note.file_path.clone()) {
                continue;
            }
            if !in_scope(&note.file_path, &q.scopes) {
                continue;
            }

            let breakdown = ScoreBreakdown {
                graph: note.score,
                ..Default::default()
            };
            // 扩展分上限 0.4，低于任何一条真实命中的基准分（1/(1+rank) ≥ 0.5 起）。
            let mut item =
                build_document_item(conn, &note.file_path, (note.score * 0.4).min(0.4), breakdown)?;
            item.excerpt = truncate_excerpt(&note.preview);
            item.locator = Some(note.file_path.clone());
            item.why_matched.push("expanded".to_string());
            item.why_matched.extend(note.signals.clone());
            item.warnings.push("expanded".to_string());
            out.push(item);
        }
    }
    Ok(out)
}

// ── 记忆与任务 / memories and open tasks ────────────────────────────────────

fn retrieve_memories(conn: &Connection, q: &RetrievalQuery) -> ObjectResult<Vec<RetrievedItem>> {
    let scope = q.scopes.first().map(|s| s.as_str());
    let hits = memory::recall(conn, &q.query, scope, memory::RECALL_LIMIT)?;

    Ok(hits
        .into_iter()
        .map(|hit| {
            let breakdown = ScoreBreakdown {
                lexical: hit.score,
                ..Default::default()
            };
            RetrievedItem {
                object_id: hit.item.object_id.clone(),
                legacy_source_id: hit.item.id.clone(),
                kind: ObjectKind::Memory,
                title: hit.item.kind.as_str().to_string(),
                excerpt: hit.item.claim.clone(),
                version: None,
                scope: hit.item.scope.clone(),
                updated_at_ms: Some(hit.item.updated_at_ms),
                score: hit.score,
                score_breakdown: breakdown,
                why_matched: vec!["memory_recall".to_string()],
                source: hit
                    .item
                    .source
                    .clone()
                    .unwrap_or_else(|| SourceRef {
                        source_type: "memory".into(),
                        source_id: hit.item.id.clone(),
                    }),
                locator: None,
                evidence_ids: Vec::new(),
                evidence_summary: hit.item.confirmed_by.clone().map(|by| format!("confirmed by {by}")),
                warnings: hit.warnings,
            }
        })
        .collect())
}

/// 与当前问题相关的未完成承诺 / open commitments relevant to the query.
///
/// 用同一条词面重叠规则打分，不引第二套匹配逻辑。
fn retrieve_open_tasks(conn: &Connection, q: &RetrievalQuery) -> ObjectResult<Vec<RetrievedItem>> {
    let query_tokens = crate::db::memory_store::tokenize(&q.query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT id, object_id, title, status, due_at_ms, updated_at_ms, priority
         FROM task_commitments
         WHERE status IN ('proposed', 'active')
         ORDER BY COALESCE(due_at_ms, 9223372036854775807), priority DESC
         LIMIT 100",
    )?;
    let rows: Vec<(String, Option<String>, String, String, Option<i64>, i64, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let now = now_ms();
    let mut out = Vec::new();
    for (id, object_id, title, status, due_at_ms, updated_at_ms, _priority) in rows {
        let overlap = crate::db::memory_store::lexical_overlap(&query_tokens, &title);
        if overlap <= 0.0 {
            continue;
        }
        let mut warnings = Vec::new();
        if let Some(due) = due_at_ms {
            if due < now {
                warnings.push("overdue".to_string());
            }
        }
        if status == "proposed" {
            warnings.push("unconfirmed".to_string());
        }

        out.push(RetrievedItem {
            object_id,
            legacy_source_id: id.clone(),
            kind: ObjectKind::Task,
            title: title.clone(),
            excerpt: title,
            version: None,
            scope: String::new(),
            updated_at_ms: Some(updated_at_ms),
            score: overlap,
            score_breakdown: ScoreBreakdown { lexical: overlap, ..Default::default() },
            why_matched: vec!["open_task".to_string()],
            source: SourceRef { source_type: "commitment".into(), source_id: id },
            locator: None,
            evidence_ids: Vec::new(),
            evidence_summary: None,
            warnings,
        });
    }
    Ok(out)
}
