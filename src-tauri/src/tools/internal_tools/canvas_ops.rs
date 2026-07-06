use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

// Canvas operations: read_canvas, modify_canvas, CanvasOperation

use super::helpers::is_path_in_any_vault;

pub(super) fn resolve_canvas_path(canvas_path: &str, vault_path: &str, all_vault_paths: &[String]) -> anyhow::Result<std::path::PathBuf> {
    // Try multi-vault resolution first for canvas paths
    let full_path = if std::path::Path::new(canvas_path).is_absolute() {
        std::path::PathBuf::from(canvas_path)
    } else {
        // Try each vault for relative canvas paths
        let mut found = None;
        for vp in all_vault_paths {
            let candidate = std::path::PathBuf::from(vp).join(canvas_path);
            if candidate.exists() {
                found = Some(candidate);
                break;
            }
        }
        found.unwrap_or_else(|| std::path::PathBuf::from(vault_path).join(canvas_path))
    };

    // Canonicalize parent directory and append filename to guarantee absolute canonical structure
    let parent = full_path.parent()
        .ok_or_else(|| anyhow::anyhow!("Invalid canvas path"))?;
    let parent_canonical = parent.canonicalize()
        .map_err(|e| anyhow::anyhow!("Failed to canonicalize parent path {:?}: {}", parent, e))?;
    let filename = full_path.file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid canvas filename"))?;
    let canonical = parent_canonical.join(filename);

    if !is_path_in_any_vault(&canonical, vault_path, all_vault_paths) {
        anyhow::bail!("Access denied: canvas path is outside all vaults ({:?})", canonical);
    }
    Ok(canonical)
}

pub(super) fn execute_read_canvas(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let canvas_path = args["canvas_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'canvas_path' parameter"))?;

    let canonical = resolve_canvas_path(canvas_path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        return Ok(format!("Canvas file does not exist at {:?}", canonical));
    }

    let content = std::fs::read_to_string(&canonical)?;
    let canvas: crate::canvas::Canvas = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("Failed to parse canvas JSON: {}", e))?;

    let mut summary = String::new();
    summary.push_str(&format!("Canvas File: {}\n", canvas_path));
    summary.push_str(&format!("Total Nodes: {}\n", canvas.nodes.len()));
    summary.push_str(&format!("Total Connections: {}\n\n", canvas.edges.len()));

    summary.push_str("Nodes:\n");
    for node in &canvas.nodes {
        match node {
            crate::canvas::Node::File { id, x, y, width, height, file, color, .. } => {
                summary.push_str(&format!("- Note Card (File):\n  ID: {}\n  File: {}\n  Position: ({}, {})\n  Size: {}x{}\n", id, file, x, y, width, height));
                if let Some(c) = color {
                    summary.push_str(&format!("  Color: {}\n", c));
                }
            }
            crate::canvas::Node::Text { id, x, y, width, height, text, color } => {
                summary.push_str(&format!("- Sticky Text Note:\n  ID: {}\n  Text: {}\n  Position: ({}, {})\n  Size: {}x{}\n", id, text, x, y, width, height));
                if let Some(c) = color {
                    summary.push_str(&format!("  Color: {}\n", c));
                }
            }
            crate::canvas::Node::Link { id, x, y, width, height, url, color } => {
                summary.push_str(&format!("- Web Link:\n  ID: {}\n  URL: {}\n  Position: ({}, {})\n  Size: {}x{}\n", id, url, x, y, width, height));
                if let Some(c) = color {
                    summary.push_str(&format!("  Color: {}\n", c));
                }
            }
            crate::canvas::Node::Group { id, x, y, width, height, label, color, .. } => {
                summary.push_str(&format!("- Group Frame:\n  ID: {}\n  Label: {}\n  Position: ({}, {})\n  Size: {}x{}\n", id, label.as_deref().unwrap_or(""), x, y, width, height));
                if let Some(c) = color {
                    summary.push_str(&format!("  Color: {}\n", c));
                }
            }
        }
    }

    summary.push_str("\nConnections (Edges):\n");
    for edge in &canvas.edges {
        summary.push_str(&format!("- Connection (ID: {}):\n  From: {} ({})\n  To: {} ({})\n", edge.id, edge.from_node, edge.from_side.as_deref().unwrap_or("right"), edge.to_node, edge.to_side.as_deref().unwrap_or("left")));
        if let Some(lbl) = &edge.label {
            summary.push_str(&format!("  Label: {}\n", lbl));
        }
        if let Some(col) = &edge.color {
            summary.push_str(&format!("  Color: {}\n", col));
        }
    }

    Ok(summary)
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "op")]
pub(crate) enum CanvasOperation {
    #[serde(rename = "add_node")]
    AddNode {
        #[serde(rename = "type")]
        node_type: String, // "file" | "text" | "group"
        id: Option<String>,
        x: i32,
        y: i32,
        width: Option<i32>,
        height: Option<i32>,
        file: Option<String>,
        text: Option<String>,
        label: Option<String>,
        color: Option<String>,
    },
    #[serde(rename = "remove_node")]
    RemoveNode {
        id: String,
    },
    #[serde(rename = "update_node")]
    UpdateNode {
        id: String,
        x: Option<i32>,
        y: Option<i32>,
        width: Option<i32>,
        height: Option<i32>,
        text: Option<String>,
        label: Option<String>,
        color: Option<String>,
    },
    #[serde(rename = "add_edge")]
    AddEdge {
        id: Option<String>,
        from: String,
        to: String,
        #[serde(rename = "fromSide")]
        from_side: Option<String>,
        #[serde(rename = "toSide")]
        to_side: Option<String>,
        label: Option<String>,
        color: Option<String>,
    },
    #[serde(rename = "remove_edge")]
    RemoveEdge {
        id: String,
    },
}

