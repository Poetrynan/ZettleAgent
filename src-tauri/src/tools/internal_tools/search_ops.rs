use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

use crate::db::search;

// Search operations: search_notes, list_notes, find_similar_notes, search_by_tag

/// Escape special characters (% _ \) in a string for use in SQL LIKE patterns.
fn escape_like_pattern(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '%' => result.push_str("\\%"),
            '_' => result.push_str("\\_"),
            other => result.push(other),
        }
    }
    result
}

pub(super) fn execute_search_notes(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let query = args["query"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'query' parameter"))?;
    let limit = args["limit"].as_u64().unwrap_or(5) as usize;
    let folder = args["folder"].as_str().unwrap_or("");
    let use_regex = args["regex"].as_bool().unwrap_or(false);

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let mut results = if use_regex {
        // Regex search: scan chunks table with regex on content
        let re = regex::Regex::new(query)
            .map_err(|e| anyhow::anyhow!("Invalid regex '{}': {}", query, e))?;
        let mut stmt = conn.prepare(
            "SELECT c.file_path, c.heading_hierarchy, c.content FROM chunks c ORDER BY c.file_path"
        )?;
        let all: Vec<search::SearchResult> = stmt.query_map([], |row| {
            let fp: String = row.get(0)?;
            let hh: Option<String> = row.get(1)?;
            let ct: String = row.get(2)?;
            Ok((fp, hh.unwrap_or_default(), ct))
        })?
        .filter_map(|r| r.ok())
        .filter(|(fp, _, ct)| {
            let path_ok = folder.is_empty() || fp.replace('\\', "/").starts_with(&folder.replace('\\', "/"));
            path_ok && re.is_match(ct)
        })
        .map(|(fp, hh, ct)| search::SearchResult {
            file_path: fp,
            chunk_id: 0,
            heading_hierarchy: Some(hh),
            content: ct,
            score: 1.0,
        })
        .take(limit)
        .collect();
        all
    } else {
        // Try hybrid search if embedding index is available, otherwise fall back to FTS5
        // Relevance rerank (Tier 1) is applied inside the `*_reranked` wrappers:
        // the agent's `search_notes` is the call site that benefits most, since the
        // model only ever sees the top few hits and cannot scroll for a better one.
        // `external: None` — the agent loop is sync and holds the DB lock here, so
        // Tiers 2/3 are not reachable; they degrade to Tier 1 by contract.
        // Architectural, not a TODO: the cross-encoder runs in the webview and an
        // agent tool call has no webview in the loop for that turn. Bridging it
        // would require suspending the tool call on a frontend round trip.
        let rerank_config = crate::db::search::rerank::active_config();
        let fetch_limit = if folder.is_empty() { limit } else { limit * 3 };

        let has_embeddings: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM chunks_vec LIMIT 1",
            [],
            |row| row.get(0),
        ).unwrap_or(false);

        if has_embeddings {
            // Use FTS top-1 result's embedding as the query vector for hybrid search
            // (this probe is a seed lookup, not a result set — reranking a 1-row
            // list is a no-op anyway, so it stays on the plain function).
            let fts_top = search::full_text_search(&conn, query, 1)?;
            if let Some(top_result) = fts_top.first() {
                // Load the chunk's embedding from chunks_vec
                let emb_result: Result<Vec<u8>, _> = conn.query_row(
                    "SELECT embedding FROM chunks_vec WHERE id = ?1",
                    rusqlite::params![top_result.chunk_id],
                    |row| row.get(0),
                );
                if let Ok(emb_bytes) = emb_result {
                    let query_emb: Vec<f32> = emb_bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    search::hybrid_search_reranked(
                        &conn,
                        query,
                        &query_emb,
                        fetch_limit,
                        &rerank_config,
                        None,
                    )?
                } else {
                    search::full_text_search_reranked(
                        &conn,
                        query,
                        fetch_limit,
                        &rerank_config,
                        None,
                    )?
                }
            } else {
                search::full_text_search_reranked(&conn, query, fetch_limit, &rerank_config, None)?
            }
        } else {
            search::full_text_search_reranked(&conn, query, fetch_limit, &rerank_config, None)?
        }
    };


    // Apply folder filter (for FTS results)
    if !folder.is_empty() && !use_regex {
        let folder_norm = folder.replace('\\', "/");
        results.retain(|r| r.file_path.replace('\\', "/").starts_with(&folder_norm));
        results.truncate(limit);
    }

    // ── Time-decay + MMR rerank ─────────────────────────────────────
    // Regex mode is an exact-match lookup, so leave its ordering alone.
    // Otherwise reorder on rank position (the only score signal comparable
    // across FTS / vector / hybrid), decayed by note age and diversified.
    if !use_regex && results.len() > 1 {
        let cands = crate::db::rerank::from_ranked(
            results.iter().map(|r| (r.chunk_id, r.file_path.as_str())),
        );
        let order = crate::db::rerank::rerank(&conn, cands, limit.min(results.len()), None, None);
        let rank_of: std::collections::HashMap<i64, usize> = order
            .iter()
            .enumerate()
            .map(|(i, c)| (c.chunk_id, i))
            .collect();
        // Keep only reranked survivors, in their new order.
        results.retain(|r| rank_of.contains_key(&r.chunk_id));
        results.sort_by_key(|r| rank_of.get(&r.chunk_id).copied().unwrap_or(usize::MAX));
    }


    let output: Vec<serde_json::Value> = results
        .iter()
        .map(|r| {
            json!({
                "file_path": r.file_path,
                "heading": r.heading_hierarchy,
                "content": if r.content.chars().count() > 1000 {
                    let t: String = r.content.chars().take(1000).collect();
                    format!("{}...", t)
                } else {
                    r.content.clone()
                },
                "score": r.score,
            })
        })
        .collect();

    // ── Graph-Augmented RAG: fetch graph neighbors for richer context ──
    let graph_context = {
        // Reuse the existing conn (no re-lock needed)

        let unique_files: Vec<&str> = results.iter().map(|r| r.file_path.as_str()).collect::<std::collections::HashSet<_>>().into_iter().collect();
        let mut graph_neighbors: Vec<serde_json::Value> = Vec::new();

        // Only fetch graph context if we have results (avoid unnecessary graph computation)
        if !unique_files.is_empty() && unique_files.len() <= 10 {
            // Read precomputed semantic edges and note_relations for result files
            for &file_path in &unique_files {
                // Get relation edges (supports, contradicts, refines, etc.)
                if let Ok(mut stmt) = conn.prepare(
                    "SELECT target_path, relation_type, confidence FROM note_relations
                     WHERE source_path = ?1
                     UNION
                     SELECT source_path, relation_type, confidence FROM note_relations
                     WHERE target_path = ?1
                     LIMIT 5"
                ) {
                    let relations: Vec<(String, String, f64)> = match stmt
                        .query_map(rusqlite::params![file_path], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2).unwrap_or(0.5)))
                        }) {
                        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                        Err(_) => Vec::new(),
                    };

                    for (neighbor, relation, confidence) in relations {
                        // Don't include neighbors already in search results
                        if !unique_files.contains(&neighbor.as_str()) {
                            // Get neighbor's title
                            let title: String = conn.query_row(
                                "SELECT COALESCE(title, path) FROM files WHERE path = ?1",
                                rusqlite::params![neighbor],
                                |row| row.get(0),
                            ).unwrap_or_else(|_| neighbor.clone());

                            graph_neighbors.push(json!({
                                "file_path": neighbor,
                                "title": title,
                                "relation": relation,
                                "confidence": confidence,
                            }));
                        }
                    }
                }
            }
        }

        // Deduplicate neighbors
        let mut seen = std::collections::HashSet::new();
        graph_neighbors.retain(|n| {
            let fp = n["file_path"].as_str().unwrap_or("").to_string();
            seen.insert(fp)
        });

        // Limit to top 5 neighbors
        graph_neighbors.truncate(5);
        graph_neighbors
    };

    // Structured envelope: _summary helps LLM quickly understand results
    let unique_files: std::collections::HashSet<&str> = results.iter().map(|r| r.file_path.as_str()).collect();
    let has_vec: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM chunks_vec LIMIT 1",
        [],
        |row| row.get(0),
    ).unwrap_or(false);
    let search_mode = if use_regex { "regex" } else if has_vec { "hybrid" } else { "fts5" };

    let mut response = json!({
        "_summary": format!("Found {} results across {} notes (mode: {})", output.len(), unique_files.len(), search_mode),
        "total_results": output.len(),
        "unique_files": unique_files.len(),
        "search_mode": search_mode,
        "query": query,
        "results": output
    });

    // Add graph context if available
    if !graph_context.is_empty() {
        response["graph_neighbors"] = json!(graph_context);
        response["_summary"] = json!(format!(
            "Found {} results across {} notes (mode: {}). {} related notes from knowledge graph.",
            output.len(), unique_files.len(), search_mode, graph_context.len()
        ));
    }

    Ok(serde_json::to_string_pretty(&response)?)
}

