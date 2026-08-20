//! Domain layer for the "知识库体检台 / Knowledge-base health desk" view.
//!
//! Follows the `db::review_store` split: this module owns the SQL and the
//! aggregation logic and knows nothing about Tauri; `commands::bases_commands`
//! stays thin (lock + delegate). Everything the frontend's Bases view needs to
//! score a note's health lives here.
//!
//! ## Why a handful of full-table aggregations instead of one mega-JOIN
//!
//! The health signals come from tables with *different cardinalities* relative
//! to `files`: `note_relations` is many-per-target, `chunks` is many-per-file,
//! `semantic_edges` is an undirected pair list, and wikilink backlinks can only
//! be computed in Rust (see below). Cramming all of those into one SQL statement
//! would produce a row-multiplying cross join that then needs de-duplication in
//! Rust anyway. Instead we run one bounded main query plus a small, fixed number
//! of `GROUP BY` passes (each hitting an index), fold them into `HashMap`s, and
//! join in memory. This is O(passes), NOT N+1: the pass count does not grow with
//! the number of notes.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

/// Safety ceiling on rows returned by the main query.
///
/// Rationale: on local SQLite + local IPC, shipping a few thousand rows is a
/// sub-millisecond affair; the real bottleneck is the DOM, and the frontend
/// virtualises the table. Past ~20k rows no UI rendering strategy stays usable,
/// so returning more would only waste memory to render nothing. When the cap is
/// hit we set `truncated = true` so the UI can say "仅显示前 N 条 / showing first
/// N only" instead of silently lying about the vault size.
const MAX_ROWS: usize = 20_000;

/// Max characters kept for a displayed title.
///
/// UTF-8 iron rule: truncation is `chars().take(n)`, never a byte slice — this
/// repo has already shipped six CJK panics from `&s[..n]`. A 200-char cap is far
/// beyond any real note title and exists only as a defence against a pathological
/// filename blowing up a table cell.
const TITLE_MAX_CHARS: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub note_type: String,
    pub tags: Vec<String>,
    /// `card_meta.links` JSON array length. The old code called this `linkCount`
    /// but it is really the *outbound* link count; renamed to be honest.
    pub outbound_links: usize,
    pub backlink_count: usize,
    pub semantic_degree: usize,
    /// "indexed" | "partial" | "notIndexed" | "noChunks"
    pub index_status: String,
    pub chunk_total: usize,
    pub chunk_embedded: usize,
    pub reconciled_at: Option<String>,
    pub has_contradictions: bool,
    pub contradiction_count: usize,
    pub review_state: Option<String>,
    pub review_due_at_ms: Option<i64>,
    pub review_is_due: bool,
    pub review_suspended: bool,
    pub review_lapses: usize,
    /// Only populated when `include_graph_signals` is true.
    pub pagerank: Option<f64>,
    pub is_hub: Option<bool>,
    pub created_at: String,
    pub last_synced: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesOverview {
    pub rows: Vec<NoteRow>,
    pub folders: Vec<String>,
    pub all_tags: Vec<String>,
    pub all_types: Vec<String>,
    /// Whether the `semantic_edges` table is non-empty at all. `false` means the
    /// semantic index has never been computed — the UI must show "未计算 / not
    /// computed" rather than painting every note as a semantic island.
    pub semantic_index_ready: bool,
    pub graph_signals_included: bool,
    pub total: usize,
    /// True when the safety cap was hit; the UI must warn "仅显示前 N 条".
    pub truncated: bool,
}

// ── Signal helpers ──────────────────────────────────────────────────────────

/// Truncate to `TITLE_MAX_CHARS` *characters*. See [`TITLE_MAX_CHARS`].
fn clamp_title(s: &str) -> String {
    s.chars().take(TITLE_MAX_CHARS).collect()
}

/// Normalise a stored path for prefix comparison. Matches the existing
/// `get_bases_data` convention (`bases_commands.rs`): separators to `/` and
/// lowercased, because the DB holds whatever Windows handed us.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// Parent folder of a path, `""` for a bare filename.
fn folder_of(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

/// Filename without the `.md` extension, lowercased.
///
/// Delegates to [`crate::db::wikilink::file_stem_lower`] so the stem used for
/// display fallback and the stem the link resolver keys on cannot drift apart.
fn file_stem_of(path: &str) -> String {
    crate::db::wikilink::file_stem_lower(path)
}


/// Length of the `contradictions` JSON array.
///
/// **Verified shape** (not guessed): `scheduler::reconcile_task`
/// (`update_card_meta_from_response`) stores `serde_json::to_string` of the LLM's
/// `contradictions` value, and the prompt (`llm::prompts`) specifies an array of
/// objects `{with_note, severity, description}` — empty array when there are
/// none. `tools::internal_tools::graph_ops` reads it back with
/// `unwrap_or(json!([]))`, i.e. it also assumes an array but tolerates junk.
///
/// Nothing validates the LLM's output before it is stringified, so a
/// misbehaving model can persist a bare object, a string, or `null`. Parsing is
/// therefore tolerant: an array counts its elements, a lone object counts as one
/// contradiction, and anything else (including `null`, invalid JSON, empty text,
/// or a legacy NULL column) counts as zero. A malformed row must never make the
/// health desk unreadable.
fn contradiction_count(raw: Option<&str>) -> usize {
    let Some(text) = raw else { return 0 };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::Array(items)) => items.len(),
        Ok(serde_json::Value::Object(_)) => 1,
        _ => 0,
    }
}