pub(super) fn execute_modify_canvas(
    arguments: &str,
    vault_path: &str,
    db: &Arc<Mutex<Connection>>,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let canvas_path = args["canvas_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'canvas_path' parameter"))?;
    let operations_val = args["operations"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'operations' parameter"))?;

    let mut operations = Vec::new();
    for op_val in operations_val {
        let op: CanvasOperation = serde_json::from_value(op_val.clone())
            .map_err(|e| anyhow::anyhow!("Failed to parse operation: {}", e))?;
        operations.push(op);
    }

    let canonical = resolve_canvas_path(canvas_path, vault_path, all_vault_paths)?;

    // Read existing canvas or initialize a new blank one
    let mut canvas = if canonical.exists() {
        let content = std::fs::read_to_string(&canonical)?;
        serde_json::from_str::<crate::canvas::Canvas>(&content)
            .unwrap_or_else(|_| crate::canvas::Canvas { nodes: Vec::new(), edges: Vec::new() })
    } else {
        crate::canvas::Canvas { nodes: Vec::new(), edges: Vec::new() }
    };

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let mut ops_applied = 0;

    for op in operations {
        match op {
            CanvasOperation::AddNode { node_type, id, x, y, width, height, file, text, label, color } => {
                let node_id = id.unwrap_or_else(|| {
                    let ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    format!("node-{}", ms)
                });

                let new_node = match node_type.as_str() {
                    "file" => {
                        let file_path = file.ok_or_else(|| anyhow::anyhow!("Missing 'file' parameter for file node"))?;
                        crate::canvas::Node::File {
                            id: node_id,
                            x,
                            y,
                            width: width.unwrap_or(400),
                            height: height.unwrap_or(300),
                            file: file_path,
                            subpath: None,
                            color,
                        }
                    }
                    "text" => {
                        crate::canvas::Node::Text {
                            id: node_id,
                            x,
                            y,
                            width: width.unwrap_or(250),
                            height: height.unwrap_or(250),
                            text: text.unwrap_or_default(),
                            color,
                        }
                    }
                    "group" => {
                        crate::canvas::Node::Group {
                            id: node_id,
                            x,
                            y,
                            width: width.unwrap_or(600),
                            height: height.unwrap_or(400),
                            label,
                            background: None,
                            background_style: None,
                            color,
                        }
                    }
                    _ => anyhow::bail!("Invalid node type: {}", node_type),
                };

                canvas.nodes.push(new_node);
                ops_applied += 1;
            }
            CanvasOperation::RemoveNode { id } => {
                let initial_len = canvas.nodes.len();
                canvas.nodes.retain(|n| {
                    let nid = match n {
                        crate::canvas::Node::File { id: nid, .. } => nid,
                        crate::canvas::Node::Text { id: nid, .. } => nid,
                        crate::canvas::Node::Link { id: nid, .. } => nid,
                        crate::canvas::Node::Group { id: nid, .. } => nid,
                    };
                    nid != &id
                });

                if canvas.nodes.len() < initial_len {
                    // Remove any associated edges
                    let mut edges_to_remove = Vec::new();
                    canvas.edges.retain(|e| {
                        let matches = e.from_node == id || e.to_node == id;
                        if matches {
                            edges_to_remove.push((e.from_node.clone(), e.to_node.clone()));
                        }
                        !matches
                    });

                    // Remove note relations from SQLite if applicable
                    for (from_node_id, to_node_id) in edges_to_remove {
                        let source_file = canvas.nodes.iter().find_map(|n| {
                            if let crate::canvas::Node::File { id: nid, file, .. } = n {
                                if nid == &from_node_id { Some(file.clone()) } else { None }
                            } else {
                                None
                            }
                        });
                        let target_file = canvas.nodes.iter().find_map(|n| {
                            if let crate::canvas::Node::File { id: nid, file, .. } = n {
                                if nid == &to_node_id { Some(file.clone()) } else { None }
                            } else {
                                None
                            }
                        });

                        if let (Some(s_path), Some(t_path)) = (source_file, target_file) {
                            conn.execute(
                                "DELETE FROM note_relations WHERE source_path = ?1 AND target_path = ?2",
                                rusqlite::params![s_path, t_path],
                            )?;
                        }
                    }
                    ops_applied += 1;
                }
            }
            CanvasOperation::UpdateNode { id, x, y, width, height, text, label, color } => {
                if let Some(node) = canvas.nodes.iter_mut().find(|n| {
                    let nid = match n {
                        crate::canvas::Node::File { id: nid, .. } => nid,
                        crate::canvas::Node::Text { id: nid, .. } => nid,
                        crate::canvas::Node::Link { id: nid, .. } => nid,
                        crate::canvas::Node::Group { id: nid, .. } => nid,
                    };
                    nid == &id
                }) {
                    match node {
                        crate::canvas::Node::File { x: nx, y: ny, width: nw, height: nh, color: nc, .. } => {
                            if let Some(val) = x { *nx = val; }
                            if let Some(val) = y { *ny = val; }
                            if let Some(val) = width { *nw = val; }
                            if let Some(val) = height { *nh = val; }
                            if color.is_some() { *nc = color; }
                        }
                        crate::canvas::Node::Text { x: nx, y: ny, width: nw, height: nh, text: nt, color: nc, .. } => {
                            if let Some(val) = x { *nx = val; }
                            if let Some(val) = y { *ny = val; }
                            if let Some(val) = width { *nw = val; }
                            if let Some(val) = height { *nh = val; }
                            if let Some(val) = text { *nt = val; }
                            if color.is_some() { *nc = color; }
                        }
                        crate::canvas::Node::Link { x: nx, y: ny, width: nw, height: nh, color: nc, .. } => {
                            if let Some(val) = x { *nx = val; }
                            if let Some(val) = y { *ny = val; }
                            if let Some(val) = width { *nw = val; }
                            if let Some(val) = height { *nh = val; }
                            if color.is_some() { *nc = color; }
                        }
                        crate::canvas::Node::Group { x: nx, y: ny, width: nw, height: nh, label: nl, color: nc, .. } => {
                            if let Some(val) = x { *nx = val; }
                            if let Some(val) = y { *ny = val; }
                            if let Some(val) = width { *nw = val; }
                            if let Some(val) = height { *nh = val; }
                            if label.is_some() { *nl = label; }
                            if color.is_some() { *nc = color; }
                        }
                    }
                    ops_applied += 1;
                }
            }
            CanvasOperation::AddEdge { id, from, to, from_side, to_side, label, color } => {
                let from_exists = canvas.nodes.iter().any(|n| {
                    let nid = match n {
                        crate::canvas::Node::File { id: nid, .. } => nid,
                        crate::canvas::Node::Text { id: nid, .. } => nid,
                        crate::canvas::Node::Link { id: nid, .. } => nid,
                        crate::canvas::Node::Group { id: nid, .. } => nid,
                    };
                    nid == &from
                });
                let to_exists = canvas.nodes.iter().any(|n| {
                    let nid = match n {
                        crate::canvas::Node::File { id: nid, .. } => nid,
                        crate::canvas::Node::Text { id: nid, .. } => nid,
                        crate::canvas::Node::Link { id: nid, .. } => nid,
                        crate::canvas::Node::Group { id: nid, .. } => nid,
                    };
                    nid == &to
                });

                if !from_exists || !to_exists {
                    anyhow::bail!("Cannot add edge: source ({}) or target ({}) node does not exist", from, to);
                }

                let edge_id = id.unwrap_or_else(|| {
                    let ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    format!("edge-{}", ms)
                });

                let edge = crate::canvas::Edge {
                    id: edge_id,
                    from_node: from.clone(),
                    from_side: Some(from_side.unwrap_or_else(|| "right".to_string())),
                    from_end: None,
                    to_node: to.clone(),
                    to_side: Some(to_side.unwrap_or_else(|| "left".to_string())),
                    to_end: Some("arrow".to_string()),
                    color,
                    label: label.clone(),
                };

                canvas.edges.push(edge);

                let source_file = canvas.nodes.iter().find_map(|n| {
                    if let crate::canvas::Node::File { id: nid, file, .. } = n {
                        if nid == &from { Some(file.clone()) } else { None }
                    } else {
                        None
                    }
                });
                let target_file = canvas.nodes.iter().find_map(|n| {
                    if let crate::canvas::Node::File { id: nid, file, .. } = n {
                        if nid == &to { Some(file.clone()) } else { None }
                    } else {
                        None
                    }
                });

                if let (Some(s_path), Some(t_path)) = (source_file, target_file) {
                    let rel_type = label.unwrap_or_else(|| "wikilink".to_string());
                    conn.execute(
                        "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
                         VALUES (?1, ?2, ?3, 1.0, 'Created manually by AI Agent on canvas')",
                        rusqlite::params![s_path, t_path, rel_type],
                    )?;
                }

                ops_applied += 1;
            }
            CanvasOperation::RemoveEdge { id } => {
                let mut edge_info = None;
                if let Some(pos) = canvas.edges.iter().position(|e| e.id == id) {
                    edge_info = Some((canvas.edges[pos].from_node.clone(), canvas.edges[pos].to_node.clone()));
                    canvas.edges.remove(pos);
                    ops_applied += 1;
                }

                if let Some((from_node_id, to_node_id)) = edge_info {
                    let source_file = canvas.nodes.iter().find_map(|n| {
                        if let crate::canvas::Node::File { id: nid, file, .. } = n {
                            if nid == &from_node_id { Some(file.clone()) } else { None }
                        } else {
                            None
                        }
                    });
                    let target_file = canvas.nodes.iter().find_map(|n| {
                        if let crate::canvas::Node::File { id: nid, file, .. } = n {
                            if nid == &to_node_id { Some(file.clone()) } else { None }
                        } else {
                            None
                        }
                    });

                    if let (Some(s_path), Some(t_path)) = (source_file, target_file) {
                        conn.execute(
                            "DELETE FROM note_relations WHERE source_path = ?1 AND target_path = ?2",
                            rusqlite::params![s_path, t_path],
                        )?;
                    }
                }
            }
        }
    }

    let canvas_json = serde_json::to_string_pretty(&canvas)?;
    if let Some(parent) = canonical.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&canonical, canvas_json)?;

    Ok(json!({
        "success": true,
        "canvas_path": canvas_path,
        "operations_applied": ops_applied,
        "total_nodes": canvas.nodes.len(),
        "total_edges": canvas.edges.len(),
    }).to_string())
}

