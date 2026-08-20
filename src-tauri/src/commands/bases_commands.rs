use crate::AppState;
use crate::error::ZettelError;
use serde::Serialize;
use tauri::State;

// The overview/saved-view data contracts live in `db/` next to the SQL that
// builds them (same split as `review_store` / `review_commands`). Re-exported
// here so callers of the command layer see one surface. `NoteRow` is reached
// through `NotesOverview::rows` and needs no separate re-export.
pub use crate::db::notes_overview::NotesOverview;
pub use crate::db::saved_views::SavedView;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasesEntry {
    pub path: String,
    pub title: String,
    pub note_type: String,
    pub tags: Vec<String>,
    pub link_count: usize,
    pub confidence: Option<f64>,
    pub created_at: String,
    pub last_synced: String,
    pub folder: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasesData {
    pub entries: Vec<BasesEntry>,
    pub folders: Vec<String>,
    pub all_tags: Vec<String>,
    pub all_types: Vec<String>,
}

/// Get all notes with their metadata for the Bases (database) view.
/// Single SQL query with JOINs — much faster than N individual calls.
#[tauri::command]
pub fn get_bases_data(
    state: State<'_, AppState>,
    vault_path: String,
) -> Result<BasesData, ZettelError> {
    let conn = state.db.lock()?;
    let vault_path_norm = vault_path.replace('\\', "/").to_lowercase();

    let mut stmt = conn.prepare(
        "SELECT
            f.path,
            f.title,
            COALESCE(cm.note_type, 'permanent') AS note_type,
            COALESCE(cm.tags, '[]') AS tags_json,
            COALESCE(cm.links, '[]') AS links_json,
            cm.confidence,
            COALESCE(
                (SELECT MIN(c.created_at) FROM chunks c WHERE c.file_path = f.path),
                f.last_synced
            ) AS created_at,
            f.last_synced
         FROM files f
         LEFT JOIN card_meta cm ON f.path = cm.file_path
         ORDER BY f.path"
     )?;

    let mut entries: Vec<BasesEntry> = Vec::new();
    let mut folders_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tags_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut types_set: std::collections::HashSet<String> = std::collections::HashSet::new();

    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let note_type: String = row.get(2)?;
        let tags_json: String = row.get(3)?;
        let links_json: String = row.get(4)?;
        let confidence: Option<f64> = row.get(5)?;
        let created_at: Option<String> = row.get(6)?;
        let last_synced: Option<String> = row.get(7)?;
        Ok((path, title, note_type, tags_json, links_json, confidence, created_at, last_synced))
    })?;

    for row in rows {
        let (path, title, note_type, tags_json, links_json, confidence, created_at, last_synced) = row?;

        // Filter by vault_path prefix
        let path_norm = path.replace('\\', "/").to_lowercase();
        if !path_norm.starts_with(&vault_path_norm) {
            continue;
        }

        // Derive title from filename if not stored
        let display_title = title.unwrap_or_else(|| {
            path.replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .replace(".md", "")
        });

        // Parse tags JSON
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

        // Count links
        let link_count: usize = serde_json::from_str::<Vec<serde_json::Value>>(&links_json)
            .map(|v| v.len())
            .unwrap_or(0);

        // Extract folder from path
        let norm_path = path.replace('\\', "/");
        let folder = norm_path.rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
            .unwrap_or_default();

        folders_set.insert(folder.clone());
        for tag in &tags {
            tags_set.insert(tag.clone());
        }
        types_set.insert(note_type.clone());

        entries.push(BasesEntry {
            path,
            title: display_title,
            note_type,
            tags,
            link_count,
            confidence,
            created_at: created_at.unwrap_or_default(),
            last_synced: last_synced.unwrap_or_default(),
            folder,
        });
    }

    let mut folders: Vec<String> = folders_set.into_iter().collect();
    folders.sort();
    let mut all_tags: Vec<String> = tags_set.into_iter().collect();
    all_tags.sort();
    let mut all_types: Vec<String> = types_set.into_iter().collect();
    all_types.sort();

    Ok(BasesData {
        entries,
        folders,
        all_tags,
        all_types,
    })
}

// ── Notes overview / 知识库体检台 ──────────────────────────────────────────
//
// `get_bases_data` above is kept as-is for existing callers. It returns seven
// generic metadata columns, one of which (`confidence`) is永远为空 / always NULL:
// nothing in the repo ever writes `card_meta.confidence` — the AI's per-link
// confidence actually lands in `note_relations.confidence`. The commands below
// replace that view with aggregated health signals instead.
//
// All four are thin: lock, delegate to `db::notes_overview` / `db::saved_views`,
// return. `state.db.lock()?` works directly because `error.rs` implements
// `From<PoisonError<_>>` for `ZettelError`.

/// Every note under `vault_path` with its knowledge-base health signals.
///
/// `include_graph_signals` gates `pagerank`/`is_hub`, which are not persisted and
/// can only come from a possibly-cold full graph rebuild. Pass `false` (the
/// default the UI uses) for an interactive table load.
#[tauri::command]
pub fn get_notes_overview(
    state: State<'_, AppState>,
    vault_path: String,
    include_graph_signals: bool,
) -> Result<NotesOverview, ZettelError> {
    let conn = state.db.lock()?;
    // The only clock read in this feature, so the domain layer stays deterministic.
    let now_ms = chrono::Utc::now().timestamp_millis();
    Ok(crate::db::notes_overview::build_overview(
        &conn,
        &vault_path,
        include_graph_signals,
        now_ms,
    )?)
}

/// All saved Bases views, in the user's own order.
#[tauri::command]
pub fn list_saved_views(state: State<'_, AppState>) -> Result<Vec<SavedView>, ZettelError> {
    let conn = state.db.lock()?;
    Ok(crate::db::saved_views::list(&conn))
}

/// Create or replace a saved view, keyed by `id`.
#[tauri::command]
pub fn save_view(state: State<'_, AppState>, view: SavedView) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    crate::db::saved_views::upsert(&conn, view)
        .map_err(|e| ZettelError::System(format!("保存视图失败 / Failed to save view: {e}")))
}

/// Remove a saved view. Deleting a missing id succeeds.
#[tauri::command]
pub fn delete_saved_view(state: State<'_, AppState>, id: String) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    crate::db::saved_views::delete(&conn, &id)
        .map_err(|e| ZettelError::System(format!("删除视图失败 / Failed to delete view: {e}")))
}
