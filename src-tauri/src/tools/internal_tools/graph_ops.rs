use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

use crate::db::search;

// Graph operations: get_graph, get_local_graph, find_shortest_path, backlinks, tags, metadata, relations, timeline

/// Helper to parse JSON from an LLM response that may have markdown fencing or extra text.
fn parse_json_from_llm_response(response: &str) -> serde_json::Value {
    serde_json::from_str(response)
        .or_else(|_| {
            let start = response.find('[').or_else(|| response.find('{')).unwrap_or(0);
            let end = response.rfind(']').or_else(|| response.rfind('}')).map(|i| i + 1).unwrap_or(response.len());
            serde_json::from_str(&response[start..end])
        })
        .unwrap_or(serde_json::json!([]))
}

pub(super) fn execute_get_graph(
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let graph = search::get_graph_data(&conn)?;

    // Compute summary stats
    let hub_count = graph.nodes.iter().filter(|n| n.is_hub).count();
    let orphan_count = graph.nodes.iter().filter(|n| n.is_orphan).count();
    let cluster_count = graph.clusters.len();

    // Return a compact summary with structured envelope
    let summary = json!({
        "_summary": format!(
            "Knowledge graph: {} nodes ({} hubs, {} orphans), {} edges, {} clusters",
            graph.nodes.len(), hub_count, orphan_count, graph.edges.len(), cluster_count
        ),
        "total_nodes": graph.nodes.len(),
        "total_edges": graph.edges.len(),
        "hub_count": hub_count,
        "orphan_count": orphan_count,
        "cluster_count": cluster_count,
        "clusters": graph.clusters.iter().take(10).map(|c| json!({
            "id": c.id,
            "label": c.label,
            "node_count": c.node_count,
            "color": c.color,
        })).collect::<Vec<_>>(),
        "nodes": graph.nodes.iter().take(50).map(|n| json!({
            "id": n.id,
            "label": n.label,
            "type": n.note_type,
            "is_hub": n.is_hub,
            "is_orphan": n.is_orphan,
            "chunk_count": n.chunk_count,
            "pagerank": format!("{:.3}", n.pagerank),
        })).collect::<Vec<_>>(),
        "edges": graph.edges.iter().take(100).map(|e| json!({
            "source": e.source,
            "target": e.target,
            "type": e.edge_type,
            "label": e.label,
        })).collect::<Vec<_>>(),
    });

    Ok(serde_json::to_string_pretty(&summary)?)
}


pub(super) fn execute_get_local_graph(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let depth = args["depth"].as_u64().unwrap_or(1) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let graph = search::get_local_graph_with_depth(&conn, path, depth)?;

    let output = json!({
        "_summary": format!("{}-hop graph around '{}': {} nodes, {} edges", depth, path, graph.nodes.len(), graph.edges.len()),
        "center": path,
        "depth": depth,
        "total_nodes": graph.nodes.len(),
        "total_edges": graph.edges.len(),
        "nodes": graph.nodes.iter().map(|n| json!({
            "id": n.id,
            "label": n.label,
            "type": n.note_type,
            "pagerank": format!("{:.3}", n.pagerank),
            "is_hub": n.is_hub,
        })).collect::<Vec<_>>(),
        "edges": graph.edges.iter().map(|e| json!({
            "source": e.source,
            "target": e.target,
            "type": e.edge_type,
            "label": e.label,
        })).collect::<Vec<_>>(),
    });

    Ok(serde_json::to_string_pretty(&output)?)
}


