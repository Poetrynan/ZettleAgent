use crate::AppState;
use crate::db::search::{self, GraphData};
use crate::canvas::{self, ExportOptions};
use crate::error::ZettelError;
use tauri::State;

#[tauri::command]
pub fn get_knowledge_graph(
    state: State<'_, AppState>,
    vault_path: String,
) -> Result<GraphData, ZettelError> {
    let conn = state.db.lock()?;
    let data = search::get_graph_data(&conn)?;

    let vault_path_norm = vault_path.replace('\\', "/").to_lowercase();
    let mut filtered_nodes = Vec::new();
    let mut node_paths = std::collections::HashSet::new();

    for node in data.nodes {
        let node_path_norm = node.id.replace('\\', "/").to_lowercase();
        if node_path_norm.starts_with(&vault_path_norm) {
            node_paths.insert(node.id.clone());
            filtered_nodes.push(node);
        }
    }

    let mut filtered_edges = Vec::new();
    for edge in data.edges {
        if node_paths.contains(&edge.source) && node_paths.contains(&edge.target) {
            filtered_edges.push(edge);
        }
    }

    Ok(GraphData {
        nodes: filtered_nodes,
        edges: filtered_edges,
        clusters: data.clusters,
    })
}

/// Get local graph data for a specific note.
#[tauri::command]
pub fn get_local_graph(state: State<'_, AppState>, file_path: String) -> Result<GraphData, ZettelError> {
    let conn = state.db.lock()?;
    let data = search::get_local_graph(&conn, &file_path)?;
    Ok(data)
}

/// Export knowledge graph to JSON Canvas 1.0 format
#[tauri::command]
pub fn export_canvas(
    state: State<'_, AppState>,
    options: ExportOptions,
) -> Result<String, ZettelError> {
    let conn = state.db.lock()?;
    let canvas = canvas::export_to_canvas(&conn, &options)?;
    let json = serde_json::to_string_pretty(&canvas)?;
    Ok(json)
}

/// Save Canvas JSON to file
#[tauri::command]
pub fn save_canvas_to_file(
    canvas_json: String,
    output_path: String,
) -> Result<(), ZettelError> {
    std::fs::write(&output_path, canvas_json)?;
    Ok(())
}

/// Add a note relation to the note_relations table from canvas connection.
#[tauri::command]
pub fn add_canvas_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
         VALUES (?1, ?2, ?3, 1.0, 'Created manually on canvas')",
        rusqlite::params![source_path, target_path, relation_type],
    )?;
    Ok(())
}

/// Remove a note relation from the note_relations table from canvas disconnection.
#[tauri::command]
pub fn delete_canvas_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "DELETE FROM note_relations WHERE source_path = ?1 AND target_path = ?2",
        rusqlite::params![source_path, target_path],
    )?;
    Ok(())
}

/// Get edges filtered by relation type from note_relations table.
#[tauri::command]
pub fn get_edges_by_relation(
    state: State<'_, AppState>,
    relation_type: String,
) -> Result<Vec<search::GraphEdge>, ZettelError> {
    let conn = state.db.lock()?;
    let edges = search::get_edges_by_relation(&conn, &relation_type)?;
    Ok(edges)
}

/// Add a note relation directly from the knowledge graph view.
/// Reuses the same note_relations table as canvas connections.
#[tauri::command]
pub fn add_note_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
    reason: Option<String>,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
         VALUES (?1, ?2, ?3, 1.0, ?4)",
        rusqlite::params![
            source_path,
            target_path,
            relation_type,
            reason.unwrap_or_else(|| "Created manually on graph".to_string())
        ],
    )?;
    Ok(())
}

/// Remove a note relation directly from the knowledge graph view.
#[tauri::command]
pub fn delete_note_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
) -> Result<bool, ZettelError> {
    let conn = state.db.lock()?;
    let deleted = conn.execute(
        "DELETE FROM note_relations WHERE source_path = ?1 AND target_path = ?2",
        rusqlite::params![source_path, target_path],
    )?;
    Ok(deleted > 0)
}

/// AI-powered relationship explanation between two notes.
/// Reads both notes' content and uses LLM to explain the conceptual relationship.
#[tauri::command]
pub async fn explain_relationship(
    state: State<'_, AppState>,
    note_a: String,
    note_b: String,
    api_url: String,
    api_key: Option<String>,
    model: String,
    provider_id: Option<String>,
) -> Result<String, ZettelError> {
    // Read both notes' content (first 3000 chars)
    let content_a = std::fs::read_to_string(&note_a)?;
    let content_b = std::fs::read_to_string(&note_b)?;

    let snippet_a: String = content_a.chars().take(3000).collect();
    let snippet_b: String = content_b.chars().take(3000).collect();

    // Query existing relations from DB
    let (direct_relations, shared_tags) = {
        let conn = state.db.lock()?;
        let mut direct = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT relation_type, confidence, reason FROM note_relations
             WHERE (source_path = ?1 AND target_path = ?2)
                OR (source_path = ?2 AND target_path = ?1)"
        )?;
        let rows = stmt.query_map(rusqlite::params![note_a, note_b], |row| {
            Ok(format!(
                "- type: {} (confidence: {:.2}){}",
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1).unwrap_or(0.5),
                row.get::<_, Option<String>>(2)?.map(|r| format!(", reason: {}", r)).unwrap_or_default()
            ))
        })?;
        for r in rows.flatten() {
            direct.push(r);
        }

        // Shared tags
        let mut shared = Vec::new();
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
                if list_b.contains(&t) { shared.push(t); }
            }
        }
        (direct, shared)
    };

    let existing_info = if direct_relations.is_empty() {
        "No existing relations found.".to_string()
    } else {
        format!("Existing relations:\n{}", direct_relations.join("\n"))
    };
    let shared_info = if shared_tags.is_empty() {
        "No shared tags.".to_string()
    } else {
        format!("Shared tags: {}", shared_tags.join(", "))
    };

    let prompt = format!(
        "You are a knowledge graph analyst. Analyze the conceptual relationship between these two notes.\n\n\
        Note A ({}) content:\n{}\n\n\
        Note B ({}) content:\n{}\n\n\
        Database context:\n{}\n{}\n\n\
        Provide a concise explanation (3-5 sentences) of how these two notes relate to each other. \
        Identify the main conceptual connection, whether they support/contradict/complement each other, \
        and suggest the most appropriate relation type from: \
        supports, contradicts, refines, supplementary, depends_on, exemplifies, supersedes, or wikilink. \
        Respond in the same language as the note content.",
        note_a, snippet_a, note_b, snippet_b, existing_info, shared_info
    );

    let config = crate::llm::LlmConfig {
        api_url,
        api_key,
        model,
        provider_id,
        ..Default::default()
    };
    let messages = vec![crate::llm::ChatMessage {
        role: "user".to_string(),
        content: prompt,
        ..Default::default()
    }];
    let response = crate::llm::chat_completion(&config, &messages)
        .await
        .map_err(|e| ZettelError::Llm(e.to_string()))?;

    Ok(response)
}

