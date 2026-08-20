use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

/// Relevance rerank stage (Lexical / CrossEncoder / Llm). Lives in
/// `db/search/rerank.rs` as a child of this module so it can reuse the
/// segmentation helpers (`is_cjk_char`) that FTS query building already relies on,
/// and so the rerank always sees the same tokenization the recall stage used.
///
/// Not to be confused with [`crate::db::rerank`], which is the *diversity/recency*
/// reranker (time decay + MMR). This one answers "is this chunk about the query",
/// that one answers "have I already shown the user this".
pub mod rerank;

/// A single search result returned from full-text or vector search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub file_path: String,
    pub chunk_id: i64,
    pub content: String,
    pub heading_hierarchy: Option<String>,
    pub score: f64,
}

/// A node in the knowledge graph.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub note_type: String,
    pub chunk_count: i64,
    pub is_hub: bool,       // most connected nodes
    pub is_orphan: bool,    // no connections
    pub cluster: usize,     // community/cluster id
    pub created_at: String, // earliest chunk timestamp for time travel slider
    pub pagerank: f64,      // KG-3: knowledge importance score
}

/// Cluster info with label and node count.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterInfo {
    pub id: usize,
    pub label: String,
    pub node_count: usize,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SuggestedLink {
    Simple(String),
    Detailed {
        target: String,
        relation: Option<String>,
        reason: Option<String>,
        confidence: Option<f64>,
    }
}

impl SuggestedLink {
    pub fn target(&self) -> &str {
        match self {
            SuggestedLink::Simple(s) => s,
            SuggestedLink::Detailed { target, .. } => target,
        }
    }

    pub fn relation(&self) -> Option<&str> {
        match self {
            SuggestedLink::Simple(_) => None,
            SuggestedLink::Detailed { relation, .. } => relation.as_deref(),
        }
    }

    pub fn confidence(&self) -> f64 {
        match self {
            SuggestedLink::Simple(_) => 0.5,
            SuggestedLink::Detailed { confidence, .. } => confidence.unwrap_or(0.5),
        }
    }
}

/// An edge in the knowledge graph.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub edge_type: String, // "link" | "semantic"
    pub weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// The complete graph data.
#[derive(Debug, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub clusters: Vec<ClusterInfo>,
}

