/// JSON Canvas 1.0 export functionality
/// Spec: https://jsoncanvas.org/spec/1.0/
///
/// Converts ZettelAgent knowledge graph to Obsidian Canvas format

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// JSON Canvas root structure
#[derive(Debug, Serialize, Deserialize)]
pub struct Canvas {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// Canvas node (file, text, link, or group) per JSON Canvas 1.0 spec
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Node {
    #[serde(rename = "file")]
    File {
        id: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        file: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        subpath: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    #[serde(rename = "text")]
    Text {
        id: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    #[serde(rename = "link")]
    Link {
        id: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    #[serde(rename = "group")]
    Group {
        id: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        background: Option<String>,
        #[serde(rename = "backgroundStyle", skip_serializing_if = "Option::is_none")]
        background_style: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
}

/// Canvas edge (connection between nodes)
#[derive(Debug, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    #[serde(rename = "fromNode")]
    pub from_node: String,
    #[serde(rename = "fromSide", skip_serializing_if = "Option::is_none")]
    pub from_side: Option<String>,
    #[serde(rename = "fromEnd", skip_serializing_if = "Option::is_none")]
    pub from_end: Option<String>,
    #[serde(rename = "toNode")]
    pub to_node: String,
    #[serde(rename = "toSide", skip_serializing_if = "Option::is_none")]
    pub to_side: Option<String>,
    #[serde(rename = "toEnd", skip_serializing_if = "Option::is_none")]
    pub to_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Layout algorithm for positioning nodes
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum LayoutAlgorithm {
    /// Force-directed layout (simulates physics)
    ForceDirected,
    /// Circular layout (nodes in a circle)
    Circular,
    /// Grid layout (organized grid)
    Grid,
    /// Hierarchical layout (tree-like structure)
    Hierarchical,
}

/// Node metadata for layout calculations
#[derive(Debug, Clone)]
struct NodeData {
    id: String,
    file_path: String,
    title: String,
    note_type: String,
    outgoing_links: Vec<String>,
    incoming_links: Vec<String>,
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

/// Export options
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub layout: String,
    pub node_width: i32,
    pub node_height: i32,
    pub spacing: f64,
    pub include_orphans: bool,
    pub max_nodes: usize,
    pub color_by_type: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            layout: "force-directed".to_string(),
            node_width: 400,
            node_height: 300,
            spacing: 100.0,
            include_orphans: false,
            max_nodes: 100,
            color_by_type: true,
        }
    }
}

/// Export knowledge graph to JSON Canvas format
pub fn export_to_canvas(
    conn: &Connection,
    options: &ExportOptions,
) -> anyhow::Result<Canvas> {
    // Step 1: Load all notes and their links
    let mut node_data = load_graph_data(conn, options)?;

    // Step 2: Apply layout algorithm
    apply_layout(&mut node_data, options)?;

    // Step 3: Convert to Canvas nodes
    let nodes = node_data
        .iter()
        .map(|nd| create_canvas_node(nd, options))
        .collect();

    // Step 4: Create edges
    let edges = create_canvas_edges(&node_data, options);

    Ok(Canvas { nodes, edges })
}

/// Load graph data from database
fn load_graph_data(
    conn: &Connection,
    options: &ExportOptions,
) -> anyhow::Result<Vec<NodeData>> {
    let mut nodes = Vec::new();
    let mut path_to_id = HashMap::new();

    // Query all files with their metadata
    let query = if options.include_orphans {
        "SELECT f.path, COALESCE(f.title, f.path), COALESCE(cm.note_type, 'permanent'), cm.links
         FROM files f
         LEFT JOIN card_meta cm ON f.path = cm.file_path
         ORDER BY f.last_synced DESC
         LIMIT ?"
    } else {
        "SELECT f.path, COALESCE(f.title, f.path), COALESCE(cm.note_type, 'permanent'), cm.links
         FROM files f
         LEFT JOIN card_meta cm ON f.path = cm.file_path
         WHERE cm.links IS NOT NULL AND cm.links != '[]'
         ORDER BY f.last_synced DESC
         LIMIT ?"
    };

    let mut stmt = conn.prepare(query)?;
    let rows = stmt.query_map([options.max_nodes as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "[]".to_string()),
        ))
    })?;

    for (idx, row) in rows.enumerate() {
        let (path, title, note_type, _links_json) = row?;
        let id = format!("node-{}", idx);
        path_to_id.insert(path.clone(), id.clone());

        nodes.push(NodeData {
            id,
            file_path: path,
            title,
            note_type,
            outgoing_links: Vec::new(),
            incoming_links: Vec::new(),
            x: 0.0,
            y: 0.0,
            vx: 0.0,
            vy: 0.0,
        });
    }