/// Four-state index health from the authoritative source: `chunks.embedding`.
///
/// `chunks_vec` is deliberately NOT consulted — it is a derived KNN index that
/// can be dropped and rebuilt (`schema::migrate_vec_dimensions` does exactly
/// that), so it cannot answer "does this note have vectors".
///
/// `noChunks` and `notIndexed` are distinct on purpose: the first means the file
/// was never chunked (sync never reached it, or it is empty), the second means it
/// was chunked but never embedded. Different fixes, different UI copy.
fn index_status_of(total: usize, embedded: usize) -> &'static str {
    if total == 0 {
        "noChunks"
    } else if embedded == 0 {
        "notIndexed"
    } else if embedded < total {
        "partial"
    } else {
        "indexed"
    }
}

/// Extract `[[wikilink]]` targets from note text.
///
/// Delegates to [`crate::db::wikilink::wikilink_targets`]. This parser used to
/// live here and was the only correct one of the three in the codebase (the
/// backlink panel and the graph builder both mis-handled `|alias` / `#heading`),
/// so it was promoted to `db::wikilink` and all three now share it. Kept as a
/// one-line alias so this module's own tests keep documenting the contract they
/// depend on.
fn wikilink_targets(content: &str) -> Vec<String> {
    crate::db::wikilink::wikilink_targets(content)
}


// ── Aggregation passes ──────────────────────────────────────────────────────

/// `target_path -> set of distinct source paths`, merged from BOTH backlink
/// sources that `commands::file_commands::get_backlinks` uses.
///
/// Source 1 — `note_relations` (AI-discovered relations). We select the distinct
/// pairs rather than `COUNT(*)` because `UNIQUE(source_path, target_path,
/// relation_type)` lets the same pair of notes appear once per relation type;
/// counting rows would inflate a single neighbour into several. Even
/// `COUNT(DISTINCT source_path)` is not enough here, because the result has to be
/// **merged** with source 2 without double counting, and that needs the source
/// identities, not a number.
///
/// Source 2 — inline `[[wikilink]]`s in `chunks.content`. This cannot be
/// expressed in SQL: resolving a link requires fuzzy matching against every
/// note's title *or* file stem via `search::normalize_title`. We take the
/// one-shot approach: pull every chunk that could contain a wikilink
/// (`LIKE '%[[%]]%'`, the same pre-filter the graph builder uses) and build the
/// whole-vault adjacency once. The alternative — reading the graph cache — was
/// rejected because it makes a plain table view depend on the PageRank cache
/// being warm and fresh, which it often is not (see `search::get_graph_data`).
fn backlink_sources(
    conn: &Connection,
    paths: &[String],
) -> rusqlite::Result<HashMap<String, HashSet<String>>> {
    let mut map: HashMap<String, HashSet<String>> = HashMap::new();

    // Source 1: structured relations.
    let mut stmt = conn.prepare(
        "SELECT DISTINCT source_path, target_path FROM note_relations",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (source, target) = row?;
        if source == target {
            continue; // a self-relation is not a backlink
        }
        map.entry(target).or_default().insert(source);
    }
    drop(stmt);

    // Resolution table for source 2. Both the title and the file stem are keys,
    // mirroring `get_backlinks`'s two-way match; first writer wins on a
    // collision. That rule, the parser and the normalisation now live in
    // `db::wikilink` and are shared with `get_backlinks` and the graph builder —
    // one link must produce one answer in all three views.
    let resolver = crate::db::wikilink::LinkResolver::from_files(conn)?;

    // Source 2: inline wikilinks.
    let mut stmt = conn.prepare("SELECT file_path, content FROM chunks WHERE content LIKE '%[[%]]%'")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (source, content) = row?;
        for raw_target in wikilink_targets(&content) {
            let Some(target) = resolver.resolve(&raw_target) else { continue };
            if target == source {
                continue;
            }
            // `HashSet` is what makes the merge idempotent: a note that both
            // wikilinks to and has an AI relation with the same target counts once.
            map.entry(target.to_string()).or_default().insert(source.clone());
        }
    }


    // Keep only targets we are actually going to render; a vault-filtered view
    // has no use for the rest and this bounds the map we hand back.
    let wanted: HashSet<&String> = paths.iter().collect();
    map.retain(|target, _| wanted.contains(target));
    Ok(map)
}

