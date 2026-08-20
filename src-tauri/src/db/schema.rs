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

    // Content-addressed embedding cache.
    //
    // `sync_file` deletes and re-inserts every chunk of a touched file, so
    // without this table an unrelated one-line edit forces re-embedding of
    // the whole file. Keying vectors by SHA-256 of the chunk text lets
    // unchanged chunks be backfilled instantly and for free — and also
    // deduplicates byte-identical chunks across different notes.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS embedding_cache (
            content_hash TEXT PRIMARY KEY,
            embedding BLOB NOT NULL,
            dim INTEGER NOT NULL,
            hits INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            last_used_at TEXT DEFAULT (datetime('now'))
        );",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used ON embedding_cache(last_used_at);",
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
            computed_at TEXT DEFAULT (datetime('now')),
            content_fingerprint TEXT
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

    // Per-agent-run change journal — the backing store for "undo this whole turn".
    //
    // `note_snapshots` alone only supports one-note-at-a-time restores from the version
    // history UI. One row here per file mutation an Agent turn performed, keyed by the
    // run id, so the entire turn can be rolled back in reverse `seq` order.
    //
    // `file_path` / `new_path` use the same key shape as `note_snapshots.file_path`
    // (see `tools::internal_tools::helpers::snapshot_path_key`).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_run_journal (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id        TEXT NOT NULL,
            seq           INTEGER NOT NULL,
            tool_name     TEXT NOT NULL,
            op            TEXT NOT NULL,
            file_path     TEXT NOT NULL,
            new_path      TEXT,
            snapshot_id   INTEGER,
            trash_path    TEXT,
            created_at_ms INTEGER NOT NULL,
            undone        INTEGER NOT NULL DEFAULT 0
        );",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_run_journal_run ON agent_run_journal(run_id, seq);",
        [],
    )?;

    // User-authored approval allow rules — the "stop asking me about this" table.
    //
    // Matching (see `llm::approval::matching_rule`): tool_name equal (or the
    // wildcard '*') AND the target's vault-relative path starts with path_prefix
    // ('' = no restriction) AND the call's effective risk <= max_risk.
    //
    // `max_risk` is never 'critical': deletion always requires an explicit
    // confirmation, so no rule may waive it (enforced in `add_approval_rule_db`).
    // `scope='session'` rows are deleted at startup (`cleanup_session_rules`).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS approval_rules (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_name     TEXT NOT NULL,
            path_prefix   TEXT NOT NULL,
            max_risk      TEXT NOT NULL,
            scope         TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            note          TEXT
        );",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_approval_rules_tool ON approval_rules(tool_name);",
        [],
    )?;

    // ── Spaced repetition (FSRS-4.5) ──
    //
    // One row per note the user has put in the review deck. Keyed by
    // `files(path)` with the same FK shape as `card_meta`, because `file_path`
    // is the only stable note identity in this schema: ON UPDATE CASCADE makes a
    // rename carry the schedule with it, ON DELETE CASCADE stops a deleted note
    // from haunting the queue.
    //
    // `state`/`suspended` are separate concepts on purpose: suspending is a user
    // action ("stop showing me this") and must not destroy the FSRS state it
    // would take months to rebuild.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS review_cards (
            file_path       TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
            stability       REAL NOT NULL DEFAULT 0,
            difficulty      REAL NOT NULL DEFAULT 0,
            due_at_ms       INTEGER NOT NULL,
            last_review_ms  INTEGER,
            reps            INTEGER NOT NULL DEFAULT 0,
            lapses          INTEGER NOT NULL DEFAULT 0,
            state           TEXT NOT NULL DEFAULT 'new',
            suspended       INTEGER NOT NULL DEFAULT 0,
            created_at_ms   INTEGER NOT NULL
        );",
        [],
    )?;
    // The due-queue query (`due_at_ms <= now ORDER BY due_at_ms`) runs on every
    // session start and is the only hot path in this feature.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_review_cards_due ON review_cards(due_at_ms);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_review_cards_state ON review_cards(state);",
        [],
    )?;

    // Append-only grade history. Two jobs: it powers the stats/forecast view, and
    // it is exactly the dataset an FSRS parameter optimiser would need if one is
    // ever added — which is why the before/after columns are stored rather than
    // recomputed.
    //
    // Deliberately NO foreign key on `file_path`, unlike `review_cards`. Cascading
    // would mean deleting a note silently rewrites the user's retention rate and
    // streak for every past day, and those are aggregate facts about the user's
    // study history, not about the note. Same call `note_snapshots` and
    // `reconciliation_log` already make. The cost is that a rename leaves stale
    // keys here, so per-note history is best-effort while the aggregates are exact.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS review_log (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path         TEXT NOT NULL,
            grade             INTEGER NOT NULL,
            reviewed_at_ms    INTEGER NOT NULL,
            elapsed_days      REAL NOT NULL DEFAULT 0,
            scheduled_days    REAL NOT NULL DEFAULT 0,
            stability_before  REAL,
            stability_after   REAL,
            difficulty_before REAL,
            difficulty_after  REAL,
            state_before      TEXT,
            state_after       TEXT
        );",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_review_log_file ON review_log(file_path, reviewed_at_ms);",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_review_log_time ON review_log(reviewed_at_ms);",
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

    // Graph cache staleness fingerprint (see `search::graph_input_fingerprint`).
    // Deliberately nullable: an existing row written by an older build has no
    // fingerprint, and `get_graph_data` must read that NULL as "unknown ⇒ stale"
    // and recompute once, never as a match.
    let _ = conn.execute("ALTER TABLE graph_cache ADD COLUMN content_fingerprint TEXT;", []);

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
///
/// Returns the number of relations actually written. Entries whose target cannot
/// be resolved to a real note are **skipped** — see [`resolve_relation_target`].
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

    // 建一次表复用 / one resolution table for the whole migration. The old code
    // called `find_file_path_for_title_prioritized` inside the loop, and that
    // function does a full `SELECT path, title FROM files` every call — the
    // migration was O(links × files) on a vault where both grow together. The
    // resolver is one pass over `files` plus a hash lookup per link.
    let resolver = crate::db::wikilink::LinkResolver::from_files(conn)?;

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

                let Some(target_path) =
                    resolve_relation_target(&resolver, target, &file_path)
                else {
                    continue;
                };

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