pub(super) fn execute_find_shortest_path(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let source = args["source"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'source' parameter"))?;
    let target = args["target"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target' parameter"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let path = search::find_shortest_path(&conn, source, target)?;

    if path.is_empty() {
        Ok(serde_json::to_string_pretty(&json!({
            "_summary": format!("No connection path found between '{}' and '{}'", source, target),
            "connected": false,
            "source": source,
            "target": target,
            "path": [],
            "hops": 0
        }))?)
    } else {
        let hops = path.len() - 1;
        let path_labels: Vec<String> = path.iter().map(|p| {
            p.replace('\\', "/").rsplit('/').next().unwrap_or(p).replace(".md", "").to_string()
        }).collect();
        Ok(serde_json::to_string_pretty(&json!({
            "_summary": format!("Found {}-hop path: {}", hops, path_labels.join(" → ")),
            "connected": true,
            "source": source,
            "target": target,
            "hops": hops,
            "path": path,
            "path_labels": path_labels
        }))?)
    }
}


pub(super) fn execute_get_timeline(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"].as_str();

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    if let Some(path) = note_path {
        let facts = crate::temporal::get_active_facts(&conn, path)?;
        Ok(serde_json::to_string_pretty(&facts)?)
    } else {
        let timeline = crate::temporal::get_timeline_range(&conn, "1970-01-01", "2099-12-31")?;
        // Limit to most recent 50 entries
        let limited: Vec<_> = timeline.into_iter().take(50).collect();
        Ok(serde_json::to_string_pretty(&limited)?)
    }
}


pub(super) fn execute_get_backlinks(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let mut backlinks: Vec<serde_json::Value> = Vec::new();

    // From note_relations table
    let mut stmt = conn.prepare(
        "SELECT nr.source_path, COALESCE(f.title, '') as title, COALESCE(nr.relation_type, '') as rel
         FROM note_relations nr
         LEFT JOIN files f ON f.path = nr.source_path
         WHERE nr.target_path = ?1"
    )?;
    let rows = stmt.query_map(rusqlite::params![path], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (src, title, rel) = row?;
        if seen.insert(src.clone()) {
            backlinks.push(json!({ "source": src, "title": title, "relation": rel }));
        }
    }

    // Also scan for [[wikilinks]] using a single SQL query (much faster than per-file scanning)
    let target_title: Option<String> = conn.query_row(
        "SELECT title FROM files WHERE path = ?1",
        rusqlite::params![path],
        |row| row.get(0),
    ).ok();

    if let Some(ref title) = target_title {
        let pattern = format!("%[[{}]]%", title);
        let mut wl_stmt = conn.prepare(
            "SELECT DISTINCT c.file_path, COALESCE(f.title, '') as ftitle
             FROM chunks c
             LEFT JOIN files f ON f.path = c.file_path
             WHERE c.content LIKE ?1 AND c.file_path != ?2
             LIMIT 50"
        )?;
        let wl_rows = wl_stmt.query_map(rusqlite::params![pattern, path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in wl_rows {
            let (fpath, ftitle) = row?;
            if seen.insert(fpath.clone()) {
                backlinks.push(json!({
                    "source": fpath,
                    "title": ftitle,
                    "relation": "wikilink"
                }));
            }
        }
    }

    Ok(serde_json::to_string_pretty(&json!({
        "target": path,
        "count": backlinks.len(),
        "backlinks": backlinks
    }))?)
}


pub(super) fn execute_get_note_tags(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let filter_tag = args["tag"].as_str();

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    if let Some(tag) = filter_tag {
        // Find all notes with a specific tag
        let pattern = format!("%{}%", tag);
        let mut stmt = conn.prepare(
            "SELECT file_path, tags, note_type FROM card_meta WHERE tags LIKE ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
        })?;

        let mut notes: Vec<serde_json::Value> = Vec::new();
        for row in rows {
            let (path, tags, note_type) = row?;
            notes.push(json!({
                "path": path,
                "tags": tags,
                "note_type": note_type.unwrap_or_default()
            }));
        }
        Ok(serde_json::to_string_pretty(&json!({
            "filter": tag,
            "count": notes.len(),
            "notes": notes
        }))?)
    } else {
        // Return all unique tags with counts
        let mut stmt = conn.prepare("SELECT tags FROM card_meta WHERE tags IS NOT NULL AND tags != ''")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let mut tag_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for row in rows {
            if let Ok(tags_str) = row {
                // tags are stored as comma-separated or JSON array
                let tags: Vec<String> = if tags_str.starts_with('[') {
                    serde_json::from_str(&tags_str).unwrap_or_else(|_| vec![tags_str.clone()])
                } else {
                    tags_str.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
                };
                for tag in tags {
                    *tag_counts.entry(tag).or_insert(0) += 1;
                }
            }
        }

        let mut sorted: Vec<_> = tag_counts.into_iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));

        let tag_list: Vec<serde_json::Value> = sorted.iter().take(50).map(|(tag, count)| {
            json!({ "tag": tag, "count": count })
        }).collect();

        Ok(serde_json::to_string_pretty(&json!({
            "total_unique_tags": sorted.len(),
            "tags": tag_list
        }))?)
    }
}


pub(super) fn execute_get_note_metadata(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    // Get AI metadata
    let meta_result = conn.query_row(
        "SELECT note_type, tags_json, suggested_links, contradictions, facts_extracted
         FROM ai_note_metadata WHERE file_path = ?1",
        rusqlite::params![path],
        |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, String>(1).unwrap_or_else(|_| "[]".to_string()),
                row.get::<_, String>(2).unwrap_or_else(|_| "[]".to_string()),
                row.get::<_, String>(3).unwrap_or_else(|_| "[]".to_string()),
                row.get::<_, String>(4).unwrap_or_else(|_| "[]".to_string()),
            ))
        },
    );

    // Get chunk count
    let chunk_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE file_path = ?1",
        rusqlite::params![path],
        |r| r.get(0),
    ).unwrap_or(0);

    // Get title
    let title: String = conn.query_row(
        "SELECT COALESCE(title, '') FROM files WHERE path = ?1",
        rusqlite::params![path],
        |r| r.get(0),
    ).unwrap_or_default();

    match meta_result {
        Ok((note_type, tags_json, links_json, contradictions_json, facts_json)) => {
            let tags: serde_json::Value = serde_json::from_str(&tags_json).unwrap_or(json!([]));
            let links: serde_json::Value = serde_json::from_str(&links_json).unwrap_or(json!([]));
            let contradictions: serde_json::Value = serde_json::from_str(&contradictions_json).unwrap_or(json!([]));
            let facts: serde_json::Value = serde_json::from_str(&facts_json).unwrap_or(json!([]));

            Ok(serde_json::to_string_pretty(&json!({
                "path": path,
                "title": title,
                "note_type": note_type,
                "tags": tags,
                "suggested_links": links,
                "contradictions": contradictions,
                "facts_extracted": facts,
                "chunk_count": chunk_count
            }))?)
        }
        Err(_) => {
            Ok(serde_json::to_string_pretty(&json!({
                "path": path,
                "title": title,
                "note_type": null,
                "tags": [],
                "suggested_links": [],
                "contradictions": [],
                "facts_extracted": [],
                "chunk_count": chunk_count,
                "warning": "No AI metadata found for this note. It may not have been processed yet."
            }))?)
        }
    }
}