/// Perform full-text search using FTS5 on chunk content.
pub fn full_text_search(conn: &Connection, query: &str, limit: usize) -> anyhow::Result<Vec<SearchResult>> {
    // Only control characters need stripping. Every other character is made safe by
    // wrapping each term in an FTS5 string literal in `build_fts_query`, so we must NOT
    // drop things like '.' or '-' here — that used to turn "nomic-embed-v1.5" into
    // "nomicembedv15", which can never match the indexed tokens.
    let sanitized: String = query
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        return Ok(vec![]);
    }

    // Split mixed Chinese+English queries into meaningful terms.
    // FTS5 unicode61 tokenizer treats each CJK character as a separate token,
    // so "BERT是什么" would require ALL of (BERT, 是, 什, 么) to match.
    // Instead, we extract English words and CJK character sequences as separate terms
    // and join them with OR for broader matching.
    let fts_query = build_fts_query(&sanitized);

    if fts_query.is_empty() {
        return Ok(vec![]);
    }

    let mut stmt = conn.prepare(
        "SELECT c.id, c.file_path, c.content, c.heading_hierarchy,
                chunks_fts.rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?1
         ORDER BY chunks_fts.rank
         LIMIT ?2",
    )?;

    let results = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            Ok(SearchResult {
                chunk_id: row.get(0)?,
                file_path: row.get(1)?,
                content: row.get(2)?,
                heading_hierarchy: row.get(3)?,
                score: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Wrap a term in an FTS5 string literal so operator characters (`-`, `+`, `"`, `*`,
/// `:`, `(`, `NEAR`, …) are treated as text instead of syntax. Inner double quotes are
/// doubled, which is FTS5's own escaping rule.
fn fts_quote(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// A term is only usable if it still contains something the tokenizer will index.
/// `"-"` or `"..."` would otherwise become an empty FTS5 literal.
fn has_indexable_content(term: &str) -> bool {
    term.chars().any(|c| c.is_alphanumeric() || is_cjk_char(c))
}

/// Build an FTS5 query from mixed Chinese+English input.
/// Extracts English words (kept whole) and Chinese terms (grouped by consecutive CJK chars).
/// Joins them with OR for broader matching. Every term is quoted, so an input like
/// "AI-Agent 是什么" or "C++ 编程" is a valid query instead of an FTS5 syntax error.
/// Examples:
///   "BERT是什么" → "\"BERT\" OR \"是什么\""
///   "knowledge graph 知识图谱" → "\"knowledge\" OR \"graph\" OR \"知识图谱\""
///   "Transformer" → "\"Transformer\""
fn build_fts_query(input: &str) -> String {
    let mut terms: Vec<String> = Vec::new();
    let mut current_ascii = String::new();
    let mut current_cjk = String::new();

    for c in input.chars() {
        if is_cjk_char(c) {
            // Flush ASCII word if any
            if !current_ascii.is_empty() {
                let word = current_ascii.trim().to_string();
                if !word.is_empty() {
                    terms.push(word);
                }
                current_ascii.clear();
            }
            current_cjk.push(c);
        } else {
            // Flush CJK sequence if any
            if !current_cjk.is_empty() {
                terms.push(current_cjk.clone());
                current_cjk.clear();
            }
            if c.is_whitespace() {
                // Flush ASCII word on space
                let word = current_ascii.trim().to_string();
                if !word.is_empty() {
                    terms.push(word);
                }
                current_ascii.clear();
            } else {
                current_ascii.push(c);
            }
        }
    }

    // Flush remaining
    if !current_ascii.is_empty() {
        let word = current_ascii.trim().to_string();
        if !word.is_empty() {
            terms.push(word);
        }
    }
    if !current_cjk.is_empty() {
        terms.push(current_cjk);
    }

    // Deduplicate
    terms.dedup();

    // Drop terms the tokenizer would index as nothing (e.g. a bare "-" or "...").
    terms.retain(|t| has_indexable_content(t));

    // Filter out very short CJK stop-word-like terms (single chars like 是, 的, 了, 吗)
    let stop_chars = ['是', '的', '了', '吗', '呢', '吧', '啊', '在', '有', '和', '与', '或', '不', '也', '都', '就', '把', '被', '给', '让', '对', '从', '到', '为', '着', '过', '得', '地', '么'];
    let meaningful_terms: Vec<&String> = terms.iter().filter(|t| {
        // Keep all ASCII terms
        if t.chars().all(|c| !is_cjk_char(c)) {
            return true;
        }
        // For CJK, filter out single stop chars
        if t.chars().count() == 1 && stop_chars.contains(&t.chars().next().unwrap()) {
            return false;
        }
        true
    }).collect();

    // Every term is quoted so operator characters cannot break the query syntax.
    if meaningful_terms.is_empty() {
        // Fallback: use all terms
        terms.iter().map(|t| fts_quote(t)).collect::<Vec<_>>().join(" OR ")
    } else {
        meaningful_terms.iter().map(|t| fts_quote(t)).collect::<Vec<_>>().join(" OR ")
    }
}

/// Check if a character is CJK (Chinese/Japanese/Korean)
fn is_cjk_char(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}' |    // CJK Unified Ideographs
        '\u{3400}'..='\u{4DBF}' |    // CJK Extension A
        '\u{F900}'..='\u{FAFF}' |    // CJK Compatibility Ideographs
        '\u{3000}'..='\u{303F}' |    // CJK Symbols and Punctuation
        '\u{FF00}'..='\u{FFEF}' |    // Fullwidth Forms
        '\u{3040}'..='\u{309F}' |    // Hiragana
        '\u{30A0}'..='\u{30FF}'      // Katakana
    )
}

/// Perform vector similarity search using sqlite-vec.
/// `query_embedding` must be a 768-dimensional f32 vector (nomic-embed-text-v1.5).
pub fn vector_search(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    // Serialize the embedding to bytes (little-endian f32 array)
    let embedding_bytes: Vec<u8> = query_embedding
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();

    let mut stmt = conn.prepare(
        "SELECT c.id, c.file_path, c.content, c.heading_hierarchy,
                vec_distance_cosine(v.embedding, ?1) as distance
         FROM chunks_vec v
         JOIN chunks c ON c.id = v.id
         ORDER BY distance ASC
         LIMIT ?2",
    )?;

    let results = stmt
        .query_map(params![embedding_bytes, limit as i64], |row| {
            Ok(SearchResult {
                chunk_id: row.get(0)?,
                file_path: row.get(1)?,
                content: row.get(2)?,
                heading_hierarchy: row.get(3)?,
                score: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results)
}

/// Hybrid search: combine FTS and vector results with reciprocal rank fusion.
pub fn hybrid_search(
    conn: &Connection,
    query: &str,
    query_embedding: &[f32],
    limit: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    // Get results from both search methods (fetch more than needed for fusion)
    let fts_results = full_text_search(conn, query, limit * 2)?;
    let vec_results = vector_search(conn, query_embedding, limit * 2)?;

    // Reciprocal Rank Fusion (RRF)
    let k = 60.0_f64;
    let mut scores: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    let mut chunk_data: std::collections::HashMap<i64, SearchResult> = std::collections::HashMap::new();

    for (rank, result) in fts_results.iter().enumerate() {
        let rrf_score = 1.0 / (k + rank as f64 + 1.0);
        *scores.entry(result.chunk_id).or_insert(0.0) += rrf_score;
        chunk_data.entry(result.chunk_id).or_insert_with(|| SearchResult {
            file_path: result.file_path.clone(),
            chunk_id: result.chunk_id,
            content: result.content.clone(),
            heading_hierarchy: result.heading_hierarchy.clone(),
            score: 0.0,
        });
    }

    for (rank, result) in vec_results.iter().enumerate() {
        let rrf_score = 1.0 / (k + rank as f64 + 1.0);
        *scores.entry(result.chunk_id).or_insert(0.0) += rrf_score;
        chunk_data.entry(result.chunk_id).or_insert_with(|| SearchResult {
            file_path: result.file_path.clone(),
            chunk_id: result.chunk_id,
            content: result.content.clone(),
            heading_hierarchy: result.heading_hierarchy.clone(),
            score: 0.0,
        });
    }

    // Sort by RRF score descending
    let mut combined: Vec<(i64, f64)> = scores.into_iter().collect();
    combined.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<SearchResult> = combined
        .into_iter()
        .take(limit)
        .filter_map(|(chunk_id, score)| {
            chunk_data.get(&chunk_id).map(|d| SearchResult {
                file_path: d.file_path.clone(),
                chunk_id: d.chunk_id,
                content: d.content.clone(),
                heading_hierarchy: d.heading_hierarchy.clone(),
                score,
            })
        })
        .collect();

    Ok(results)
}

/// Hybrid search followed by the relevance rerank stage.
///
/// Deliberately a *new* function rather than a change to [`hybrid_search`]: every
/// existing caller (`commands/chat_commands.rs`, `commands/search_commands.rs`,
/// `tools/internal_tools/search_ops.rs`, `scheduler/reconcile_task.rs`) keeps its
/// current signature and current behaviour, and opts in only when it is ready.
///
/// The recall/rerank split is the point of the whole stage: we fetch
/// `max(limit, top_k)` fused candidates — wider than the caller asked for — rerank
/// that window, then cut to `limit`. Reranking only the `limit` rows the old code
/// returned could never promote anything the fusion under-ranked, which is exactly
/// the failure a reranker exists to fix.
///
/// `RerankMode::Off` short-circuits to plain [`hybrid_search`] with the original
/// `limit`, so the disabled path is not merely equivalent but literally the same
/// call.
pub fn hybrid_search_reranked(
    conn: &Connection,
    query: &str,
    query_embedding: &[f32],
    limit: usize,
    config: &rerank::RerankConfig,
    external: Option<&dyn rerank::ExternalReranker>,
) -> anyhow::Result<Vec<SearchResult>> {
    if config.mode == rerank::RerankMode::Off {
        return hybrid_search(conn, query, query_embedding, limit);
    }

    let recall_limit = limit.max(config.effective_top_k());
    let fused = hybrid_search(conn, query, query_embedding, recall_limit)?;
    let mut reranked = rerank::rerank_results(query, fused, config, external);
    reranked.truncate(limit);
    Ok(reranked)
}

/// Same recall-wide/rerank-narrow wrapper for the FTS-only path, used when the
/// vector index is empty (see `rag_effective_search_mode`). Lexical reranking is
/// arguably *more* valuable here: without embeddings, FTS5's `OR`-joined match is
/// the only recall signal, so ranking by feature quality is all we have.
pub fn full_text_search_reranked(
    conn: &Connection,
    query: &str,
    limit: usize,
    config: &rerank::RerankConfig,
    external: Option<&dyn rerank::ExternalReranker>,
) -> anyhow::Result<Vec<SearchResult>> {
    if config.mode == rerank::RerankMode::Off {
        return full_text_search(conn, query, limit);
    }

    let recall_limit = limit.max(config.effective_top_k());
    let recalled = full_text_search(conn, query, recall_limit)?;
    let mut reranked = rerank::rerank_results(query, recalled, config, external);
    reranked.truncate(limit);
    Ok(reranked)
}

/// Fetch knowledge graph data with caching.
///
/// The cache is keyed on a **content fingerprint** of every table the builder
/// actually reads (see [`graph_input_fingerprint`]). The previous condition was
/// `cached.nodes.len() == COUNT(*) FROM files`, which pure content editing never
/// changes: a user could add a hundred `[[wikilink]]`s, or the reconciler could
/// rewrite `card_meta.links`, and the cached edges, communities and PageRank
/// would keep being served indefinitely.
pub fn get_graph_data(conn: &Connection) -> anyhow::Result<GraphData> {
    let fingerprint = graph_input_fingerprint(conn);

    if let Ok((cached, cached_fingerprint)) = get_cached_graph(conn) {
        // `cached_fingerprint` is NULL for a row written by a pre-migration build.
        // Unknown is *not* a match: recompute once and stamp the fingerprint, or
        // an upgraded vault would keep the stale graph forever.
        if cached_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return Ok(cached);
        }
    }

    // Cache miss or stale: recompute
    let graph = build_graph_data_uncached(conn)?;

    // Store in cache.
    //
    // The fingerprint is re-read *after* the build on purpose: `build_graph_data_uncached`
    // may itself populate `semantic_edges` (the "no precomputed edges yet" path),
    // and those rows are part of the graph it just returned. Storing the
    // pre-build fingerprint would therefore never match again and the cache would
    // miss on every single call.
    let stored_fingerprint = graph_input_fingerprint(conn);
    if let Ok(serialized) = serde_json::to_vec(&graph) {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO graph_cache (id, serialized_data, node_count, edge_count, computed_at, content_fingerprint)
             VALUES (1, ?1, ?2, ?3, datetime('now'), ?4)",
            params![serialized, graph.nodes.len() as i64, graph.edges.len() as i64, stored_fingerprint],
        );
    }

    Ok(graph)
}

/// 图谱输入的内容指纹 / Content fingerprint of the graph builder's real inputs.
///
/// `build_graph_data_uncached` reads exactly five tables, and this covers each:
///
/// | input | why the graph depends on it | fingerprint component |
/// |---|---|---|
/// | `files` (path, title) | node set + link resolution keys | `COUNT(*)`, `MAX(last_synced)`, total title length |
/// | `chunks` (content, id, created_at) | inline `[[wikilink]]` edges, chunk counts, node `created_at` | `COUNT(*)`, `MAX(id)`, `MAX(updated_at/created_at)` |
/// | `card_meta` (links, note_type) | explicit link edges + node type | `COUNT(*)`, total `links` length, total `note_type` length, `MAX(last_reconciled)` |
/// | `note_relations` | labelled relation edges | `COUNT(*)`, `MAX(id)` |
/// | `semantic_edges` | similarity edges | `COUNT(*)`, `MAX(id)` |
///
/// `chunks_vec` / `files_vec` are deliberately absent: the builder never reads
/// them. It can *write* `semantic_edges` from them, and that write shows up in
/// the `semantic_edges` component.
///
/// ## 为什么 `MAX(id)` 是这里最强的信号 / Why `MAX(id)` is the strongest signal
///
/// `chunks.id`, `note_relations.id` and `semantic_edges.id` are
/// `INTEGER PRIMARY KEY AUTOINCREMENT`, which never re-uses a value. `sync_file`
/// (`db/sync.rs`) edits a note by `DELETE FROM chunks WHERE file_path = ?` and
/// re-inserting, so **any** content edit mints strictly larger ids —
/// `MAX(id)` moves even when the byte count is unchanged, which a length- or
/// timestamp-based fingerprint would miss. `semantic_edges` is written with
/// `INSERT OR REPLACE`, which also allocates a new id. `COUNT(*)` covers the
/// deletion direction, where `MAX(id)` can move backwards or not at all.
///
/// ## 抓不到什么（诚实说明）/ What it does NOT catch — honestly
///
/// 1. An **in-place** `UPDATE chunks SET content = …` that keeps the same row id
///    and leaves `updated_at` alone. Nothing in this repo does that today (sync
///    deletes and re-inserts, and `chunks.updated_at` has no update trigger), but
///    a future writer that does would slip past.
/// 2. A `card_meta.links` (or `note_type`) edit whose **total text length is
///    unchanged** — swapping `[[AAA]]` for `[[BBB]]`. In production the
///    reconciler that performs such a rewrite also calls
///    `invalidate_graph_cache` (`scheduler::reconcile_task`), so the fingerprint
///    is the backstop, not the only line of defence. A per-row hash would close
///    this, but hashing every note's link JSON on every cache probe costs more
///    than the staleness is worth.
/// 3. A `files.title` rename to a **same-length** title inside the same second
///    (`last_synced` is second-resolution). The accompanying chunk re-insert
///    normally moves `MAX(chunks.id)` anyway, so this needs a title-only DB edit.
/// 4. Timestamp collisions in general: `datetime('now')` has one-second
///    granularity, so timestamp components only distinguish changes at least a
///    second apart. Every component above is paired with a count or an id for
///    exactly this reason.
///
/// Cost: five scalar aggregate queries, no content hashing. `COUNT(*)`/`MAX(id)`
/// are index reads; the `SUM(LENGTH(...))` pairs are over `card_meta` and
/// `files.title` only — one short row per note — never over `chunks.content`,
/// which is the one table where a length sum would be genuinely expensive.
fn graph_input_fingerprint(conn: &Connection) -> String {
    // A failed component degrades to a fixed sentinel rather than a random value:
    // a table that cannot be read is a broken DB, and the graph build itself will
    // fail loudly right after. Silently *matching* is the only outcome to avoid.
    let files: (i64, String, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(last_synced), ''), COALESCE(SUM(LENGTH(title)), 0) FROM files",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or((-1, "?".to_string(), -1));

    let chunks: (i64, i64, String) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(id), 0),
                    COALESCE(MAX(COALESCE(updated_at, created_at)), '') FROM chunks",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or((-1, -1, "?".to_string()));

    let card_meta: (i64, i64, i64, String) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(links)), 0), COALESCE(SUM(LENGTH(note_type)), 0),
                    COALESCE(MAX(last_reconciled), '')
             FROM card_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap_or((-1, -1, -1, "?".to_string()));

    let relations: (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM note_relations",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((-1, -1));

    let semantic: (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM semantic_edges",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((-1, -1));

    format!(
        "v1|files:{}:{}:{}|chunks:{}:{}:{}|card_meta:{}:{}:{}:{}|relations:{}:{}|semantic:{}:{}",
        files.0, files.1, files.2,
        chunks.0, chunks.1, chunks.2,
        card_meta.0, card_meta.1, card_meta.2, card_meta.3,
        relations.0, relations.1,
        semantic.0, semantic.1,
    )
}

/// Invalidate the graph cache. Call when notes are created, deleted, renamed,
/// or after Smart Organize completes.
pub fn invalidate_graph_cache(conn: &Connection) {
    let _ = conn.execute("DELETE FROM graph_cache WHERE id = 1", []);
}

/// Read cached graph data from the database, together with the fingerprint it was
/// computed under (`None` when the row predates the `content_fingerprint` column).
fn get_cached_graph(conn: &Connection) -> anyhow::Result<(GraphData, Option<String>)> {
    let (blob, fingerprint): (Vec<u8>, Option<String>) = conn.query_row(
        "SELECT serialized_data, content_fingerprint FROM graph_cache WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let graph: GraphData = serde_json::from_slice(&blob)?;
    Ok((graph, fingerprint))
}

/// Build graph data from scratch (no caching).
fn build_graph_data_uncached(conn: &Connection) -> anyhow::Result<GraphData> {
    // ── Step 1: Get all files as nodes ──────────────────────────────
    let mut stmt = conn.prepare(
        "SELECT f.path, f.title, COALESCE(cm.note_type, 'permanent'),
                (SELECT COUNT(*) FROM chunks c WHERE c.file_path = f.path),
                (SELECT MIN(c2.created_at) FROM chunks c2 WHERE c2.file_path = f.path)
         FROM files f
         LEFT JOIN card_meta cm ON f.path = cm.file_path",
    )?;

    let mut nodes: Vec<GraphNode> = stmt
        .query_map([], |row| {
            let path: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let note_type: String = row.get(2)?;
            let chunk_count: i64 = row.get(3)?;
            let created_at: Option<String> = row.get(4)?;

            let label = title
                .or_else(|| {
                    path.replace('\\', "/")
                        .rsplit('/')
                        .next()
                        .map(|s| s.replace(".md", ""))
                })
                .unwrap_or_else(|| path.clone());

            Ok(GraphNode {
                id: path,
                label,
                note_type,
                chunk_count,
                is_hub: false,
                is_orphan: false,
                cluster: 0,
                created_at: created_at.unwrap_or_default(),
                pagerank: 0.0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // 归一化解析表，Step 2 与 Step 2b 共用一份 / one resolution table, shared by
    // both link steps. Built once: `from_files` is a full pass over `files`, and
    // the two steps must resolve `[[X]]` identically or the graph would contain
    // edges the backlink panel and the health desk disagree with.
    let resolver = crate::db::wikilink::LinkResolver::from_files(conn)?;

    // ── Step 2: Get explicit wikilink edges ─────────────────────────
    let mut stmt = conn.prepare(
        "SELECT file_path, links FROM card_meta WHERE links IS NOT NULL AND links != '[]'",
    )?;

    let mut edges: Vec<GraphEdge> = Vec::new();

    let rows = stmt.query_map([], |row| {
        let file_path: String = row.get(0)?;
        let links_json: String = row.get(1)?;
        Ok((file_path, links_json))
    })?;

    for row in rows {
        let (file_path, links_json) = row?;
        if let Ok(links) = serde_json::from_str::<Vec<SuggestedLink>>(&links_json) {
            for link_item in links {
                let relation = link_item.relation();

                // `card_meta.links` 的真实形状 / what is actually stored here:
                // the reconciler copies the LLM's `suggested_links` array verbatim
                // (scheduler/reconcile_task.rs:557), and both prompts that produce
                // it demand `"target": "[[Exact Candidate Title]]"` —
                // llm/prompts.rs:220 and :554. So an entry is a `SuggestedLink`
                // whose `target` is a **bracket-wrapped note title**. Nothing
                // validates that, though: the LLM may drop the brackets (hence
                // reconcile_task.rs:571 re-wrapping them) and may append
                // `|别名` / `#小节` copied out of the note body. `parse_link_target`
                // handles all four spellings plus the optional brackets, which is
                // why it tolerates them at all.
                let Some(raw_target) = crate::db::wikilink::parse_link_target(link_item.target())
                else {
                    continue;
                };

                // 为什么删掉 `filename_norm.contains(link_norm)` 模糊兜底 /
                // Why the old fuzzy fallback had to go.
                //
                // This used to walk every node and accept the first one where
                // `node_norm == link_norm || filename_norm == link_norm ||
                //  filename_norm.contains(&link_norm)`. The third arm is a
                // substring test, so `[[Rust]]` attached itself to whichever of
                // `Rust.md` / `Rust进阶笔记.md` the node scan reached first. That is
                // not a missing edge, it is a **wrong** edge, and the graph is not
                // where wrong edges stop: `link` edges feed PageRank, community
                // detection, hub/orphan flags and the local-graph view, so one bad
                // substring hit silently reweights the whole vault.
                //
                // Nothing needed the fuzziness. The resolver keys every note by
                // *both* its title and its file stem, which covers every spelling
                // the prompts can legitimately produce ("use the EXACT title") and
                // every spelling a human writes by hand. A target that matches
                // neither key is either a note that does not exist or an LLM
                // paraphrase of a title — and in both cases guessing a longer note
                // that merely *contains* the text is worse than admitting the link
                // is broken. 宁缺勿错 / a missing edge is recoverable, a wrong edge
                // corrupts every metric downstream.
                //
                // Behaviour boundary now: an entry resolves to exactly one note or
                // to nothing. Ambiguous keys (`重复` vs `重复！`) go to the lowest
                // path, the same first-writer-wins rule the other three views use.
                if let Some(target_path) = resolver.resolve(&raw_target) {
                    if target_path != file_path {
                        edges.push(GraphEdge {
                            source: file_path.clone(),
                            target: target_path.to_string(),
                            edge_type: "link".to_string(),
                            weight: 1.0,
                            label: relation.map(|s| s.to_string()),
                        });
                    }
                }
            }
        }
    }

    // ── Step 2b: Get inline wikilinks from note content chunks ───────
    // Parsing + resolution are delegated to `db::wikilink`, the single shared
    // implementation the backlink panel, the health desk and the related-notes
    // panel also use, and — since Step 2 above — the same `resolver` instance.
    // This replaces the old inline `[[…]]` walk that (a) fed the raw inner text
    // through `normalize_title`, which merges `标题|别名` into `标题别名` and so
    // matched no note, and (b) fell back to a `filename.contains(link)` fuzzy
    // test that could attach a link to the wrong note. The resolver keys every
    // note by title *and* file stem, first-writer-wins, so `[[标题|别名]]` and
    // `[[标题#小节]]` now resolve to exactly the note the other views resolve
    // them to. The old per-node scan is also O(chunks × nodes); this is O(links).
    let mut chunk_stmt = conn.prepare(
        "SELECT file_path, content FROM chunks WHERE content LIKE '%[[%]]%'",
    )?;
    let chunk_rows = chunk_stmt.query_map([], |row| {
        let file_path: String = row.get(0)?;
        let content: String = row.get(1)?;
        Ok((file_path, content))
    })?;

    for row in chunk_rows {
        let (file_path, content) = row?;
        for raw_target in crate::db::wikilink::wikilink_targets(&content) {
            if let Some(target_path) = resolver.resolve(&raw_target) {
                if target_path != file_path {
                    edges.push(GraphEdge {
                        source: file_path.clone(),
                        target: target_path.to_string(),
                        edge_type: "link".to_string(),
                        weight: 1.0,
                        label: None,
                    });
                }
            }
        }
    }

    // ── Step 3: Get precomputed semantic similarity edges ────────────
    // KG-1: Read from semantic_edges table (precomputed by scheduler)
    let semantic_edges = get_precomputed_semantic_edges(conn)?;
    if semantic_edges.is_empty() {
        // No precomputed edges yet: trigger full KNN-based computation
        // (replaces the old O(N²) brute-force fallback for scalability)
        log::info!("No precomputed semantic edges found, computing via KNN...");
        if let Err(e) = compute_and_store_semantic_edges(conn, None) {
            log::warn!("Semantic edge computation failed: {}, skipping semantic edges", e);
        }
        let computed = get_precomputed_semantic_edges(conn)?;
        edges.extend(computed);
    } else {
        edges.extend(semantic_edges);
    }

    // ── Step 3b: Get relation edges from note_relations table ────────
    // These carry labels like "supports", "contradicts", "refines", "supplementary"
    // Filter out very low-confidence relations to reduce graph noise
    let relation_edges = get_all_relation_edges(conn).unwrap_or_default();
    for re in relation_edges {
        // Only add if both source and target exist as nodes
        let src_exists = nodes.iter().any(|n| n.id == re.source);
        let tgt_exists = nodes.iter().any(|n| n.id == re.target);
        if src_exists && tgt_exists {
            edges.push(re);
        }
    }

    // ── Step 3c: Deduplicate edges preserving type diversity ─────────
    // FIX: Previous dedup removed ALL but one edge between any pair, losing
    // valuable information (e.g. a "supports" link AND a semantic similarity
    // edge between the same pair). Now we dedup by (source, target, edge_type, label)
    // to preserve different types of connections.
    edges.sort_by(|a, b| {
        (&a.source, &a.target, &a.edge_type, &a.label)
            .cmp(&(&b.source, &b.target, &b.edge_type, &b.label))
    });
    edges.dedup_by(|a, b| {
        a.source == b.source && a.target == b.target
            && a.edge_type == b.edge_type && a.label == b.label
    });

    // ── Step 3d: Apply edge type weighting ───────────────────────────
    // Different edge types carry different signal strength:
    // - Explicit wikilinks (user-written): strongest signal (weight 1.0)
    // - AI relation edges (LLM-suggested): medium signal (weight = confidence)
    // - Semantic edges (embedding similarity): weaker signal (weight * 0.6)
    // This improves community detection and PageRank accuracy.
    for edge in &mut edges {
        match edge.edge_type.as_str() {
            "link" => {
                // Unlabeled link edges are explicit user wikilinks — strongest
                if edge.label.is_none() {
                    edge.weight = 1.0;
                }
                // Labeled edges (AI relations) keep their confidence-based weight
            }
            "semantic" => {
                // Semantic similarity is a weaker signal than explicit links.
                // Scale down to prevent semantic clusters from overwhelming
                // explicit conceptual connections in community detection.
                edge.weight *= 0.6;
            }
            _ => {}
        }
    }

    // ── Step 4: Detect hub and orphan nodes ─────────────────────────
    let mut connection_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for edge in &edges {
        *connection_count.entry(edge.source.clone()).or_insert(0) += 1;
        *connection_count.entry(edge.target.clone()).or_insert(0) += 1;
    }

    // Hub = top 10% most connected (at least 3 connections)
    let mut counts: Vec<usize> = connection_count.values().copied().collect();
    counts.sort_unstable();
    let hub_threshold = if counts.len() >= 10 {
        counts[counts.len() * 9 / 10].max(3)
    } else {
        3
    };

    for node in &mut nodes {
        let count = connection_count.get(&node.id).copied().unwrap_or(0);
        node.is_hub = count >= hub_threshold;
        node.is_orphan = count == 0;
    }

    // ── Step 5: Community detection using Louvain ────────────────
    let clusters = detect_communities(&mut nodes, &edges);

    // ── Step 6: PageRank for knowledge importance (KG-3) ────────────
    compute_pagerank(&mut nodes, &edges);

    Ok(GraphData { nodes, edges, clusters })
}

/// Cluster colors for visualization.
const CLUSTER_COLORS: &[&str] = &[
    "#10B981", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6",
    "#EC4899", "#06B6D4", "#84CC16", "#F97316", "#6366F1",
    "#14B8A6", "#E11D48", "#A855F7", "#0EA5E9", "#D946EF",
];

/// Detect communities using Louvain modularity optimization.
/// Unlike Union-Find (which only finds connected components), Louvain identifies
/// densely-connected sub-communities within large connected components.
fn detect_communities(nodes: &mut [GraphNode], edges: &[GraphEdge]) -> Vec<ClusterInfo> {
    if nodes.is_empty() {
        return Vec::new();
    }

    // Build node index map
    let mut node_index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        node_index.insert(node.id.clone(), i);
    }

    let n = nodes.len();

    // Build weighted adjacency list
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    let mut total_weight = 0.0_f64;

    for edge in edges {
        if let (Some(&src), Some(&tgt)) = (node_index.get(&edge.source), node_index.get(&edge.target)) {
            if src != tgt {
                let w = edge.weight.max(0.1); // minimum weight
                adj[src].push((tgt, w));
                adj[tgt].push((src, w));
                total_weight += w; // each edge counted once here, but adj is bidirectional
            }
        }
    }

    if total_weight == 0.0 {
        // No edges: each node is its own community
        for (i, node) in nodes.iter_mut().enumerate() {
            node.cluster = i;
        }
        return build_cluster_info(nodes, edges);
    }

    // m = sum of all edge weights (each edge counted once)
    let m = total_weight;

    // Degree (sum of edge weights) for each node
    let mut degree: Vec<f64> = vec![0.0; n];
    for i in 0..n {
        for &(_, w) in &adj[i] {
            degree[i] += w;
        }
    }

    // Initialize: each node in its own community
    let mut community: Vec<usize> = (0..n).collect();

    // Louvain Phase 1: local moving
    // P1-7: Precompute sigma_tot per community ONCE per pass (was O(N²) before)
    let max_passes = 10;
    for _pass in 0..max_passes {
        let mut improved = false;

        // Precompute sigma_tot for all communities at the start of each pass
        let mut sigma_tot: std::collections::HashMap<usize, f64> =
            std::collections::HashMap::new();
        for j in 0..n {
            *sigma_tot.entry(community[j]).or_insert(0.0) += degree[j];
        }

        for i in 0..n {
            let current_comm = community[i];
            let ki = degree[i];

            // Sum of weights to each neighboring community
            let mut comm_weights: std::collections::HashMap<usize, f64> =
                std::collections::HashMap::new();
            for &(j, w) in &adj[i] {
                *comm_weights.entry(community[j]).or_insert(0.0) += w;
            }

            // Weight from node i to its own community
            let ki_in_own = comm_weights.get(&current_comm).copied().unwrap_or(0.0);
            let sigma_own = sigma_tot.get(&current_comm).copied().unwrap_or(0.0);

            // Modularity gain for removing i from current community
            let remove_cost = ki_in_own / m - (sigma_own * ki) / (2.0 * m * m);

            let mut best_comm = current_comm;
            let mut best_gain = 0.0_f64;

            for (&target_comm, &ki_in_target) in &comm_weights {
                if target_comm == current_comm {
                    continue;
                }
                let sigma_target = sigma_tot.get(&target_comm).copied().unwrap_or(0.0);

                // Modularity gain for inserting i into target community
                let insert_gain = ki_in_target / m - (sigma_target * ki) / (2.0 * m * m);
                let delta_q = insert_gain - remove_cost;

                if delta_q > best_gain {
                    best_gain = delta_q;
                    best_comm = target_comm;
                }
            }

            if best_comm != current_comm && best_gain > 1e-10 {
                // Incrementally update sigma_tot when a node moves
                *sigma_tot.entry(current_comm).or_insert(0.0) -= ki;
                *sigma_tot.entry(best_comm).or_insert(0.0) += ki;
                community[i] = best_comm;
                improved = true;
            }
        }

        if !improved {
            break;
        }
    }

    // Renumber communities to be contiguous (0, 1, 2, ...)
    let mut comm_remap: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    let mut next_id = 0;
    for i in 0..n {
        let c = community[i];
        let mapped = *comm_remap.entry(c).or_insert_with(|| {
            let id = next_id;
            next_id += 1;
            id
        });
        nodes[i].cluster = mapped;
    }

    build_cluster_info(nodes, edges)
}

/// Build ClusterInfo from assigned node clusters.
fn build_cluster_info(nodes: &[GraphNode], edges: &[GraphEdge]) -> Vec<ClusterInfo> {
    let mut cluster_nodes: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        cluster_nodes.entry(node.cluster).or_default().push(i);
    }

    let mut clusters: Vec<ClusterInfo> = cluster_nodes
        .iter()
        .map(|(&cid, member_indices)| {
            // Pick the most connected node as the cluster label
            let mut best_label_idx = member_indices[0];
            let mut max_conns = 0usize;
            for &idx in member_indices {
                let node_id = &nodes[idx].id;
                let conns = edges
                    .iter()
                    .filter(|e| e.source == *node_id || e.target == *node_id)
                    .count();
                if conns > max_conns {
                    max_conns = conns;
                    best_label_idx = idx;
                }
            }

            let color_idx = cid % CLUSTER_COLORS.len();
            ClusterInfo {
                id: cid,
                label: nodes[best_label_idx].label.clone(),
                node_count: member_indices.len(),
                color: CLUSTER_COLORS[color_idx].to_string(),
            }
        })
        .collect();

    clusters.sort_by_key(|c| std::cmp::Reverse(c.node_count));
    clusters
}

/// KG-3: Compute PageRank scores for knowledge importance.
/// Identifies "bridge nodes" (connecting different communities) with boosted importance.
/// Weighted PageRank with damping factor d=0.85, 20 iterations.
///
/// Edge weights are respected so that explicit wikilinks (weight=1.0) carry more
/// importance than semantic similarity edges (weight*0.6) or AI-relation edges
/// (weight=confidence) in centrality computation.
fn compute_pagerank(nodes: &mut [GraphNode], edges: &[GraphEdge]) {
    let n = nodes.len();
    if n == 0 {
        return;
    }

    // Build node index map
    let node_index: std::collections::HashMap<&str, usize> = nodes.iter().enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();

    // Build weighted adjacency: out_neighbors[i] = list of (node_index, edge_weight)
    let mut out_neighbors: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];

    for edge in edges {
        if let (Some(&src_idx), Some(&tgt_idx)) = (node_index.get(edge.source.as_str()), node_index.get(edge.target.as_str())) {
            if src_idx != tgt_idx {
                let w = edge.weight.max(0.01); // minimum weight to avoid division issues
                out_neighbors[src_idx].push((tgt_idx, w));
                // Treat undirected: also add reverse
                out_neighbors[tgt_idx].push((src_idx, w));
            }
        }
    }

    // Precompute weighted out-degree for each node
    let mut weighted_out: Vec<f64> = vec![0.0; n];
    for i in 0..n {
        weighted_out[i] = out_neighbors[i].iter().map(|(_, w)| w).sum();
    }

    let d: f64 = 0.85; // damping factor
    let base = (1.0 - d) / n as f64;
    let mut scores: Vec<f64> = vec![1.0 / n as f64; n];
    let mut new_scores: Vec<f64> = vec![0.0; n];

    // 20 iterations of weighted PageRank
    for _ in 0..20 {
        for i in 0..n {
            new_scores[i] = base;
        }

        for i in 0..n {
            if weighted_out[i] > 0.0 {
                // Distribute score proportionally by edge weight
                for &(neighbor, weight) in &out_neighbors[i] {
                    new_scores[neighbor] += d * scores[i] * weight / weighted_out[i];
                }
            } else {
                // Dangling node: distribute evenly
                let contribution = d * scores[i] / n as f64;
                for j in 0..n {
                    new_scores[j] += contribution;
                }
            }
        }

        std::mem::swap(&mut scores, &mut new_scores);
    }

    // Normalize to 0-1 range
    let max_score = scores.iter().cloned().fold(0.0_f64, f64::max);
    let min_score = scores.iter().cloned().fold(f64::MAX, f64::min);
    let range = max_score - min_score;

    for (i, node) in nodes.iter_mut().enumerate() {
        node.pagerank = if range > 0.0 {
            (scores[i] - min_score) / range
        } else {
            0.5
        };
    }

    // Also update is_hub based on PageRank: top 10% by PageRank are hubs
    let mut sorted_scores: Vec<f64> = scores.clone();
    sorted_scores.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let hub_threshold_pr = if sorted_scores.len() >= 10 {
        sorted_scores[sorted_scores.len() * 9 / 10]
    } else {
        sorted_scores.last().copied().unwrap_or(0.0)
    };

    for (i, node) in nodes.iter_mut().enumerate() {
        // Mark as hub if either high connection count OR high PageRank
        if scores[i] >= hub_threshold_pr {
            node.is_hub = true;
        }
    }
}

/// Find semantic similarity edges between files using their chunk embeddings.
/// DEPRECATED: This O(N²) brute-force implementation has been replaced by
/// `compute_and_store_semantic_edges` which uses sqlite-vec KNN for scalability.
/// Kept here for reference; the fallback path now calls compute_and_store_semantic_edges.
#[allow(dead_code)]
fn find_semantic_edges(conn: &Connection, _nodes: &[GraphNode]) -> anyhow::Result<Vec<GraphEdge>> {
    // Get one representative chunk per file (first chunk)
    let mut stmt = conn.prepare(
        "SELECT file_path, embedding FROM chunks
         WHERE embedding IS NOT NULL
         GROUP BY file_path
         HAVING chunk_index = 0",
    )?;

    let mut file_embeddings: Vec<(String, Vec<f32>)> = Vec::new();
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let emb_blob: Vec<u8> = row.get(1)?;
        Ok((path, emb_blob))
    })?;

    for row in rows {
        let (path, blob) = row?;
        let floats: Vec<f32> = blob
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        if !floats.is_empty() {
            file_embeddings.push((path, floats));
        }
    }

    // Compare all pairs and find highly similar ones
    let mut edges = Vec::new();
    let threshold = 0.85_f32; // cosine similarity threshold

    for i in 0..file_embeddings.len() {
        for j in (i + 1)..file_embeddings.len() {
            let (ref path_a, ref emb_a) = file_embeddings[i];
            let (ref path_b, ref emb_b) = file_embeddings[j];

            if emb_a.len() != emb_b.len() || emb_a.is_empty() {
                continue;
            }

            // Cosine similarity
            let dot: f32 = emb_a.iter().zip(emb_b.iter()).map(|(a, b)| a * b).sum();
            let norm_a: f32 = emb_a.iter().map(|x| x * x).sum::<f32>().sqrt();
            let norm_b: f32 = emb_b.iter().map(|x| x * x).sum::<f32>().sqrt();

            if norm_a == 0.0 || norm_b == 0.0 {
                continue;
            }

            let similarity = dot / (norm_a * norm_b);

            if similarity >= threshold {
                edges.push(GraphEdge {
                    source: path_a.clone(),
                    target: path_b.clone(),
                    edge_type: "semantic".to_string(),
                    weight: similarity as f64,
                    label: None,
                });
            }
        }
    }

    Ok(edges)
}

/// Get local graph data for a specific note with configurable depth (1-3 hop, KG-2).
pub fn get_local_graph(conn: &Connection, file_path: &str) -> anyhow::Result<GraphData> {
    get_local_graph_with_depth(conn, file_path, 1)
}

/// Get local graph data with configurable hop depth.
/// depth=1: immediate neighbors, depth=2: neighbors of neighbors, depth=3: 3-hop
pub fn get_local_graph_with_depth(conn: &Connection, file_path: &str, depth: usize) -> anyhow::Result<GraphData> {
    let depth = depth.min(3).max(1); // Clamp to 1-3
    let full_graph = get_graph_data(conn)?;

    // Build adjacency list for efficient traversal
    let mut adjacency: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for edge in &full_graph.edges {
        adjacency.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        adjacency.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
    }

    // BFS to find all nodes within `depth` hops
    let mut connected_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut frontier: Vec<String> = vec![file_path.to_string()];
    connected_ids.insert(file_path.to_string());

    for _hop in 0..depth {
        let mut next_frontier: Vec<String> = Vec::new();
        for node_id in &frontier {
            if let Some(neighbors) = adjacency.get(node_id.as_str()) {
                for &neighbor in neighbors {
                    if connected_ids.insert(neighbor.to_string()) {
                        next_frontier.push(neighbor.to_string());
                    }
                }
            }
        }
        frontier = next_frontier;
    }

    let nodes: Vec<GraphNode> = full_graph
        .nodes
        .into_iter()
        .filter(|n| connected_ids.contains(&n.id))
        .collect();

    let edges: Vec<GraphEdge> = full_graph
        .edges
        .into_iter()
        .filter(|e| connected_ids.contains(&e.source) && connected_ids.contains(&e.target))
        .collect();

    Ok(GraphData { nodes, edges, clusters: Vec::new() })
}

/// Find shortest path between two notes in the knowledge graph (KG-2).
/// Returns the path as a list of note IDs, or empty if no path exists.
pub fn find_shortest_path(conn: &Connection, source: &str, target: &str) -> anyhow::Result<Vec<String>> {
    let full_graph = get_graph_data(conn)?;

    // Build adjacency list
    let mut adjacency: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for edge in &full_graph.edges {
        adjacency.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        adjacency.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
    }

    // BFS from source to target
    let mut visited: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut parent: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let mut queue: std::collections::VecDeque<&str> = std::collections::VecDeque::new();

    visited.insert(source);
    queue.push_back(source);

    let mut found = false;
    while let Some(current) = queue.pop_front() {
        if current == target {
            found = true;
            break;
        }
        if let Some(neighbors) = adjacency.get(current) {
            for &neighbor in neighbors {
                if visited.insert(neighbor) {
                    parent.insert(neighbor, current);
                    queue.push_back(neighbor);
                }
            }
        }
    }

    if !found {
        return Ok(Vec::new()); // No path
    }

    // Reconstruct path
    let mut path = Vec::new();
    let mut current = target;
    while current != source {
        path.push(current.to_string());
        current = match parent.get(current) {
            Some(&p) => p,
            None => break,
        };
    }
    path.push(source.to_string());
    path.reverse();
    Ok(path)
}

/// Helper function to normalize titles/labels for robust matching.
/// Converts to lowercase, strips parenthetical suffix, strips leading numeric prefix,
/// and keeps only alphanumeric and Chinese characters.
pub fn normalize_title(title: &str) -> String {
    let mut clean = title.to_lowercase();
    if let Some(idx) = clean.find('(') {
        clean.truncate(idx);
    }
    if let Some(idx) = clean.find('（') {
        clean.truncate(idx);
    }

    let clean_str = clean.trim();
    let chars: Vec<char> = clean_str.chars().collect();
    let mut start_idx = 0;
    while start_idx < chars.len() && chars[start_idx].is_ascii_digit() {
        start_idx += 1;
    }

    let mut final_start = start_idx;
    if start_idx > 0 && start_idx < chars.len() {
        while final_start < chars.len() && (chars[final_start] == '-' || chars[final_start] == '.' || chars[final_start] == '_' || chars[final_start] == ' ') {
            final_start += 1;
        }
    } else {
        final_start = 0;
    }

    let filtered_chars: Vec<char> = if final_start < chars.len() {
        chars[final_start..].to_vec()
    } else {
        chars.clone()
    };

    filtered_chars
        .into_iter()
        .filter(|c| {
            c.is_alphanumeric() || (*c >= '\u{4e00}' && *c <= '\u{9fa5}')
        })
        .collect()
}

/// Get edges filtered by a specific relation type from note_relations table.
pub fn get_edges_by_relation(conn: &Connection, relation_type: &str) -> anyhow::Result<Vec<GraphEdge>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, target_path, relation_type, confidence, reason
         FROM note_relations WHERE relation_type = ?1",
    )?;

    let edges = stmt
        .query_map(params![relation_type], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                edge_type: "link".to_string(),
                weight: row.get::<_, f64>(3).unwrap_or(0.5),
                label: Some(row.get::<_, String>(2)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(edges)
}

/// Read precomputed semantic edges from the semantic_edges table.
fn get_precomputed_semantic_edges(conn: &Connection) -> anyhow::Result<Vec<GraphEdge>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, target_path, similarity FROM semantic_edges"
    )?;

    let edges = stmt
        .query_map([], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                edge_type: "semantic".to_string(),
                weight: row.get(2)?,
                label: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(edges)
}

// ══════════════════════════════════════════════════════════════════════
//  Related Notes — passive "serendipity" surface for the reading view
// ══════════════════════════════════════════════════════════════════════

/// One note surfaced as related to the note the user is reading.
///
/// The `reason` is deliberately *not* baked here: this is a pure-local, CJK-first
/// app whose user-facing strings are all key-based i18n, so a Chinese (or English)
/// sentence composed in Rust would be wrong for half the users. Instead we carry
/// the structured pieces the UI needs — `relation`, `relation_type`, `score`,
/// and the full `signals` set — and let the frontend render a bilingual reason.
#[derive(Debug, Clone, Serialize)]
pub struct RelatedNote {
    pub file_path: String,
    pub title: String,
    /// First-chunk preview, char-truncated (never byte-sliced — CJK safety).
    pub preview: String,
    /// The strongest/most-specific signal: `"explicit"` | `"link"` | `"semantic"`.
    pub relation: String,
    /// For `explicit`, the `note_relations.relation_type` (e.g. `supports`); else `None`.
    pub relation_type: Option<String>,
    /// Semantic cosine similarity when the note carries a `semantic` signal, else the
    /// synthetic rank weight of its strongest signal (explicit/link = 1.0).
    pub score: f64,
    /// Every signal this note matched. Length > 1 is the highest-value case — a note
    /// related by both an explicit link *and* semantic proximity is the strongest
    /// serendipity hit — so the UI flags it specially.
    pub signals: Vec<String>,
}

/// Result wrapper so the UI can tell three states apart that a bare `Vec` conflates:
/// notes found, "no related notes" (index ready, nothing matched), and "no semantic
/// index yet" (embeddings/edges never built — a setup gap, not an absence of relations).
#[derive(Debug, Clone, Serialize)]
pub struct RelatedNotesResult {
    pub notes: Vec<RelatedNote>,
    /// False only when the vault has no semantic signal available *at all* for this
    /// note: no `semantic_edges` rows anywhere and no first-chunk embedding to run the
    /// live fallback against. The UI shows a "build the index" hint rather than "empty".
    pub semantic_index_ready: bool,
}

/// Per-path accumulator while merging the three signals. One note can match several.
#[derive(Default)]
struct RelatedAgg {
    semantic: Option<f64>,       // cosine similarity from semantic_edges or live search
    link: bool,                  // an incoming [[wikilink]] points here
    explicit_type: Option<String>, // note_relations.relation_type (either direction)
}

/// Gather notes related to `file_path`, merging three complementary signals:
/// precomputed `semantic_edges` (bidirectional), incoming `[[wikilink]]` backlinks,
/// and explicit `note_relations` (both directions). Deduped by path, self excluded,
/// sorted so the most *meaningful* connections lead (multi-signal, then explicit,
/// then link, then semantic by similarity), and bounded by `limit`.
///
/// Semantic sourcing has a deliberate fallback: `semantic_edges` only exists after the
/// embedding index is *finalized* (it is built from file-level vectors in `files_vec`).
/// A note that has just been embedded has chunk vectors in `chunks_vec` but no edge row
/// yet, so when the edge table yields nothing for this note we fall back to a live
/// `vector_search` on its first-chunk embedding — the same path `execute_find_similar_notes`
/// uses. That makes the feature useful immediately after embedding rather than only after
/// a finalize pass, at the cost of one KNN query on the cold path.
pub fn get_related_notes(
    conn: &Connection,
    file_path: &str,
    limit: usize,
) -> anyhow::Result<RelatedNotesResult> {
    use std::collections::HashMap;
    let mut agg: HashMap<String, RelatedAgg> = HashMap::new();

    // Per-signal fetch window. Wider than `limit` so the merge has candidates to
    // dedupe across signals, but bounded so one hub note cannot pull the whole vault
    // into memory on every note open.
    let window = limit.saturating_mul(8).max(40) as i64;

    // ── Signal 1: precomputed semantic edges (stored one row per unordered pair) ──
    let mut had_edge_row = false;
    {
        let mut stmt = conn.prepare(
            "SELECT source_path, target_path, similarity FROM semantic_edges
             WHERE source_path = ?1 OR target_path = ?1
             ORDER BY similarity DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![file_path, window], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?))
        })?;
        for row in rows {
            let (src, tgt, sim) = row?;
            had_edge_row = true;
            // The related note is whichever end is not us.
            let other = if src == file_path { tgt } else { src };
            if other == file_path { continue; }
            let e = agg.entry(other).or_default();
            e.semantic = Some(e.semantic.map_or(sim, |s| s.max(sim)));
        }
    }

    // Does this note have a first-chunk embedding? Needed for the live fallback and
    // for deciding `semantic_index_ready`.
    let self_embedding: Option<Vec<u8>> = conn
        .query_row(
            "SELECT v.embedding FROM chunks c JOIN chunks_vec v ON c.id = v.id
             WHERE c.file_path = ?1 LIMIT 1",
            params![file_path],
            |row| row.get(0),
        )
        .ok();

    // ── Signal 1b: live vector fallback, only when the edge table gave us nothing ──
    // Once finalized, `semantic_edges` is complete above the 0.75 threshold (no K cap),
    // so we only reach for the live path to cover the pre-finalization gap.
    if !had_edge_row {
        if let Some(ref emb_bytes) = self_embedding {
            let embedding: Vec<f32> = emb_bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            // Over-fetch a little; the threshold below does the real filtering.
            let overfetch = (limit + 1).saturating_mul(3).max(10);
            if let Ok(hits) = vector_search(conn, &embedding, overfetch) {
                for h in hits {
                    if h.file_path == file_path { continue; }
                    let sim = 1.0 - h.score; // cosine distance → similarity
                    // Match the edge-table threshold so "semantic" means the same thing
                    // whether it came from the cache or the live path.
                    if sim < 0.75 { continue; }
                    let e = agg.entry(h.file_path).or_default();
                    e.semantic = Some(e.semantic.map_or(sim, |s| s.max(sim)));
                }
            }
        }
    }

    // ── Signal 2: explicit note_relations, both directions ──
    {
        let mut stmt = conn.prepare(
            "SELECT source_path, target_path, relation_type FROM note_relations
             WHERE source_path = ?1 OR target_path = ?1
             ORDER BY confidence DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![file_path, window], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (src, tgt, rel_type) = row?;
            let other = if src == file_path { tgt } else { src };
            if other == file_path { continue; }
            let e = agg.entry(other).or_default();
            // Keep the first relation type we see; a note rarely has two.
            if e.explicit_type.is_none() {
                e.explicit_type = Some(rel_type);
            }
        }
    }

    // ── Signal 3: incoming [[wikilink]] backlinks ──
    // Parsing + resolution are delegated to `db::wikilink`, the same shared
    // implementation the backlink panel (`commands::file_commands`), the health
    // desk (`db::notes_overview`) and the graph builder above use.
    //
    // This replaces a hand-rolled `content_lower.contains("[[title]]")` /
    // `[[stem]]` pair — a byte-for-byte copy of the bug `get_backlinks` already
    // had. Because it demanded the closing `]]` immediately after the title, a
    // note linking here as `[[知识图谱|图谱]]` or `[[知识图谱#定义]]` produced no
    // hit, and the user reading this note saw the linking note missing from the
    // 「相关笔记 / Related notes」panel while the backlink panel listed it.
    //
    // `target_title` stays as a guard, not as the matcher: a path with no `files`
    // row is not a note and cannot own backlinks. The resolver decides matches,
    // and it keys notes by title *and* file stem, so `[[文件名]]` resolves too.
    let target_title: Option<String> = conn
        .query_row(
            "SELECT title FROM files WHERE path = ?1",
            params![file_path],
            |row| row.get(0),
        )
        .ok();
    if target_title.is_some() {
        let resolver = crate::db::wikilink::LinkResolver::from_files(conn)?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT c.file_path, c.content FROM chunks c
             WHERE c.file_path != ?1 AND c.content LIKE '%[[%]]%'
             ORDER BY c.file_path, c.chunk_index
             LIMIT ?2",
        )?;
        // The LIKE prefilter already discards chunks with no wikilink at all; this cap
        // keeps a very large vault from paying for a full scan on every note open.
        // `c.file_path != ?1` is also what excludes self-links here, matching signals
        // 1/1b/2 above and `notes_overview`'s self-relation skip.
        let rows = stmt.query_map(params![file_path, 5_000_i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (src_path, content) = row?;
            if resolver.content_links_to(&content, file_path) {
                let e = agg.entry(src_path).or_default();
                e.link = true;
            }
        }
    }

    // ── Materialize: pick the strongest relation per note, then rank ──
    let mut notes: Vec<RelatedNote> = Vec::with_capacity(agg.len());
    for (path, a) in agg {
        let mut signals: Vec<String> = Vec::new();
        if a.explicit_type.is_some() { signals.push("explicit".to_string()); }
        if a.link { signals.push("link".to_string()); }
        if a.semantic.is_some() { signals.push("semantic".to_string()); }
        if signals.is_empty() { continue; }

        // Strongest → most specific first: an explicit human/AI link outranks a wikilink,
        // which outranks a bare cosine hit.
        let relation = if a.explicit_type.is_some() {
            "explicit"
        } else if a.link {
            "link"
        } else {
            "semantic"
        }
        .to_string();

        // Score carries the semantic similarity when present (the UI shows it in the
        // reason); explicit/link without a cosine get a synthetic 1.0 so they sort high.
        let score = a.semantic.unwrap_or(1.0);

        notes.push(RelatedNote {
            file_path: path,
            // Title and preview are filled in after the cut — see below.
            title: String::new(),
            preview: String::new(),
            relation,
            relation_type: a.explicit_type,
            score,
            signals,
        });
    }

    // Rank: multi-signal notes first (the highest-value serendipity), then by relation
    // specificity, then by score. Explicit links are more meaningful than a 0.76 cosine.
    let rank_kind = |r: &str| match r {
        "explicit" => 0,
        "link" => 1,
        _ => 2,
    };
    notes.sort_by(|a, b| {
        let a_multi = a.signals.len() > 1;
        let b_multi = b.signals.len() > 1;
        b_multi
            .cmp(&a_multi)
            .then_with(|| rank_kind(&a.relation).cmp(&rank_kind(&b.relation)))
            .then_with(|| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    notes.truncate(limit);

    // ── Hydrate only the survivors ──
    // After the cut on purpose: a hub note can produce dozens of candidates, and
    // reading a title + first chunk for rows nobody will see is pure waste.
    for note in notes.iter_mut() {
        note.title = conn
            .query_row(
                "SELECT COALESCE(title, '') FROM files WHERE path = ?1",
                params![note.file_path],
                |row| row.get(0),
            )
            .unwrap_or_default();
        // Preview from the first chunk, cut with `chars().take` — NEVER byte-sliced,
        // which is what makes it safe for CJK.
        note.preview = conn
            .query_row(
                "SELECT content FROM chunks WHERE file_path = ?1 ORDER BY chunk_index LIMIT 1",
                params![note.file_path],
                |row| row.get::<_, String>(0),
            )
            .map(|c| c.trim().chars().take(120).collect::<String>())
            .unwrap_or_default();
    }

    // The vault has *some* semantic capability iff any edge exists anywhere, or this
    // note has an embedding the live path could use. Only when neither holds do we tell
    // the UI to show "no semantic index yet" instead of "no related notes".
    let any_edges: i64 = conn
        .query_row("SELECT COUNT(*) FROM semantic_edges", [], |row| row.get(0))
        .unwrap_or(0);
    let semantic_index_ready = any_edges > 0 || self_embedding.is_some();

    Ok(RelatedNotesResult { notes, semantic_index_ready })
}

/// Precompute semantic similarity edges and persist to the semantic_edges table.
/// Uses file-level mean-pooled embeddings in files_vec for threshold-based edge discovery.
/// `changed_paths`: if Some, only recompute edges involving these paths.
pub fn compute_and_store_semantic_edges(
    conn: &Connection,
    changed_paths: Option<&[String]>,
) -> anyhow::Result<usize> {
    // ── Phase 1: Build/update file-level mean-pooled embeddings ──────
    rebuild_file_embeddings(conn, changed_paths)?;

    // ── Phase 2: Threshold-based semantic edge discovery ─────────────
    // Any file pair with cosine similarity >= threshold gets an edge.
    // No K cap — guaranteed to find ALL edges above threshold.
    let threshold = 0.75_f64;
    let distance_threshold = 1.0 - threshold; // cosine distance = 1 - similarity

    // If changed_paths provided, only delete/recompute edges for those files
    if let Some(paths) = changed_paths {
        for path in paths {
            conn.execute(
                "DELETE FROM semantic_edges WHERE source_path = ?1 OR target_path = ?1",
                params![path],
            )?;
        }
    } else {
        // Full recompute: clear all
        conn.execute("DELETE FROM semantic_edges", [])?;
    }

    // Get the list of files to process
    let file_paths: Vec<String> = if let Some(paths) = changed_paths {
        paths.to_vec()
    } else {
        let mut stmt = conn.prepare("SELECT file_path FROM files_vec")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut edge_count = 0usize;

    // Prepare the neighbor query once (reused per file)
    let mut neighbor_stmt = conn.prepare(
        "SELECT fv.file_path, vec_distance_cosine(fv.embedding, ?1) as distance
         FROM files_vec fv
         WHERE fv.file_path != ?2
           AND distance <= ?3
         ORDER BY distance
         LIMIT 25",
    )?;

    // For each file, find ALL neighbors above similarity threshold
    for file_path in &file_paths {
        // Get this file's embedding
        let file_emb: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM files_vec WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .ok();

        let file_emb = match file_emb {
            Some(emb) => emb,
            None => continue,
        };

        // Find all files within distance threshold (no LIMIT — complete coverage)
        let neighbors: Vec<(String, f64)> = neighbor_stmt
            .query_map(params![file_emb, file_path, distance_threshold], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (neighbor_path, distance) in neighbors {
            let similarity = 1.0 - distance;
            // Use ordered pair to avoid duplicate edges (a,b) and (b,a)
            let (src, tgt) = if *file_path < neighbor_path {
                (file_path.as_str(), neighbor_path.as_str())
            } else {
                (neighbor_path.as_str(), file_path.as_str())
            };

            conn.execute(
                "INSERT OR REPLACE INTO semantic_edges (source_path, target_path, similarity, computed_at)
                 VALUES (?1, ?2, ?3, datetime('now'))",
                params![src, tgt, similarity],
            )?;
            edge_count += 1;
        }
    }

    log::info!(
        "Precomputed {} semantic edges from {} files (threshold={})",
        edge_count, file_paths.len(), threshold
    );
    Ok(edge_count)
}

/// Build/update file-level mean-pooled embeddings in files_vec table.
/// If `changed_paths` is Some, only update those specific files.
fn rebuild_file_embeddings(
    conn: &Connection,
    changed_paths: Option<&[String]>,
) -> anyhow::Result<()> {

    let file_paths_to_process: Vec<String> = if let Some(paths) = changed_paths {
        paths.to_vec()
    } else {
        // Get all file paths with embeddings
        let mut stmt = conn.prepare(
            "SELECT DISTINCT file_path FROM chunks WHERE embedding IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for file_path in &file_paths_to_process {
        // Delete old file embedding
        let _ = conn.execute(
            "DELETE FROM files_vec WHERE file_path = ?1",
            params![file_path],
        );

        // Get all chunk embeddings for this file
        let mut stmt = conn.prepare(
            "SELECT embedding FROM chunks
             WHERE embedding IS NOT NULL AND file_path = ?1
             ORDER BY chunk_index",
        )?;

        let chunk_embeddings: Vec<Vec<f32>> = stmt
            .query_map(params![file_path], |row| {
                let blob: Vec<u8> = row.get(0)?;
                let floats: Vec<f32> = blob
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
                Ok(floats)
            })?
            .filter_map(|r| r.ok())
            .filter(|v| !v.is_empty())
            .collect();

        if chunk_embeddings.is_empty() {
            continue;
        }

        // ── Content quality gate: skip files with trivial content ────────
        // Empty notes, pure-frontmatter templates, and very short stubs
        // produce meaningless embeddings that cause false semantic edges.
        let total_text: String = conn
            .query_row(
                "SELECT COALESCE(GROUP_CONCAT(content, ' '), '') FROM chunks WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .unwrap_or_default();

        if total_text.trim().len() < 50 {
            log::debug!("Skipping file embedding for short content ({}B): {}", total_text.trim().len(), file_path);
            continue;
        }

        // Weighted mean pooling: front chunks (title/intro) get higher weight
        // since they usually contain core content. Exponential decay factor.
        let dim = chunk_embeddings[0].len();
        let total_chunks = chunk_embeddings.len() as f32;
        let mut mean_embedding = vec![0.0_f32; dim];
        let mut weight_sum = 0.0_f32;

        for (idx, emb) in chunk_embeddings.iter().enumerate() {
            if emb.len() != dim {
                continue; // skip mismatched dimensions
            }
            // Exponential decay: first chunk weight ≈ 1.0, last chunk weight ≈ 0.6
            let weight = (-0.5 * idx as f32 / total_chunks).exp();
            for (i, val) in emb.iter().enumerate() {
                mean_embedding[i] += val * weight;
            }
            weight_sum += weight;
        }

        if weight_sum > 0.0 {
            for val in mean_embedding.iter_mut() {
                *val /= weight_sum;
            }
        }

        // L2-normalize the mean embedding for cosine similarity
        let norm: f32 = mean_embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for val in mean_embedding.iter_mut() {
                *val /= norm;
            }
        }

        // Store as bytes in files_vec
        let embedding_bytes: Vec<u8> = mean_embedding
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        let _ = conn.execute(
            "INSERT INTO files_vec (file_path, embedding) VALUES (?1, ?2)",
            params![file_path, embedding_bytes],
        );
    }

    log::info!(
        "Rebuilt file-level embeddings for {} files",
        file_paths_to_process.len()
    );
    Ok(())
}

/// Get all relation edges from note_relations table.
/// Returns edges with relation labels. Used to supplement card_meta.links edges.
/// Filters out very low-confidence relations (confidence < 0.4) to reduce graph noise.
pub fn get_all_relation_edges(conn: &Connection) -> anyhow::Result<Vec<GraphEdge>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, target_path, relation_type, confidence
         FROM note_relations
         WHERE confidence >= 0.4",
    )?;

    let edges = stmt
        .query_map([], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                edge_type: "link".to_string(),
                weight: row.get::<_, f64>(3).unwrap_or(0.5),
                label: Some(row.get::<_, String>(2)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(edges)
}

#[cfg(test)]
mod fts_query_tests {
    use super::build_fts_query;

    // Every term must be wrapped in a quoted FTS5 literal so operator characters can never
    // reach the parser. These inputs used to produce `fts5: syntax error` and surface as a
    // failed search to the user.
    #[test]
    fn quotes_terms_with_operator_chars() {
        assert_eq!(build_fts_query("AI-Agent"), "\"AI-Agent\"");
        assert_eq!(build_fts_query("C++"), "\"C++\"");
    }

    #[test]
    fn mixed_cjk_and_ascii_joined_with_or() {
        assert_eq!(build_fts_query("知识 graph"), "\"知识\" OR \"graph\"");
    }

    #[test]
    fn embeds_inner_quote_by_doubling() {
        // A stray double quote must be escaped, not left to unbalance the literal.
        assert_eq!(build_fts_query("say\"hi"), "\"say\"\"hi\"");
    }

    #[test]
    fn punctuation_only_input_does_not_panic_or_break() {
        // "---" has nothing indexable; result must stay a syntactically valid (possibly empty) query.
        let q = build_fts_query("---");
        assert!(q.is_empty() || q.starts_with('"'));
    }
}

/// Shared fixture for rerank wiring tests, here rather than duplicated in each
/// call site's test module: two notes crafted so FTS rank order and lexical
/// relevance order disagree, which is the only way a test can tell "went through
/// the rerank" from "happened to already be sorted".
///
/// `a.md` is a two-word stub. bm25 loves it — both query terms, essentially zero
/// document length — so FTS puts it first. `b.md` is a real paragraph whose
/// *heading* is the query and which contains the exact phrase; `chunks_fts`
/// indexes `content` only, so bm25 cannot see the heading at all. That blind spot
/// is precisely the one the rerank exists to cover, so Tier 1 must reverse them.
#[cfg(test)]
pub fn test_db_with_ranking_disagreement() -> Connection {
    crate::db::register_sqlite_vec();
    let conn = Connection::open_in_memory().unwrap();
    crate::db::schema::setup_database_schema(&conn).unwrap();
    // The live app follows setup with the column migrations (db/mod.rs:35).
    crate::db::schema::migrate_schema_columns(&conn).unwrap();

    let insert = |path: &str, idx: i64, heading: &str, content: &str| {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, 'h', ?1)",
            params![path],
        )
        .ok(); // a second chunk for the same note is fine; ignore the dup
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type)
             VALUES (?1, ?2, ?3, ?4, 'user')",
            params![path, idx, content, heading],
        )
        .unwrap();
    };

    // Shortest possible both-terms match: unbeatable bm25, thin on actual meaning.
    insert("a.md", 0, "Misc", "graph knowledge");
    // Under 400 chars so the length norm does not discount it; heading + exact
    // phrase are the two signals bm25 has no access to.
    insert(
        "b.md",
        1,
        "Knowledge graph",
        "A knowledge graph stores entities and the relations between them, which is \
         what lets a note vault answer questions instead of merely storing text.",
    );

    conn
}

/// 图谱缓存的失效判据 / Graph cache staleness — the contract `get_graph_data`
/// guarantees now that the cache key is a content fingerprint instead of
/// `COUNT(*) FROM files`.
///
/// Every test here proves the invalidation *observably*: the cached blob is
/// poisoned with a sentinel node label, so a later call that still returns the
/// sentinel was served from the cache and one that does not was rebuilt.
/// Asserting on `computed_at` would be unreliable — `datetime('now')` has
/// one-second resolution, so a recompute inside the same second is
/// indistinguishable from a hit.
#[cfg(test)]
mod graph_cache_tests {
    use super::*;

    const SENTINEL: &str = "__POISONED__";

    fn test_db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        conn
    }

    fn add_file(conn: &Connection, path: &str, title: &str) {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, 'h', ?2)",
            params![path, title],
        )
        .unwrap();
    }

    /// Mimics `sync_file`: a note edit deletes every chunk of the file and
    /// re-inserts, so `chunks.id` values are re-minted (AUTOINCREMENT).
    fn set_chunk(conn: &Connection, path: &str, body: &str) {
        conn.execute("DELETE FROM chunks WHERE file_path = ?1", params![path]).unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type)
             VALUES (?1, 0, ?2, '', 'user')",
            params![path, body],
        )
        .unwrap();
    }

    fn link_edges(graph: &GraphData) -> usize {
        graph.edges.iter().filter(|e| e.edge_type == "link").count()
    }

    fn poisoned(graph: &GraphData) -> bool {
        graph.nodes.iter().any(|n| n.label == SENTINEL)
    }

    /// Rewrite the cached blob only — `content_fingerprint` is left exactly as the
    /// real code wrote it, so the staleness decision under test is untouched.
    fn poison_cache(conn: &Connection) {
        let blob: Vec<u8> = conn
            .query_row("SELECT serialized_data FROM graph_cache WHERE id = 1", [], |r| r.get(0))
            .expect("cache row must exist");
        let mut graph: GraphData = serde_json::from_slice(&blob).unwrap();
        assert!(!graph.nodes.is_empty(), "need a node to poison");
        graph.nodes[0].label = SENTINEL.to_string();
        let repacked = serde_json::to_vec(&graph).unwrap();
        conn.execute(
            "UPDATE graph_cache SET serialized_data = ?1 WHERE id = 1",
            params![repacked],
        )
        .unwrap();
    }

    fn cached_fingerprint(conn: &Connection) -> Option<String> {
        conn.query_row("SELECT content_fingerprint FROM graph_cache WHERE id = 1", [], |r| r.get(0))
            .unwrap()
    }

    /// Baseline: nothing changed between two calls ⇒ the second is a cache hit.
    /// Proven by the sentinel surviving, and by the fingerprint being unchanged.
    #[test]
    fn unchanged_vault_hits_the_cache() {
        let conn = test_db();
        add_file(&conn, "a.md", "A");
        add_file(&conn, "b.md", "B");
        set_chunk(&conn, "a.md", "see [[B]]");

        let first = get_graph_data(&conn).unwrap();
        assert!(!poisoned(&first));
        let fp1 = cached_fingerprint(&conn);
        poison_cache(&conn);

        let second = get_graph_data(&conn).unwrap();
        assert!(poisoned(&second), "unchanged vault must be served from cache");
        assert_eq!(cached_fingerprint(&conn), fp1, "fingerprint must not drift on a hit");
    }

    /// Pure content edit: add a wikilink to a chunk, file count unchanged. The
    /// old `nodes.len() == COUNT(files)` check would have served the stale graph;
    /// the fingerprint must force a rebuild and the new edge must appear.
    #[test]
    fn new_wikilink_in_chunk_invalidates_even_though_file_count_is_constant() {
        let conn = test_db();
        add_file(&conn, "a.md", "A");
        add_file(&conn, "b.md", "B");
        set_chunk(&conn, "a.md", "no links yet");

        let before = get_graph_data(&conn).unwrap();
        assert_eq!(link_edges(&before), 0);
        poison_cache(&conn);

        // Same two files; a.md now links to B.
        set_chunk(&conn, "a.md", "now see [[B]]");
        let after = get_graph_data(&conn).unwrap();
        assert!(!poisoned(&after), "content edit must trigger a rebuild");
        assert_eq!(after.nodes.len(), 2, "still two files");
        assert_eq!(link_edges(&after), 1, "the new edge must be observable");
    }

    /// Pure `card_meta.links` edit: no file/chunk change at all. Adding a link to
    /// the JSON array changes the fingerprint's `SUM(LENGTH(links))` component.
    #[test]
    fn card_meta_links_edit_invalidates() {
        let conn = test_db();
        add_file(&conn, "a.md", "A");
        add_file(&conn, "b.md", "B");
        set_chunk(&conn, "a.md", "body");

        let before = get_graph_data(&conn).unwrap();
        assert_eq!(link_edges(&before), 0);
        poison_cache(&conn);

        conn.execute(
            "INSERT INTO card_meta (file_path, links) VALUES ('a.md', '[\"[[B]]\"]')",
            [],
        )
        .unwrap();
        let after = get_graph_data(&conn).unwrap();
        assert!(!poisoned(&after), "card_meta.links edit must trigger a rebuild");
        assert_eq!(link_edges(&after), 1, "explicit link edge must appear");
    }

    /// Adding and removing files must still invalidate — the behaviour the old
    /// file-count check had, which we must not regress.
    #[test]
    fn adding_and_removing_files_still_invalidates() {
        let conn = test_db();
        add_file(&conn, "a.md", "A");
        set_chunk(&conn, "a.md", "body");

        let one = get_graph_data(&conn).unwrap();
        assert_eq!(one.nodes.len(), 1);
        poison_cache(&conn);

        add_file(&conn, "b.md", "B");
        set_chunk(&conn, "b.md", "body");
        let two = get_graph_data(&conn).unwrap();
        assert!(!poisoned(&two), "new file must trigger a rebuild");
        assert_eq!(two.nodes.len(), 2);
        poison_cache(&conn);

        conn.execute("DELETE FROM chunks WHERE file_path = 'b.md'", []).unwrap();
        conn.execute("DELETE FROM files WHERE path = 'b.md'", []).unwrap();
        let back = get_graph_data(&conn).unwrap();
        assert!(!poisoned(&back), "deletion must trigger a rebuild");
        assert_eq!(back.nodes.len(), 1);
    }

    /// Old-DB scenario: a cache row whose `content_fingerprint` is NULL (written
    /// by a build that predates the column). It must be treated as unknown ⇒
    /// stale ⇒ recomputed once, never as a match, or an upgraded vault would keep
    /// serving whatever it cached forever.
    #[test]
    fn null_fingerprint_is_treated_as_stale() {
        let conn = test_db();
        add_file(&conn, "a.md", "A");
        add_file(&conn, "b.md", "B");
        set_chunk(&conn, "a.md", "see [[B]]");

        // Prime the cache, then simulate an old row: keep the (correct) blob but
        // wipe the fingerprint back to NULL.
        let _ = get_graph_data(&conn).unwrap();
        poison_cache(&conn);
        conn.execute("UPDATE graph_cache SET content_fingerprint = NULL WHERE id = 1", []).unwrap();
        assert_eq!(cached_fingerprint(&conn), None);

        let out = get_graph_data(&conn).unwrap();
        assert!(!poisoned(&out), "NULL fingerprint must force a recompute");
        assert!(cached_fingerprint(&conn).is_some(), "recompute must stamp a fingerprint");
    }
}