pub(super) fn execute_list_notes(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or(json!({}));
    let folder = args["folder"].as_str().unwrap_or("");
    let sort_by = args["sort_by"].as_str().unwrap_or("name");
    let limit = args["limit"].as_u64().unwrap_or(200).min(500) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let order_clause = match sort_by {
        "date" => "ORDER BY last_synced DESC",
        "size" => "ORDER BY length(path) DESC",
        _ => "ORDER BY path",
    };

    // The folder pattern is bound, never interpolated: a folder name containing a quote
    // used to produce invalid SQL (and could smuggle in extra conditions). ESCAPE '\' is
    // required because `escape_like_pattern` escapes with a backslash — without it,
    // list_notes({"folder":"my_notes"}) matched nothing.
    let (query_sql, total_sql, like_pattern) = if folder.is_empty() {
        (
            format!("SELECT path, title FROM files {} LIMIT ?1", order_clause),
            "SELECT COUNT(*) FROM files".to_string(),
            None,
        )
    } else {
        let folder_norm = folder.replace('\\', "/");
        (
            format!(
                "SELECT path, title FROM files WHERE replace(path, '\\', '/') LIKE ?2 ESCAPE '\\' {} LIMIT ?1",
                order_clause
            ),
            "SELECT COUNT(*) FROM files WHERE replace(path, '\\', '/') LIKE ?1 ESCAPE '\\'".to_string(),
            Some(format!("{}%", escape_like_pattern(&folder_norm))),
        )
    };

    let total: i64 = match &like_pattern {
        Some(p) => conn
            .query_row(&total_sql, rusqlite::params![p], |r| r.get(0))
            .unwrap_or(0),
        None => conn.query_row(&total_sql, [], |r| r.get(0)).unwrap_or(0),
    };
    let mut stmt = conn.prepare(&query_sql)?;
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<serde_json::Value> {
        let path: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        Ok(serde_json::json!({
            "path": path,
            "title": title.unwrap_or_default()
        }))
    };
    let results: Vec<serde_json::Value> = match &like_pattern {
        Some(p) => stmt
            .query_map(rusqlite::params![limit, p], map_row)?
            .filter_map(|r| r.ok())
            .collect(),
        None => stmt
            .query_map(rusqlite::params![limit], map_row)?
            .filter_map(|r| r.ok())
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&json!({
        "total_notes": total,
        "shown": results.len(),
        "folder": if folder.is_empty() { "(all)" } else { folder },
        "notes": results
    }))?)
}


