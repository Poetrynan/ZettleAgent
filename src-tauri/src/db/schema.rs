use rusqlite::{Connection, Result};

pub fn setup_database_schema(conn: &Connection) -> Result<()> {
    // Enable foreign key support
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // P0-4: Enable WAL mode for concurrent read/write access.
    // This allows the Scheduler to write in the background without blocking
    // frontend reads. Also set a generous busy_timeout so queries wait
    // instead of failing immediately when the DB is briefly locked.
    // NOTE: Use execute_batch() instead of execute() because PRAGMA journal_mode
    // returns a result row, and rusqlite's execute() panics on returned results.
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
    conn.execute_batch("PRAGMA synchronous = NORMAL;")?;

    // Create the files table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            title TEXT,
            last_synced TEXT DEFAULT (datetime('now')),
            methodology TEXT DEFAULT 'zettelkasten'
        );",
        [],
    )?;

    // Create the chunks table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            heading_hierarchy TEXT,
            marker_type TEXT DEFAULT 'user',
            embedding BLOB,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(file_path, chunk_index)
        );",
        [],
    )?;

    // Create FTS5 virtual table for full-text search
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            content='chunks',
            content_rowid='id',
            tokenize='unicode61'
        );",
        [],
    )?;

    // Create FTS5 triggers to sync chunks and chunks_fts
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;",
        [],
    )?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;",
        [],
    )?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;",
        [],
    )?;

    // Create vector table using vec0 virtual table
    // 768 dimensions matches nomic-embed-text-v1.5 embedding model
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
            id INTEGER PRIMARY KEY,
            embedding float[768]
        );",
        [],
    )?;

    // Create card_meta table for AI-generated Zettelkasten card information
    conn.execute(
        "CREATE TABLE IF NOT EXISTS card_meta (
            file_path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            tags TEXT,
            links TEXT,
            contradictions TEXT,
            confidence REAL,
            last_reconciled TEXT,
            note_type TEXT DEFAULT 'permanent'
        );",
        [],
    )?;

    // Create reconciliation_log table for tracking AI edit actions
    conn.execute(
        "CREATE TABLE IF NOT EXISTS reconciliation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            action TEXT NOT NULL,
            diff_summary TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );",
        [],
    )?;

    // Create fact_history table for bi-temporal knowledge tracking
    conn.execute(
        "CREATE TABLE IF NOT EXISTS fact_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,
            fact_content TEXT NOT NULL,
            valid_from TEXT DEFAULT (datetime('now')),
            valid_to TEXT,
            superseded_by INTEGER,
            created_by TEXT DEFAULT 'ai',
            FOREIGN KEY (note_path) REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            FOREIGN KEY (superseded_by) REFERENCES fact_history(id)
        );",
        [],
    )?;

    // Create knowledge_timeline table for event tracking
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_timeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,
            event_type TEXT CHECK(event_type IN ('created', 'updated', 'contradicted', 'superseded')),
            event_timestamp TEXT DEFAULT (datetime('now')),
            event_details TEXT,
            old_fact_id INTEGER,
            new_fact_id INTEGER,
            FOREIGN KEY (note_path) REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            FOREIGN KEY (old_fact_id) REFERENCES fact_history(id),
            FOREIGN KEY (new_fact_id) REFERENCES fact_history(id)
        );",
        [],
    )?;

    // Create note_relations table for structured relationship storage (Phase 4)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            confidence REAL DEFAULT 0.5,
            reason TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(source_path, target_path, relation_type)
        );",
        [],
    )?;

    // Create app_settings table for persistent configuration
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );",
        [],
    )?;

    // Chat sessions for persistent conversation history
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            mode TEXT DEFAULT 'agent',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );",
        [],
    )?;

    // Chat messages within sessions
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            sources TEXT,
            tool_calls TEXT,
            thinking_content TEXT,
            agent_timeline TEXT,
            plan_steps TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );",
        [],
    )?;

    // AI long-term memory entries
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            weight REAL DEFAULT 1.0,
            source_session_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT
        );",
        [],
    )?;

    // Precomputed semantic similarity edges (KG-1 optimization)
    // Avoids O(n^2) realtime cosine similarity during get_graph_data()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            similarity REAL NOT NULL,
            computed_at TEXT DEFAULT (datetime('now')),
            UNIQUE(source_path, target_path)
        );",
        [],
    )?;

    // File-level mean-pooled embedding vectors for efficient KNN
    // Used by compute_and_store_semantic_edges to avoid O(n^2) brute-force
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS files_vec USING vec0(
            file_path TEXT PRIMARY KEY,
            embedding float[768]
        );",
        [],
    )?;

    // Cached graph data to avoid recomputing PageRank/communities on every request
    conn.execute(
        "CREATE TABLE IF NOT EXISTS graph_cache (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            serialized_data BLOB NOT NULL,
            node_count INTEGER NOT NULL DEFAULT 0,
            edge_count INTEGER NOT NULL DEFAULT 0,
            computed_at TEXT DEFAULT (datetime('now'))
        );",
        [],
    )?;

    // P1-6: Add B-tree indexes on commonly queried columns for performance
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_relations_source ON note_relations(source_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_relations_target ON note_relations(target_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_semantic_edges_source ON semantic_edges(source_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_semantic_edges_target ON semantic_edges(target_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_fact_history_note ON fact_history(note_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_timeline_note ON knowledge_timeline(note_path);",
        [],
    )?;

    // Create note_snapshots table for user-edit version history (persistent across app restarts)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            content TEXT NOT NULL,
            content_length INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            created_at_ms INTEGER NOT NULL
        );",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_snapshots_file ON note_snapshots(file_path);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_snapshots_time ON note_snapshots(created_at_ms);",
        [],
    )?;

    Ok(())
}

/// Migrate schema columns by idempotently adding any columns that might be missing in older database versions (Fix 4).
pub fn migrate_schema_columns(conn: &Connection) -> Result<()> {
    // Ignore errors for existing columns
    let _ = conn.execute("ALTER TABLE files ADD COLUMN methodology TEXT DEFAULT 'zettelkasten';", []);
    let _ = conn.execute("ALTER TABLE chunks ADD COLUMN marker_type TEXT DEFAULT 'user';", []);
    let _ = conn.execute("ALTER TABLE chunks ADD COLUMN created_at TEXT DEFAULT (datetime('now'));", []);
    let _ = conn.execute("ALTER TABLE chunks ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));", []);
    let _ = conn.execute("ALTER TABLE card_meta ADD COLUMN note_type TEXT DEFAULT 'permanent';", []);
    let _ = conn.execute("ALTER TABLE card_meta ADD COLUMN last_reconciled_hash TEXT;", []);
    let _ = conn.execute("ALTER TABLE card_meta ADD COLUMN last_reconciled_methodology TEXT;", []);
    let _ = conn.execute("ALTER TABLE note_relations ADD COLUMN confidence REAL DEFAULT 0.5;", []);
    let _ = conn.execute("ALTER TABLE note_relations ADD COLUMN reason TEXT;", []);
    let _ = conn.execute("ALTER TABLE note_relations ADD COLUMN created_at TEXT DEFAULT (datetime('now'));", []);
    let _ = conn.execute("ALTER TABLE chat_sessions ADD COLUMN mode TEXT DEFAULT 'agent';", []);
    let _ = conn.execute("ALTER TABLE chat_sessions ADD COLUMN created_at TEXT DEFAULT (datetime('now'));", []);
    let _ = conn.execute("ALTER TABLE chat_sessions ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));", []);
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN sources TEXT;", []);
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN tool_calls TEXT;", []);
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN created_at TEXT DEFAULT (datetime('now'));", []);
    // Agent trace persistence: full thought chain + tool timeline (Cursor-style history restore)
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN thinking_content TEXT;", []);
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN agent_timeline TEXT;", []);
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN plan_steps TEXT;", []);
    
    // Also include ensure_fact_history_table's migrations
    let _ = conn.execute("ALTER TABLE fact_history ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;", []);
    let _ = conn.execute("ALTER TABLE fact_history ADD COLUMN category TEXT NOT NULL DEFAULT 'claim';", []);
    let _ = conn.execute("ALTER TABLE fact_history ADD COLUMN extraction_time TEXT NOT NULL DEFAULT (datetime('now'));", []);
    let _ = conn.execute("ALTER TABLE fact_history ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;", []);

    Ok(())
}

/// Migrate vec0 tables to 768 dimensions (nomic-embed-text-v1.5).
/// Safe to call on every startup — recreates vec tables if dimension differs.
pub fn migrate_vec_dimensions(conn: &Connection) -> Result<bool> {
    // Check if chunks_vec exists and what dimension it uses
    let table_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
            [],
            |row| row.get(0),
        )
        .ok();

    match table_sql {
        Some(sql) if !sql.contains("float[768]") => {
            log::info!("Migrating vector tables to 768 dimensions...");

            // Drop old vec tables and recreate with 768 dims
            conn.execute("DROP TABLE IF EXISTS chunks_vec;", [])?;
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                    id INTEGER PRIMARY KEY,
                    embedding float[768]
                );",
                [],
            )?;

            conn.execute("DROP TABLE IF EXISTS files_vec;", [])?;
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS files_vec USING vec0(
                    file_path TEXT PRIMARY KEY,
                    embedding float[768]
                );",
                [],
            )?;

            // Clear all stored embeddings to force re-computation
            conn.execute("UPDATE chunks SET embedding = NULL;", [])?;
            conn.execute("DELETE FROM semantic_edges;", [])?;

            log::info!("Vec dimension migration complete. All embeddings cleared for re-indexing.");
            Ok(true) // Migration happened
        }
        _ => Ok(false), // Already 768 or table doesn't exist yet
    }
}