    // Load links from card_meta
    let mut edges = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT file_path, links FROM card_meta WHERE links IS NOT NULL AND links != '[]'"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    for row in rows {
        let (file_path, links_json) = row?;
        if let Ok(links) = serde_json::from_str::<Vec<crate::db::search::SuggestedLink>>(&links_json) {
            for link in links {
                let target = link.target();
                // simple title normalization for mapping
                let link_clean = target.trim_start_matches("[[").trim_end_matches("]]").trim().to_lowercase();
                edges.push((file_path.clone(), link_clean));
            }
        }
    }

    // Build incoming/outgoing
    for (source_path, target_title) in edges {
        let mut target_id_opt = None;
        for n in &nodes {
            let n_title = n.title.to_lowercase();
            let n_file = n.file_path.replace('\\', "/").to_lowercase();
            if n_title == target_title || n_file.contains(&target_title) {
                target_id_opt = Some(n.id.clone());
                break;
            }
        }
        
        if let Some(target_id) = target_id_opt {
            if let Some(source_id) = path_to_id.get(&source_path) {
                if let Some(s) = nodes.iter_mut().find(|n| n.id == *source_id) {
                    s.outgoing_links.push(target_id.clone());
                }
                if let Some(t) = nodes.iter_mut().find(|n| n.id == target_id) {
                    t.incoming_links.push(source_id.clone());
                }
            }
        }
    }

    Ok(nodes)
}

/// Apply layout algorithm to position nodes
fn apply_layout(nodes: &mut [NodeData], options: &ExportOptions) -> anyhow::Result<()> {
    match options.layout.as_str() {
        "circular" => apply_circular_layout(nodes, options),
        "grid" => apply_grid_layout(nodes, options),
        "hierarchical" => apply_hierarchical_layout(nodes, options),
        _ => apply_force_directed_layout(nodes, options),
    }
}

/// Force-directed layout (physics simulation)
fn apply_force_directed_layout(nodes: &mut [NodeData], options: &ExportOptions) -> anyhow::Result<()> {
    const ITERATIONS: usize = 300;
    const REPULSION: f64 = 10000.0;
    const ATTRACTION: f64 = 0.01;
    const DAMPING: f64 = 0.85;

    let node_count = nodes.len();

    // Initialize random positions
    for (i, node) in nodes.iter_mut().enumerate() {
        let angle = (i as f64 / node_count as f64) * 2.0 * std::f64::consts::PI;
        let radius = options.spacing * 2.0;
        node.x = radius * angle.cos();
        node.y = radius * angle.sin();
    }

    // Simulate physics
    for _ in 0..ITERATIONS {
        // Reset forces
        for node in nodes.iter_mut() {
            node.vx = 0.0;
            node.vy = 0.0;
        }

        // Repulsion between all nodes
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                let dx = nodes[j].x - nodes[i].x;
                let dy = nodes[j].y - nodes[i].y;
                let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                let force = REPULSION / (dist * dist);

                let fx = (dx / dist) * force;
                let fy = (dy / dist) * force;

                nodes[i].vx -= fx;
                nodes[i].vy -= fy;
                nodes[j].vx += fx;
                nodes[j].vy += fy;
            }
        }

        // Attraction along edges
        for i in 0..nodes.len() {
            let outgoing = nodes[i].outgoing_links.clone();
            for target_id in outgoing {
                if let Some(j) = nodes.iter().position(|n| n.id == target_id) {
                    let dx = nodes[j].x - nodes[i].x;
                    let dy = nodes[j].y - nodes[i].y;
                    let force = ATTRACTION * (dx * dx + dy * dy).sqrt();

                    nodes[i].vx += dx * force;
                    nodes[i].vy += dy * force;
                    nodes[j].vx -= dx * force;
                    nodes[j].vy -= dy * force;
                }
            }
        }

        // Apply forces
        for node in nodes.iter_mut() {
            node.x += node.vx * DAMPING;
            node.y += node.vy * DAMPING;
        }
    }

    Ok(())
}

/// Circular layout (nodes arranged in circle)
fn apply_circular_layout(nodes: &mut [NodeData], options: &ExportOptions) -> anyhow::Result<()> {
    let node_count = nodes.len();
    let radius = options.spacing * node_count as f64 / (2.0 * std::f64::consts::PI);
    for (i, node) in nodes.iter_mut().enumerate() {
        let angle = (i as f64 / node_count as f64) * 2.0 * std::f64::consts::PI;
        node.x = radius * angle.cos();
        node.y = radius * angle.sin();
    }
    Ok(())
}

/// Grid layout (organized in rows and columns)
fn apply_grid_layout(nodes: &mut [NodeData], options: &ExportOptions) -> anyhow::Result<()> {
    let node_count = nodes.len();
    let cols = (node_count as f64).sqrt().ceil() as usize;
    for (i, node) in nodes.iter_mut().enumerate() {
        let row = i / cols;
        let col = i % cols;
        node.x = col as f64 * (options.node_width as f64 + options.spacing);
        node.y = row as f64 * (options.node_height as f64 + options.spacing);
    }
    Ok(())
}

