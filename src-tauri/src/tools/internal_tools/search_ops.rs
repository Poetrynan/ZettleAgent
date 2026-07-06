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
        let fetch_limit = if folder.is_empty() { limit } else { limit * 3 };
        let has_embeddings: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM chunks_vec LIMIT 1",
            [],
            |row| row.get(0),
        ).unwrap_or(false);

        if has_embeddings {
            // Use FTS top-1 result's embedding as the query vector for hybrid search
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
                    search::hybrid_search(&conn, query, &query_emb, fetch_limit)?
                } else {
                    search::full_text_search(&conn, query, fetch_limit)?
                }
            } else {
                search::full_text_search(&conn, query, fetch_limit)?
            }
        } else {
            search::full_text_search(&conn, query, fetch_limit)?
        }
    };

    // Apply folder filter (for FTS results)
    if !folder.is_empty() && !use_regex {
        let folder_norm = folder.replace('\\', "/");
        results.retain(|r| r.file_path.replace('\\', "/").starts_with(&folder_norm));
        results.truncate(limit);
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

    let (query_sql, total_sql) = if folder.is_empty() {
        (
            format!("SELECT path, title FROM files {} LIMIT ?1", order_clause),
            "SELECT COUNT(*) FROM files".to_string(),
        )
    } else {
        let folder_norm = folder.replace('\\', "/");
        let like_pattern = format!("{}%", escape_like_pattern(&folder_norm));
        (
            format!("SELECT path, title FROM files WHERE replace(path, '\\', '/') LIKE '{}' {} LIMIT ?1", like_pattern, order_clause),
            format!("SELECT COUNT(*) FROM files WHERE replace(path, '\\', '/') LIKE '{}'", like_pattern),
        )
    };

    let total: i64 = conn.query_row(&total_sql, [], |r| r.get(0)).unwrap_or(0);
    let mut stmt = conn.prepare(&query_sql)?;
    let results: Vec<serde_json::Value> = stmt
        .query_map(rusqlite::params![limit], |row| {
            let path: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            Ok(serde_json::json!({
                "path": path,
                "title": title.unwrap_or_default()
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();
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

    // Run vector search
    let results = search::vector_search(&conn, &embedding, limit + 1)?;

    // Filter out the query note itself
    let filtered: Vec<_> = results
        .iter()
        .filter(|r| r.file_path != note_path)
        .take(limit)
        .collect();

    if filtered.is_empty() {
        return Ok("No similar notes found.".to_string());
    }

    let mut output = format!("Found {} similar notes:\n\n", filtered.len());
    for (i, r) in filtered.iter().enumerate() {
        output.push_str(&format!(
            "{}. {} (similarity: {:.3})\n   {}\n\n",
            i + 1,
            r.file_path,
            1.0 - r.score, // cosine distance → similarity
            if r.content.len() > 100 { &r.content[..100] } else { &r.content },
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

    // Search in ai_note_metadata.tags_json (stored as JSON array of strings)
    let pattern = format!("%{}%", escape_like_pattern(&tag.to_lowercase()));
    let mut stmt = conn.prepare(
        "SELECT am.file_path, COALESCE(f.title, '') as title, 
                COALESCE(am.note_type, '') as note_type, am.tags_json
         FROM ai_note_metadata am
         LEFT JOIN files f ON f.path = am.file_path
         WHERE LOWER(am.tags_json) LIKE ?1
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