pub(super) fn execute_find_similar_notes(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_path' parameter"))?;
    let limit = args["limit"].as_i64().unwrap_or(5) as usize;

    let conn = db.lock().map_err(|e| anyhow::anyhow!("DB lock: {}", e))?;

    // Get the first chunk's embedding for this note
    let embedding_bytes: Vec<u8> = conn.query_row(
        "SELECT v.embedding FROM chunks c JOIN chunks_vec v ON c.id = v.id WHERE c.file_path = ?1 LIMIT 1",
        rusqlite::params![note_path],
        |row| row.get(0),
    ).map_err(|_| anyhow::anyhow!("No embedding found for '{}'. Run Smart Organize first to generate embeddings.", note_path))?;

    // Convert bytes back to f32 slice
    let embedding: Vec<f32> = embedding_bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();

    // Run vector search — over-fetch so the reranker has room to trade
    // relevance for recency and diversity before we cut to `limit`.
    let overfetch = (limit + 1).saturating_mul(3).max(10);
    let results = search::vector_search(&conn, &embedding, overfetch)?;

    // Drop the query note itself, then rerank: time-decay (30-day half-life)
    // pulls stale notes down, MMR (λ=0.7) breaks up near-duplicate hits.
    let candidates: Vec<crate::db::rerank::Candidate> = results
        .iter()
        .filter(|r| r.file_path != note_path)
        .map(|r| crate::db::rerank::Candidate {
            chunk_id: r.chunk_id,
            file_path: r.file_path.clone(),
            relevance: (1.0 - r.score).max(0.0), // cosine distance → similarity
            age_days: None,                       // hydrated inside rerank()
            embedding: None,                      // hydrated inside rerank()
        })
        .collect();

    let reranked = crate::db::rerank::rerank(&conn, candidates, limit, None, None);

    if reranked.is_empty() {
        return Ok("No similar notes found.".to_string());
    }

    // Re-associate reranked candidates with their content for display.
    let by_chunk: std::collections::HashMap<i64, &search::SearchResult> =
        results.iter().map(|r| (r.chunk_id, r)).collect();

    let mut output = format!("Found {} similar notes:\n\n", reranked.len());
    for (i, c) in reranked.iter().enumerate() {
        let content = by_chunk
            .get(&c.chunk_id)
            .map(|r| r.content.as_str())
            .unwrap_or("");
        let preview = if content.chars().count() > 100 {
            content.chars().take(100).collect::<String>()
        } else {
            content.to_string()
        };
        output.push_str(&format!(
            "{}. {} (score: {:.3})\n   {}\n\n",
            i + 1,
            c.file_path,
            c.relevance, // post-decay relevance
            preview,
        ));
    }

    Ok(output)
}