// ── create_canvas ──────────────────────────────────────────────────

pub(super) fn execute_create_canvas(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let canvas_path = args["canvas_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'canvas_path' parameter"))?;
    let title = args["title"].as_str().unwrap_or("");

    let full_path = if std::path::Path::new(canvas_path).is_absolute() {
        std::path::PathBuf::from(canvas_path)
    } else {
        std::path::PathBuf::from(vault_path).join(canvas_path)
    };

    let canonical = if let Some(parent) = full_path.parent() {
        if let Ok(parent_canonical) = parent.canonicalize() {
            if let Some(filename) = full_path.file_name() {
                parent_canonical.join(filename)
            } else {
                full_path.clone()
            }
        } else {
            full_path.clone()
        }
    } else {
        full_path.clone()
    };

    if !is_path_in_any_vault(&canonical, vault_path, all_vault_paths) {
        anyhow::bail!("Access denied: canvas path is outside vault");
    }

    if full_path.exists() {
        anyhow::bail!("Canvas already exists at {:?}. Use modify_canvas to edit it.", full_path);
    }

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Create canvas with optional title node
    let mut canvas = crate::canvas::Canvas {
        nodes: vec![],
        edges: vec![],
    };

    if !title.is_empty() {
        canvas.nodes.push(crate::canvas::Node::Text {
            id: format!("title-{}", chrono::Utc::now().timestamp_millis()),
            x: 0,
            y: 0,
            width: 300,
            height: 80,
            text: format!("# {}", title),
            color: None,
        });
    }

    let content = serde_json::to_string_pretty(&canvas)?;
    std::fs::write(&full_path, &content)?;

    Ok(json!({
        "success": true,
        "canvas_path": canvas_path,
        "message": format!("Created canvas: {}", canvas_path),
        "has_title_node": !title.is_empty(),
    }).to_string())
}

