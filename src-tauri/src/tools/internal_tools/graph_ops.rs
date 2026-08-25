use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

use crate::db::search;
use crate::knowledge::{changeset, relations, write_guard};
use super::helpers;

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


/// 与侧边栏反链面板同一口径 / the exact query the sidebar backlink panel runs.
///
/// This used to be a line-for-line copy of the *pre-fix* sidebar implementation
/// and had inherited every one of its bugs:
///
/// * `note_relations` was read without `source_path != target_path`, so a note
///   could be listed as its own backlink.
/// * the wikilink half was `content LIKE '%[[title]]%'` — bare links only (no
///   `[[标题|别名]]`, no `[[标题#小节]]`) and title-only (no `[[文件名]]`).
/// * a silent `LIMIT 50` truncated the result with no indication.
///
/// Net effect: the user saw 5 backlinks in the sidebar while the agent's tool
/// reported 3, and the agent then reasoned about the graph from the短 list. A
/// disagreement between what the user sees and what the AI sees is worse than
/// either number being wrong, because neither side can tell.
///
/// `collect_backlinks` is `Connection`-typed precisely so this call site can
/// share it. De-dup, self-relation skipping and `[[…]]` resolution now have one
/// implementation; the `LIMIT` is gone rather than made quieter.
/// `pub(crate)` rather than `pub(super)` so the five-way backlink agreement test
/// in `db::wikilink` can call the tool through its real entry point (JSON in,
/// JSON out) instead of re-implementing what it does.
pub(crate) fn execute_get_backlinks(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let entries = crate::commands::file_commands::collect_backlinks(&conn, path)?;

    let backlinks: Vec<serde_json::Value> = entries
        .iter()
        .map(|b| {
            json!({
                "source": b.file_path,
                "title": b.title,
                // For a `note_relations` source this is the relation type; for a
                // wikilink source it is the line the link sits on. Same field the
                // sidebar renders, so the agent and the user read the same thing.
                "context": b.context,
            })
        })
        .collect();

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
        "SELECT note_type, tags, links, contradictions, ''
         FROM card_meta WHERE file_path = ?1",
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

/// 把工具参数里的路径变成 `note_relations` 用的那个拼法 / the key the relation table uses.
///
/// 关系表的两列被每个读图谱的地方当成 `files.path` 用。参数里给的通常是 vault 相对
/// 路径，直接写进去的后果不是报错，而是造一个幽灵节点：图谱、backlinks、related
/// notes、lint 的单向关系报告都会看到一个指向不存在文件的端点。
///
/// 解析不出来（不在任何 vault 里）就返回 `None`，调用方据此拒绝，而不是"先写下再说"。
fn relation_path_key(
    raw: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> Option<String> {
    let resolved = helpers::resolve_path_multi_vault(raw, vault_path, all_vault_paths).ok()?;
    Some(helpers::snapshot_path_key(&resolved))
}

pub(super) fn execute_add_relation(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let source = args["source_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'source_path'"))?;
    let target = args["target_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target_path'"))?;
    let relation_type = args["relation_type"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'relation_type'"))?;
    let reason = args["reason"].as_str().unwrap_or("Proposed by the agent");
    let confidence = args["confidence"]
        .as_f64()
        .unwrap_or(write_guard::DEFAULT_AGENT_RELATION_CONFIDENCE);

    let source_key = relation_path_key(source, vault_path, all_vault_paths)
        .ok_or_else(|| anyhow::anyhow!("`{source}` is not inside any open vault"))?;
    let target_key = relation_path_key(target, vault_path, all_vault_paths)
        .ok_or_else(|| anyhow::anyhow!("`{target}` is not inside any open vault"))?;

    let op = changeset::RelationOp {
        source_path: source_key.clone(),
        target_path: target_key.clone(),
        relation_type: relation_type.to_string(),
        confidence,
        reason: Some(reason.to_string()),
        origin: relations::ORIGIN_AGENT.to_string(),
        old_confidence: None,
        old_reason: None,
        expected_source_version: None,
        expected_target_version: None,
    };

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let outcome = relations::add_relation(&conn, &op, None, crate::llm::tool_hooks::current_run_id().as_deref())
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // `success` 说的是"图谱变了吗"，不是"调用没报错吗"。已存在和被用户拒过都不是成功——
    // 旧实现两种都回 true，于是"已建立 5 条关系"里可能一条都没新增。
    Ok(json!({
        "success": outcome.changed_graph(),
        "outcome": outcome.as_str(),
        "source_path": source_key,
        "target_path": target_key,
        "relation_type": relation_type,
        "confidence": confidence,
        "origin": relations::ORIGIN_AGENT,
        "message": match outcome {
            relations::RelationOutcome::Added => format!(
                "Relation '{relation_type}' added: {source_key} → {target_key} (confidence {confidence:.2}, unconfirmed)"
            ),
            relations::RelationOutcome::AlreadyExists =>
                "Nothing written: that relation already exists.".to_string(),
            relations::RelationOutcome::RejectedByUser =>
                "Nothing written: the user rejected this relation before.".to_string(),
            _ => "Nothing written.".to_string(),
        }
    }).to_string())
}

pub(super) fn execute_delete_relation(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let source = args["source_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'source_path'"))?;
    let target = args["target_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target_path'"))?;
    // 必填。缺了就拒绝，而不是删掉两篇笔记之间所有类型的边——那会连用户手连的
    // wikilink 一起删掉，而且不可撤销。
    let relation_type = args["relation_type"].as_str()
        .ok_or_else(|| anyhow::anyhow!(
            "Missing 'relation_type'. Deleting every relation between two notes is not allowed; \
             name the one to remove."
        ))?;

    let source_key = relation_path_key(source, vault_path, all_vault_paths)
        .ok_or_else(|| anyhow::anyhow!("`{source}` is not inside any open vault"))?;
    let target_key = relation_path_key(target, vault_path, all_vault_paths)
        .ok_or_else(|| anyhow::anyhow!("`{target}` is not inside any open vault"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let outcome = relations::delete_relation(&conn, &source_key, &target_key, relation_type)
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    Ok(json!({
        "success": outcome.changed_graph(),
        "outcome": outcome.as_str(),
        "deleted": if outcome.changed_graph() { 1 } else { 0 },
        "message": match outcome {
            relations::RelationOutcome::Deleted => format!(
                "Deleted the '{relation_type}' relation {source_key} → {target_key}"
            ),
            _ => format!(
                "Nothing deleted: there is no '{relation_type}' relation from {source_key} to {target_key}"
            ),
        }
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
            "SELECT tags FROM card_meta WHERE file_path = ?1",
            rusqlite::params![note_a],
            |row| row.get(0),
        ).ok();
        let tags_b: Option<String> = conn.query_row(
            "SELECT tags FROM card_meta WHERE file_path = ?1",
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
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let links = args["links"].as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing 'links' array"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let run_id = crate::llm::tool_hooks::current_run_id();
    let mut added = 0usize;
    let mut already = 0usize;
    let mut rejected = 0usize;
    let mut unresolved = 0usize;
    let mut details = Vec::with_capacity(links.len());

    // 整批一个事务。旧实现在循环里逐条 `INSERT OR IGNORE`，一条失败就只是 `skipped += 1`，
    // 于是"部分写入"成了正常结果，而且没有任何地方记着写到了第几条。
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let outcome = (|| -> anyhow::Result<()> {
        for link in links {
            let source = link["source_path"].as_str().unwrap_or_default();
            let target = link["target_path"].as_str().unwrap_or_default();
            let rel_type = link["relation_type"].as_str().unwrap_or_default();
            let reason = link["reason"].as_str().unwrap_or("Proposed by the agent");
            let confidence = link["confidence"]
                .as_f64()
                .unwrap_or(write_guard::DEFAULT_AGENT_RELATION_CONFIDENCE);

            if source.is_empty() || target.is_empty() || rel_type.trim().is_empty() {
                unresolved += 1;
                details.push(json!({
                    "source": source, "target": target, "relationType": rel_type,
                    "outcome": "unresolved",
                    "message": "Skipped: source_path, target_path and relation_type are all required"
                }));
                continue;
            }

            let (Some(source_key), Some(target_key)) = (
                relation_path_key(source, vault_path, all_vault_paths),
                relation_path_key(target, vault_path, all_vault_paths),
            ) else {
                unresolved += 1;
                details.push(json!({
                    "source": source, "target": target, "relationType": rel_type,
                    "outcome": "unresolved",
                    "message": "Skipped: one end is not inside any open vault"
                }));
                continue;
            };

            let op = changeset::RelationOp {
                source_path: source_key.clone(),
                target_path: target_key.clone(),
                relation_type: rel_type.to_string(),
                confidence,
                reason: Some(reason.to_string()),
                origin: relations::ORIGIN_AGENT.to_string(),
                old_confidence: None,
                old_reason: None,
                expected_source_version: None,
                expected_target_version: None,
            };
            let result = relations::add_relation(&conn, &op, None, run_id.as_deref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            match result {
                relations::RelationOutcome::Added => added += 1,
                relations::RelationOutcome::AlreadyExists => already += 1,
                relations::RelationOutcome::RejectedByUser => rejected += 1,
                _ => unresolved += 1,
            }
            details.push(json!({
                "source": source_key, "target": target_key, "relationType": rel_type,
                "outcome": result.as_str(),
                "confidence": confidence,
            }));
        }
        Ok(())
    })();

    if let Err(e) = outcome {
        let _ = conn.execute_batch("ROLLBACK;");
        return Ok(serde_json::to_string_pretty(&json!({
            "success": false,
            "links_processed": links.len(),
            "added": 0,
            "message": format!("Nothing was written — the batch was rolled back: {e}"),
        }))?);
    }
    conn.execute_batch("COMMIT;")?;

    Ok(serde_json::to_string_pretty(&json!({
        // 只有真的新增了边才算成功。这是 Auto-Fix 判定"修复完成"的唯一依据。
        "success": added > 0,
        "links_processed": links.len(),
        "added": added,
        "already_existed": already,
        "rejected_by_user": rejected,
        "unresolved": unresolved,
        "origin": relations::ORIGIN_AGENT,
        "confirmed": false,
        "details": details,
        "message": format!(
            "{added} added, {already} already existed, {rejected} previously rejected by the user, {unresolved} unresolved. \
             New relations are marked as agent-proposed and unconfirmed."
        ),
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
    // 每篇下游笔记一条结果。计数只在真的发生了对应的事之后才加，返回值里的
    // applied / conflicted / skipped 因此是磁盘上的事实，而不是"我们试过几篇"。
    let mut details: Vec<serde_json::Value> = Vec::new();
    let (mut applied, mut conflicted, mut skipped) = (0usize, 0usize, 0usize);

    let ctx = write_guard::WriteContext {
        actor: "agent".to_string(),
        session_id: None,
        run_id: crate::llm::tool_hooks::current_run_id(),
        primary_vault: vault_path.to_string(),
        vaults: if all_vault_paths.is_empty() {
            vec![vault_path.to_string()]
        } else {
            all_vault_paths.to_vec()
        },
    };

    // 4. For each dependent note, ask LLM to generate patches (search-replace)
    for (dep_path, rel_reason) in dependents {
        let canonical_dep = match helpers::resolve_path_multi_vault(&dep_path, vault_path, all_vault_paths) {
            Ok(p) => p,
            Err(_) => {
                skipped += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": "该下游笔记不在任何库里，没有任何改动",
                }));
                continue;
            }
        };

        let dep_content = match std::fs::read_to_string(&canonical_dep) {
            Ok(c) => c,
            Err(e) => {
                skipped += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": format!("读不到这篇笔记，没有任何改动：{e}"),
                }));
                continue;
            }
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
            Err(e) => {
                skipped += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": format!("模型没能给出补丁，这篇保持原样：{e}"),
                }));
                continue;
            }
        };

        // Parse LLM JSON array response
        let json_val = parse_json_from_llm_response(&llm_res);
        let Some(patches_arr) = json_val.as_array() else {
            skipped += 1;
            details.push(json!({
                "path": dep_path,
                "outcome": "skipped",
                "message": "模型返回的不是补丁数组，这篇保持原样",
            }));
            continue;
        };
        if patches_arr.is_empty() {
            skipped += 1;
            details.push(json!({
                "path": dep_path,
                "outcome": "skipped",
                "message": "模型认为这篇不需要跟着改",
            }));
            continue;
        }

        // 逐条精确匹配。匹配不上、或者同一段文字出现多次，都算这篇笔记冲突：
        // 前者说明模型记的原文和磁盘上的不是一份，后者说明"改哪一处"没有唯一答案。
        // 两种情况下都一个字都不写——猜一处改掉，用户下次打开笔记才会发现，那比报错难查得多。
        let mut next_content = dep_content.clone();
        let mut patch_log: Vec<serde_json::Value> = Vec::new();
        let mut conflict: Option<String> = None;
        for p in patches_arr {
            let (Some(search_str), Some(replace_str)) = (p["search"].as_str(), p["replace"].as_str())
            else {
                conflict = Some("模型给的补丁缺少 search 或 replace 字段".to_string());
                break;
            };
            if search_str.is_empty() {
                conflict = Some("模型给的 search 是空串，无法定位改哪里".to_string());
                break;
            }
            let hits = next_content.matches(search_str).count();
            if hits == 0 {
                conflict = Some(format!(
                    "笔记里找不到这段原文，可能已被你改过：{}",
                    truncate_for_message(search_str)
                ));
                break;
            }
            if hits > 1 {
                conflict = Some(format!(
                    "这段原文在笔记里出现了 {hits} 次，无法确定该改哪一处：{}",
                    truncate_for_message(search_str)
                ));
                break;
            }
            next_content = next_content.replacen(search_str, replace_str, 1);
            patch_log.push(json!({
                "search": search_str,
                "replace": replace_str,
                "reason": p["reason"].as_str().unwrap_or(""),
            }));
        }
        if let Some(reason) = conflict {
            conflicted += 1;
            details.push(json!({
                "path": dep_path,
                "outcome": "conflict",
                "message": format!("{reason}。这篇笔记没有被改动。"),
            }));
            continue;
        }
        if next_content == dep_content {
            skipped += 1;
            details.push(json!({
                "path": dep_path,
                "outcome": "skipped",
                "message": "补丁应用后内容没有变化",
            }));
            continue;
        }

        // 先把这一篇登记成一个可审查、可回滚的 op，再写盘。守卫会用 Agent 这一轮读到的
        // 版本做基线，所以"生成补丁期间这篇笔记被别人改过"在这里就会变成冲突。
        let staged = {
            let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
            write_guard::open_intents(
                &conn,
                &ctx,
                "propagate_fact_update",
                &[write_guard::rewrite_intent(
                    dep_path.clone(),
                    next_content.clone(),
                )],
            )
        };
        let ready = match staged {
            Ok(write_guard::Guarded::Ready(ready)) => ready,
            Ok(write_guard::Guarded::Conflicted { report, .. }) => {
                conflicted += 1;
                let detail = report
                    .ops
                    .iter()
                    .filter_map(|op| op.conflict_message.clone())
                    .collect::<Vec<_>>()
                    .join("；");
                details.push(json!({
                    "path": dep_path,
                    "outcome": "conflict",
                    "message": format!("{detail}。这篇笔记没有被改动。"),
                }));
                continue;
            }
            Ok(write_guard::Guarded::Refused { refusal, .. }) => {
                skipped += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": format!("{}。这篇笔记没有被改动。", refusal.message()),
                }));
                continue;
            }
            Ok(write_guard::Guarded::Unguarded) => {
                skipped += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": "写入审查没有接管这次改动，为安全起见没有写入",
                }));
                continue;
            }
            Err(e) => {
                skipped += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": format!("无法登记这次改动，没有写入：{e}"),
                }));
                continue;
            }
        };

        // 生成补丁要等模型，这中间磁盘上的那份可能已经变了。落盘前再读一次比对，
        // 不一致就当冲突处理——基线检查管的是索引里的版本，这一步管的是文件本身。
        let disk_now = std::fs::read_to_string(&canonical_dep).unwrap_or_default();
        if disk_now != dep_content {
            conflicted += 1;
            if let Ok(conn) = db.lock() {
                let _ = write_guard::settle(&conn, &ready, Err("下游笔记在生成补丁期间被改过"));
            }
            details.push(json!({
                "path": dep_path,
                "outcome": "conflict",
                "message": "这篇笔记在生成补丁期间被改过，没有覆盖你的改动",
            }));
            continue;
        }

        // Preserve the downstream note's pre-image before this batch rewrite so
        // the user can undo an unwanted propagation. Fail-closed: skip the write
        // for this note if the restore point cannot be recorded.
        let dep_snapshot_id = match helpers::snapshot_before_write(db, &canonical_dep) {
            Ok(id) => id,
            Err(e) => {
                skipped += 1;
                if let Ok(conn) = db.lock() {
                    let _ = write_guard::settle(&conn, &ready, Err("无法记录还原点"));
                }
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": format!("无法记录还原点，没有写入：{e}"),
                }));
                continue;
            }
        };

        match crate::file_lock::safe_write(&canonical_dep, &next_content) {
            Ok(_) => {
                // One journal row per downstream note, so undoing the turn walks
                // every propagated edit back.
                helpers::journal_write(
                    db,
                    "propagate_fact_update",
                    "write",
                    &helpers::snapshot_path_key(&canonical_dep),
                    None,
                    dep_snapshot_id,
                    None,
                );
                if let Ok(conn) = db.lock() {
                    let _ = write_guard::settle(&conn, &ready, Ok(()));
                    if let Ok(new_hash) = crate::db::sync::compute_file_hash(&canonical_dep) {
                        let _ = conn.execute(
                            "UPDATE files SET hash = ?1, last_synced = datetime('now') WHERE path = ?2",
                            rusqlite::params![new_hash, dep_path],
                        );
                    }
                    let _ = conn.execute(
                        "INSERT INTO reconciliation_log (file_path, action, diff_summary) VALUES (?1, 'propagate_fact_update', ?2)",
                        rusqlite::params![dep_path, format!("Applied {} fact propagation patches", patch_log.len())],
                    );
                }
                applied += 1;
                details.push(json!({
                    "path": dep_path,
                    "outcome": "applied",
                    "changesetId": ready.changeset_id,
                    "patches": patch_log,
                    "message": format!("{} 处改动已写入，可从变更审查里撤销", patch_log.len()),
                }));
            }
            Err(e) => {
                skipped += 1;
                let msg = e.to_string();
                if let Ok(conn) = db.lock() {
                    let _ = write_guard::settle(&conn, &ready, Err(&msg));
                }
                details.push(json!({
                    "path": dep_path,
                    "outcome": "skipped",
                    "message": format!("写盘失败，这篇保持原样：{msg}"),
                }));
            }
        }
    }

    // §32 的状态词表。`success` 由真实计数推出来：有笔记停在冲突上、或者一篇都没落地，
    // 就不是成功——旧版本无条件返回 `success: true`，等于告诉用户"传播完成了"，
    // 而下游笔记可能一个字都没改。
    let state = if conflicted == 0 && skipped == 0 {
        "completed"
    } else if applied > 0 {
        "partial_success"
    } else if conflicted > 0 {
        "conflict"
    } else {
        "failed"
    };

    Ok(serde_json::to_string_pretty(&json!({
        "success": state == "completed" || state == "partial_success",
        "state": state,
        "fact_id": fact_id,
        "new_fact_id": new_fact_id,
        "source_note": old_note_path,
        "dependents_found": dependents_count,
        "applied": applied,
        "conflicted": conflicted,
        "skipped": skipped,
        "details": details,
        "message": format!(
            "Fact updated. {applied} downstream notes rewritten, {conflicted} left untouched because of a conflict, \
             {skipped} skipped. Conflicted notes were never overwritten; every rewrite is reviewable and undoable."
        ),
    }))?)
}

