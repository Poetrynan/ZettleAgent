use rusqlite::{Connection, params};
use sha2::{Sha256, Digest};
use std::path::Path;
use std::fs;
use crate::chunker::{ChunkerConfig, chunk_markdown};

/// Compute SHA-256 hash of file contents
pub fn compute_file_hash(path: &Path) -> anyhow::Result<String> {
    let content = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Parsed YAML frontmatter fields.
#[derive(Debug, Default)]
struct Frontmatter {
    note_type: Option<String>,
    tags: Option<Vec<String>>,
    created: Option<String>,
}

/// Parse YAML frontmatter from markdown content.
/// Expects `---` delimiters on the first line and a closing `---`.
/// Returns None if no valid frontmatter block is found.
fn parse_frontmatter(content: &str) -> Option<Frontmatter> {
    let mut lines = content.lines();

    // First line must be exactly `---`
    let first = lines.next()?.trim();
    if first != "---" {
        return None;
    }

    let mut fm = Frontmatter::default();
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            // End of frontmatter block
            // Only return if we found at least one field
            if fm.note_type.is_some() || fm.tags.is_some() || fm.created.is_some() {
                return Some(fm);
            }
            return None;
        }

        // Parse `key: value` pairs
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim().to_lowercase();
            let value = value.trim();

            match key.as_str() {
                "type" => {
                    if !value.is_empty() {
                        fm.note_type = Some(value.to_string());
                    }
                }
                "tags" => {
                    fm.tags = parse_tags_value(value);
                }
                "created" | "date" => {
                    if !value.is_empty() {
                        fm.created = Some(value.to_string());
                    }
                }
                _ => {} // Ignore unknown keys
            }
        }
    }

    // Reached EOF without closing `---` — malformed, ignore
    None
}

/// Parse a YAML tags value. Supports:
/// - `[AI, NLP, deep-learning]`
/// - `[AI, "deep learning"]`
fn parse_tags_value(value: &str) -> Option<Vec<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Strip surrounding brackets
    let inner = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        // Single tag without brackets
        return Some(vec![trimmed.to_string()]);
    };

    let tags: Vec<String> = inner
        .split(',')
        .map(|t| t.trim().trim_matches('"').trim_matches('\'').trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    if tags.is_empty() { None } else { Some(tags) }
}

/// Sync a single file into the database using hash comparison.
/// Returns true if the file was updated, false if it was already up-to-date.
pub fn sync_file(conn: &Connection, path: &Path) -> anyhow::Result<bool> {
    let path_str = path.to_string_lossy().to_string();
    
    // Read file content exactly once
    let content = fs::read_to_string(path)?;
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let new_hash = format!("{:x}", hasher.finalize());

    // Check if file exists and hash matches
    let existing_hash: Option<String> = conn
        .query_row(
            "SELECT hash FROM files WHERE path = ?1",
            params![path_str],
            |row| row.get(0),
        )
        .ok();

    // Check if chunks actually exist for this file to handle recovery from previous bug state
    let chunks_exist: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chunks WHERE file_path = ?1)",
            params![path_str],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if let Some(hash) = existing_hash {
        if hash == new_hash && chunks_exist {
            // File hasn't changed and has chunks, skip
            return Ok(false);
        }
    }

    // Extract title from first heading or filename (skips frontmatter)
    let title = extract_title(&content, path);

    // Use a savepoint for atomic sync
    conn.execute("SAVEPOINT sync_file", [])?;

    // Upsert file record
    conn.execute(
        "INSERT INTO files (path, hash, title, last_synced)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash,
           title = excluded.title,
           last_synced = datetime('now')",
        params![path_str, new_hash, title],
    )?;

    // Delete old chunks for this file (cascades to FTS and vec)
    conn.execute("DELETE FROM chunks WHERE file_path = ?1", params![path_str])?;

    // Chunk the content and save to database
    let chunker_config = ChunkerConfig::default();
    let chunks = chunk_markdown(&content, &chunker_config);
    for chunk in chunks {
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                path_str,
                chunk.chunk_index as i64,
                chunk.content,
                chunk.heading_hierarchy,
                chunk.marker_type,
            ],
        )?;
    }

    // Parse YAML frontmatter and pre-fill card_meta (INSERT OR IGNORE — never overwrite AI data)
    if let Some(fm) = parse_frontmatter(&content) {
        let tags_json = fm.tags.map(|t| serde_json::to_string(&t).unwrap_or_default());
        let note_type = fm.note_type;

        // Only insert if card_meta row doesn't exist yet
        conn.execute(
            "INSERT OR IGNORE INTO card_meta (file_path, tags, note_type)
             VALUES (?1, ?2, ?3)",
            params![path_str, tags_json, note_type],
        )?;

        log::info!("Pre-filled card_meta from frontmatter: {}", path_str);
    }

    conn.execute("RELEASE SAVEPOINT sync_file", [])?;
    log::info!("Synced file: {}", path_str);
    Ok(true)
}

/// Remove database records for files that no longer exist on disk within the given vault.
/// Only removes files that belong to this vault path — files from other vaults are left untouched.
pub fn remove_deleted_files(conn: &Connection, vault_path: &str) -> anyhow::Result<usize> {
    let mut stmt = conn.prepare("SELECT path FROM files")?;
    let paths: Vec<String> = stmt.query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;

    let mut removed = 0;
    // Normalize vault path for prefix check
    let vault_path_norm = std::path::Path::new(vault_path)
        .to_string_lossy()
        .to_string()
        .replace('\\', "/")
        .to_lowercase();

    for path_str in paths {
        let path = std::path::Path::new(&path_str);
        let path_norm = path.to_string_lossy().to_string().replace('\\', "/").to_lowercase();
        
        // Only consider files that belong to THIS vault
        if !path_norm.starts_with(&vault_path_norm) {
            continue; // Skip files from other vaults
        }

        // Remove only if the file no longer exists on disk
        if !path.exists() {
            conn.execute("DELETE FROM files WHERE path = ?1", params![path_str])?;
            removed += 1;
            log::info!("Removed deleted file from DB: {}", path_str);
        }
    }
    Ok(removed)
}

/// Extract a title from markdown content (first heading) or filename.
/// Skips YAML frontmatter blocks (`---` ... `---`) at the start of the file.
fn extract_title(content: &str, path: &Path) -> String {
    let mut in_frontmatter = false;
    let mut first_line = true;

    for line in content.lines() {
        let trimmed = line.trim();

        // Handle frontmatter: skip `---` delimited block at start of file
        if first_line && trimmed == "---" {
            in_frontmatter = true;
            first_line = false;
            continue;
        }
        first_line = false;

        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
            }
            continue;
        }

        // Look for first markdown heading after frontmatter
        if trimmed.starts_with("# ") {
            return trimmed[2..].trim().to_string();
        }
    }

    // Fallback to filename without extension
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}