/// Migrate existing tables to add ON UPDATE CASCADE.
/// SQLite can't ALTER constraints, so we recreate affected tables.
/// Safe to call on every startup — skips if already migrated.
pub fn migrate_add_update_cascade(conn: &Connection) -> Result<()> {
    // Check if migration is needed by looking at the schema SQL
    let chunks_sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks'",
        [],
        |row| row.get(0),
    ).unwrap_or_default();

    if chunks_sql.contains("ON UPDATE CASCADE") {
        return Ok(()); // Already migrated
    }

    conn.execute("PRAGMA foreign_keys = OFF;", [])?;
    conn.execute_batch("BEGIN TRANSACTION;")?;

    // ── chunks ──
    conn.execute_batch("
        CREATE TABLE chunks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            heading_hierarchy TEXT,
            marker_type TEXT DEFAULT 'user',
            embedding BLOB,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(file_path, chunk_index)
        );
        INSERT INTO chunks_new SELECT * FROM chunks;
        DROP TABLE chunks;
        ALTER TABLE chunks_new RENAME TO chunks;
    ")?;

    // Recreate FTS triggers (they reference 'chunks' by name)
    conn.execute_batch("
        DROP TRIGGER IF EXISTS chunks_ai;
        DROP TRIGGER IF EXISTS chunks_ad;
        DROP TRIGGER IF EXISTS chunks_au;
        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
    ")?;

    // ── card_meta ──
    conn.execute_batch("
        CREATE TABLE card_meta_new (
            file_path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            tags TEXT,
            links TEXT,
            contradictions TEXT,
            confidence REAL,
            last_reconciled TEXT,
            note_type TEXT DEFAULT 'permanent'
        );
        INSERT INTO card_meta_new SELECT * FROM card_meta;
        DROP TABLE card_meta;
        ALTER TABLE card_meta_new RENAME TO card_meta;
    ")?;

    // ── fact_history ──
    conn.execute_batch("
        CREATE TABLE fact_history_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,
            fact_content TEXT NOT NULL,
            valid_from TEXT DEFAULT (datetime('now')),
            valid_to TEXT,
            superseded_by INTEGER,
            created_by TEXT DEFAULT 'ai',
            FOREIGN KEY (note_path) REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            FOREIGN KEY (superseded_by) REFERENCES fact_history_new(id)
        );
        INSERT INTO fact_history_new SELECT * FROM fact_history;
        DROP TABLE fact_history;
        ALTER TABLE fact_history_new RENAME TO fact_history;
    ")?;

    // ── knowledge_timeline ──
    conn.execute_batch("
        CREATE TABLE knowledge_timeline_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,
            event_type TEXT CHECK(event_type IN ('created', 'updated', 'contradicted', 'superseded')),
            event_timestamp TEXT DEFAULT (datetime('now')),
            event_details TEXT,
            old_fact_id INTEGER,
            new_fact_id INTEGER,
            FOREIGN KEY (note_path) REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            FOREIGN KEY (old_fact_id) REFERENCES fact_history(id),
            FOREIGN KEY (new_fact_id) REFERENCES fact_history(id)
        );
        INSERT INTO knowledge_timeline_new SELECT * FROM knowledge_timeline;
        DROP TABLE knowledge_timeline;
        ALTER TABLE knowledge_timeline_new RENAME TO knowledge_timeline;
    ")?;

    conn.execute_batch("COMMIT;")?;
    conn.execute("PRAGMA foreign_keys = ON;", [])?;

    Ok(())
}

/// Migrate existing card_meta.links data into note_relations table.
/// Safe to call multiple times (uses INSERT OR IGNORE).
pub fn migrate_links_to_relations(conn: &Connection) -> Result<usize> {
    use crate::db::search::SuggestedLink;

    let mut stmt = conn.prepare(
        "SELECT file_path, links FROM card_meta WHERE links IS NOT NULL AND links != '[]'",
    )?;

    let mut count = 0usize;

    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (file_path, links_json) in rows {
        if let Ok(links) = serde_json::from_str::<Vec<SuggestedLink>>(&links_json) {
            for link in &links {
                let target = link.target();
                let relation = link.relation().unwrap_or("related");
                let reason = match link {
                    SuggestedLink::Detailed { reason, .. } => reason.as_deref().unwrap_or(""),
                    _ => "",
                };
                let conf = link.confidence();

                let target_clean = target
                    .trim_start_matches("[[")
                    .trim_end_matches("]]")
                    .trim();

                // Try to find the actual file path for this target, prioritizing the same vault
                let target_path = find_file_path_for_title_prioritized(conn, target_clean, Some(&file_path))
                    .unwrap_or_else(|| target_clean.to_string());

                let _ = conn.execute(
                    "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        file_path,
                        target_path,
                        relation,
                        conf,
                        reason
                    ],
                );
                count += 1;
            }
        }
    }

    Ok(count)
}