/// 把一段原文截短到能放进错误消息里 / shorten a snippet for a user-facing message.
///
/// 冲突消息要让用户能认出是哪一段，但整段原文可能有几百字。按字符边界截断，
/// 不按字节——否则中文会被切成半个字符，`String::from_utf8` 直接 panic。
fn truncate_for_message(text: &str) -> String {
    let flat = text.replace(['\n', '\r'], " ");
    let mut out: String = flat.chars().take(60).collect();
    if flat.chars().count() > 60 {
        out.push('…');
    }
    out
}


// ── GraphRAG Community Operations ────────────────────────────────────────

pub(super) fn execute_generate_community_summaries(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or(json!({}));
    let min_community_size = args["min_community_size"].as_u64().unwrap_or(2) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    // 1. Load all nodes
    let mut stmt = conn.prepare("SELECT path, COALESCE(title, path) FROM files")?;
    let nodes: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    if nodes.is_empty() {
        return Ok(json!({
            "success": true,
            "communities_created": 0,
            "message": "Vault is empty, no communities generated."
        }).to_string());
    }

    let node_map: std::collections::HashMap<String, String> = nodes.iter().cloned().collect();

    // 2. Load edges from note_relations and card_meta.links
    let mut adj: std::collections::HashMap<String, std::collections::HashSet<String>> = std::collections::HashMap::new();
    for (p, _) in &nodes {
        adj.entry(p.clone()).or_default();
    }

    let mut rel_stmt = conn.prepare("SELECT source_path, target_path FROM note_relations")?;
    let rel_rows = rel_stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for r in rel_rows.flatten() {
        adj.entry(r.0.clone()).or_default().insert(r.1.clone());
        adj.entry(r.1).or_default().insert(r.0);
    }

    let mut meta_stmt = conn.prepare("SELECT file_path, links FROM card_meta WHERE links IS NOT NULL")?;
    let meta_rows = meta_stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for (file_path, links_str) in meta_rows.flatten() {
        if let Ok(links) = serde_json::from_str::<Vec<String>>(&links_str) {
            for target in links {
                adj.entry(file_path.clone()).or_default().insert(target.clone());
                adj.entry(target).or_default().insert(file_path.clone());
            }
        }
    }

    // 3. Community detection: Connected components with modularity grouping
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut raw_communities: Vec<Vec<String>> = Vec::new();

    for (node, _) in &nodes {
        if visited.contains(node) {
            continue;
        }
        let mut comp = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(node.clone());
        visited.insert(node.clone());

        while let Some(curr) = queue.pop_front() {
            comp.push(curr.clone());
            if let Some(neighbors) = adj.get(&curr) {
                for nbr in neighbors {
                    if !visited.contains(nbr) && node_map.contains_key(nbr) {
                        visited.insert(nbr.clone());
                        queue.push_back(nbr.clone());
                    }
                }
            }
        }
        if comp.len() >= min_community_size {
            raw_communities.push(comp);
        }
    }

    // 4. Compute PageRank per community and generate summary records
    //
    // `DELETE` 之后紧跟一串 `INSERT`，中间任何一条失败都会留下一张被清空或只写了一半
    // 的社区表——而这张表是图谱聚类视图和 GraphRAG 检索的输入。整段包进一个事务：要么
    // 全换成新的一批，要么原来那批完全不动。
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let mut generated = Vec::new();
    let rebuild = (|| -> anyhow::Result<()> {
        conn.execute("DELETE FROM graph_communities", [])?;
        for (cid, members) in raw_communities.iter().enumerate() {
        // Collect tags and titles for keyword extraction
        let mut titles: Vec<String> = Vec::new();
        let mut all_tags: Vec<String> = Vec::new();
        let mut snippets: Vec<String> = Vec::new();

        for m in members {
            if let Some(t) = node_map.get(m) {
                titles.push(t.clone());
            }
            let tags_opt: Option<String> = conn.query_row(
                "SELECT tags FROM card_meta WHERE file_path = ?1",
                rusqlite::params![m],
                |row| row.get(0),
            ).ok();
            if let Some(t_str) = tags_opt {
                if let Ok(tag_list) = serde_json::from_str::<Vec<String>>(&t_str) {
                    all_tags.extend(tag_list);
                }
            }
            let chunk_snippet: Option<String> = conn.query_row(
                "SELECT content FROM chunks WHERE file_path = ?1 LIMIT 1",
                rusqlite::params![m],
                |row| row.get(0),
            ).ok();
            if let Some(snip) = chunk_snippet {
                let trimmed: String = snip.chars().take(150).collect();
                snippets.push(format!("{}: {}", node_map.get(m).unwrap_or(m), trimmed));
            }
        }

        let main_title = titles.first().cloned().unwrap_or_else(|| format!("Community {}", cid + 1));
        let title = format!("知识社区 {}: {}", cid + 1, main_title);
        let summary = format!(
            "本社区包含 {} 篇关联笔记：{}。\n核心主题概览：{}",
            members.len(),
            titles.join(", "),
            if snippets.is_empty() { "暂无详细片段".to_string() } else { snippets.join("；") }
        );

        let keywords_json = serde_json::to_string(&all_tags).unwrap_or_else(|_| "[]".to_string());
        let members_json = serde_json::to_string(members).unwrap_or_else(|_| "[]".to_string());

        conn.execute(
            "INSERT INTO graph_communities (community_id, title, summary, keywords, node_count, member_paths, level)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![cid as i64, title, summary, keywords_json, members.len() as i64, members_json, 0],
        )?;

        generated.push(json!({
            "community_id": cid,
            "title": title,
            "node_count": members.len(),
            "members": members
        }));
    }
        Ok(())
    })();

    match rebuild {
        Ok(()) => conn.execute_batch("COMMIT;")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            return Ok(json!({
                "success": false,
                "communities_count": 0,
                "message": format!("社区摘要未更新，原有结果保持不变：{e}")
            }).to_string());
        }
    }

    Ok(json!({
        "success": true,
        "communities_count": generated.len(),
        "communities": generated
    }).to_string())
}

