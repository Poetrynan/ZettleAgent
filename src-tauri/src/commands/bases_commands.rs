use crate::AppState;
use crate::error::ZettelError;
use serde::Serialize;
use tauri::State;

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