/// Hierarchical layout (tree-like structure)
fn apply_hierarchical_layout(nodes: &mut [NodeData], options: &ExportOptions) -> anyhow::Result<()> {
    // Find root nodes (no incoming links)
    let mut roots = Vec::new();
    let mut visited = HashSet::new();

    for node in nodes.iter() {
        if node.incoming_links.is_empty() {
            roots.push(node.id.clone());
        }
    }

    // If no roots, use nodes with most outgoing links
    if roots.is_empty() {
        let mut sorted = nodes.to_vec();
        sorted.sort_by_key(|n| std::cmp::Reverse(n.outgoing_links.len()));
        if let Some(root) = sorted.first() {
            roots.push(root.id.clone());
        }
    }

    // BFS from roots to assign levels
    let mut levels: HashMap<String, usize> = HashMap::new();
    let mut queue = std::collections::VecDeque::new();

    for root in &roots {
        queue.push_back((root.clone(), 0));
        levels.insert(root.clone(), 0);
    }

    while let Some((node_id, level)) = queue.pop_front() {
        if visited.contains(&node_id) {
            continue;
        }
        visited.insert(node_id.clone());

        if let Some(node) = nodes.iter().find(|n| n.id == node_id) {
            for child_id in &node.outgoing_links {
                if !levels.contains_key(child_id) {
                    levels.insert(child_id.clone(), level + 1);
                    queue.push_back((child_id.clone(), level + 1));
                }
            }
        }
    }

    // Assign positions by level
    let max_level = levels.values().max().copied().unwrap_or(0);
    let mut level_counts = vec![0; max_level + 1];

    for node in nodes.iter_mut() {
        let level = levels.get(&node.id).copied().unwrap_or(max_level);
        let x_offset = level_counts[level] as f64 * (options.node_width as f64 + options.spacing);
        level_counts[level] += 1;

        node.x = x_offset;
        node.y = level as f64 * (options.node_height as f64 + options.spacing * 2.0);
    }

    Ok(())
}

/// Create Canvas node from NodeData
fn create_canvas_node(node: &NodeData, options: &ExportOptions) -> Node {
    let color = if options.color_by_type {
        Some(match node.note_type.as_str() {
            // Zettelkasten
            "permanent" => "#10B981".to_string(),  // green
            "literature" => "#3B82F6".to_string(),  // blue
            "fleeting" => "#94A3B8".to_string(),    // gray
            "structure" => "#F59E0B".to_string(),   // amber

            // PARA
            "project" => "#10B981".to_string(),
            "area" => "#3B82F6".to_string(),
            "resource" => "#F59E0B".to_string(),
            "archive" => "#94A3B8".to_string(),

            // Generic
            "concept" => "#10B981".to_string(),
            "reference" => "#3B82F6".to_string(),
            "task" => "#94A3B8".to_string(),
            "journal" => "#F59E0B".to_string(),

            // CODE (Tiago Forte)
            "capture" => "#94A3B8".to_string(),
            "organize" => "#3B82F6".to_string(),
            "distill" => "#F59E0B".to_string(),
            "express" => "#10B981".to_string(),

            // Evergreen (Andy Matuschak)
            "seed" => "#94A3B8".to_string(),
            "sapling" => "#3B82F6".to_string(),
            "evergreen" => "#10B981".to_string(),
            "compost" => "#F59E0B".to_string(),

            // GTD (David Allen)
            "inbox" => "#94A3B8".to_string(),
            "next_action" => "#10B981".to_string(),
            "waiting" => "#F59E0B".to_string(),
            "someday" => "#3B82F6".to_string(),

            // Cornell
            "cue" => "#F59E0B".to_string(),
            "note" => "#3B82F6".to_string(),
            "summary" => "#10B981".to_string(),
            "review" => "#8B5CF6".to_string(),

            // MOC / LYT
            "map" => "#8B5CF6".to_string(),
            "hub" => "#10B981".to_string(),
            "dashboard" => "#F59E0B".to_string(),

            _ => "#94A3B8".to_string(),            // gray fallback
        })
    } else {
        None
    };

    Node::File {
        id: node.id.clone(),
        x: node.x as i32,
        y: node.y as i32,
        width: options.node_width,
        height: options.node_height,
        file: node.file_path.clone(),
        subpath: None,
        color,
    }
}

/// Create Canvas edges from node connections
fn create_canvas_edges(nodes: &[NodeData], options: &ExportOptions) -> Vec<Edge> {
    let mut edges = Vec::new();
    let mut edge_counter = 0;

    for node in nodes {
        for target_id in &node.outgoing_links {
            let edge = Edge {
                id: format!("edge-{}", edge_counter),
                from_node: node.id.clone(),
                from_side: Some("right".to_string()),
                from_end: Some("none".to_string()),
                to_node: target_id.clone(),
                to_side: Some("left".to_string()),
                to_end: Some("arrow".to_string()),
                color: if options.color_by_type {
                    Some("#6b7280".to_string())
                } else {
                    None
                },
                label: None,
            };
            edges.push(edge);
            edge_counter += 1;
        }
    }

    edges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canvas_serialization() {
        let canvas = Canvas {
            nodes: vec![
                Node::File {
                    id: "node-1".to_string(),
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 300,
                    file: "test.md".to_string(),
                    subpath: None,
                    color: Some("#3b82f6".to_string()),
                },
            ],
            edges: vec![],
        };

        let json = serde_json::to_string_pretty(&canvas).unwrap();
        assert!(json.contains("\"type\": \"file\""));
        assert!(json.contains("test.md"));
    }
}