/// Helper: find a file path in the files table that matches a title, prioritizing the current vault path.
pub fn find_file_path_for_title_prioritized(conn: &Connection, title: &str, current_file_path: Option<&str>) -> Option<String> {
    let title_lower = title.to_lowercase();
    let mut stmt = conn.prepare("SELECT path, title FROM files").ok()?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    let mut best_match: Option<String> = None;
    let mut max_common_len = 0;

    for (path, file_title) in &rows {
        let mut matches = false;
        if let Some(ft) = file_title {
            if ft.to_lowercase() == title_lower {
                matches = true;
            }
        }
        if !matches {
            let filename = path.replace('\\', "/");
            let basename = filename.rsplit('/').next().unwrap_or(path).to_lowercase();
            let basename_no_ext = basename.strip_suffix(".md").unwrap_or(&basename);
            if basename_no_ext == title_lower {
                matches = true;
            }
        }

        if matches {
            if let Some(curr_path) = current_file_path {
                let common_len = common_directory_prefix_len(path, curr_path);
                if best_match.is_none() || common_len > max_common_len {
                    max_common_len = common_len;
                    best_match = Some(path.clone());
                }
            } else {
                return Some(path.clone());
            }
        }
    }
    best_match
}

fn common_directory_prefix_len(p1: &str, p2: &str) -> usize {
    let p1_clean = p1.replace('\\', "/");
    let p2_clean = p2.replace('\\', "/");
    let mut len = 0;
    for (c1, c2) in p1_clean.chars().zip(p2_clean.chars()) {
        if c1 == c2 {
            len += 1;
        } else {
            break;
        }
    }
    // We only care about directory levels, so find the last slash in the common prefix
    let common_prefix = &p1_clean[..len];
    if let Some(slash_idx) = common_prefix.rfind('/') {
        slash_idx + 1
    } else {
        0
    }
}

/// Helper: find a file path in the files table that matches a title.
/// Used by reconcile_task to resolve LLM-generated [[wikilink]] titles to actual file paths.
pub fn find_file_path_for_title(conn: &Connection, title: &str) -> Option<String> {
    find_file_path_for_title_prioritized(conn, title, None)
}

/// Get a setting value from app_settings
pub fn get_setting(conn: &Connection, key: &str) -> anyhow::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1")?;
    let mut rows = stmt.query_map(rusqlite::params![key], |row| row.get::<_, String>(0))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Ensure fact_history table has the extended columns needed by extract_facts / query_temporal.
/// Adds missing columns (confidence, category, extraction_time, is_current) if they don't exist.
pub fn ensure_fact_history_table(conn: &Connection) -> anyhow::Result<()> {
    migrate_schema_columns(conn).map_err(|e| anyhow::anyhow!(e))
}

/// Set a setting value in app_settings
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

