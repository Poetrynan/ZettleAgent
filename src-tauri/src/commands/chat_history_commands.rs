use tauri::State;
use crate::AppState;
use crate::error::ZettelError;
use crate::db::schema;
use serde::{Deserialize, Serialize};
use rusqlite::params;

// ── Types ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub sources: Option<String>,
    pub tool_calls: Option<String>,
    /// Separated chain-of-thought (agent narration), JSON-free plain text
    pub thinking_content: Option<String>,
    /// Full agent timeline (thinking + tool calls + text interleaved), JSON array
    pub agent_timeline: Option<String>,
    /// Live plan from the model's `todo_write` tool, JSON array of {text, status}
    pub plan_steps: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMemoryEntry {
    pub id: i64,
    pub content: String,
    pub category: String,
    pub weight: f64,
    pub source_session_id: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

// ── Session Commands ───────────────────────────────────────────────

#[tauri::command]
pub fn list_chat_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<ChatSession>, ZettelError> {
    let conn = state.db.lock()?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.title, s.mode, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages WHERE session_id = s.id) as msg_count
         FROM chat_sessions s
         ORDER BY s.updated_at DESC"
    )?;

    let results = stmt
        .query_map([], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                mode: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn get_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ChatMessageRecord>, ZettelError> {
    let conn = state.db.lock()?;
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, sources, tool_calls, thinking_content, agent_timeline, plan_steps, created_at
         FROM chat_messages
         WHERE session_id = ?1
         ORDER BY created_at ASC"
    )?;

    let results = stmt
        .query_map(params![session_id], |row| {
            Ok(ChatMessageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                sources: row.get(4)?,
                tool_calls: row.get(5)?,
                thinking_content: row.get(6)?,
                agent_timeline: row.get(7)?,
                plan_steps: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn create_chat_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
    mode: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "INSERT INTO chat_sessions (id, title, mode) VALUES (?1, ?2, ?3)",
        params![id, title, mode],
    )?;
    Ok(())
}

#[tauri::command]
pub fn save_chat_message(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
    role: String,
    content: String,
    sources: Option<String>,
    tool_calls: Option<String>,
    thinking_content: Option<String>,
    agent_timeline: Option<String>,
    plan_steps: Option<String>,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;

    // Auto-create session if it doesn't exist
    conn.execute(
        "INSERT OR IGNORE INTO chat_sessions (id, title, mode)
         VALUES (?1, ?2, 'agent')",
        params![session_id, content.chars().take(30).collect::<String>()],
    )?;

    conn.execute(
        "INSERT OR REPLACE INTO chat_messages (id, session_id, role, content, sources, tool_calls, thinking_content, agent_timeline, plan_steps)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, session_id, role, content, sources, tool_calls, thinking_content, agent_timeline, plan_steps],
    )?;

    // Update session timestamp
    conn.execute(
        "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?1",
        params![session_id],
    )?;

    Ok(())
}

#[tauri::command]
pub fn delete_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![session_id])?;
    Ok(())
}

#[tauri::command]
pub fn rename_chat_session(
    state: State<'_, AppState>,
    session_id: String,
    new_title: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "UPDATE chat_sessions SET title = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![session_id, new_title],
    )?;
    Ok(())
}