pub(super) fn execute_query_graph_communities(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let query = args["query"].as_str().unwrap_or("");
    let limit = args["limit"].as_u64().unwrap_or(5) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let pattern = format!("%{}%", query);
    let mut stmt = if query.is_empty() {
        conn.prepare(
            "SELECT community_id, title, summary, keywords, node_count, member_paths, updated_at
             FROM graph_communities
             ORDER BY node_count DESC
             LIMIT ?1",
        )?
    } else {
        conn.prepare(
            "SELECT community_id, title, summary, keywords, node_count, member_paths, updated_at
             FROM graph_communities
             WHERE title LIKE ?1 OR summary LIKE ?1 OR keywords LIKE ?1
             ORDER BY node_count DESC
             LIMIT ?2",
        )?
    };

    let rows: Vec<serde_json::Value> = if query.is_empty() {
        stmt.query_map(rusqlite::params![limit as i64], |row| {
            let cid: i64 = row.get(0)?;
            let title: String = row.get(1)?;
            let summary: String = row.get(2)?;
            let kw: String = row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "[]".to_string());
            let count: i64 = row.get(4)?;
            let members_raw: String = row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".to_string());
            let updated_at: String = row.get(6)?;

            Ok(json!({
                "community_id": cid,
                "title": title,
                "summary": summary,
                "keywords": serde_json::from_str::<serde_json::Value>(&kw).unwrap_or(json!([])),
                "node_count": count,
                "member_paths": serde_json::from_str::<serde_json::Value>(&members_raw).unwrap_or(json!([])),
                "updated_at": updated_at
            }))
        })?
        .filter_map(|r| r.ok())
        .collect()
    } else {
        stmt.query_map(rusqlite::params![pattern, limit as i64], |row| {
            let cid: i64 = row.get(0)?;
            let title: String = row.get(1)?;
            let summary: String = row.get(2)?;
            let kw: String = row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "[]".to_string());
            let count: i64 = row.get(4)?;
            let members_raw: String = row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".to_string());
            let updated_at: String = row.get(6)?;

            Ok(json!({
                "community_id": cid,
                "title": title,
                "summary": summary,
                "keywords": serde_json::from_str::<serde_json::Value>(&kw).unwrap_or(json!([])),
                "node_count": count,
                "member_paths": serde_json::from_str::<serde_json::Value>(&members_raw).unwrap_or(json!([])),
                "updated_at": updated_at
            }))
        })?
        .filter_map(|r| r.ok())
        .collect()
    };

    Ok(json!({
        "query": query,
        "total_communities_found": rows.len(),
        "communities": rows
    }).to_string())
}