/// `card_meta.links` 的一条 target → `note_relations.target_path`。
/// Resolve one `card_meta.links` target into a `note_relations.target_path`.
///
/// Shared by this module's migration and `scheduler::reconcile_task`, the only
/// two places that write `note_relations` from LLM output, so the两处 cannot drift.
///
/// ## 两个必须一起做的修正 / the two fixes this encodes
///
/// **1. 先切 `|别名` / `#小节`.** Both writers used a bare
/// `trim_start_matches("[[")`, so an LLM emitting `"[[知识图谱|图谱]]"` (the shape
/// the prompts invite, since they tell it to copy the exact title and the body
/// spells links that way) produced the lookup key `知识图谱|图谱`, which matches no
/// note. `parse_link_target` cuts the decorations first.
///
/// **2. 匹配不到就不写 / an unresolved target is not written at all.** The old code
/// ended in `.unwrap_or_else(|| target_clean.to_string())`, i.e. on a failed match
/// it stored the *link text* in a column that every reader treats as a file path.
/// That fabricates a 幽灵节点 / ghost node visible to everything reading
/// `note_relations`: the graph's relation edges, backlinks, related-notes, the
/// health desk, `analyze_workspace`'s relation counts, and `lint`'s
/// unidirectional-relation report (a ghost can never have a reverse edge, so it is
/// permanently listed as a defect). Combined with fix 1 it was worse than a
/// missing note: `知识图谱|图谱` is neither a path nor a title.
///
/// 为什么不怕丢掉「链接到尚未创建的笔记」/ why dropping forward references is safe:
/// `note_relations` is **derived** data — `card_meta.links` remains the record of
/// what the LLM proposed, this function is `INSERT OR IGNORE` and idempotent, and
/// broken-link reporting does not read this table at all (`lint::run_vault_lint`
/// scans note text against `files` titles, lint.rs:270-304). So a link to a note
/// that does not exist yet is still reported as broken by the feature that owns
/// that job, and the relation appears as soon as the target exists and the source
/// is reconciled again. 宁缺勿脏 / a missing derived row is recoverable; a row
/// pointing at a path that does not exist corrupts every consumer.
pub fn resolve_relation_target(
    resolver: &crate::db::wikilink::LinkResolver,
    raw_target: &str,
    source_path: &str,
) -> Option<String> {
    let target = crate::db::wikilink::parse_link_target(raw_target)?;
    // `resolve_near`: 同 vault 优先 / same-vault first, which is the tie-break this
    // write path has always used. It now comes from the shared resolver, so the
    // read side answers "which note is `[[X]]`?" the same way.
    resolver
        .resolve_near(&target, Some(source_path))
        .map(|s| s.to_string())
}