#[cfg(test)]
mod reranked_wrapper_tests {
    use super::*;
    use crate::db::search::rerank::{RerankConfig, RerankMode};

    #[test]
    fn lexical_reranks_full_text_search() {
        let conn = test_db_with_ranking_disagreement();
        let cfg = RerankConfig::lexical();

        // Guard against a vacuous test: if bm25 already returned b.md first there
        // would be nothing for the rerank to prove. This asserts the fixture still
        // encodes a genuine disagreement.
        let plain = full_text_search(&conn, "knowledge graph", 5).unwrap();
        assert_eq!(
            plain[0].file_path, "a.md",
            "fixture no longer discriminates — FTS already ranks b.md first"
        );

        let reranked = full_text_search_reranked(&conn, "knowledge graph", 5, &cfg, None).unwrap();
        assert!(reranked.len() >= 2, "fixture should match both notes");
        // The phrase-in-heading note must be promoted to the top by Tier 1.
        assert_eq!(
            reranked[0].file_path, "b.md",
            "lexical rerank should float the exact-phrase heading note to #1"
        );
        // Rerank overwrites score with the blended 0..1 value (documented side
        // effect); prove the magnitude changed away from the ~0.016 RRF band.
        assert!(
            reranked[0].score > 0.1,
            "expected a rerank-scale score, got {}",
            reranked[0].score
        );
    }