// ── Export Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn export_chat_session(
    state: State<'_, AppState>,
    session_id: String,
    format: String,
    export_path: String,
) -> Result<String, ZettelError> {
    let conn = state.db.lock()?;

    // Get session info
    let session: ChatSession = conn.query_row(
        "SELECT id, title, mode, created_at, updated_at, 0 FROM chat_sessions WHERE id = ?1",
        params![session_id],
        |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                mode: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
            })
        },
    ).map_err(|_| ZettelError::System("Session not found".to_string()))?;

    // Get messages
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, sources, tool_calls, thinking_content, agent_timeline, plan_steps, created_at
         FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC"
    )?;
    let messages: Vec<ChatMessageRecord> = stmt
        .query_map(params![session_id], |row| {
            Ok(ChatMessageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                sources: row.get(4)?,
                tool_calls: row.get(5)?,
                thinking_content: row.get(6)?,
                agent_timeline: row.get(7)?,
                plan_steps: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    let export_dir = std::path::Path::new(&export_path);
    std::fs::create_dir_all(export_dir)
        .map_err(|e| ZettelError::System(format!("Cannot create export dir: {}", e)))?;

    let safe_title = session.title.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");

    match format.as_str() {
        "markdown" | "md" => {
            let mut md = format!("# {}\n\n", session.title);
            md.push_str(&format!("- **模式**: {}\n", session.mode));
            md.push_str(&format!("- **创建时间**: {}\n", session.created_at));
            md.push_str(&format!("- **消息数**: {}\n\n---\n\n", messages.len()));

            for msg in &messages {
                let role_label = match msg.role.as_str() {
                    "user" => "👤 用户",
                    "assistant" => "🤖 AI",
                    _ => &msg.role,
                };
                md.push_str(&format!("### {} ({})\n\n{}\n\n", role_label, msg.created_at, msg.content));
            }

            let file_path = export_dir.join(format!("{}.md", safe_title));
            std::fs::write(&file_path, &md)
                .map_err(|e| ZettelError::System(format!("Write failed: {}", e)))?;
            Ok(file_path.to_string_lossy().to_string())
        }
        "json" => {
            let export_data = serde_json::json!({
                "session": session,
                "messages": messages,
            });
            let file_path = export_dir.join(format!("{}.json", safe_title));
            std::fs::write(&file_path, serde_json::to_string_pretty(&export_data)?)
                .map_err(|e| ZettelError::System(format!("Write failed: {}", e)))?;
            Ok(file_path.to_string_lossy().to_string())
        }
        _ => Err(ZettelError::System(format!("Unknown format: {}", format))),
    }
}

#[tauri::command]
pub fn export_all_sessions(
    state: State<'_, AppState>,
    format: String,
    export_path: String,
) -> Result<Vec<String>, ZettelError> {
    let sessions = list_chat_sessions(state.clone())?;
    let mut paths = Vec::new();
    for session in &sessions {
        let path = export_chat_session(
            state.clone(),
            session.id.clone(),
            format.clone(),
            export_path.clone(),
        )?;
        paths.push(path);
    }
    Ok(paths)
}

// ── AI Memory Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn get_ai_memories(
    state: State<'_, AppState>,
) -> Result<Vec<AiMemoryEntry>, ZettelError> {
    let conn = state.db.lock()?;
    let mut stmt = conn.prepare(
        "SELECT id, content, category, weight, source_session_id, created_at, expires_at
         FROM ai_memory
         WHERE expires_at IS NULL OR expires_at > datetime('now')
         ORDER BY weight DESC, created_at DESC"
    )?;

    let results = stmt
        .query_map([], |row| {
            Ok(AiMemoryEntry {
                id: row.get(0)?,
                content: row.get(1)?,
                category: row.get(2)?,
                weight: row.get(3)?,
                source_session_id: row.get(4)?,
                created_at: row.get(5)?,
                expires_at: row.get(6)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn add_ai_memory(
    state: State<'_, AppState>,
    content: String,
    category: Option<String>,
    source_session_id: Option<String>,
) -> Result<i64, ZettelError> {
    let conn = state.db.lock()?;
    let cat = category.unwrap_or_else(|| "general".to_string());

    conn.execute(
        "INSERT INTO ai_memory (content, category, source_session_id)
         VALUES (?1, ?2, ?3)",
        params![content, cat, source_session_id],
    )?;

    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn delete_ai_memory(
    state: State<'_, AppState>,
    memory_id: i64,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute("DELETE FROM ai_memory WHERE id = ?1", params![memory_id])?;
    Ok(())
}

/// Get active memories as strings (for injection into system prompt)
pub fn get_memory_strings(
    conn: &rusqlite::Connection,
    limit: usize,
) -> Vec<String> {
    let result: Result<Vec<String>, _> = (|| {
        let mut stmt = conn.prepare(
            "SELECT content FROM ai_memory
             WHERE expires_at IS NULL OR expires_at > datetime('now')
             ORDER BY weight DESC, created_at DESC
             LIMIT ?1"
        )?;
        let rows: Vec<String> = stmt
            .query_map(params![limit as i64], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .filter(|s| !s.is_empty())
            .collect();
        Ok::<_, rusqlite::Error>(rows)
    })();

    result.unwrap_or_default()
}

/// Save a setting (convenience re-export)
#[allow(dead_code)]
pub fn save_chat_setting(
    conn: &rusqlite::Connection,
    key: &str,
    value: &str,
) -> anyhow::Result<()> {
    schema::set_setting(conn, key, value)
}

// ── App Settings Commands ──────────────────────────────────────────

#[tauri::command]
pub fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, ZettelError> {
    let conn = state.db.lock()?;
    let val = schema::get_setting(&conn, &key)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(val)
}

#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    schema::set_setting(&conn, &key, &value)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(())
}