/// Helper: find a file path in the files table that matches a title, prioritizing the current vault path.
///
/// Kept as a thin wrapper over the shared resolver: the collision rule (同 vault
/// 优先, then lowest path) used to live only here, which meant a multi-vault user
/// could get one answer when a relation was *written* and a different one when the
/// same link was *read* by the panel/graph/health views. There is now one rule, in
/// `db::wikilink::LinkResolver`.
///
/// Note this builds a resolution table per call (one pass over `files`), exactly
/// like the hand-rolled scan it replaces. Loops should build a `LinkResolver` once
/// and call `resolve_near` directly.
pub fn find_file_path_for_title_prioritized(conn: &Connection, title: &str, current_file_path: Option<&str>) -> Option<String> {
    let resolver = crate::db::wikilink::LinkResolver::from_files(conn).ok()?;
    let target = crate::db::wikilink::parse_link_target(title)?;
    resolver
        .resolve_near(&target, current_file_path)
        .map(|s| s.to_string())
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

// ── Tests ───────────────────────────────────────────────────────────────────
//
// These pin the two `note_relations` write-side guarantees: the target is parsed
// before it is looked up, and an unresolvable target is not written at all.

#[cfg(test)]
mod relation_target_tests {
    use super::*;
    use rusqlite::params;

    /// Production runs both schema functions (db/mod.rs:35); a fixture that only
    /// runs the first drifts from the real schema.
    fn test_db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        setup_database_schema(&conn).unwrap();
        migrate_schema_columns(&conn).unwrap();
        conn
    }

    fn add_file(conn: &Connection, path: &str, title: &str) {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, 'h', ?2)",
            params![path, title],
        )
        .unwrap();
    }

    fn set_links(conn: &Connection, path: &str, links_json: &str) {
        conn.execute(
            "INSERT INTO card_meta (file_path, links) VALUES (?1, ?2)
             ON CONFLICT(file_path) DO UPDATE SET links = ?2",
            params![path, links_json],
        )
        .unwrap();
    }

    fn targets_of(conn: &Connection, source: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT target_path FROM note_relations WHERE source_path = ?1 ORDER BY target_path")
            .unwrap();
        stmt.query_map(params![source], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// 别名写法必须落到真实路径 / an aliased target lands on the real note path.
    ///
    /// The bug: `"[[知识图谱|图谱]]"` was only `trim_start_matches("[[")`-ed, so the
    /// lookup key was `知识图谱|图谱`, nothing matched, and the fallback stored that
    /// literal string in `target_path` — a 幽灵节点 for every reader.
    #[test]
    fn aliased_target_resolves_to_the_real_note_path() {
        let conn = test_db();
        add_file(&conn, "d:/vault/知识图谱.md", "知识图谱");
        add_file(&conn, "d:/vault/源.md", "源");
        set_links(
            &conn,
            "d:/vault/源.md",
            r#"["[[知识图谱|图谱]]", "[[知识图谱#定义]]"]"#,
        );

        migrate_links_to_relations(&conn).unwrap();

        assert_eq!(
            targets_of(&conn, "d:/vault/源.md"),
            vec!["d:/vault/知识图谱.md".to_string()],
            "both spellings resolve to the one real path, deduped by INSERT OR IGNORE"
        );
        // The specific string that used to be stored must not exist anywhere.
        let ghosts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_relations nr
                 WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.path = nr.target_path)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghosts, 0, "no relation may point at a non-existent path");
    }

    /// 匹配不到就不写 / an unresolvable target writes no row.
    ///
    /// This locks the decision to drop the old `unwrap_or_else(|| target_clean)`
    /// fallback. `note_relations` is derived data and this migration is idempotent,
    /// so the relation appears once the note exists; broken-link *reporting* reads
    /// note text, not this table, so nothing is lost by staying silent here.
    #[test]
    fn unresolvable_target_is_not_written_at_all() {
        let conn = test_db();
        add_file(&conn, "d:/vault/源.md", "源");
        set_links(&conn, "d:/vault/源.md", r#"["[[尚未创建的笔记]]", "[[]]"]"#);

        let written = migrate_links_to_relations(&conn).unwrap();
        assert_eq!(written, 0, "nothing resolvable ⇒ nothing written");
        assert!(targets_of(&conn, "d:/vault/源.md").is_empty());

        // …and it does appear once the target exists, so this is a deferral, not a loss.
        add_file(&conn, "d:/vault/尚未创建的笔记.md", "尚未创建的笔记");
        assert_eq!(migrate_links_to_relations(&conn).unwrap(), 1);
        assert_eq!(
            targets_of(&conn, "d:/vault/源.md"),
            vec!["d:/vault/尚未创建的笔记.md".to_string()]
        );
    }

    /// 多 vault：写侧与读侧同一裁决 / the write side uses the shared same-vault rule.
    #[test]
    fn same_vault_wins_when_two_vaults_hold_the_same_title() {
        let conn = test_db();
        add_file(&conn, "d:/vaultA/项目笔记.md", "项目笔记");
        add_file(&conn, "d:/vaultB/项目笔记.md", "项目笔记");
        add_file(&conn, "d:/vaultB/源.md", "源");
        set_links(&conn, "d:/vaultB/源.md", r#"["[[项目笔记]]"]"#);

        migrate_links_to_relations(&conn).unwrap();
        assert_eq!(
            targets_of(&conn, "d:/vaultB/源.md"),
            vec!["d:/vaultB/项目笔记.md".to_string()],
            "the relation stays inside the linking note's own vault"
        );
    }
}

