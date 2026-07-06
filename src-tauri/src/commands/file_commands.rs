use std::path::PathBuf;
use tauri::{State, Manager};
use rusqlite::params;
use crate::AppState;
use crate::error::ZettelError;

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "ZettelAgent",
        "version": "0.1.0",
        "description": "AI-Powered Zettelkasten Desktop Application"
    })
}

#[tauri::command]
pub fn set_vault_path(path: String) -> Result<String, ZettelError> {
    let vault_path = PathBuf::from(&path);
    if !vault_path.exists() {
        return Err(ZettelError::System(format!("Vault path does not exist: {}", path)));
    }
    if !vault_path.is_dir() {
        return Err(ZettelError::System(format!("Vault path is not a directory: {}", path)));
    }
    Ok(vault_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_markdown_file(path: String) -> Result<String, ZettelError> {
    let content = std::fs::read_to_string(&path)?;
    Ok(content)
}

#[tauri::command]
pub fn read_binary_file(path: String) -> Result<String, ZettelError> {
    use base64::Engine;
    let bytes = std::fs::read(&path)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(encoded)
}

#[tauri::command]
pub fn write_markdown_file(path: String, content: String) -> Result<(), ZettelError> {
    crate::file_lock::safe_write(&PathBuf::from(&path), &content)?;
    Ok(())
}

// ── Note Snapshot (persistent version history in SQLite) ──────────

#[derive(serde::Serialize)]
pub struct NoteSnapshot {
    pub id: i64,
    pub file_path: String,
    pub content: String,
    pub content_length: i64,
    pub created_at: String,
    pub created_at_ms: i64,
}

/// Save a note snapshot to SQLite. Deduplicates if content is identical to the latest.
/// Keeps at most 100 snapshots per file (prunes oldest).
#[tauri::command]
pub fn save_note_snapshot(state: State<'_, AppState>, file_path: String, content: String) -> Result<bool, ZettelError> {
    let conn = state.db.lock().map_err(|e| ZettelError::System(format!("DB lock error: {}", e)))?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Check if content is identical to the latest snapshot — skip if so
    let latest: Option<String> = conn
        .query_row(
            "SELECT content FROM note_snapshots WHERE file_path = ?1 ORDER BY created_at_ms DESC LIMIT 1",
            params![&file_path],
            |row| row.get(0),
        )
        .ok();
    if let Some(ref last) = latest {
        if last == &content {
            return Ok(false);
        }
    }

    // Insert new snapshot
    conn.execute(
        "INSERT INTO note_snapshots (file_path, content, content_length, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
        params![&file_path, &content, content.len() as i64, now_ms],
    )?;

    // Prune: keep at most 100 per file
    conn.execute(
        "DELETE FROM note_snapshots WHERE file_path = ?1 AND id NOT IN (
            SELECT id FROM note_snapshots WHERE file_path = ?1 ORDER BY created_at_ms DESC LIMIT 100
        )",
        params![&file_path],
    )?;

    Ok(true)
}

/// Get all snapshots for a file, sorted newest first.
#[tauri::command]
pub fn get_note_snapshots(state: State<'_, AppState>, file_path: String) -> Result<Vec<NoteSnapshot>, ZettelError> {
    let conn = state.db.lock().map_err(|e| ZettelError::System(format!("DB lock error: {}", e)))?;
    let mut stmt = conn.prepare(
        "SELECT id, file_path, content, content_length, created_at, created_at_ms
         FROM note_snapshots WHERE file_path = ?1 ORDER BY created_at_ms DESC"
    )?;
    let rows = stmt.query_map(params![&file_path], |row| {
        Ok(NoteSnapshot {
            id: row.get(0)?,
            file_path: row.get(1)?,
            content: row.get(2)?,
            content_length: row.get(3)?,
            created_at: row.get(4)?,
            created_at_ms: row.get(5)?,
        })
    })?;
    let mut snapshots = Vec::new();
    for row in rows {
        snapshots.push(row?);
    }
    Ok(snapshots)
}

/// Delete a specific snapshot by id.
#[tauri::command]
pub fn delete_note_snapshot(state: State<'_, AppState>, snapshot_id: i64) -> Result<(), ZettelError> {
    let conn = state.db.lock().map_err(|e| ZettelError::System(format!("DB lock error: {}", e)))?;
    conn.execute("DELETE FROM note_snapshots WHERE id = ?1", params![snapshot_id])?;
    Ok(())
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, path: String) -> Result<(), ZettelError> {
    let file_path = PathBuf::from(&path);
    if file_path.exists() {
        std::fs::remove_file(&file_path)?;
    }
    let conn = state.db.lock()?;
    conn.execute("DELETE FROM files WHERE path = ?1", params![path])?;
    crate::db::search::invalidate_graph_cache(&conn);
    log::info!("Deleted file: {}", path);
    Ok(())
}

#[tauri::command]
pub fn list_markdown_files(dir_path: String) -> Result<Vec<String>, ZettelError> {
    let dir = PathBuf::from(&dir_path);
    if !dir.is_dir() {
        return Err(ZettelError::System(format!("Not a directory: {}", dir_path)));
    }
    let mut files = Vec::new();
    fn walk_dir(dir: &std::path::Path, files: &mut Vec<String>) -> Result<(), ZettelError> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" || name == "build" {
                        continue;
                    }
                }
                walk_dir(&path, files)?;
            } else if path.is_file() && path.extension().map_or(false, |ext| ext == "md") {
                files.push(path.to_string_lossy().to_string());
            }
        }
        Ok(())
    }
    walk_dir(&dir, &mut files)?;
    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn resolve_wikilink(state: State<'_, AppState>, title: String) -> Result<Option<String>, ZettelError> {
    let conn = state.db.lock()?;
    let title_norm = crate::db::search::normalize_title(&title);
    if title_norm.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT path, title FROM files")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        let (path, file_title) = row?;
        if let Some(t) = file_title {
            if crate::db::search::normalize_title(&t) == title_norm {
                return Ok(Some(path));
            }
        }
        let filename = path.replace('\\', "/").rsplit('/').next().unwrap_or(&path).replace(".md", "");
        if crate::db::search::normalize_title(&filename) == title_norm || crate::db::search::normalize_title(&filename).contains(&title_norm) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// A backlink entry: a note that links to the current note.
#[derive(serde::Serialize)]
pub struct BacklinkEntry {
    pub file_path: String,
    pub title: String,
    pub context: String,
}

/// Get all notes that link to the given file path (via note_relations + wikilink scan).
#[tauri::command]
pub fn get_backlinks(state: State<'_, AppState>, file_path: String) -> Result<Vec<BacklinkEntry>, ZettelError> {
    let conn = state.db.lock()?;

    // Extract the title from the target file for wikilink matching
    let target_title: Option<String> = conn.query_row(
        "SELECT title FROM files WHERE path = ?1",
        rusqlite::params![file_path],
        |row| row.get(0),
    ).ok();

    let mut backlinks: Vec<BacklinkEntry> = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    // Method 1: Query note_relations table (AI-discovered relations)
    {
        let mut stmt = conn.prepare(
            "SELECT nr.source_path, COALESCE(f.title, '') as title, COALESCE(nr.relation_type, '') as rel_type
             FROM note_relations nr
             LEFT JOIN files f ON f.path = nr.source_path
             WHERE nr.target_path = ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (source_path, title, rel_type) = row?;
            if seen_paths.insert(source_path.clone()) {
                backlinks.push(BacklinkEntry {
                    file_path: source_path,
                    title,
                    context: rel_type,
                });
            }
        }
    }

    // Method 2: Scan all files for [[title]] wikilinks pointing to this file
    if let Some(ref title) = target_title {
        let title_lower = title.to_lowercase();
        let file_stem = std::path::Path::new(&file_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();

        let mut stmt = conn.prepare(
            "SELECT c.file_path, COALESCE(f.title, '') as title, c.content
             FROM chunks c
             LEFT JOIN files f ON f.path = c.file_path
             WHERE c.file_path != ?1 AND c.content LIKE '%[[%]]%'"
        )?;
        let rows = stmt.query_map(rusqlite::params![file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (source_path, source_title, content) = row?;
            if seen_paths.contains(&source_path) {
                continue;
            }
            // Check if content contains [[target_title]] or [[file_stem]]
            let content_lower = content.to_lowercase();
            let has_link = content_lower.contains(&format!("[[{}]]", title_lower))
                || content_lower.contains(&format!("[[{}]]", file_stem));
            if has_link {
                if seen_paths.insert(source_path.clone()) {
                    // Extract a snippet around the wikilink
                    let snippet = content.lines()
                        .find(|line| {
                            let ll = line.to_lowercase();
                            ll.contains(&format!("[[{}]]", title_lower)) || ll.contains(&format!("[[{}]]", file_stem))
                        })
                        .unwrap_or("")
                        .trim()
                        .chars()
                        .take(120)
                        .collect::<String>();
                    backlinks.push(BacklinkEntry {
                        file_path: source_path,
                        title: source_title,
                        context: snippet,
                    });
                }
            }
        }
    }

    Ok(backlinks)
}

#[tauri::command]
pub async fn get_data_path(app: tauri::AppHandle) -> Result<String, ZettelError> {
    let app_data_dir = app.path().app_data_dir()?;
    Ok(app_data_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_db_path(app: tauri::AppHandle) -> Result<String, ZettelError> {
    let app_data_dir = app.path().app_data_dir()?;
    let db_path = crate::db_config::resolve_db_path(&app_data_dir);
    Ok(db_path.to_string_lossy().to_string())
}

/// Get the current custom DB path setting (may be None if using default)
#[tauri::command]
pub async fn get_custom_db_path(app: tauri::AppHandle) -> Result<Option<String>, ZettelError> {
    let app_data_dir = app.path().app_data_dir()?;
    let config = crate::db_config::read_config(&app_data_dir);
    Ok(config.custom_db_path)
}

/// Set a custom DB path. Takes effect after app restart.
/// If `new_path` is empty, resets to default.
/// If `migrate` is true, copies the current DB file to the new location.
#[tauri::command]
pub async fn set_custom_db_path(
    app: tauri::AppHandle,
    new_path: String,
    migrate: bool,
) -> Result<String, ZettelError> {
    let app_data_dir = app.path().app_data_dir()?;
    let current_db = crate::db_config::resolve_db_path(&app_data_dir);
    
    let trimmed = new_path.trim().to_string();
    
    // Resolve actual new path
    let actual_new_path = if trimmed.is_empty() {
        app_data_dir.join("zettelagent.db")
    } else {
        let p = std::path::PathBuf::from(&trimmed);
        // If user specified a directory, append the db filename
        if p.is_dir() || trimmed.ends_with('/') || trimmed.ends_with('\\') {
            let dir = std::path::PathBuf::from(&trimmed);
            std::fs::create_dir_all(&dir).map_err(|e| ZettelError::System(format!("Failed to create directory: {}", e)))?;
            dir.join("zettelagent.db")
        } else {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| ZettelError::System(format!("Failed to create directory: {}", e)))?;
            }
            p
        }
    };
    
    // Migrate (copy) current DB to new path if requested
    if migrate && current_db.exists() && actual_new_path != current_db {
        std::fs::copy(&current_db, &actual_new_path)
            .map_err(|e| ZettelError::System(format!("Failed to copy database: {}", e)))?;
        log::info!("Migrated database from {:?} to {:?}", current_db, actual_new_path);
    }
    
    // Save config
    let config = crate::db_config::DbConfig {
        custom_db_path: if trimmed.is_empty() {
            None
        } else {
            Some(actual_new_path.to_string_lossy().to_string())
        },
    };
    crate::db_config::write_config(&app_data_dir, &config)
        .map_err(|e| ZettelError::System(format!("Failed to save config: {}", e)))?;
    
    Ok(actual_new_path.to_string_lossy().to_string())
}

/// 初始化 demo-vault：从打包资源复制到用户文档目录，返回路径
#[tauri::command]
pub fn init_demo_vault(app: tauri::AppHandle) -> Result<String, ZettelError> {
    // 获取用户文档目录
    let doc_dir = app.path()
        .document_dir()
        .map_err(|e| ZettelError::System(format!("Failed to get document dir: {}", e)))?;
    let target_dir = doc_dir.join("ZettelAgent Demo");

    // 如果目标目录已存在且有 .md 文件，直接返回
    if target_dir.exists() {
        let has_md = std::fs::read_dir(&target_dir)
            .map(|mut entries| entries.any(|e| e.ok().map(|e| e.path().extension().map_or(false, |ext| ext == "md")).unwrap_or(false)))
            .unwrap_or(false);
        if has_md {
            return Ok(target_dir.to_string_lossy().to_string());
        }
    }

    // 从打包资源获取 demo-vault 路径
    let resource_path = app.path()
        .resource_dir()
        .map_err(|e| ZettelError::System(format!("Failed to get resource dir: {}", e)))?
        .join("demo-vault");

    if !resource_path.exists() {
        return Err(ZettelError::System("Bundled demo-vault not found".to_string()));
    }

    // 复制到用户文档目录
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| ZettelError::System(format!("Failed to create demo vault dir: {}", e)))?;

    for entry in std::fs::read_dir(&resource_path)
        .map_err(|e| ZettelError::System(format!("Failed to read demo-vault: {}", e)))?
    {
        let entry = entry.map_err(|e| ZettelError::System(format!("Failed to read entry: {}", e)))?;
        let file_name = entry.file_name();
        let target_file = target_dir.join(&file_name);
        if !target_file.exists() {
            std::fs::copy(entry.path(), &target_file)
                .map_err(|e| ZettelError::System(format!("Failed to copy demo file: {}", e)))?;
        }
    }

    Ok(target_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn clear_data(state: State<'_, AppState>) -> Result<(), ZettelError> {
    if state.scheduler.running.load(std::sync::atomic::Ordering::SeqCst) {
        state.scheduler.running.store(false, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let conn = state.db.lock()?;
    let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);
    let drop_statements = [
        "DROP TRIGGER IF EXISTS chunks_ai;",
        "DROP TRIGGER IF EXISTS chunks_ad;",
        "DROP TRIGGER IF EXISTS chunks_au;",
        "DROP TABLE IF EXISTS chunks_fts;",
        "DROP TABLE IF EXISTS chunks_vec;",
        "DROP TABLE IF EXISTS files_vec;",
        "DROP TABLE IF EXISTS card_meta;",
        "DROP TABLE IF EXISTS note_relations;",
        "DROP TABLE IF EXISTS semantic_edges;",
        "DROP TABLE IF EXISTS graph_cache;",
        "DROP TABLE IF EXISTS reconciliation_log;",
        "DROP TABLE IF EXISTS fact_history;",
        "DROP TABLE IF EXISTS knowledge_timeline;",
        "DROP TABLE IF EXISTS app_settings;",
        "DROP TABLE IF EXISTS chat_messages;",
        "DROP TABLE IF EXISTS chat_sessions;",
        "DROP TABLE IF EXISTS ai_memory;",
        "DROP TABLE IF EXISTS note_snapshots;",
        "DROP TABLE IF EXISTS chunks;",
        "DROP TABLE IF EXISTS files;", 
    ];
    for stmt in &drop_statements {
        let _ = conn.execute(stmt, []);
    }
    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
    crate::db::schema::setup_database_schema(&conn)?;
    {
        let mut s = state.scheduler.status.lock()?;
        *s = crate::scheduler::SchedulerStatus {
            running: false,
            last_run: None,
            notes_processed: 0,
            notes_reconciled: 0,
            api_calls_used: 0,
            errors: Vec::new(),
        };
    }
    log::info!("Database cleared successfully");
    Ok(())
}

/// Selective clear — only deletes the categories the user chose.
/// categories: "db_cache", "card_meta", "connections", "embeddings",
///             "settings", "chat_history", "ai_memory"
#[tauri::command]
pub fn clear_data_selective(
    state: State<'_, AppState>,
    categories: Vec<String>,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);

    for cat in &categories {
        match cat.as_str() {
            "db_cache" => {
                let _ = conn.execute("DELETE FROM files", []);
                let _ = conn.execute("DELETE FROM chunks", []);
            }
            "card_meta" => {
                let _ = conn.execute("DELETE FROM card_meta", []);
                let _ = conn.execute("DELETE FROM reconciliation_log", []);
                let _ = conn.execute("DELETE FROM fact_history", []);
                let _ = conn.execute("DELETE FROM knowledge_timeline", []);
            }
            "connections" => {
                // Clear AI-suggested relationship edges from note_relations table
                let _ = conn.execute("DELETE FROM note_relations", []);
                // Also clear semantic edges (AI-computed cosine similarity links)
                let _ = conn.execute("DELETE FROM semantic_edges", []);
                // Also clear legacy card_meta connections if any
                let _ = conn.execute("DELETE FROM card_meta WHERE key = 'connections'", []);
                // Invalidate graph cache so UI refreshes
                crate::db::search::invalidate_graph_cache(&conn);
            }
            "embeddings" => {
                let _ = conn.execute("DROP TRIGGER IF EXISTS chunks_ai;", []);
                let _ = conn.execute("DROP TRIGGER IF EXISTS chunks_ad;", []);
                let _ = conn.execute("DROP TRIGGER IF EXISTS chunks_au;", []);
                let _ = conn.execute("DROP TABLE IF EXISTS chunks_fts;", []);
                let _ = conn.execute("DROP TABLE IF EXISTS chunks_vec;", []);
                let _ = conn.execute("DELETE FROM chunks", []);
                // Re-create FTS/vec tables
                crate::db::schema::setup_database_schema(&conn)?;
            }
            "settings" => {
                let _ = conn.execute("DELETE FROM app_settings", []);
            }
            "chat_history" => {
                let _ = conn.execute("DELETE FROM chat_messages", []);
                let _ = conn.execute("DELETE FROM chat_sessions", []);
            }
            "ai_memory" => {
                let _ = conn.execute("DELETE FROM ai_memory", []);
            }
            "semantic_edges" => {
                let _ = conn.execute("DELETE FROM semantic_edges", []);
                crate::db::search::invalidate_graph_cache(&conn);
            }
            "snapshots" => {
                let _ = conn.execute("DELETE FROM note_snapshots", []);
            }
            _ => {}
        }
    }

    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
    log::info!("Selective clear completed: {:?}", categories);
    Ok(())
}

use super::DirTreeNode;

#[tauri::command]
pub fn list_directory_tree(vault_path: String) -> Result<DirTreeNode, ZettelError> {
    let root = PathBuf::from(&vault_path);
    if !root.exists() {
        return Err(ZettelError::System(format!("Vault path does not exist: {}", vault_path)));
    }
    
    fn build_dir_tree(path: &std::path::Path) -> Result<Option<DirTreeNode>, ZettelError> {
        let name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let path_str = path.to_string_lossy().to_string();

        if path.is_dir() {
            if let Some(name_str) = path.file_name().and_then(|n| n.to_str()) {
                if name_str.starts_with('.') || name_str == "node_modules" || name_str == "target" || name_str == "dist" || name_str == "build" {
                    return Ok(None);
                }
            }

            let mut children = Vec::new();
            let mut file_count = 0;
            for entry in std::fs::read_dir(path)? {
                let entry = entry?;
                if let Some(node) = build_dir_tree(&entry.path())? {
                    file_count += if node.is_dir { node.file_count } else { 1 };
                    children.push(node);
                }
            }

            children.sort_by(|a, b| {
                if a.is_dir != b.is_dir {
                    b.is_dir.cmp(&a.is_dir)
                } else {
                    a.name.to_lowercase().cmp(&b.name.to_lowercase())
                }
            });

            Ok(Some(DirTreeNode {
                name,
                path: path_str,
                is_dir: true,
                children,
                file_count,
            }))
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if matches!(ext.as_str(), "md" | "html" | "htm" | "csv" | "pdf" | "docx" | "png" | "jpg" | "jpeg" | "webp") {
                Ok(Some(DirTreeNode {
                    name,
                    path: path_str,
                    is_dir: false,
                    children: Vec::new(),
                    file_count: 0,
                }))
            } else {
                Ok(None)
            }
        } else {
            Ok(None)
        }
    }

    let tree = build_dir_tree(&root)?
        .ok_or_else(|| ZettelError::System("Failed to build directory tree".to_string()))?;
    
    Ok(tree)
}

#[tauri::command]
pub fn create_file(parent_path: String, name: String) -> Result<String, ZettelError> {
    let mut path = PathBuf::from(parent_path).join(name);
    if path.extension().map_or(true, |ext| ext != "md") {
        path.set_extension("md");
    }
    if path.exists() {
        return Err(ZettelError::System("File already exists".to_string()));
    }
    std::fs::File::create(&path)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(parent_path: String, name: String) -> Result<String, ZettelError> {
    let path = PathBuf::from(parent_path).join(name);
    if path.exists() {
        return Err(ZettelError::System("Directory already exists".to_string()));
    }
    std::fs::create_dir_all(&path)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename_path(
    state: State<'_, AppState>,
    old_path: String,
    new_name: String,
) -> Result<String, ZettelError> {
    let old = PathBuf::from(&old_path);
    if !old.exists() {
        return Err(ZettelError::System("Path does not exist".to_string()));
    }
    let parent = old.parent().ok_or_else(|| ZettelError::System("Cannot rename root".to_string()))?;
    let mut new = parent.join(new_name);
    if old.is_file() && new.extension().map_or(true, |ext| ext != "md") {
        new.set_extension("md");
    }
    if new.exists() {
        return Err(ZettelError::System("Target path already exists".to_string()));
    }
    std::fs::rename(&old, &new)?;
    
    let new_path_str = new.to_string_lossy().to_string();
    let conn = state.db.lock()?;
    if old.is_file() {
        conn.execute(
            "UPDATE files SET path = ?1 WHERE path = ?2",
            params![new_path_str, old_path],
        )?;
    } else {
        let pattern = format!("{}%", old_path);
        conn.execute(
            "UPDATE files SET path = replace(path, ?1, ?2) WHERE path LIKE ?3",
            params![old_path, new_path_str, pattern],
        )?;
    }
    crate::db::search::invalidate_graph_cache(&conn);
    
    Ok(new_path_str)
}

#[tauri::command]
pub fn move_path(
    state: State<'_, AppState>,
    source_path: String,
    target_dir: String,
) -> Result<String, ZettelError> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(ZettelError::System("Source path does not exist".to_string()));
    }

    let target_parent = PathBuf::from(&target_dir);
    if !target_parent.is_dir() {
        return Err(ZettelError::System("Target directory does not exist".to_string()));
    }

    let file_name = source.file_name()
        .ok_or_else(|| ZettelError::System("Cannot determine file name".to_string()))?;

    let destination = target_parent.join(file_name);
    if destination.exists() {
        return Err(ZettelError::System(format!(
            "A file or folder named '{}' already exists in the target directory",
            file_name.to_string_lossy()
        )));
    }

    // Don't allow moving a folder into itself or its descendants
    if source.is_dir() {
        let canon_source = source.canonicalize().unwrap_or_else(|_| source.clone());
        let canon_target = target_parent.canonicalize().unwrap_or_else(|_| target_parent.clone());
        if canon_target.starts_with(&canon_source) {
            return Err(ZettelError::System("Cannot move a folder into itself".to_string()));
        }
    }

    std::fs::rename(&source, &destination)?;

    let new_path_str = destination.to_string_lossy().to_string();
    let conn = state.db.lock()?;
    if source.is_file() {
        conn.execute(
            "UPDATE files SET path = ?1 WHERE path = ?2",
            params![new_path_str, source_path],
        )?;
        conn.execute(
            "UPDATE chunks SET file_path = ?1 WHERE file_path = ?2",
            params![new_path_str, source_path],
        )?;
    } else {
        // Update all paths under the moved directory
        let pattern = format!("{}%", source_path);
        conn.execute(
            "UPDATE files SET path = replace(path, ?1, ?2) WHERE path LIKE ?3",
            params![source_path, new_path_str, pattern],
        )?;
        conn.execute(
            "UPDATE chunks SET file_path = replace(file_path, ?1, ?2) WHERE file_path LIKE ?3",
            params![source_path, new_path_str, pattern],
        )?;
    }
    crate::db::search::invalidate_graph_cache(&conn);

    log::info!("Moved '{}' -> '{}'", source_path, new_path_str);
    Ok(new_path_str)
}

#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, path: String) -> Result<(), ZettelError> {
    let dir_path = PathBuf::from(&path);
    if dir_path.exists() {
        std::fs::remove_dir_all(&dir_path)?;
    }
    let conn = state.db.lock()?;
    let pattern = format!("{}%", path);
    conn.execute("DELETE FROM files WHERE path LIKE ?1", params![pattern])?;
    crate::db::search::invalidate_graph_cache(&conn);
    Ok(())
}

#[tauri::command]
pub fn save_image_to_vault(
    vault_path: String,
    relative_path: String,
    base64_data: String,
) -> Result<String, ZettelError> {
    use base64::Engine;
    let full_path = std::path::PathBuf::from(&vault_path).join(&relative_path);
    if let Some(parent) = full_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)?;
        }
    }
    
    let clean_base64 = if let Some(pos) = base64_data.find("base64,") {
        &base64_data[pos + 7..]
    } else {
        &base64_data
    };
    
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_base64)
        .map_err(|e| ZettelError::System(format!("Failed to decode base64: {}", e)))?;
        
    std::fs::write(&full_path, bytes)?;
    Ok(relative_path)
}