/// `path -> semantic degree`.
///
/// `semantic_edges` stores each unordered pair once, so a note's degree is its
/// appearances as *either* endpoint. `UNION ALL` over the two columns lets each
/// half use its own index (`idx_semantic_edges_source` /
/// `idx_semantic_edges_target`); `WHERE source = ? OR target = ?` would force a
/// scan because SQLite cannot use two indexes for one table reference.
fn semantic_degrees(conn: &Connection) -> rusqlite::Result<HashMap<String, usize>> {
    let mut stmt = conn.prepare(
        "SELECT p AS path, COUNT(*) AS n FROM (
             SELECT source_path AS p FROM semantic_edges
             UNION ALL SELECT target_path AS p FROM semantic_edges
         ) GROUP BY p",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (path, n) = row?;
        map.insert(path, n.max(0) as usize);
    }
    Ok(map)
}

/// `path -> (chunk_total, chunk_embedded)`, via `idx_chunks_file_path`.
fn chunk_index_stats(conn: &Connection) -> rusqlite::Result<HashMap<String, (usize, usize)>> {
    let mut stmt = conn.prepare(
        "SELECT file_path,
                COUNT(*) AS total,
                SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM chunks GROUP BY file_path",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (path, total, embedded) = row?;
        map.insert(path, (total.max(0) as usize, embedded.max(0) as usize));
    }
    Ok(map)
}

// ── Main entry point ────────────────────────────────────────────────────────

/// Raw main-query row, before the aggregation maps are folded in.
struct BaseRow {
    path: String,
    title: String,
    note_type: String,
    tags: Vec<String>,
    outbound_links: usize,
    contradiction_count: usize,
    reconciled_at: Option<String>,
    review_state: Option<String>,
    review_due_at_ms: Option<i64>,
    review_is_due: bool,
    review_suspended: bool,
    review_lapses: usize,
    created_at: String,
    last_synced: String,
}