pub(super) fn execute_query_relations(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let relation_type = args["relation_type"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(50) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let (query, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(rt) = relation_type {
        (
            format!(
                "SELECT nr.source_path, COALESCE(fs.title, '') as source_title,
                        nr.target_path, COALESCE(ft.title, '') as target_title,
                        nr.relation_type
                 FROM note_relations nr
                 LEFT JOIN files fs ON fs.path = nr.source_path
                 LEFT JOIN files ft ON ft.path = nr.target_path
                 WHERE nr.relation_type = ?1
                 ORDER BY nr.source_path
                 LIMIT {}", limit
            ),
            vec![Box::new(rt.to_string()) as Box<dyn rusqlite::types::ToSql>],
        )
    } else {
        (
            format!(
                "SELECT nr.source_path, COALESCE(fs.title, '') as source_title,
                        nr.target_path, COALESCE(ft.title, '') as target_title,
                        nr.relation_type
                 FROM note_relations nr
                 LEFT JOIN files fs ON fs.path = nr.source_path
                 LEFT JOIN files ft ON ft.path = nr.target_path
                 ORDER BY nr.relation_type, nr.source_path
                 LIMIT {}", limit
            ),
            vec![],
        )
    };

    let mut stmt = conn.prepare(&query)?;
    let results: Vec<serde_json::Value> = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(json!({
                "source_path": row.get::<_, String>(0)?,
                "source_title": row.get::<_, String>(1)?,
                "target_path": row.get::<_, String>(2)?,
                "target_title": row.get::<_, String>(3)?,
                "relation": row.get::<_, String>(4)?
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Count by type
    let mut type_counts = std::collections::HashMap::new();
    for r in &results {
        let rt = r["relation"].as_str().unwrap_or("unknown");
        *type_counts.entry(rt.to_string()).or_insert(0u32) += 1;
    }

    Ok(serde_json::to_string_pretty(&json!({
        "filter": relation_type.unwrap_or("all"),
        "count": results.len(),
        "by_type": type_counts,
        "relations": results
    }))?)
}

// ── Knowledge Graph Write Operations ─────────────────────────────────

pub(super) fn execute_add_relation(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let source = args["source_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'source_path'"))?;
    let target = args["target_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target_path'"))?;
    let relation_type = args["relation_type"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'relation_type'"))?;
    let reason = args["reason"].as_str().unwrap_or("Created by AI Agent");

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    conn.execute(
        "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
         VALUES (?1, ?2, ?3, 1.0, ?4)",
        rusqlite::params![source, target, relation_type, reason],
    )?;

    Ok(json!({
        "success": true,
        "message": format!("Relation '{}' created: {} → {}", relation_type, source, target)
    }).to_string())
}

pub(super) fn execute_delete_relation(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let source = args["source_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'source_path'"))?;
    let target = args["target_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target_path'"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let deleted = conn.execute(
        "DELETE FROM note_relations WHERE source_path = ?1 AND target_path = ?2",
        rusqlite::params![source, target],
    )?;

    Ok(json!({
        "success": true,
        "deleted": deleted,
        "message": format!("Deleted {} relation(s) between {} and {}", deleted, source, target)
    }).to_string())
}

pub(super) fn execute_get_relations_by_type(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let relation_type = args["relation_type"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'relation_type'"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let edges = search::get_edges_by_relation(&conn, relation_type)?;

    let results: Vec<serde_json::Value> = edges.iter().map(|e| json!({
        "source": e.source,
        "target": e.target,
        "type": e.edge_type,
        "label": e.label,
    })).collect();

    Ok(json!({
        "relation_type": relation_type,
        "count": results.len(),
        "edges": results
    }).to_string())
}

// ── Timeline & Facts Operations ──────────────────────────────────────

pub(super) fn execute_get_note_facts(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_path'"))?;
    let include_history = args["include_history"].as_bool().unwrap_or(false);

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let facts = if include_history {
        crate::temporal::get_fact_history(&conn, note_path)?
    } else {
        crate::temporal::get_active_facts(&conn, note_path)?
    };

    let results: Vec<serde_json::Value> = facts.iter().map(|f| json!({
        "fact": f.fact_content,
        "valid_from": f.valid_from,
        "valid_to": f.valid_to,
        "created_by": f.created_by,
    })).collect();

    Ok(json!({
        "note_path": note_path,
        "fact_count": results.len(),
        "include_history": include_history,
        "facts": results
    }).to_string())
}

pub(super) fn execute_get_global_timeline(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let start_date = args["start_date"].as_str().unwrap_or("1970-01-01");
    let end_date = args["end_date"].as_str().unwrap_or("2099-12-31");

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let events = crate::temporal::get_timeline_range(&conn, start_date, end_date)?;

    let results: Vec<serde_json::Value> = events.iter().take(100).map(|e| json!({
        "timestamp": e.event_timestamp,
        "event_type": e.event_type,
        "note_path": e.note_path,
        "details": e.event_details,
    })).collect();

    Ok(json!({
        "start_date": start_date,
        "end_date": end_date,
        "event_count": results.len(),
        "events": results
    }).to_string())
}

// ── execute_explain_relationship ──────────────────────────────────────

pub(super) async fn execute_explain_relationship(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    llm_config: &crate::llm::LlmConfig,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_a = args["note_a"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_a' parameter"))?;
    let note_b = args["note_b"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_b' parameter"))?;

    // Multi-vault resolution
    let canonical_a = super::helpers::resolve_path_multi_vault(note_a, vault_path, all_vault_paths)?;
    let canonical_b = super::helpers::resolve_path_multi_vault(note_b, vault_path, all_vault_paths)?;

    if !canonical_a.exists() {
        anyhow::bail!("Note A does not exist: {}", note_a);
    }
    if !canonical_b.exists() {
        anyhow::bail!("Note B does not exist: {}", note_b);
    }

    // Read first 3000 chars of both files
    let content_a = std::fs::read_to_string(&canonical_a)?;
    let content_b = std::fs::read_to_string(&canonical_b)?;

    let snippet_a: String = content_a.chars().take(3000).collect();
    let snippet_b: String = content_b.chars().take(3000).collect();

    let (direct_relations, shared_tags, indirect_connections) = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

        // 1. Direct relations from note_relations
        let mut direct_relations = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT source_path, target_path, relation_type, confidence, reason 
             FROM note_relations 
             WHERE (source_path = ?1 AND target_path = ?2) 
                OR (source_path = ?2 AND target_path = ?1)"
        )?;
        let rows = stmt.query_map(rusqlite::params![note_a, note_b], |row| {
            Ok(json!({
                "source": row.get::<_, String>(0)?,
                "target": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "confidence": row.get::<_, f64>(3).unwrap_or(0.5),
                "reason": row.get::<_, Option<String>>(4)?
            }))
        })?;
        for r in rows.flatten() {
            direct_relations.push(r);
        }

        // 2. Shared tags
        let mut shared_tags = Vec::new();
        let tags_a: Option<String> = conn.query_row(
            "SELECT tags_json FROM ai_note_metadata WHERE file_path = ?1",
            rusqlite::params![note_a],
            |row| row.get(0),
        ).ok();
        let tags_b: Option<String> = conn.query_row(
            "SELECT tags_json FROM ai_note_metadata WHERE file_path = ?1",
            rusqlite::params![note_b],
            |row| row.get(0),
        ).ok();

        if let (Some(ta), Some(tb)) = (tags_a, tags_b) {
            let list_a: Vec<String> = serde_json::from_str(&ta).unwrap_or_default();
            let list_b: Vec<String> = serde_json::from_str(&tb).unwrap_or_default();
            for t in list_a {
                if list_b.contains(&t) {
                    shared_tags.push(t);
                }
            }
        }

        // 3. Indirect connections (2-hop paths)
        let mut indirect_connections = Vec::new();
        let mut stmt_indirect = conn.prepare(
            "SELECT nr1.target_path FROM note_relations nr1
             JOIN note_relations nr2 ON nr1.target_path = nr2.target_path
             WHERE nr1.source_path = ?1 AND nr2.source_path = ?2"
        )?;
        let rows_indirect = stmt_indirect.query_map(rusqlite::params![note_a, note_b], |row| {
            row.get::<_, String>(0)
        })?;
        for r in rows_indirect.flatten() {
            indirect_connections.push(r);
        }

        (direct_relations, shared_tags, indirect_connections)
    };

    let system_prompt = "You are a professional knowledge graph analyst. \
                         Your goal is to explain the semantic and structural relationship between two notes. \
                         You must respond with a JSON object containing the fields: \
                         'relation_type' (string, e.g., 'supports', 'contradicts', 'refines', 'parallel', 'unrelated'), \
                         'explanation' (string, a paragraph explaining how they relate), \
                         'strength' (number between 0.0 and 1.0 representing connection strength), \
                         'shared_concepts' (array of strings). \
                         Return ONLY the JSON object, with no markdown code blocks or extra text.";

    let user_content = format!(
        "Note A Path: {}\nContent Snippet A:\n{}\n\n\
         Note B Path: {}\nContent Snippet B:\n{}\n\n\
         Direct Relations in Graph:\n{}\n\n\
         Shared Tags:\n{:?}\n\n\
         Shared 2-hop Neighbors:\n{:?}",
        note_a, snippet_a,
        note_b, snippet_b,
        serde_json::to_string_pretty(&direct_relations)?,
        shared_tags,
        indirect_connections
    );

    let messages = vec![
        crate::llm::ChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
            ..Default::default()
        },
        crate::llm::ChatMessage {
            role: "user".to_string(),
            content: user_content,
            ..Default::default()
        }
    ];

    let mut explanation_json = crate::llm::chat_completion(llm_config, &messages).await?;
    
    // Strip markdown JSON block if present
    if explanation_json.starts_with("```") {
        let lines: Vec<&str> = explanation_json.lines().collect();
        if lines.len() >= 2 {
            let start = if lines[0].starts_with("```json") || lines[0].starts_with("```") { 1 } else { 0 };
            let end = if lines.last().unwrap().starts_with("```") { lines.len() - 1 } else { lines.len() };
            explanation_json = lines[start..end].join("\n");
        }
    }
    let explanation_json = explanation_json.trim().to_string();

    Ok(explanation_json)
}

// ── execute_extract_facts ───────────────────────────────────────────

pub(super) async fn execute_extract_facts(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    llm_config: &crate::llm::LlmConfig,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_path' parameter"))?;
    let _force = args["force_re_extract"].as_bool().unwrap_or(false);

    // Resolve path
    let canonical = super::helpers::resolve_path_multi_vault(note_path, vault_path, all_vault_paths)?;
    let content = std::fs::read_to_string(&canonical)?;

    // Read note content (first 8000 chars for LLM)
    let prompt_content: String = content.chars().take(8000).collect();

    // Construct LLM prompt to extract structured facts
    let prompt = format!(
        "Extract key factual claims from the following note. For each fact, provide:\n\
         - The fact statement (concise, one sentence)\n\
         - Confidence level (0.0-1.0, how certain the fact appears to be)\n\
         - A short category label (e.g. 'definition', 'claim', 'result', 'opinion', 'observation')\n\n\
         Return a JSON array: [{{\"fact\": \"...\", \"confidence\": 0.9, \"category\": \"definition\"}}, ...]\n\n\
         Note content:\n{}\n\nFacts (JSON array only, no explanation):", prompt_content);

    let messages = vec![
        crate::llm::ChatMessage {
            role: "system".to_string(),
            content: "You are a precise fact extraction assistant. Return only valid JSON.".to_string(),
            ..Default::default()
        },
        crate::llm::ChatMessage {
            role: "user".to_string(),
            content: prompt,
            ..Default::default()
        },
    ];

    let llm_response = crate::llm::chat_completion(llm_config, &messages).await?;

    // Parse facts from LLM response
    let facts_json = parse_json_from_llm_response(&llm_response);
    let facts: Vec<serde_json::Value> = facts_json.as_array()
        .map(|a| a.to_vec())
        .unwrap_or_default();

    // Store facts in fact_history table
    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    crate::db::schema::ensure_fact_history_table(&conn)?;

    let db_path = super::helpers::normalize_db_path(&canonical);
    let now = chrono::Utc::now().to_rfc3339();

    // Mark all existing facts for this note as not current
    let _ = conn.execute(
        "UPDATE fact_history SET is_current = 0 WHERE note_path = ?1",
        rusqlite::params![db_path],
    );

    for fact in &facts {
        let fact_text = fact["fact"].as_str().unwrap_or("");
        let confidence = fact["confidence"].as_f64().unwrap_or(0.7);
        let category = fact["category"].as_str().unwrap_or("claim");

        conn.execute(
            "INSERT INTO fact_history (note_path, fact_content, confidence, category, extraction_time, is_current)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            rusqlite::params![db_path, fact_text, confidence, category, now],
        )?;
    }

    Ok(serde_json::to_string_pretty(&json!({
        "note_path": db_path,
        "facts_extracted": facts.len(),
        "facts": facts,
        "stored_in_fact_history": true,
    }))?)
}

// ── execute_query_temporal ──────────────────────────────────────────

pub(super) fn execute_query_temporal(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"].as_str();
    let fact_query = args["fact_query"].as_str();
    let before_date = args["before_date"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(30) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    // Ensure extended columns exist
    crate::db::schema::ensure_fact_history_table(&conn)?;

    if let Some(path) = note_path {
        let db_path = path.replace('\\', "/");
        let facts: Vec<serde_json::Value> = if let Some(date) = before_date {
            let mut stmt = conn.prepare(
                "SELECT fact_content, confidence, category, extraction_time, is_current
                 FROM fact_history WHERE note_path = ?1 AND extraction_time <= ?2
                 ORDER BY extraction_time DESC LIMIT ?3"
            )?;
            let rows = stmt.query_map(
                rusqlite::params![db_path, date, limit as i64],
                |row| {
                    Ok(json!({
                        "fact": row.get::<_, String>(0)?,
                        "confidence": row.get::<_, f64>(1)?,
                        "category": row.get::<_, String>(2)?,
                        "extracted_at": row.get::<_, String>(3)?,
                        "is_current": row.get::<_, bool>(4)?,
                    }))
                },
            )?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT fact_content, confidence, category, extraction_time, is_current
                 FROM fact_history WHERE note_path = ?1
                 ORDER BY extraction_time DESC LIMIT ?2"
            )?;
            let rows = stmt.query_map(
                rusqlite::params![db_path, limit as i64],
                |row| {
                    Ok(json!({
                        "fact": row.get::<_, String>(0)?,
                        "confidence": row.get::<_, f64>(1)?,
                        "category": row.get::<_, String>(2)?,
                        "extracted_at": row.get::<_, String>(3)?,
                        "is_current": row.get::<_, bool>(4)?,
                    }))
                },
            )?;
            rows.filter_map(|r| r.ok()).collect()
        };

        return Ok(serde_json::to_string_pretty(&json!({
            "note_path": db_path,
            "total_facts": facts.len(),
            "filter": if before_date.is_some() { format!("before {}", before_date.unwrap()) } else { "all".to_string() },
            "facts": facts,
        }))?);
    }

    if let Some(query) = fact_query {
        // Full-text search across all facts
        let pattern = format!("%{}%", query);
        let mut stmt = conn.prepare(
            "SELECT f.note_path, f.fact_content, f.confidence, f.category, f.extraction_time, f.is_current,
                    COALESCE(fl.title, '')
             FROM fact_history f LEFT JOIN files fl ON fl.path = f.note_path
             WHERE f.fact_content LIKE ?1
             ORDER BY f.extraction_time DESC LIMIT ?2"
        )?;
        let facts: Vec<serde_json::Value> = stmt
            .query_map(rusqlite::params![pattern, limit as i64], |row| {
                Ok(json!({
                    "note_path": row.get::<_, String>(0)?,
                    "fact": row.get::<_, String>(1)?,
                    "confidence": row.get::<_, f64>(2)?,
                    "category": row.get::<_, String>(3)?,
                    "extracted_at": row.get::<_, String>(4)?,
                    "is_current": row.get::<_, bool>(5)?,
                    "note_title": row.get::<_, String>(6)?,
                }))
            })?
            .filter_map(|r| r.ok())
            .collect();

        return Ok(serde_json::to_string_pretty(&json!({
            "fact_query": query,
            "total_facts": facts.len(),
            "facts": facts,
        }))?);
    }

    // No filter — return all facts across vault
    let mut stmt = conn.prepare(
        "SELECT note_path, fact_content, confidence, category, extraction_time, is_current
         FROM fact_history
         WHERE is_current = 1
         ORDER BY extraction_time DESC LIMIT ?1"
    )?;
    let facts: Vec<serde_json::Value> = stmt
        .query_map(rusqlite::params![limit as i64], |row| {
            Ok(json!({
                "note_path": row.get::<_, String>(0)?,
                "fact": row.get::<_, String>(1)?,
                "confidence": row.get::<_, f64>(2)?,
                "category": row.get::<_, String>(3)?,
                "extracted_at": row.get::<_, String>(4)?,
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::to_string_pretty(&json!({
        "total_facts": facts.len(),
        "filter": "current_only",
        "facts": facts,
    }))?)
}

// ── execute_batch_link_notes ────────────────────────────────────────

pub(super) fn execute_batch_link_notes(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let links = args["links"].as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing 'links' array"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let mut added = 0;
    let mut skipped = 0;

    for link in links {
        let source = link["source_path"].as_str();
        let target = link["target_path"].as_str();
        let rel_type = link["relation_type"].as_str();
        let reason = link["reason"].as_str().unwrap_or("");

        if source.is_none() || target.is_none() || rel_type.is_none() {
            skipped += 1;
            continue;
        }

        let result = conn.execute(
            "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, reason)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![source.unwrap(), target.unwrap(), rel_type.unwrap(), reason],
        );
        match result {
            Ok(rows) => if rows > 0 { added += 1; } else { skipped += 1; },
            Err(_) => skipped += 1,
        }
    }

    Ok(serde_json::to_string_pretty(&json!({
        "links_processed": links.len(),
        "added": added,
        "skipped": skipped,
    }))?)
}

// ── propagate_fact_update ──────────────────────────────────────────

pub(super) async fn execute_propagate_fact_update(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    llm_config: &crate::llm::LlmConfig,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let fact_id = args["fact_id"].as_i64()
        .ok_or_else(|| anyhow::anyhow!("Missing 'fact_id' parameter"))?;
    let new_content = args["new_content"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'new_content' parameter"))?;

    // Scope for initial database operations
    let (old_note_path, old_fact_content, dependents, new_fact_id) = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

        // 1. Retrieve the old fact from fact_history
        let (old_note_path, old_fact_content): (String, String) = conn.query_row(
            "SELECT note_path, fact_content FROM fact_history WHERE id = ?1",
            rusqlite::params![fact_id],
            |row| Ok((row.get(0)?, row.get(1)?))
        ).map_err(|e| anyhow::anyhow!("Fact ID {} not found in fact_history: {}", fact_id, e))?;

        // 2. Insert the new fact and invalidate the old one
        let new_fact_id = crate::temporal::insert_fact(&conn, &old_note_path, new_content, "ai_propagation")?;
        crate::temporal::invalidate_fact(&conn, fact_id, new_fact_id)?;
        
        // Record update event on the source note
        crate::temporal::record_event(
            &conn,
            &old_note_path,
            "updated",
            Some(&format!("Fact ID {} updated. Propagating to dependents.", fact_id)),
            Some(fact_id),
            Some(new_fact_id)
        )?;

        // 3. Find dependents using note_relations (depends_on relation where target = old_note_path)
        let mut stmt = conn.prepare(
            "SELECT source_path, reason FROM note_relations WHERE target_path = ?1 AND relation_type = 'depends_on'"
        )?;
        let dependents: Vec<(String, Option<String>)> = stmt.query_map(rusqlite::params![old_note_path], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?.filter_map(|r| r.ok()).collect();

        (old_note_path, old_fact_content, dependents, new_fact_id)
    }; // conn and stmt are dropped here!

    let dependents_count = dependents.len();
    let mut applied_patches = Vec::new();

    // 4. For each dependent note, ask LLM to generate patches (search-replace)
    for (dep_path, rel_reason) in dependents {
        let canonical_dep = match super::helpers::resolve_path_multi_vault(&dep_path, vault_path, all_vault_paths) {
            Ok(p) => p,
            Err(_) => continue, // Skip if file not found
        };

        let dep_content = match std::fs::read_to_string(&canonical_dep) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Ask LLM to generate patches to align the dependent note with the new fact
        let prompt = format!(
            "An upstream note ({}) has updated a fact that this note ({}) depends on.\n\n\
             Upstream Relationship Reason: {}\n\n\
             Old Fact: {}\n\
             New Fact: {}\n\n\
             Current Downstream Note Content:\n{}\n\n\
             Generate a JSON array of search-replace patches to update the downstream note content to match/reflect the new fact. Make sure the replacements fit cleanly into the surrounding text.\n\
             Return ONLY a JSON array, no markdown fencing, no explanation. Each patch must have:\n\
             - 'search': precise text block to find in the note\n\
             - 'replace': text block to replace it with\n\
             - 'reason': brief explanation for the change\n\n\
             JSON only:",
            old_note_path,
            dep_path,
            rel_reason.as_deref().unwrap_or("No specific reason"),
            old_fact_content,
            new_content,
            dep_content
        );

        let messages = vec![
            crate::llm::ChatMessage {
                role: "system".to_string(),
                content: "You are a precise note propagation assistant. Return only a valid JSON array of search-replace patches.".to_string(),
                ..Default::default()
            },
            crate::llm::ChatMessage {
                role: "user".to_string(),
                content: prompt,
                ..Default::default()
            },
        ];

        let llm_res = match crate::llm::chat_completion(llm_config, &messages).await {
            Ok(res) => res,
            Err(_) => continue,
        };

        // Parse LLM JSON array response
        let json_val = parse_json_from_llm_response(&llm_res);
        if let Some(patches_arr) = json_val.as_array() {
            let mut current_content = dep_content.clone();
            let mut patches_applied_to_note = Vec::new();
            let mut failed = false;

            for p in patches_arr {
                let search_str = match p["search"].as_str() {
                    Some(s) => s,
                    None => { failed = true; break; }
                };
                let replace_str = match p["replace"].as_str() {
                    Some(r) => r,
                    None => { failed = true; break; }
                };
                let reason_str = p["reason"].as_str().unwrap_or("");

                // Apply patch (match first occurrence)
                if current_content.contains(search_str) {
                    current_content = current_content.replacen(search_str, replace_str, 1);
                    patches_applied_to_note.push(json!({
                        "search": search_str,
                        "replace": replace_str,
                        "reason": reason_str
                    }));
                } else {
                    failed = true;
                    break;
                }
            }

            if !failed && !patches_applied_to_note.is_empty() {
                // Write modified file content back
                if std::fs::write(&canonical_dep, &current_content).is_ok() {
                    // Lock database for writing changes
                    if let Ok(conn) = db.lock() {
                        // Update database metadata for this file (e.g. hash)
                        if let Ok(new_hash) = crate::db::sync::compute_file_hash(&canonical_dep) {
                            let _ = conn.execute(
                                "UPDATE files SET hash = ?1, last_synced = datetime('now') WHERE path = ?2",
                                rusqlite::params![new_hash, dep_path]
                            );
                        }
                        
                        // Log in reconciliation_log
                        let _ = conn.execute(
                            "INSERT INTO reconciliation_log (file_path, action, diff_summary) VALUES (?1, 'propagate_fact_update', ?2)",
                            rusqlite::params![dep_path, format!("Applied {} fact propagation patches", patches_applied_to_note.len())]
                        );
                    }

                    applied_patches.push(json!({
                        "file_path": dep_path,
                        "patches": patches_applied_to_note
                    }));
                }
            }
        }
    }

    Ok(json!({
        "success": true,
        "fact_id": fact_id,
        "new_fact_id": new_fact_id,
        "source_note": old_note_path,
        "dependents_found": dependents_count,
        "applied_propagation": applied_patches
    }).to_string())
}