/// Import external files (HTML, CSV, MD) into the vault.
/// - `.md` files are copied directly.
/// - `.html`/`.htm` and `.csv` files: originals go to `_imports/`, companion `.md` created.
#[tauri::command]
pub fn import_files(
    vault_path: String,
    file_paths: Vec<String>,
) -> Result<Vec<crate::import::ImportResult>, ZettelError> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(ZettelError::System(format!("Vault path is not a directory: {}", vault_path)));
    }

    let mut results = Vec::new();
    for path_str in &file_paths {
        let source = PathBuf::from(path_str);
        if !source.exists() {
            results.push(crate::import::ImportResult {
                source_name: source.file_name().unwrap_or_default().to_string_lossy().to_string(),
                import_type: "unknown".to_string(),
                companion_path: None,
                success: false,
                error: Some("File does not exist".to_string()),
            });
            continue;
        }
        results.push(crate::import::import_file(&vault, &source));
    }

    let success_count = results.iter().filter(|r| r.success).count();
    log::info!("Imported {} of {} files into vault {}", success_count, results.len(), vault_path);

    Ok(results)
}

/// Open a file with the system's default application.
#[tauri::command]
pub fn open_file_external(file_path: String) -> Result<(), ZettelError> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(ZettelError::System(format!("File not found: {}", file_path)));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["shell32.dll,OpenAs_RunDLL", &file_path])
            .spawn()
            .map_err(|e| ZettelError::System(format!("Failed to open: {}", e)))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| ZettelError::System(format!("Failed to open: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| ZettelError::System(format!("Failed to open: {}", e)))?;
    }

    Ok(())
}