    #[test]
    fn off_is_byte_identical_to_plain_full_text_search() {
        let conn = test_db_with_ranking_disagreement();
        let plain = full_text_search(&conn, "knowledge graph", 5).unwrap();
        let off = full_text_search_reranked(
            &conn,
            "knowledge graph",
            5,
            &RerankConfig::off(),
            None,
        )
        .unwrap();

        assert_eq!(plain.len(), off.len());
        for (p, o) in plain.iter().zip(off.iter()) {
            assert_eq!(p.chunk_id, o.chunk_id);
            assert_eq!(p.file_path, o.file_path);
            assert_eq!(p.content, o.content);
            assert_eq!(p.heading_hierarchy, o.heading_hierarchy);
            // score identity is the strict part: Off must not touch it at all.
            assert_eq!(p.score.to_bits(), o.score.to_bits(), "Off changed the score");
        }
    }

    #[test]
    fn chinese_query_runs_full_path_without_panic() {
        let conn = test_db_with_ranking_disagreement();
        // No CJK content in the fixture; the point is that the CJK-bigram path in
        // tokenize_query and scoring survives an all-Chinese query end to end.
        let out = full_text_search_reranked(&conn, "知识图谱", 5, &RerankConfig::lexical(), None)
            .unwrap();
        // Result may be empty (no CJK docs) — the assertion is simply "no panic".
        let _ = out.len();
    }

