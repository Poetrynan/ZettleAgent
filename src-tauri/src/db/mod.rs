pub mod schema;
pub mod sync;
pub mod search;

use rusqlite::Connection;
use std::path::Path;

/// Register sqlite-vec as an auto-extension.
/// Must be called BEFORE opening any database connection.
pub fn register_sqlite_vec() {
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

/// Initialize a database connection with sqlite-vec extension loaded
/// and schema set up. The database file is created at `db_path`.
pub fn initialize_database(db_path: &Path) -> anyhow::Result<Connection> {
    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(db_path)?;

    // Set up the database schema (tables, triggers, FTS)
    schema::setup_database_schema(&conn)?;

    // Run schema upgrade migrations to add missing columns (Fix 4)
    schema::migrate_schema_columns(&conn)?;

    // Migrate existing tables to add ON UPDATE CASCADE (idempotent)
    match schema::migrate_add_update_cascade(&conn) {
        Ok(()) => {},
        Err(e) => log::warn!("Cascade migration: {}", e),
    }

    // Migrate existing links data to note_relations table (Phase 4, idempotent)
    match schema::migrate_links_to_relations(&conn) {
        Ok(count) => {
            if count > 0 {
                log::info!("Migrated {} links to note_relations table", count);
            }
        }
        Err(e) => log::warn!("Failed to migrate links to note_relations: {}", e),
    }

    log::info!("Database initialized at {:?}", db_path);
    Ok(conn)
}