/// Build the health overview for every note under `vault_path`.
///
/// `now_ms` is injected rather than read from a clock here so this function stays
/// deterministic and testable — the same split `db::review_store` uses.
///
/// `include_graph_signals` is an explicit, default-off switch because
/// `pagerank`/`is_hub` are **not persisted**: the only way to get them is
/// `search::get_graph_data`, whose cache is invalidated merely by a change in
/// `COUNT(*) FROM files`. A cache hit is milliseconds; a miss rebuilds the whole
/// graph (all `card_meta.links`, every wikilink-bearing chunk, Louvain
/// communities, 20 PageRank iterations) and can cost hundreds of ms to seconds on
/// a few thousand notes. When the flag is false we never touch that path at all
/// and the two fields stay `None`, so the UI can distinguish "not requested" from
/// "zero".
pub fn build_overview(
    conn: &Connection,
    vault_path: &str,
    include_graph_signals: bool,
    now_ms: i64,
) -> rusqlite::Result<NotesOverview> {
    let vault_norm = norm_path(vault_path);

    // Main query. One statement for everything that is 1:1 with a note, plus the
    // review LEFT JOIN (`review_cards` is keyed by `file_path` PRIMARY KEY, so it
    // cannot multiply rows).
    //
    // The `is_due` CASE is the verbatim predicate from `review_store::queue`
    // (`suspended = 0 AND state != 'new' AND due_at_ms <= now`) restated as a
    // three-way veto plus the "no card at all" case. All three vetoes matter: a
    // suspended card is user-silenced, a `new` card belongs to the new-cards
    // queue and not the due queue, and a future `due_at_ms` is simply not due yet.
    let sql = format!(
        "SELECT
             f.path,
             f.title,
             COALESCE(cm.note_type, 'permanent')   AS note_type,
             COALESCE(cm.tags, '[]')               AS tags_json,
             COALESCE(cm.links, '[]')              AS links_json,
             cm.contradictions,
             cm.last_reconciled,
             COALESCE(
                 (SELECT MIN(c.created_at) FROM chunks c WHERE c.file_path = f.path),
                 f.last_synced
             )                                     AS created_at,
             f.last_synced,
             rc.state,
             rc.due_at_ms,
             COALESCE(rc.suspended, 0)             AS suspended,
             COALESCE(rc.lapses, 0)                AS lapses,
             CASE WHEN rc.file_path IS NULL THEN 0
                  WHEN rc.suspended = 1      THEN 0
                  WHEN rc.state = 'new'      THEN 0
                  WHEN rc.due_at_ms <= ?1    THEN 1 ELSE 0 END AS is_due
         FROM files f
         LEFT JOIN card_meta    cm ON f.path = cm.file_path
         LEFT JOIN review_cards rc ON f.path = rc.file_path
         ORDER BY f.path
         LIMIT {MAX_ROWS}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let raw = stmt.query_map(rusqlite::params![now_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,          // path
            row.get::<_, Option<String>>(1)?,  // title
            row.get::<_, String>(2)?,          // note_type
            row.get::<_, String>(3)?,          // tags_json
            row.get::<_, String>(4)?,          // links_json
            row.get::<_, Option<String>>(5)?,  // contradictions
            row.get::<_, Option<String>>(6)?,  // last_reconciled
            row.get::<_, Option<String>>(7)?,  // created_at
            row.get::<_, Option<String>>(8)?,  // last_synced
            row.get::<_, Option<String>>(9)?,  // review state
            row.get::<_, Option<i64>>(10)?,    // due_at_ms
            row.get::<_, i64>(11)?,            // suspended
            row.get::<_, i64>(12)?,            // lapses
            row.get::<_, i64>(13)?,            // is_due
        ))
    })?;

    let mut base: Vec<BaseRow> = Vec::new();
    let mut fetched = 0usize;
    for row in raw {
        let (
            path, title, note_type, tags_json, links_json, contradictions, last_reconciled,
            created_at, last_synced, review_state, due_at_ms, suspended, lapses, is_due,
        ) = row?;
        fetched += 1;

        // Vault filter in Rust, not a SQL `LIKE`: matches the existing
        // `get_bases_data` behaviour, and avoids `LIKE` pattern-escaping bugs on
        // Windows paths (which are full of `\` and may contain `%` or `_`).
        if !norm_path(&path).starts_with(&vault_norm) {
            continue;
        }

        let display_title = clamp_title(&title.unwrap_or_else(|| file_stem_of(&path)));
        base.push(BaseRow {
            title: display_title,
            note_type,
            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            outbound_links: serde_json::from_str::<Vec<serde_json::Value>>(&links_json)
                .map(|v| v.len())
                .unwrap_or(0),
            contradiction_count: contradiction_count(contradictions.as_deref()),
            reconciled_at: last_reconciled,
            review_state,
            review_due_at_ms: due_at_ms,
            review_is_due: is_due == 1,
            review_suspended: suspended == 1,
            review_lapses: lapses.max(0) as usize,
            created_at: created_at.unwrap_or_default(),
            last_synced: last_synced.unwrap_or_default(),
            path,
        });
    }
    drop(stmt);

    let truncated = fetched >= MAX_ROWS;
    let paths: Vec<String> = base.iter().map(|r| r.path.clone()).collect();

    // Aggregation passes (see the module note on why these are separate).
    let backlinks = backlink_sources(conn, &paths)?;
    let semantic = semantic_degrees(conn)?;
    let chunk_stats = chunk_index_stats(conn)?;

    // Sentinel: an empty `semantic_edges` means the index has never been
    // computed. Without this the UI cannot tell "no neighbours" from "nothing
    // computed yet" and would brand the entire vault a set of semantic islands.
    let semantic_edge_total: i64 =
        conn.query_row("SELECT COUNT(*) FROM semantic_edges", [], |row| row.get(0))?;
    let semantic_index_ready = semantic_edge_total > 0;

    // Graph signals: opt-in only. `get_graph_data` is anyhow-typed and may fail
    // on a half-built vault; a failure degrades the two optional columns instead
    // of failing the whole view.
    let graph: HashMap<String, (f64, bool)> = if include_graph_signals {
        match crate::db::search::get_graph_data(conn) {
            Ok(data) => data
                .nodes
                .into_iter()
                .map(|n| (n.id, (n.pagerank, n.is_hub)))
                .collect(),
            Err(e) => {
                log::warn!("[notes_overview] graph signals unavailable: {e}");
                HashMap::new()
            }
        }
    } else {
        HashMap::new()
    };

    let mut folders_set: HashSet<String> = HashSet::new();
    let mut tags_set: HashSet<String> = HashSet::new();
    let mut types_set: HashSet<String> = HashSet::new();

    let rows: Vec<NoteRow> = base
        .into_iter()
        .map(|r| {
            let folder = folder_of(&r.path);
            folders_set.insert(folder.clone());
            for tag in &r.tags {
                tags_set.insert(tag.clone());
            }
            types_set.insert(r.note_type.clone());

            let (chunk_total, chunk_embedded) =
                chunk_stats.get(&r.path).copied().unwrap_or((0, 0));
            let (pagerank, is_hub) = match graph.get(&r.path) {
                Some((pr, hub)) => (Some(*pr), Some(*hub)),
                // Still `None` when the flag is on but the note is missing from
                // the graph, which is honest: we have no score for it.
                None => (None, None),
            };

            NoteRow {
                folder,
                backlink_count: backlinks.get(&r.path).map(|s| s.len()).unwrap_or(0),
                semantic_degree: semantic.get(&r.path).copied().unwrap_or(0),
                index_status: index_status_of(chunk_total, chunk_embedded).to_string(),
                chunk_total,
                chunk_embedded,
                has_contradictions: r.contradiction_count > 0,
                contradiction_count: r.contradiction_count,
                pagerank,
                is_hub,
                path: r.path,
                title: r.title,
                note_type: r.note_type,
                tags: r.tags,
                outbound_links: r.outbound_links,
                reconciled_at: r.reconciled_at,
                review_state: r.review_state,
                review_due_at_ms: r.review_due_at_ms,
                review_is_due: r.review_is_due,
                review_suspended: r.review_suspended,
                review_lapses: r.review_lapses,
                created_at: r.created_at,
                last_synced: r.last_synced,
            }
        })
        .collect();

    let mut folders: Vec<String> = folders_set.into_iter().collect();
    folders.sort();
    let mut all_tags: Vec<String> = tags_set.into_iter().collect();
    all_tags.sort();
    let mut all_types: Vec<String> = types_set.into_iter().collect();
    all_types.sort();

    Ok(NotesOverview {
        total: rows.len(),
        rows,
        folders,
        all_tags,
        all_types,
        semantic_index_ready,
        graph_signals_included: include_graph_signals,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    const VAULT: &str = "d:/vault";
    const NOW: i64 = 1_700_000_000_000;

    /// Repo fixture rule: BOTH schema fns. Omitting `migrate_schema_columns` has
    /// already produced a real test failure once — `card_meta.note_type` and
    /// friends only exist after it runs on an older schema.
    fn conn() -> Connection {
        crate::db::register_sqlite_vec();
        let c = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&c).unwrap();
        crate::db::schema::migrate_schema_columns(&c).unwrap();
        c
    }

    fn add_file(c: &Connection, path: &str, title: &str) {
        c.execute(
            "INSERT OR IGNORE INTO files (path, hash, title, last_synced) VALUES (?1, 'h', ?2, '2024-01-01 00:00:00')",
            params![path, title],
        )
        .unwrap();
    }

    /// `embedded = false` leaves `embedding` NULL, which is what makes a chunk
    /// "not indexed" per the authoritative source.
    fn add_chunk(c: &Connection, path: &str, idx: i64, body: &str, embedded: bool) {
        let blob: Option<Vec<u8>> = if embedded { Some(vec![0u8, 1, 2, 3]) } else { None };
        c.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type, embedding)
             VALUES (?1, ?2, ?3, '', 'user', ?4)",
            params![path, idx, body, blob],
        )
        .unwrap();
    }

    fn add_relation(c: &Connection, source: &str, target: &str, rel: &str) {
        c.execute(
            "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type) VALUES (?1, ?2, ?3)",
            params![source, target, rel],
        )
        .unwrap();
    }

    fn add_semantic_edge(c: &Connection, a: &str, b: &str) {
        c.execute(
            "INSERT OR IGNORE INTO semantic_edges (source_path, target_path, similarity) VALUES (?1, ?2, 0.9)",
            params![a, b],
        )
        .unwrap();
    }

    fn overview(c: &Connection) -> NotesOverview {
        build_overview(c, VAULT, false, NOW).unwrap()
    }

    fn row<'a>(o: &'a NotesOverview, path: &str) -> &'a NoteRow {
        o.rows.iter().find(|r| r.path == path).expect("row present")
    }

    // ── Backlinks ───────────────────────────────────────────────────────────

    #[test]
    fn backlinks_merge_both_sources_without_double_counting() {
        let c = conn();
        add_file(&c, "d:/vault/target.md", "Target");
        add_file(&c, "d:/vault/a.md", "A");
        add_file(&c, "d:/vault/b.md", "B");

        // A reaches Target twice over: two relation types (allowed by
        // UNIQUE(source, target, relation_type)) *and* an inline wikilink.
        add_relation(&c, "d:/vault/a.md", "d:/vault/target.md", "supports");
        add_relation(&c, "d:/vault/a.md", "d:/vault/target.md", "contradicts");
        add_chunk(&c, "d:/vault/a.md", 0, "see [[Target]] for detail", false);
        // B reaches it only by wikilink, in different case.
        add_chunk(&c, "d:/vault/b.md", 0, "compare with [[target]]", false);
        // Target links to itself; a self-link is not a backlink.
        add_chunk(&c, "d:/vault/target.md", 0, "I am [[Target]]", false);

        let o = overview(&c);
        assert_eq!(
            row(&o, "d:/vault/target.md").backlink_count,
            2,
            "two distinct sources, not 4 rows and not 3 edges"
        );
        assert_eq!(row(&o, "d:/vault/a.md").backlink_count, 0);
    }

    #[test]
    fn backlinks_resolve_via_file_stem_when_title_differs() {
        let c = conn();
        // The wikilink uses the filename, not the stored title.
        add_file(&c, "d:/vault/202401-note.md", "Completely Different Title");
        add_file(&c, "d:/vault/src.md", "Src");
        add_chunk(&c, "d:/vault/src.md", 0, "ref [[202401-note]]", false);

        let o = overview(&c);
        assert_eq!(row(&o, "d:/vault/202401-note.md").backlink_count, 1);
    }

    #[test]
    fn outbound_links_come_from_card_meta_links_array() {
        let c = conn();
        add_file(&c, "d:/vault/a.md", "A");
        c.execute(
            "INSERT INTO card_meta (file_path, links) VALUES (?1, '[\"[[X]]\", \"[[Y]]\", \"[[Z]]\"]')",
            params!["d:/vault/a.md"],
        )
        .unwrap();
        assert_eq!(row(&overview(&c), "d:/vault/a.md").outbound_links, 3);
    }

    // ── Semantic degree + readiness sentinel ────────────────────────────────

    #[test]
    fn semantic_degree_counts_both_endpoints() {
        let c = conn();
        for p in ["d:/vault/a.md", "d:/vault/b.md", "d:/vault/c.md", "d:/vault/lonely.md"] {
            add_file(&c, p, p);
        }
        // Each unordered pair is stored once; B is only ever a target/source half.
        add_semantic_edge(&c, "d:/vault/a.md", "d:/vault/b.md");
        add_semantic_edge(&c, "d:/vault/b.md", "d:/vault/c.md");

        let o = overview(&c);
        assert!(o.semantic_index_ready);
        assert_eq!(row(&o, "d:/vault/a.md").semantic_degree, 1);
        assert_eq!(row(&o, "d:/vault/b.md").semantic_degree, 2, "both directions");
        assert_eq!(row(&o, "d:/vault/c.md").semantic_degree, 1);
        assert_eq!(
            row(&o, "d:/vault/lonely.md").semantic_degree,
            0,
            "a real island: index is ready and it still has no neighbours"
        );
    }

    #[test]
    fn semantic_index_not_ready_is_distinguishable_from_real_islands() {
        let c = conn();
        add_file(&c, "d:/vault/a.md", "A");

        // No edges anywhere: degree 0 but the index was never computed.
        let cold = overview(&c);
        assert!(!cold.semantic_index_ready);
        assert_eq!(row(&cold, "d:/vault/a.md").semantic_degree, 0);

        // Once any edge exists the vault is "ready", so a 0 now genuinely means
        // isolated. Same number, different meaning — that is the whole point of
        // the sentinel.
        add_file(&c, "d:/vault/b.md", "B");
        add_file(&c, "d:/vault/c.md", "C");
        add_semantic_edge(&c, "d:/vault/b.md", "d:/vault/c.md");
        let warm = overview(&c);
        assert!(warm.semantic_index_ready);
        assert_eq!(row(&warm, "d:/vault/a.md").semantic_degree, 0);
    }

    // ── Index status: one case per state ────────────────────────────────────

    #[test]
    fn index_status_covers_all_four_states() {
        let c = conn();
        add_file(&c, "d:/vault/none.md", "None");

        add_file(&c, "d:/vault/raw.md", "Raw");
        add_chunk(&c, "d:/vault/raw.md", 0, "x", false);
        add_chunk(&c, "d:/vault/raw.md", 1, "y", false);

        add_file(&c, "d:/vault/half.md", "Half");
        add_chunk(&c, "d:/vault/half.md", 0, "x", true);
        add_chunk(&c, "d:/vault/half.md", 1, "y", false);

        add_file(&c, "d:/vault/full.md", "Full");
        add_chunk(&c, "d:/vault/full.md", 0, "x", true);

        let o = overview(&c);
        let s = |p: &str| row(&o, p).index_status.clone();
        assert_eq!(s("d:/vault/none.md"), "noChunks");
        assert_eq!(s("d:/vault/raw.md"), "notIndexed");
        assert_eq!(s("d:/vault/half.md"), "partial");
        assert_eq!(s("d:/vault/full.md"), "indexed");

        let half = row(&o, "d:/vault/half.md");
        assert_eq!((half.chunk_total, half.chunk_embedded), (2, 1));
    }

    // ── Review ──────────────────────────────────────────────────────────────

    #[test]
    fn review_is_due_needs_all_three_conditions() {
        let c = conn();
        let mk = |path: &str, state: &str, due: i64, suspended: i64| {
            add_file(&c, path, path);
            c.execute(
                "INSERT INTO review_cards (file_path, due_at_ms, state, suspended, lapses, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, 3, 0)",
                params![path, due, state, suspended],
            )
            .unwrap();
        };
        let past = NOW - 1_000;
        let future = NOW + 1_000;

        add_file(&c, "d:/vault/nocard.md", "nocard"); // no review_cards row at all
        mk("d:/vault/due.md", "review", past, 0);
        mk("d:/vault/suspended.md", "review", past, 1);
        mk("d:/vault/new.md", "new", past, 0);
        mk("d:/vault/future.md", "review", future, 0);

        let o = overview(&c);
        assert!(row(&o, "d:/vault/due.md").review_is_due, "the only due card");
        assert!(!row(&o, "d:/vault/nocard.md").review_is_due, "not in the deck");
        assert!(
            !row(&o, "d:/vault/suspended.md").review_is_due,
            "suspended vetoes"
        );
        assert!(!row(&o, "d:/vault/new.md").review_is_due, "state='new' vetoes");
        assert!(
            !row(&o, "d:/vault/future.md").review_is_due,
            "due_at_ms in the future vetoes"
        );

        // Companion fields survive the LEFT JOIN correctly.
        let nocard = row(&o, "d:/vault/nocard.md");
        assert_eq!(nocard.review_state, None);
        assert_eq!(nocard.review_due_at_ms, None);
        assert!(!nocard.review_suspended);
        assert_eq!(nocard.review_lapses, 0);

        let susp = row(&o, "d:/vault/suspended.md");
        assert!(susp.review_suspended);
        assert_eq!(susp.review_state.as_deref(), Some("review"));
        assert_eq!(susp.review_lapses, 3);
    }

    // ── Contradictions ──────────────────────────────────────────────────────

    #[test]
    fn contradiction_parsing_is_tolerant() {
        // Real shape: array of {with_note, severity, description}.
        let real = r#"[{"with_note":"[[X]]","severity":"high","description":"冲突"},
                       {"with_note":"[[Y]]","severity":"low","description":"次要"}]"#;
        assert_eq!(contradiction_count(Some(real)), 2);
        assert_eq!(contradiction_count(Some("[]")), 0);
        assert_eq!(contradiction_count(None), 0, "never reconciled");
        assert_eq!(contradiction_count(Some("null")), 0);
        assert_eq!(contradiction_count(Some("   ")), 0);
        assert_eq!(contradiction_count(Some("not json at all")), 0);
        assert_eq!(
            contradiction_count(Some(r#"{"with_note":"[[X]]"}"#)),
            1,
            "a lone object from a misbehaving model counts as one"
        );
        assert_eq!(contradiction_count(Some("\"a string\"")), 0);
    }

    #[test]
    fn contradiction_columns_flow_through_to_rows() {
        let c = conn();
        add_file(&c, "d:/vault/clean.md", "Clean");
        add_file(&c, "d:/vault/dirty.md", "Dirty");
        add_file(&c, "d:/vault/never.md", "Never");
        c.execute(
            "INSERT INTO card_meta (file_path, contradictions, last_reconciled) VALUES (?1, '[]', '2024-05-05 00:00:00')",
            params!["d:/vault/clean.md"],
        )
        .unwrap();
        c.execute(
            "INSERT INTO card_meta (file_path, contradictions, last_reconciled)
             VALUES (?1, '[{\"with_note\":\"[[C]]\",\"severity\":\"high\",\"description\":\"d\"}]', '2024-05-06 00:00:00')",
            params!["d:/vault/dirty.md"],
        )
        .unwrap();

        let o = overview(&c);
        let clean = row(&o, "d:/vault/clean.md");
        assert!(!clean.has_contradictions);
        assert_eq!(clean.contradiction_count, 0);
        assert_eq!(clean.reconciled_at.as_deref(), Some("2024-05-05 00:00:00"));

        let dirty = row(&o, "d:/vault/dirty.md");
        assert!(dirty.has_contradictions);
        assert_eq!(dirty.contradiction_count, 1);

        // NULL last_reconciled == never organised by the AI.
        assert_eq!(row(&o, "d:/vault/never.md").reconciled_at, None);
    }

    // ── Graph signals ───────────────────────────────────────────────────────

    #[test]
    fn graph_signals_off_never_touches_the_graph() {
        let c = conn();
        add_file(&c, "d:/vault/a.md", "A");
        add_chunk(&c, "d:/vault/a.md", 0, "body", false);

        let o = build_overview(&c, VAULT, false, NOW).unwrap();
        assert!(!o.graph_signals_included);
        assert_eq!(row(&o, "d:/vault/a.md").pagerank, None);
        assert_eq!(row(&o, "d:/vault/a.md").is_hub, None);

        // Observable proof: `get_graph_data` always writes `graph_cache`. An
        // empty cache means we never called it.
        let cached: i64 = c
            .query_row("SELECT COUNT(*) FROM graph_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cached, 0, "graph must not be computed when the flag is off");
    }

    #[test]
    fn graph_signals_on_populates_pagerank() {
        let c = conn();
        add_file(&c, "d:/vault/a.md", "A");
        add_file(&c, "d:/vault/b.md", "B");
        add_chunk(&c, "d:/vault/a.md", 0, "link to [[B]]", false);
        add_chunk(&c, "d:/vault/b.md", 0, "plain body", false);

        let o = build_overview(&c, VAULT, true, NOW).unwrap();
        assert!(o.graph_signals_included);
        assert!(row(&o, "d:/vault/a.md").pagerank.is_some());
        assert!(row(&o, "d:/vault/a.md").is_hub.is_some());
    }

    // ── UTF-8, vault filtering, facets, truncation ──────────────────────────

    #[test]
    fn cjk_title_truncates_by_chars_not_bytes() {
        let c = conn();
        // 400 CJK chars = 1200 bytes. A byte slice at 200 would land mid-codepoint
        // and panic.
        let long_title: String = "知".repeat(400);
        assert_eq!(long_title.len(), 1200);
        add_file(&c, "d:/vault/中文笔记.md", &long_title);
        add_chunk(&c, "d:/vault/中文笔记.md", 0, &"测试内容".repeat(200), false);

        let o = overview(&c);
        let r = row(&o, "d:/vault/中文笔记.md");
        assert_eq!(r.title.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(r.title, "知".repeat(TITLE_MAX_CHARS));
        assert_eq!(r.folder, "d:/vault");
    }

    #[test]
    fn missing_title_falls_back_to_file_stem_and_folder_is_derived() {
        let c = conn();
        c.execute(
            "INSERT INTO files (path, hash, title) VALUES ('d:/vault/sub/无标题.md', 'h', NULL)",
            [],
        )
        .unwrap();
        let o = overview(&c);
        let r = row(&o, "d:/vault/sub/无标题.md");
        assert_eq!(r.title, "无标题");
        assert_eq!(r.folder, "d:/vault/sub");
        assert_eq!(o.folders, vec!["d:/vault/sub".to_string()]);
    }

    #[test]
    fn vault_prefix_filter_excludes_other_vaults() {
        let c = conn();
        add_file(&c, "d:/vault/mine.md", "Mine");
        add_file(&c, "d:/other/theirs.md", "Theirs");
        // Backslashes and mixed case, as Windows actually stores them.
        add_file(&c, "D:\\Vault\\Windows.md", "Windows");

        let o = overview(&c);
        assert_eq!(o.total, 2, "same-vault rows only, separator/case insensitive");
        assert!(o.rows.iter().all(|r| !r.path.contains("other")));
    }

    #[test]
    fn facets_are_deduplicated_and_sorted() {
        let c = conn();
        add_file(&c, "d:/vault/a.md", "A");
        add_file(&c, "d:/vault/z/b.md", "B");
        c.execute(
            "INSERT INTO card_meta (file_path, tags, note_type) VALUES (?1, '[\"zeta\",\"alpha\"]', 'literature')",
            params!["d:/vault/a.md"],
        )
        .unwrap();
        c.execute(
            "INSERT INTO card_meta (file_path, tags, note_type) VALUES (?1, '[\"alpha\"]', 'permanent')",
            params!["d:/vault/z/b.md"],
        )
        .unwrap();

        let o = overview(&c);
        assert_eq!(o.all_tags, vec!["alpha".to_string(), "zeta".to_string()]);
        assert_eq!(
            o.all_types,
            vec!["literature".to_string(), "permanent".to_string()]
        );
        assert_eq!(o.folders, vec!["d:/vault".to_string(), "d:/vault/z".to_string()]);
    }

    #[test]
    fn not_truncated_below_the_cap() {
        let c = conn();
        add_file(&c, "d:/vault/a.md", "A");
        let o = overview(&c);
        assert!(!o.truncated);
        assert_eq!(o.total, 1);
    }

    #[test]
    fn truncated_when_the_row_cap_is_hit() {
        let c = conn();
        // Exactly MAX_ROWS notes. One transaction + one prepared statement so
        // this stays well under a second.
        c.execute_batch("BEGIN").unwrap();
        {
            let mut stmt = c
                .prepare("INSERT INTO files (path, hash, title) VALUES (?1, 'h', 'T')")
                .unwrap();
            for i in 0..MAX_ROWS {
                stmt.execute(params![format!("d:/vault/n{i:06}.md")]).unwrap();
            }
        }
        c.execute_batch("COMMIT").unwrap();

        let o = overview(&c);
        assert_eq!(o.rows.len(), MAX_ROWS);
        assert_eq!(o.total, MAX_ROWS);
        assert!(o.truncated, "UI must be told it is seeing a prefix");
    }

    #[test]
    fn wikilink_parsing_handles_aliases_headings_and_cjk() {
        assert_eq!(wikilink_targets("a [[X]] b [[Y|alias]] c"), vec!["X", "Y"]);
        assert_eq!(wikilink_targets("[[笔记#小节]]"), vec!["笔记"]);
        assert_eq!(wikilink_targets("[[ 有空格 ]]"), vec!["有空格"]);
        assert!(wikilink_targets("[[]]").is_empty());
        assert!(wikilink_targets("unclosed [[X").is_empty());
        assert_eq!(wikilink_targets("[[A]][[B]]"), vec!["A", "B"]);
    }
}