    #[test]
    fn mode_off_short_circuit_matches_hybrid() {
        // hybrid_search_reranked(Off) must equal hybrid_search. With an empty
        // vector index hybrid degrades to the FTS branch, which is enough to
        // exercise the short-circuit path deterministically.
        let conn = test_db_with_ranking_disagreement();
        let emb = vec![0.0_f32; 768];
        let plain = hybrid_search(&conn, "knowledge graph", &emb, 5).unwrap();
        let off = hybrid_search_reranked(
            &conn,
            "knowledge graph",
            &emb,
            5,
            &RerankConfig { mode: RerankMode::Off, ..Default::default() },
            None,
        )
        .unwrap();
        assert_eq!(plain.len(), off.len());
        for (p, o) in plain.iter().zip(off.iter()) {
            assert_eq!(p.chunk_id, o.chunk_id);
            assert_eq!(p.score.to_bits(), o.score.to_bits());
        }
    }

    /// Tier 2/3 with no external reranker attached is the state every wired call
    /// site is in today. It must behave exactly like Tier 1, never error.
    #[test]
    fn external_tiers_degrade_to_lexical_when_unavailable() {
        let conn = test_db_with_ranking_disagreement();
        let lexical =
            full_text_search_reranked(&conn, "knowledge graph", 5, &RerankConfig::lexical(), None)
                .unwrap();
        for mode in [RerankMode::CrossEncoder, RerankMode::Llm] {
            let degraded = full_text_search_reranked(
                &conn,
                "knowledge graph",
                5,
                &RerankConfig { mode, ..Default::default() },
                None,
            )
            .unwrap();
            let want: Vec<i64> = lexical.iter().map(|r| r.chunk_id).collect();
            let got: Vec<i64> = degraded.iter().map(|r| r.chunk_id).collect();
            assert_eq!(want, got, "{:?} without an external reranker must equal Tier 1", mode);
        }
    }
}