// ── group_canvas_nodes ──────────────────────────────────────────────

pub(super) fn execute_group_canvas_nodes(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let canvas_path = args["canvas_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'canvas_path' parameter"))?;
    let node_ids_val = args["node_ids"].as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing 'node_ids' parameter"))?;
    let group_name = args["group_name"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'group_name' parameter"))?;

    let node_ids: std::collections::HashSet<String> = node_ids_val
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();

    if node_ids.is_empty() {
        anyhow::bail!("No valid node_ids provided for grouping");
    }

    let canonical = resolve_canvas_path(canvas_path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        anyhow::bail!("Canvas file does not exist at {:?}", canonical);
    }

    let content = std::fs::read_to_string(&canonical)?;
    let mut canvas: crate::canvas::Canvas = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("Failed to parse canvas JSON: {}", e))?;

    // Find the nodes that match node_ids
    let mut matching_nodes = Vec::new();
    for node in &canvas.nodes {
        let (nid, nx, ny, nw, nh) = match node {
            crate::canvas::Node::File { id, x, y, width, height, .. } => (id, *x, *y, *width, *height),
            crate::canvas::Node::Text { id, x, y, width, height, .. } => (id, *x, *y, *width, *height),
            crate::canvas::Node::Link { id, x, y, width, height, .. } => (id, *x, *y, *width, *height),
            crate::canvas::Node::Group { id, x, y, width, height, .. } => (id, *x, *y, *width, *height),
        };
        if node_ids.contains(nid) {
            matching_nodes.push((nx, ny, nw, nh));
        }
    }

    if matching_nodes.is_empty() {
        anyhow::bail!("None of the provided node_ids were found on the canvas");
    }

    // Calculate bounding box
    let mut min_x = i32::MAX;
    let mut max_x = i32::MIN;
    let mut min_y = i32::MAX;
    let mut max_y = i32::MIN;

    for (x, y, w, h) in matching_nodes {
        if x < min_x { min_x = x; }
        if x + w > max_x { max_x = x + w; }
        if y < min_y { min_y = y; }
        if y + h > max_y { max_y = y + h; }
    }

    let padding = 40;
    let gx = min_x - padding;
    let gy = min_y - padding;
    let gwidth = (max_x - min_x) + 2 * padding;
    let gheight = (max_y - min_y) + 2 * padding;

    let group_id = format!("group-{}", chrono::Utc::now().timestamp_millis());

    let group_node = crate::canvas::Node::Group {
        id: group_id.clone(),
        x: gx,
        y: gy,
        width: gwidth,
        height: gheight,
        label: Some(group_name.to_string()),
        background: None,
        background_style: None,
        color: None,
    };

    canvas.nodes.push(group_node);

    let canvas_json = serde_json::to_string_pretty(&canvas)?;
    std::fs::write(&canonical, canvas_json)?;

    Ok(json!({
        "success": true,
        "canvas_path": canvas_path,
        "group_id": group_id,
        "bounds": {
            "x": gx,
            "y": gy,
            "width": gwidth,
            "height": gheight
        },
        "grouped_count": node_ids.len()
    }).to_string())
}