// ── 19. move_note ──────────────────────────────────────────────────


pub(super) fn execute_search_by_tag(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let tag = args["tag"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'tag' parameter"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    // Search in card_meta.tags (stored as JSON array of strings)
    let pattern = format!("%{}%", escape_like_pattern(&tag.to_lowercase()));
    let mut stmt = conn.prepare(
        "SELECT am.file_path, COALESCE(f.title, '') as title, 
                COALESCE(am.note_type, '') as note_type, am.tags
         FROM card_meta am
         LEFT JOIN files f ON f.path = am.file_path
         WHERE LOWER(am.tags) LIKE ?1 ESCAPE '\\'
         ORDER BY f.title
         LIMIT 50"
    )?;

    let results: Vec<serde_json::Value> = stmt
        .query_map(rusqlite::params![pattern], |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let note_type: String = row.get(2)?;
            let tags_raw: String = row.get::<_, String>(3).unwrap_or_else(|_| "[]".to_string());
            let tags: serde_json::Value = serde_json::from_str(&tags_raw).unwrap_or(json!([]));
            Ok(json!({
                "path": path,
                "title": title,
                "note_type": note_type,
                "tags": tags
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::to_string_pretty(&json!({
        "query_tag": tag,
        "count": results.len(),
        "notes": results
    }))?)
}

#[cfg(test)]
mod rerank_wiring_tests {
    use super::*;
    use crate::db::search::rerank::{self, RerankConfig, RerankMode};

    fn db() -> Arc<Mutex<Connection>> {
        Arc::new(Mutex::new(crate::db::search::test_db_with_ranking_disagreement()))
    }

    /// Order of `file_path` as the agent actually sees it in the tool result.
    fn hit_paths(payload: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(payload).unwrap();
        v["results"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|r| r["file_path"].as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The agent's `search_notes` is the call site that matters most: the model
    /// only ever reads the first couple of hits and cannot scroll for a better
    /// one. Under Tier 1 the exact-phrase note must come back first.
    #[test]
    fn search_notes_applies_lexical_rerank() {
        let _g = rerank::config_guard();
        rerank::store_config(RerankConfig::lexical());
        let db = db();
        let out =
            execute_search_notes(r#"{"query":"knowledge graph","limit":5}"#, &db).unwrap();
        let paths = hit_paths(&out);
        assert!(!paths.is_empty(), "fixture should produce hits: {}", out);
        assert_eq!(paths[0], "b.md", "expected the reranked winner first: {:?}", paths);
    }

    /// `Off` must leave the pre-existing behaviour (FTS order, then the
    /// time-decay/MMR pass) exactly as it was before this stage was wired in.
    #[test]
    fn search_notes_off_keeps_pre_rerank_order() {
        let _g = rerank::config_guard();
        let db = db();

        rerank::store_config(RerankConfig { mode: RerankMode::Off, ..Default::default() });
        let off = hit_paths(&execute_search_notes(r#"{"query":"knowledge graph","limit":5}"#, &db).unwrap());

        // Same query straight through the plain function, for reference.
        let plain: Vec<String> = {
            let conn = db.lock().unwrap();
            crate::db::search::full_text_search(&conn, "knowledge graph", 5)
                .unwrap()
                .into_iter()
                .map(|r| r.file_path)
                .collect()
        };
        assert_eq!(off, plain, "Off must not reorder anything");
    }

    /// A Chinese query has to traverse tokenize_query's CJK-bigram branch, the
    /// scorer, and the JSON projection without panicking. Content is ASCII here,
    /// so an empty hit list is a legitimate outcome — absence of panic is the test.
    #[test]
    fn search_notes_chinese_query_does_not_panic() {
        let _g = rerank::config_guard();
        rerank::store_config(RerankConfig::lexical());
        let db = db();
        let out = execute_search_notes(r#"{"query":"知识图谱是什么","limit":5}"#, &db).unwrap();
        let _ = hit_paths(&out);
    }
}