/// Related Notes panel — the merge/dedupe/rank contract the UI depends on.
#[cfg(test)]
mod related_notes_tests {
    use super::*;

    /// Production runs `setup_database_schema` *and* `migrate_schema_columns`
    /// (db/mod.rs:32-35). Skipping the second one drifts the fixture from the
    /// real schema, which has bitten this repo before.
    fn test_db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        conn
    }

    fn add_note(conn: &Connection, path: &str, title: &str, body: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO files (path, hash, title) VALUES (?1, 'h', ?2)",
            params![path, title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type)
             VALUES (?1, 0, ?2, '', 'user')",
            params![path, body],
        )
        .unwrap();
    }

    fn add_semantic_edge(conn: &Connection, source: &str, target: &str, similarity: f64) {
        conn.execute(
            "INSERT INTO semantic_edges (source_path, target_path, similarity) VALUES (?1, ?2, ?3)",
            params![source, target, similarity],
        )
        .unwrap();
    }

    fn add_relation(conn: &Connection, source: &str, target: &str, rel_type: &str) {
        conn.execute(
            "INSERT INTO note_relations (source_path, target_path, relation_type, confidence)
             VALUES (?1, ?2, ?3, 0.9)",
            params![source, target, rel_type],
        )
        .unwrap();
    }

    /// `semantic_edges` stores one row per unordered pair, so a query that only
    /// matched `source_path` would silently hide half the neighbours.
    #[test]
    fn semantic_edges_are_read_from_both_ends() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "body");
        add_note(&conn, "left.md", "Left", "body");
        add_note(&conn, "right.md", "Right", "body");
        add_semantic_edge(&conn, "left.md", "me.md", 0.81); // we are the target
        add_semantic_edge(&conn, "me.md", "right.md", 0.90); // we are the source

        let out = get_related_notes(&conn, "me.md", 10).unwrap();
        let paths: Vec<&str> = out.notes.iter().map(|n| n.file_path.as_str()).collect();
        assert!(paths.contains(&"left.md"), "missing target-side neighbour: {:?}", paths);
        assert!(paths.contains(&"right.md"), "missing source-side neighbour: {:?}", paths);
        // Higher similarity leads within the semantic group.
        assert_eq!(out.notes[0].file_path, "right.md");
        assert!(out.semantic_index_ready);
    }

    /// A note is never related to itself, no matter which table says so.
    #[test]
    fn the_note_itself_is_excluded() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "links to [[Me]] in its own text");
        add_semantic_edge(&conn, "me.md", "me.md", 0.99);
        add_relation(&conn, "me.md", "me.md", "supports");

        let out = get_related_notes(&conn, "me.md", 10).unwrap();
        assert!(out.notes.is_empty(), "self leaked into the list: {:?}", out.notes);
    }

    /// Two independent signals agreeing is the panel's most valuable result, so it
    /// must be both flagged (`signals.len() > 1`) and ranked first — ahead of a
    /// higher-similarity note that only has one signal.
    #[test]
    fn multi_signal_note_is_flagged_and_ranked_first() {
        let conn = test_db();
        add_note(&conn, "me.md", "Zettelkasten", "body");
        add_note(&conn, "both.md", "Both", "see [[Zettelkasten]] for context");
        add_note(&conn, "semantic_only.md", "Only", "body");
        add_semantic_edge(&conn, "both.md", "me.md", 0.78);
        add_semantic_edge(&conn, "me.md", "semantic_only.md", 0.97);

        let out = get_related_notes(&conn, "me.md", 10).unwrap();
        assert_eq!(out.notes[0].file_path, "both.md");
        assert_eq!(out.notes[0].signals.len(), 2);
        assert!(out.notes[0].signals.contains(&"link".to_string()));
        assert!(out.notes[0].signals.contains(&"semantic".to_string()));
        // The single-signal note still shows up, just behind.
        assert_eq!(out.notes[1].signals, vec!["semantic".to_string()]);
    }

    /// An explicit relation is an assertion someone made; a cosine score is a guess.
    /// Ranking must reflect that even when the guess scores higher.
    #[test]
    fn explicit_relations_outrank_semantic_and_are_found_in_both_directions() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "body");
        add_note(&conn, "outgoing.md", "Outgoing", "body");
        add_note(&conn, "incoming.md", "Incoming", "body");
        add_note(&conn, "similar.md", "Similar", "body");
        add_relation(&conn, "me.md", "outgoing.md", "supplementary");
        add_relation(&conn, "incoming.md", "me.md", "supports");
        add_semantic_edge(&conn, "me.md", "similar.md", 0.99);

        let out = get_related_notes(&conn, "me.md", 10).unwrap();
        let explicit: Vec<&RelatedNote> =
            out.notes.iter().filter(|n| n.relation == "explicit").collect();
        assert_eq!(explicit.len(), 2, "both directions must be picked up");
        // Relation type travels with the note so the UI can name the reason.
        let types: Vec<Option<&str>> =
            explicit.iter().map(|n| n.relation_type.as_deref()).collect();
        assert!(types.contains(&Some("supplementary")));
        assert!(types.contains(&Some("supports")));
        // The 0.99 cosine note sorts last, behind both explicit relations.
        assert_eq!(out.notes.last().unwrap().file_path, "similar.md");
    }

    /// Empty-because-nothing-matched and empty-because-nothing-was-indexed are
    /// different problems with different fixes, so the payload must distinguish them.
    #[test]
    fn missing_semantic_index_is_reported_distinctly_from_an_empty_result() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "body");
        let no_index = get_related_notes(&conn, "me.md", 10).unwrap();
        assert!(no_index.notes.is_empty());
        assert!(!no_index.semantic_index_ready, "no edges and no embedding ⇒ not ready");

        // One edge anywhere in the vault proves the index has been built; this note
        // simply has no neighbours.
        add_note(&conn, "a.md", "A", "body");
        add_note(&conn, "b.md", "B", "body");
        add_semantic_edge(&conn, "a.md", "b.md", 0.80);
        let indexed = get_related_notes(&conn, "me.md", 10).unwrap();
        assert!(indexed.notes.is_empty());
        assert!(indexed.semantic_index_ready, "edges exist ⇒ genuinely no related notes");
    }

    /// The UTF-8 iron rule. A byte cut at 120 lands mid-codepoint on CJK and panics;
    /// this note is 400 CJK chars = 1200 bytes, so a byte-slicing regression fails here.
    #[test]
    fn cjk_preview_is_truncated_on_char_boundaries() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "body");
        let long_cjk: String = "知识图谱与卡片盒笔记法".chars().cycle().take(400).collect();
        add_note(&conn, "cjk.md", "中文笔记", &long_cjk);
        add_semantic_edge(&conn, "me.md", "cjk.md", 0.88);

        let out = get_related_notes(&conn, "me.md", 10).unwrap();
        let preview = &out.notes[0].preview;
        assert_eq!(preview.chars().count(), 120, "preview must be 120 *chars*");
        assert!(long_cjk.starts_with(preview.as_str()));
        assert_eq!(out.notes[0].title, "中文笔记");
    }

    /// `limit` bounds the list after ranking, so the strongest results survive.
    #[test]
    fn limit_bounds_the_result_after_ranking() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "body");
        for i in 0..10 {
            let path = format!("n{}.md", i);
            add_note(&conn, &path, &format!("N{}", i), "body");
            add_semantic_edge(&conn, "me.md", &path, 0.75 + (i as f64) * 0.02);
        }

        let out = get_related_notes(&conn, "me.md", 3).unwrap();
        assert_eq!(out.notes.len(), 3);
        // Highest similarity first: n9 (0.93), n8, n7.
        assert_eq!(out.notes[0].file_path, "n9.md");
        assert_eq!(out.notes[2].file_path, "n7.md");
    }

    /// Before `finalize_embedding_index` runs there are no `semantic_edges` rows, but
    /// `chunks_vec` is already populated. The live KNN fallback is what makes the panel
    /// useful in that window instead of showing an empty box.
    #[test]
    fn live_vector_fallback_covers_the_pre_finalize_window() {
        let conn = test_db();
        add_note(&conn, "me.md", "Me", "body");
        add_note(&conn, "twin.md", "Twin", "near-identical body");
        add_note(&conn, "unrelated.md", "Unrelated", "orthogonal body");

        // Identical unit vectors ⇒ cosine 1.0; an orthogonal one ⇒ 0.0, below the 0.75
        // floor the edge table uses, so it must be filtered out rather than shown.
        let mut same = vec![0.0f32; 768];
        same[0] = 1.0;
        let mut orthogonal = vec![0.0f32; 768];
        orthogonal[5] = 1.0;
        let embed = |path: &str, v: &[f32]| {
            let id: i64 = conn
                .query_row(
                    "SELECT id FROM chunks WHERE file_path = ?1 ORDER BY chunk_index LIMIT 1",
                    params![path],
                    |row| row.get(0),
                )
                .unwrap();
            let blob: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)",
                params![id, blob],
            )
            .unwrap();
        };
        embed("me.md", &same);
        embed("twin.md", &same);
        embed("unrelated.md", &orthogonal);

        let out = get_related_notes(&conn, "me.md", 10).unwrap();
        assert!(out.semantic_index_ready, "an embedded note can always be compared");
        let paths: Vec<&str> = out.notes.iter().map(|n| n.file_path.as_str()).collect();
        assert_eq!(paths, vec!["twin.md"], "only above-threshold neighbours: {:?}", paths);
        assert_eq!(out.notes[0].relation, "semantic");
    }
}