// ── arrange_canvas_by ───────────────────────────────────────────────

pub(super) fn execute_arrange_canvas_by(
    arguments: &str,
    vault_path: &str,
    db: &Arc<Mutex<Connection>>,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let canvas_path = args["canvas_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'canvas_path' parameter"))?;
    let strategy = args["strategy"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'strategy' parameter"))?;

    let canonical = resolve_canvas_path(canvas_path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        anyhow::bail!("Canvas file does not exist at {:?}", canonical);
    }

    let content = std::fs::read_to_string(&canonical)?;
    let mut canvas: crate::canvas::Canvas = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("Failed to parse canvas JSON: {}", e))?;

    if canvas.nodes.is_empty() {
        return Ok(json!({
            "success": true,
            "canvas_path": canvas_path,
            "message": "Canvas has no nodes to arrange"
        }).to_string());
    }

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    match strategy {
        "methodology" => {
            // Arrange notes by Zettelkasten note methodology type (fleeting, literature, permanent, structure/other) in columns
            let mut fleeting_nodes = Vec::new();
            let mut literature_nodes = Vec::new();
            let mut permanent_nodes = Vec::new();
            let mut other_nodes = Vec::new();

            for node in &canvas.nodes {
                match node {
                    crate::canvas::Node::File { id, file, .. } => {
                        // Query database for note type
                        let note_type: String = conn.query_row(
                            "SELECT COALESCE(note_type, 'permanent') FROM card_meta WHERE file_path = ?1",
                            rusqlite::params![file],
                            |row| row.get(0),
                        ).unwrap_or_else(|_| "permanent".to_string());

                        match note_type.as_str() {
                            "fleeting" | "inbox" | "capture" => fleeting_nodes.push(id.clone()),
                            "literature" | "reference" => literature_nodes.push(id.clone()),
                            "permanent" | "evergreen" | "concept" => permanent_nodes.push(id.clone()),
                            _ => other_nodes.push(id.clone()),
                        }
                    }
                    crate::canvas::Node::Text { id, .. } |
                    crate::canvas::Node::Link { id, .. } |
                    crate::canvas::Node::Group { id, .. } => {
                        other_nodes.push(id.clone());
                    }
                }
            }

            // Arrange into columns: x = 0, 600, 1200, 1800
            let columns = vec![
                (0, fleeting_nodes),
                (600, literature_nodes),
                (1200, permanent_nodes),
                (1800, other_nodes)
            ];

            for (x_offset, ids) in columns {
                for (idx, nid) in ids.iter().enumerate() {
                    let y_offset = idx as i32 * 360;
                    if let Some(node) = canvas.nodes.iter_mut().find(|n| {
                        let id = match n {
                            crate::canvas::Node::File { id, .. } => id,
                            crate::canvas::Node::Text { id, .. } => id,
                            crate::canvas::Node::Link { id, .. } => id,
                            crate::canvas::Node::Group { id, .. } => id,
                        };
                        id == nid
                    }) {
                        match node {
                            crate::canvas::Node::File { x, y, .. } |
                            crate::canvas::Node::Text { x, y, .. } |
                            crate::canvas::Node::Link { x, y, .. } |
                            crate::canvas::Node::Group { x, y, .. } => {
                                *x = x_offset;
                                *y = y_offset;
                            }
                        }
                    }
                }
            }
        }
        "timeline" => {
            // Sort file nodes chronologically using last_synced or minimum chunk creation date
            let mut file_times = Vec::new();
            let mut non_file_nodes = Vec::new();

            for node in &canvas.nodes {
                match node {
                    crate::canvas::Node::File { id, file, .. } => {
                        let time_str: String = conn.query_row(
                            "SELECT COALESCE(
                                (SELECT MIN(created_at) FROM chunks WHERE file_path = ?1),
                                last_synced
                             ) FROM files WHERE path = ?1",
                            rusqlite::params![file],
                            |row| row.get(0),
                        ).unwrap_or_else(|_| "2020-01-01 00:00:00".to_string());

                        file_times.push((id.clone(), time_str));
                    }
                    crate::canvas::Node::Text { id, .. } |
                    crate::canvas::Node::Link { id, .. } |
                    crate::canvas::Node::Group { id, .. } => {
                        non_file_nodes.push(id.clone());
                    }
                }
            }

            // Sort by chronological order
            file_times.sort_by(|a, b| a.1.cmp(&b.1));

            // Place chronologically: x = index * 500, y = 0
            for (idx, (nid, _)) in file_times.iter().enumerate() {
                let x_offset = idx as i32 * 500;
                if let Some(node) = canvas.nodes.iter_mut().find(|n| {
                    let id = match n {
                        crate::canvas::Node::File { id, .. } => id,
                        crate::canvas::Node::Text { id, .. } => id,
                        crate::canvas::Node::Link { id, .. } => id,
                        crate::canvas::Node::Group { id, .. } => id,
                    };
                    id == nid
                }) {
                    match node {
                        crate::canvas::Node::File { x, y, .. } => {
                            *x = x_offset;
                            *y = 0;
                        }
                        _ => {}
                    }
                }
            }

            // Place non-file nodes in a stack on the right or below
            let non_file_start_x = file_times.len() as i32 * 500;
            for (idx, nid) in non_file_nodes.iter().enumerate() {
                let y_offset = idx as i32 * 360;
                if let Some(node) = canvas.nodes.iter_mut().find(|n| {
                    let id = match n {
                        crate::canvas::Node::File { id, .. } => id,
                        crate::canvas::Node::Text { id, .. } => id,
                        crate::canvas::Node::Link { id, .. } => id,
                        crate::canvas::Node::Group { id, .. } => id,
                    };
                    id == nid
                }) {
                    match node {
                        crate::canvas::Node::Text { x, y, .. } |
                        crate::canvas::Node::Link { x, y, .. } |
                        crate::canvas::Node::Group { x, y, .. } => {
                            *x = non_file_start_x;
                            *y = y_offset;
                        }
                        _ => {}
                    }
                }
            }
        }
        "cluster" | _ => {
            // Spring force directed layout using existing canvas connections
            struct LayoutNode {
                id: String,
                x: f64,
                y: f64,
                vx: f64,
                vy: f64,
            }

            let mut l_nodes: Vec<LayoutNode> = canvas.nodes.iter().map(|n| {
                let (nid, nx, ny) = match n {
                    crate::canvas::Node::File { id, x, y, .. } => (id, *x, *y),
                    crate::canvas::Node::Text { id, x, y, .. } => (id, *x, *y),
                    crate::canvas::Node::Link { id, x, y, .. } => (id, *x, *y),
                    crate::canvas::Node::Group { id, x, y, .. } => (id, *x, *y),
                };
                LayoutNode {
                    id: nid.clone(),
                    x: nx as f64,
                    y: ny as f64,
                    vx: 0.0,
                    vy: 0.0,
                }
            }).collect();

            let node_count = l_nodes.len();

            // If coordinates are all 0, initialize them in a circle
            let all_zero = l_nodes.iter().all(|n| n.x == 0.0 && n.y == 0.0);
            if all_zero {
                for (i, node) in l_nodes.iter_mut().enumerate() {
                    let angle = (i as f64 / node_count as f64) * 2.0 * std::f64::consts::PI;
                    let radius = 600.0;
                    node.x = radius * angle.cos();
                    node.y = radius * angle.sin();
                }
            }

            // Run physics simulation
            const ITERATIONS: usize = 120;
            const REPULSION: f64 = 8000.0;
            const ATTRACTION: f64 = 0.08;
            const DAMPING: f64 = 0.8;

            for _ in 0..ITERATIONS {
                // Reset forces
                for node in l_nodes.iter_mut() {
                    node.vx = 0.0;
                    node.vy = 0.0;
                }

                // Repulsion between all nodes
                for i in 0..node_count {
                    for j in (i + 1)..node_count {
                        let dx = l_nodes[j].x - l_nodes[i].x;
                        let dy = l_nodes[j].y - l_nodes[i].y;
                        let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                        let force = REPULSION / (dist * dist);

                        let fx = (dx / dist) * force;
                        let fy = (dy / dist) * force;

                        l_nodes[i].vx -= fx;
                        l_nodes[i].vy -= fy;
                        l_nodes[j].vx += fx;
                        l_nodes[j].vy += fy;
                    }
                }

                // Attraction along edges on the canvas
                for edge in &canvas.edges {
                    if let Some(i) = l_nodes.iter().position(|n| n.id == edge.from_node) {
                        if let Some(j) = l_nodes.iter().position(|n| n.id == edge.to_node) {
                            let dx = l_nodes[j].x - l_nodes[i].x;
                            let dy = l_nodes[j].y - l_nodes[i].y;
                            let force = ATTRACTION * (dx * dx + dy * dy).sqrt();

                            l_nodes[i].vx += dx * force;
                            l_nodes[i].vy += dy * force;
                            l_nodes[j].vx -= dx * force;
                            l_nodes[j].vy -= dy * force;
                        }
                    }
                }

                // Apply forces
                for node in l_nodes.iter_mut() {
                    node.x += node.vx * DAMPING;
                    node.y += node.vy * DAMPING;
                }
            }

            // Write back to canvas nodes
            for l_node in l_nodes {
                if let Some(node) = canvas.nodes.iter_mut().find(|n| {
                    let id = match n {
                        crate::canvas::Node::File { id, .. } => id,
                        crate::canvas::Node::Text { id, .. } => id,
                        crate::canvas::Node::Link { id, .. } => id,
                        crate::canvas::Node::Group { id, .. } => id,
                    };
                    id == &l_node.id
                }) {
                    match node {
                        crate::canvas::Node::File { x, y, .. } |
                        crate::canvas::Node::Text { x, y, .. } |
                        crate::canvas::Node::Link { x, y, .. } |
                        crate::canvas::Node::Group { x, y, .. } => {
                            *x = l_node.x.round() as i32;
                            *y = l_node.y.round() as i32;
                        }
                    }
                }
            }
        }
    }

    let canvas_json = serde_json::to_string_pretty(&canvas)?;
    std::fs::write(&canonical, canvas_json)?;

    Ok(json!({
        "success": true,
        "canvas_path": canvas_path,
        "strategy": strategy,
        "message": format!("Successfully arranged canvas using '{}' layout strategy", strategy)
    }).to_string())
}
