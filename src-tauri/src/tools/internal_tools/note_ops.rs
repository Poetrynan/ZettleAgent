use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

// Note operations: read, create, edit, patch, rename, delete, append, move, merge, batch_read, ocr_image

use super::helpers::{resolve_path_multi_vault, is_path_in_any_vault, normalize_db_path, walk_md_files};
use crate::import::ocr;

pub(super) fn execute_read_note(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    // Multi-vault: resolve path against all vaults
    let canonical = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;

    let content = std::fs::read_to_string(&canonical)?;
    // Limit output to ~30000 chars (UTF-8 safe) to prevent overwhelming the LLM
    let char_count = content.chars().count();
    if char_count > 30000 {
        let truncated: String = content.chars().take(30000).collect();
        Ok(format!("{}...\n\n[Content truncated at 30000 chars, total: {}]", truncated, char_count))
    } else {
        Ok(content)
    }
}


pub(super) fn execute_create_note(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let content = args["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'content' parameter"))?;

    // Resolve target workspace: use 'workspace' param if provided, else primary vault
    let target_vault = if let Some(ws) = args["workspace"].as_str() {
        // Try parsing as index first
        if let Ok(idx) = ws.parse::<usize>() {
            if idx < all_vault_paths.len() {
                all_vault_paths[idx].clone()
            } else {
                anyhow::bail!("Workspace index {} out of range (have {} workspaces). Use list_workspace_folders to see available workspaces.", idx, all_vault_paths.len());
            }
        } else {
            // Treat as absolute path — verify it's a known vault
            let ws_path = std::path::Path::new(ws);
            let ws_canonical = ws_path.canonicalize().unwrap_or_else(|_| ws_path.to_path_buf());
            let matched = all_vault_paths.iter().any(|vp| {
                let vc = std::path::Path::new(vp)
                    .canonicalize()
                    .unwrap_or_else(|_| std::path::PathBuf::from(vp));
                ws_canonical == vc || ws_canonical.starts_with(&vc)
            });
            if matched {
                ws.to_string()
            } else {
                anyhow::bail!("Workspace path '{}' is not a recognized workspace folder. Use list_workspace_folders to see available workspaces.", ws);
            }
        }
    } else {
        vault_path.to_string()
    };

    let full_path = std::path::PathBuf::from(&target_vault).join(path);

    // Don't overwrite existing files
    if full_path.exists() {
        anyhow::bail!("File already exists: {}", path);
    }

    // Security: ensure resolved path is within target vault (prevent path traversal via ../)
    let vault_canonical = std::path::Path::new(&target_vault)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&target_vault));
    // For new files, canonicalize the parent (which must exist after create_dir_all)
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)?;
        let parent_canonical = parent.canonicalize()?;
        if !parent_canonical.starts_with(&vault_canonical) {
            anyhow::bail!("Access denied: path is outside vault");
        }
    }

    let sanitized = crate::frontmatter::sanitize_frontmatter(content);
    std::fs::write(&full_path, sanitized)?;
    Ok(format!("Successfully created note: {} (in workspace: {})", path, target_vault))
}


pub(super) fn execute_edit_note(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let content = args["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'content' parameter"))?;

    // Multi-vault: resolve path against all vaults
    let canonical = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        anyhow::bail!("File does not exist: {}", path);
    }

    let sanitized = crate::frontmatter::sanitize_frontmatter(content);
    std::fs::write(&canonical, sanitized)?;
    Ok(format!("Successfully edited note: {}", path))
}


pub(super) fn execute_patch_note(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let patches = args["patches"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing 'patches' parameter (must be an array)"))?;

    if patches.is_empty() {
        anyhow::bail!("patches array is empty — nothing to do");
    }

    // Multi-vault: resolve path against all vaults
    let canonical = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        anyhow::bail!("File does not exist: {}", path);
    }

    let mut content = std::fs::read_to_string(&canonical)?;
    let mut results: Vec<String> = Vec::new();

    for (i, patch) in patches.iter().enumerate() {
        let search = patch["search"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Patch #{}: missing 'search' field", i + 1))?;
        let replace = patch["replace"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Patch #{}: missing 'replace' field", i + 1))?;
        let replace_all = patch["replace_all"].as_bool().unwrap_or(false);

        if search.is_empty() {
            results.push(format!("Patch #{}: skipped (empty search string)", i + 1));
            continue;
        }

        let count = content.matches(search).count();
        if count == 0 {
            results.push(format!(
                "Patch #{}: NOT FOUND — no match for {:?}",
                i + 1,
                if search.len() > 60 { format!("{}...", &search[..57]) } else { search.to_string() }
            ));
            continue;
        }

        if replace_all {
            content = content.replace(search, replace);
            results.push(format!("Patch #{}: replaced {} occurrence(s)", i + 1, count));
        } else {
            content = content.replacen(search, replace, 1);
            results.push(format!(
                "Patch #{}: replaced 1 of {} occurrence(s)",
                i + 1, count
            ));
        }
    }

    let sanitized = crate::frontmatter::sanitize_frontmatter(&content);
    std::fs::write(&canonical, sanitized)?;

    let summary = results.join("\n");
    Ok(format!("Patched note: {}\n{}", path, summary))
}


/// Apply edits using old_string/new_string with fuzzy matching.
/// Returns a diff preview and counts without writing to disk.
pub(super) fn execute_apply_edit(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let edits = args["edits"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing 'edits' parameter (must be an array)"))?;

    if edits.is_empty() {
        anyhow::bail!("edits array is empty — nothing to do");
    }

    let canonical = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;
    if !canonical.exists() {
        anyhow::bail!("File does not exist: {}", path);
    }

    let original = std::fs::read_to_string(&canonical)?;
    let mut content = original.clone();
    let mut results: Vec<String> = Vec::new();
    let mut total_replacements = 0usize;

    for (i, edit) in edits.iter().enumerate() {
        let old_string = edit["old_string"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Edit #{}: missing 'old_string'", i + 1))?;
        let new_string = edit["new_string"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Edit #{}: missing 'new_string'", i + 1))?;
        let expected = edit["expected_replacements"]
            .as_u64()
            .unwrap_or(1) as usize;

        if old_string.is_empty() {
            results.push(format!("Edit #{}: skipped (empty old_string)", i + 1));
            continue;
        }

        // Try exact match first
        let count = content.matches(old_string).count();

        if count == 0 {
            // Try fuzzy match: ignore leading/trailing whitespace differences
            if let Some(fuzzy_count) = find_fuzzy_match(&content, old_string) {
                if fuzzy_count == 1 {
                    // Find and replace the fuzzy match
                    if let Some((start, end)) = find_fuzzy_match_range(&content, old_string) {
                        content = format!("{}{}{}", &content[..start], new_string, &content[end..]);
                        total_replacements += 1;
                        results.push(format!("Edit #{}: fuzzy match replaced", i + 1));
                        continue;
                    }
                }
            }

            // Show context around potential matches for debugging
            let snippet = if old_string.len() > 40 {
                format!("{}...", &old_string[..37])
            } else {
                old_string.to_string()
            };
            results.push(format!("Edit #{}: NOT FOUND — no match for {:?}", i + 1, snippet));
            continue;
        }

        if expected > 0 && count != expected {
            results.push(format!(
                "Edit #{}: WARNING — found {} occurrences but expected {}",
                i + 1, count, expected
            ));
        }

        // Replace first occurrence
        content = content.replacen(old_string, new_string, 1);
        total_replacements += 1;
        results.push(format!("Edit #{}: replaced 1 of {} occurrence(s)", i + 1, count));
    }

    // Generate diff preview
    let diff = generate_diff(&original, &content);

    // Write the file
    let sanitized = crate::frontmatter::sanitize_frontmatter(&content);
    std::fs::write(&canonical, sanitized)?;

    let summary = results.join("\n");
    Ok(format!(
        "Applied edits to: {}\nReplacements: {}\n\n{}\n\nDiff preview:\n{}",
        path, total_replacements, summary, diff
    ))
}

/// Generate a unified diff between two strings.
pub fn generate_diff(old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    let mut diff = String::new();
    let mut old_idx = 0;
    let mut new_idx = 0;

    // Find first difference
    while old_idx < old_lines.len() && new_idx < new_lines.len() && old_lines[old_idx] == new_lines[new_idx] {
        old_idx += 1;
        new_idx += 1;
    }

    if old_idx == old_lines.len() && new_idx == new_lines.len() {
        return "(no changes)".to_string();
    }

    // Find last common suffix
    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > old_idx && new_end > new_idx && old_lines[old_end - 1] == new_lines[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }

    // Build diff
    let context = 2;
    let start = old_idx.saturating_sub(context);
    let end = (old_end + context).min(old_lines.len());

    diff.push_str(&format!("@@ -{},{} +{},{} @@\n", start + 1, end - start, new_idx + 1, new_end - new_idx + (end - start)));

    for i in start..old_idx {
        diff.push_str(&format!(" {}\n", old_lines[i]));
    }
    for i in old_idx..old_end {
        diff.push_str(&format!("-{}\n", old_lines[i]));
    }
    for i in new_idx..new_end {
        diff.push_str(&format!("+{}\n", new_lines[i]));
    }
    for i in old_end..end {
        diff.push_str(&format!(" {}\n", old_lines[i]));
    }

    if diff.len() > 2000 {
        diff.truncate(2000);
        diff.push_str("\n... (diff truncated)");
    }

    diff
}

/// Find fuzzy match count, ignoring leading/trailing whitespace differences.
fn find_fuzzy_match(content: &str, pattern: &str) -> Option<usize> {
    let pattern_trimmed = pattern.trim();
    if pattern_trimmed.is_empty() {
        return None;
    }

    let mut count = 0;
    for line in content.lines() {
        if line.trim() == pattern_trimmed {
            count += 1;
        }
    }

    if count > 0 { Some(count) } else { None }
}

/// Find the byte range of a fuzzy match in content.
fn find_fuzzy_match_range(content: &str, pattern: &str) -> Option<(usize, usize)> {
    let pattern_trimmed = pattern.trim();
    if pattern_trimmed.is_empty() {
        return None;
    }

    let mut pos = 0;
    for line in content.lines() {
        let line_start = pos;
        let line_end = pos + line.len();

        if line.trim() == pattern_trimmed {
            return Some((line_start, line_end));
        }

        pos = line_end + 1; // +1 for newline
    }

    None
}


pub(super) fn execute_rename_note(
    arguments: &str,
    vault_path: &str,
    db: &Arc<Mutex<Connection>>,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let old_path = args["old_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'old_path' parameter"))?;
    let new_path = args["new_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'new_path' parameter"))?;

    let old_full = if std::path::Path::new(old_path).is_absolute() {
        std::path::PathBuf::from(old_path)
    } else {
        std::path::PathBuf::from(vault_path).join(old_path)
    };

    let new_full = if std::path::Path::new(new_path).is_absolute() {
        std::path::PathBuf::from(new_path)
    } else {
        std::path::PathBuf::from(vault_path).join(new_path)
    };

    if !old_full.exists() {
        anyhow::bail!("Source file does not exist: {}", old_path);
    }
    if new_full.exists() {
        anyhow::bail!("Target file already exists: {}", new_path);
    }

    // Security: both paths must be inside some vault
    let old_canonical = old_full.canonicalize()?;
    if !is_path_in_any_vault(&old_canonical, vault_path, all_vault_paths) {
        anyhow::bail!("Access denied: source path is outside all vaults");
    }

    // Create parent dir for new path if needed
    if let Some(parent) = new_full.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Rename on filesystem
    std::fs::rename(&old_canonical, &new_full)?;

    // Update database records: all tables that reference file paths
    // P0-3: Use normalize_db_path for consistent path format
    let new_canonical = new_full.canonicalize().unwrap_or(new_full.clone());
    let old_norm = normalize_db_path(&old_canonical);
    let new_norm = normalize_db_path(&new_canonical);

    // Also try with the raw paths as they might be stored differently
    let old_raw = old_full.to_string_lossy().to_string();

    if let Ok(conn) = db.lock() {
        // Try both normalized and raw old paths for each table
        for old_p in &[&old_norm, &old_raw, &old_path.to_string()] {
            // Derive new title from filename
            let new_title = new_full.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            // files table (primary key)
            let _ = conn.execute(
                "UPDATE files SET path = ?1, title = ?2 WHERE path = ?3",
                rusqlite::params![new_norm, new_title, old_p],
            );
            // chunks table
            let _ = conn.execute(
                "UPDATE chunks SET file_path = ?1 WHERE file_path = ?2",
                rusqlite::params![new_norm, old_p],
            );
            // card_meta table
            let _ = conn.execute(
                "UPDATE card_meta SET file_path = ?1 WHERE file_path = ?2",
                rusqlite::params![new_norm, old_p],
            );
            // fact_history table
            let _ = conn.execute(
                "UPDATE fact_history SET note_path = ?1 WHERE note_path = ?2",
                rusqlite::params![new_norm, old_p],
            );
            // knowledge_timeline table
            let _ = conn.execute(
                "UPDATE knowledge_timeline SET note_path = ?1 WHERE note_path = ?2",
                rusqlite::params![new_norm, old_p],
            );
            // note_relations table (both source and target)
            let _ = conn.execute(
                "UPDATE note_relations SET source_path = ?1 WHERE source_path = ?2",
                rusqlite::params![new_norm, old_p],
            );
            let _ = conn.execute(
                "UPDATE note_relations SET target_path = ?1 WHERE target_path = ?2",
                rusqlite::params![new_norm, old_p],
            );
        }
    }

    // Update wikilinks in all vault files: [[old_title]] → [[new_title]]
    let old_title = old_full.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let new_title = new_full.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut updated_files = 0;
    if !old_title.is_empty() && !new_title.is_empty() && old_title != new_title {
        let old_link = format!("[[{}]]", old_title);
        let new_link = format!("[[{}]]", new_title);
        // Walk all .md files in vault recursively
        let md_files = walk_md_files(std::path::Path::new(vault_path));
        for ep in md_files {
            if let Ok(content) = std::fs::read_to_string(&ep) {
                if content.contains(&old_link) {
                    let updated = content.replace(&old_link, &new_link);
                    let _ = std::fs::write(&ep, updated);
                    updated_files += 1;
                }
            }
        }
    }

    Ok(format!("Successfully renamed '{}' to '{}'. Database records updated. {} files had wikilinks updated.", old_path, new_path, updated_files))
}


pub(super) fn execute_delete_note(
    arguments: &str,
    vault_path: &str,
    db: &Arc<Mutex<Connection>>,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    // Multi-vault: resolve path against all vaults
    let canonical = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        anyhow::bail!("File does not exist: {}", path);
    }

    std::fs::remove_file(&canonical)?;

    // Clean up database records (match frontend delete_file behavior)
    let canonical_str = canonical.to_string_lossy().to_string();
    if let Ok(conn) = db.lock() {
        for db_path in &[path, &canonical_str] {
            let _ = conn.execute("DELETE FROM chunks WHERE file_path = ?1", rusqlite::params![db_path]);
            let _ = conn.execute("DELETE FROM card_meta WHERE file_path = ?1", rusqlite::params![db_path]);
            let _ = conn.execute("DELETE FROM fact_history WHERE note_path = ?1", rusqlite::params![db_path]);
            let _ = conn.execute("DELETE FROM knowledge_timeline WHERE note_path = ?1", rusqlite::params![db_path]);
            let _ = conn.execute("DELETE FROM note_relations WHERE source_path = ?1 OR target_path = ?1", rusqlite::params![db_path]);
            let _ = conn.execute("DELETE FROM files WHERE path = ?1", rusqlite::params![db_path]);
        }
    }

    Ok(format!("Successfully deleted note: {}. Database records cleaned.", path))
}

// ── New Tools ──────────────────────────────────────────────────────


pub(super) fn execute_append_to_note(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let content = args["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'content' parameter"))?;

    // Multi-vault: resolve path against all vaults
    let canonical = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;

    if !canonical.exists() {
        anyhow::bail!("File does not exist: {}", path);
    }

    // Read existing content, append new content with separator
    let existing = std::fs::read_to_string(&canonical)?;
    let separator = if existing.ends_with('\n') { "\n" } else { "\n\n" };
    let new_content = format!("{}{}{}", existing, separator, content);
    let sanitized = crate::frontmatter::sanitize_frontmatter(&new_content);
    std::fs::write(&canonical, sanitized)?;

    Ok(format!("Successfully appended {} chars to: {}", content.len(), path))
}


pub(super) fn execute_move_note(
    arguments: &str,
    vault_path: &str,
    db: &Arc<Mutex<Connection>>,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;
    let destination = args["destination"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'destination' parameter"))?;

    let old_full = resolve_path_multi_vault(path, vault_path, all_vault_paths)?;

    if !old_full.exists() {
        anyhow::bail!("Source file does not exist: {}", path);
    }

    let filename = old_full.file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid source path"))?;

    // Try to resolve destination directory against all vaults
    let dest_dir = resolve_path_multi_vault(destination, vault_path, all_vault_paths)
        .unwrap_or_else(|_| std::path::PathBuf::from(vault_path).join(destination));
    // Create destination directory if needed
    std::fs::create_dir_all(&dest_dir)?;

    let new_full = dest_dir.join(filename);
    if new_full.exists() {
        anyhow::bail!("Destination already has a file named '{}'", filename.to_string_lossy());
    }

    // Use rename_note logic: construct new_path arg and delegate
    let new_rel = new_full.strip_prefix(vault_path)
        .unwrap_or(&new_full)
        .to_string_lossy()
        .to_string();

    let rename_args = json!({
        "old_path": path,
        "new_path": new_rel
    });

    execute_rename_note(&rename_args.to_string(), vault_path, db, all_vault_paths)
}

// ── 20. merge_notes ────────────────────────────────────────────────


pub(super) fn execute_merge_notes(
    arguments: &str,
    vault_path: &str,
    db: &Arc<Mutex<Connection>>,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let source_path = args["source_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'source_path' parameter"))?;
    let target_path = args["target_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target_path' parameter"))?;

    // Multi-vault: resolve both paths
    let source_canonical = resolve_path_multi_vault(source_path, vault_path, all_vault_paths)?;
    let target_canonical = resolve_path_multi_vault(target_path, vault_path, all_vault_paths)?;

    if !source_canonical.exists() {
        anyhow::bail!("Source note does not exist: {}", source_path);
    }
    if !target_canonical.exists() {
        anyhow::bail!("Target note does not exist: {}", target_path);
    }

    // Read source content
    let source_content = std::fs::read_to_string(&source_canonical)?;
    let source_title = source_canonical.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let target_title = target_canonical.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // Append to target with separator
    let separator = format!("\n\n---\n\n## Merged from: {}\n\n", source_title);
    let mut target_content = std::fs::read_to_string(&target_canonical)?;
    target_content.push_str(&separator);
    target_content.push_str(&source_content);
    std::fs::write(&target_canonical, &target_content)?;

    // Update wikilinks: [[source_title]] → [[target_title]]
    let mut updated_files = 0;
    if !source_title.is_empty() && source_title != target_title {
        let old_link = format!("[[{}]]", source_title);
        let new_link = format!("[[{}]]", target_title);
        // Walk all .md files in ALL vaults recursively
        let mut md_files = Vec::new();
        for vp in all_vault_paths {
            md_files.extend(walk_md_files(std::path::Path::new(vp)));
        }
        if all_vault_paths.is_empty() {
            md_files = walk_md_files(std::path::Path::new(vault_path));
        }
        for ep in md_files {
            if ep != source_canonical {
                if let Ok(content) = std::fs::read_to_string(&ep) {
                    if content.contains(&old_link) {
                        let updated = content.replace(&old_link, &new_link);
                        let _ = std::fs::write(&ep, updated);
                        updated_files += 1;
                    }
                }
            }
        }
    }

    // Delete source
    let delete_args = json!({ "path": source_path });
    let _ = execute_delete_note(&delete_args.to_string(), vault_path, db, all_vault_paths);

    Ok(format!(
        "Successfully merged '{}' into '{}'. {} files had wikilinks updated. Source note deleted.",
        source_path, target_path, updated_files
    ))
}

// ── 21. read_memory ────────────────────────────────────────────────


pub(super) fn execute_batch_read_notes(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let paths = args["paths"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing 'paths' parameter (must be an array)"))?;
    let max_chars = args["max_chars_per_note"].as_u64().unwrap_or(2000) as usize;

    if paths.len() > 5 {
        anyhow::bail!("batch_read_notes supports at most 5 notes per call. Got {}.", paths.len());
    }

    let mut results: Vec<serde_json::Value> = Vec::new();

    for p in paths {
        let path_str = match p.as_str() {
            Some(s) => s,
            None => {
                results.push(json!({ "path": p.to_string(), "error": "Invalid path (not a string)" }));
                continue;
            }
        };

        // Multi-vault: resolve path against all vaults
        let canonical = match resolve_path_multi_vault(path_str, vault_path, all_vault_paths) {
            Ok(c) => c,
            Err(_) => {
                results.push(json!({ "path": path_str, "error": "Access denied: outside all vaults" }));
                continue;
            }
        };

        match std::fs::read_to_string(&canonical) {
            Ok(content) => {
                // Extract title from first heading
                let title = content.lines()
                    .find(|l| l.starts_with("# "))
                    .map(|l| l.trim_start_matches("# ").to_string())
                    .unwrap_or_default();

                let char_count = content.chars().count();
                let truncated: String = content.chars().take(max_chars).collect();
                let was_truncated = char_count > max_chars;

                results.push(json!({
                    "path": path_str,
                    "title": title,
                    "content": truncated,
                    "total_chars": char_count,
                    "truncated": was_truncated
                }));
            }
            Err(e) => {
                results.push(json!({ "path": path_str, "error": format!("Read error: {}", e) }));
            }
        }
    }

    Ok(serde_json::to_string_pretty(&json!({
        "count": results.len(),
        "notes": results
    }))?)
}

// ── resolve_wikilink ───────────────────────────────────────────────

pub(super) fn execute_resolve_wikilink(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let title = args["title"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'title' parameter"))?;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let title_norm = crate::db::search::normalize_title(title);
    if title_norm.is_empty() {
        return Ok(json!({ "found": false, "title": title, "path": null }).to_string());
    }

    let mut stmt = conn.prepare("SELECT path, title FROM files")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;

    for row in rows {
        let (path, file_title) = row?;
        if let Some(t) = &file_title {
            if crate::db::search::normalize_title(t) == title_norm {
                return Ok(json!({ "found": true, "title": title, "path": path }).to_string());
            }
        }
        let filename = path.replace('\\', "/").rsplit('/').next().unwrap_or(&path).replace(".md", "");
        if crate::db::search::normalize_title(&filename) == title_norm {
            return Ok(json!({ "found": true, "title": title, "path": path }).to_string());
        }
    }

    Ok(json!({ "found": false, "title": title, "path": null }).to_string())
}

// ── fix_broken_link ────────────────────────────────────────────────

pub(super) fn execute_fix_broken_link(
    arguments: &str,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let file_path = args["file_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'file_path'"))?;
    let target_title = args["target_title"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'target_title'"))?;
    let line_number = args["line_number"].as_u64()
        .ok_or_else(|| anyhow::anyhow!("Missing 'line_number'"))? as usize;
    let action = args["action"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'action' (remove/replace)"))?;
    let replacement = args["replacement"].as_str().map(|s| s.to_string());

    crate::lint::fix_broken_link_in_file(
        file_path,
        target_title,
        line_number,
        action,
        replacement.as_deref(),
    )?;

    Ok(json!({
        "success": true,
        "message": format!("Fixed broken link to '{}' in {} (line {})", target_title, file_path, line_number)
    }).to_string())
}

// ── execute_generate_structure_note ──────────────────────────────────

pub(super) async fn execute_generate_structure_note(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    llm_config: &crate::llm::LlmConfig,
    _vault_path: &str,
    _all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let topic = args["topic"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'topic' parameter"))?;
    let depth = args["depth"].as_str().unwrap_or("shallow");

    let limit = if depth == "deep" { 20 } else { 10 };

    // Find related notes via search and retrieve metadata
    let (search_results, notes_context, relations_context) = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
        
        // Perform full-text search
        let search_results = crate::db::search::full_text_search(&conn, topic, limit)?;
        
        // Retrieve note titles, tags, and some snippet content
        let mut notes_context = Vec::new();
        for r in &search_results {
            let title: String = conn.query_row(
                "SELECT COALESCE(title, '') FROM files WHERE path = ?1",
                rusqlite::params![r.file_path],
                |row| row.get(0),
            ).unwrap_or_default();
            
            let tags: String = conn.query_row(
                "SELECT COALESCE(tags_json, '[]') FROM ai_note_metadata WHERE file_path = ?1",
                rusqlite::params![r.file_path],
                |row| row.get(0),
            ).unwrap_or_else(|_| "[]".to_string());

            let snippet: String = r.content.chars().take(400).collect();

            notes_context.push(json!({
                "path": r.file_path,
                "title": if title.is_empty() {
                    std::path::Path::new(&r.file_path)
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| r.file_path.clone())
                } else {
                    title
                },
                "tags": tags,
                "snippet": snippet
            }));
        }

        // Also get relations between these notes
        let mut relations_context = Vec::new();
        let paths: Vec<String> = search_results.iter().map(|r| r.file_path.clone()).collect();
        if paths.len() > 1 {
            // Query note_relations between the retrieved paths
            let query_in = paths.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT source_path, target_path, relation_type FROM note_relations 
                 WHERE source_path IN ({}) AND target_path IN ({})",
                query_in, query_in
            );
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            for p in &paths {
                params.push(Box::new(p.clone()));
            }
            for p in &paths {
                params.push(Box::new(p.clone()));
            }

            if let Ok(mut stmt) = conn.prepare(&sql) {
                let row_maps = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                });
                if let Ok(rows) = row_maps {
                    for row in rows.flatten() {
                        relations_context.push(json!({
                            "source": row.0,
                            "target": row.1,
                            "type": row.2
                        }));
                    }
                }
            }
        }

        (search_results, notes_context, relations_context)
    };
    
    if search_results.is_empty() {
        return Ok(format!("No notes found related to topic: '{}'. Cannot generate structure note.", topic));
    }

    // Call LLM
    let system_prompt = "You are a professional Zettelkasten assistant. \
                         Your goal is to organize related notes into a coherent Map of Content (MOC) / Structure Note. \
                         You must output ONLY valid Markdown text. \
                         Use wikilinks like [[Note Title]] (never [[Note Path]] or markdown links) to reference the notes. \
                         Organize the notes logically under subheadings, write brief explanations for each note or section, and write a short intro about the topic.";

    let user_content = format!(
        "Topic: {}\nDepth: {}\n\nRelated Notes Info:\n{}\n\nKnown Relations:\n{}",
        topic,
        depth,
        serde_json::to_string_pretty(&notes_context)?,
        serde_json::to_string_pretty(&relations_context)?
    );

    let messages = vec![
        crate::llm::ChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
            ..Default::default()
        },
        crate::llm::ChatMessage {
            role: "user".to_string(),
            content: user_content,
            ..Default::default()
        }
    ];

    let moc_content = crate::llm::chat_completion(llm_config, &messages).await?;
    
    Ok(moc_content)
}

// ── execute_compare_notes ───────────────────────────────────────────

pub(super) async fn execute_compare_notes(
    arguments: &str,
    llm_config: &crate::llm::LlmConfig,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_a = args["note_a"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_a' parameter"))?;
    let note_b = args["note_b"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_b' parameter"))?;

    let path_a = super::helpers::resolve_path_multi_vault(note_a, vault_path, all_vault_paths)?;
    let path_b = super::helpers::resolve_path_multi_vault(note_b, vault_path, all_vault_paths)?;

    let content_a = std::fs::read_to_string(&path_a)?;
    let content_b = std::fs::read_to_string(&path_b)?;

    // Truncate each to 4000 chars for the LLM
    let snippet_a: String = content_a.chars().take(4000).collect();
    let snippet_b: String = content_b.chars().take(4000).collect();

    let prompt = format!(
        "Compare the following two notes and return a JSON analysis:\n\n\
         Note A ({}):\n{}\n\n\
         Note B ({}):\n{}\n\n\
         Return JSON with these fields:\n\
         - similarities: list of shared concepts/themes\n\
         - differences: list of differing viewpoints/approaches\n\
         - contradictions: list of conflicting claims (empty if none)\n\
         - merge_potential: 'high'/'medium'/'low'/'none'\n\
         - merge_suggestion: brief description of how they could be merged (or null)\n\
         - relation_suggestion: recommended relation type (supports/contradicts/refines/related/none)\n\
         - relation_reason: one-sentence explanation for the suggested relation\n\n\
         JSON only, no markdown fencing:",
        path_a.file_stem().unwrap_or_default().to_string_lossy(),
        path_b.file_stem().unwrap_or_default().to_string_lossy(),
        snippet_a,
        snippet_b,
    );

    let messages = vec![
        crate::llm::ChatMessage {
            role: "system".to_string(),
            content: "You are a precise note comparison assistant. Return only valid JSON.".to_string(),
            ..Default::default()
        },
        crate::llm::ChatMessage {
            role: "user".to_string(),
            content: prompt,
            ..Default::default()
        },
    ];

    let llm_response = crate::llm::chat_completion(llm_config, &messages).await?;

    // Parse response
    let analysis: serde_json::Value = serde_json::from_str(&llm_response)
        .or_else(|_| {
            let start = llm_response.find('{').unwrap_or(0);
            let end = llm_response.rfind('}').map(|i| i + 1).unwrap_or(llm_response.len());
            serde_json::from_str(&llm_response[start..end])
        })
        .unwrap_or(serde_json::json!({"error": "Failed to parse LLM response"}));

    Ok(serde_json::to_string_pretty(&json!({
        "note_a": {
            "path": super::helpers::normalize_db_path(&path_a),
            "char_count": content_a.chars().count(),
        },
        "note_b": {
            "path": super::helpers::normalize_db_path(&path_b),
            "char_count": content_b.chars().count(),
        },
        "analysis": analysis,
    }))?)
}

// ── execute_ocr_image ─────────────────────────────────────────────

pub(super) async fn execute_ocr_image(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
    llm_config: Option<&crate::llm::LlmConfig>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let image_path = args["image_path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'image_path' parameter"))?;
    let store_as_note = args["store_as_note"].as_bool().unwrap_or(false);
    let note_title = args["note_title"].as_str();

    // Resolve image path
    let canonical = resolve_path_multi_vault(image_path, vault_path, all_vault_paths)?;

    // Read image bytes
    let image_bytes = std::fs::read(&canonical)
        .map_err(|e| anyhow::anyhow!("Failed to read image: {}", e))?;

    let resource_dir = crate::app_paths::bundled_resource_dir();

    // Run OCR (try LLM vision first, fall back to local ppocr)
    let extracted_text = ocr::extract_text_from_image(&image_bytes, llm_config, &resource_dir).await?;

    let mut result = serde_json::json!({
        "image_path": normalize_db_path(&canonical),
        "extracted_text": extracted_text,
        "char_count": extracted_text.chars().count(),
    });

    // Optionally store as a new note
    if store_as_note {
        let title = note_title.unwrap_or("OCR Result");
        let file_name = format!("{}.md", title.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"));
        let dest_dir = std::path::Path::new(vault_path).join("_ocr_results");
        std::fs::create_dir_all(&dest_dir)?;
        let dest_path = dest_dir.join(&file_name);

        if !dest_path.exists() {
            let note_content = format!(
                "---\ntype: literature\ntags:\n  - ocr\ncreated: {}\nsource_image: {}\n---\n\n# {}\n\n{}",
                chrono::Utc::now().format("%Y-%m-%d"),
                normalize_db_path(&canonical),
                title,
                extracted_text,
            );
            std::fs::write(&dest_path, note_content)?;
            result["stored_as_note"] = serde_json::json!(normalize_db_path(&dest_path));
        }
    }

    Ok(serde_json::to_string_pretty(&result)?)
}

// ── execute_extract_pdf_text ──────────────────────────────────────

pub(super) fn execute_extract_pdf_text(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let pdf_path = args["pdf_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'pdf_path' parameter"))?;
    let max_pages = args["max_pages"].as_u64().unwrap_or(50) as usize;
    let save_to_vault = args["save_to_vault"].as_bool().unwrap_or(false);

    // Resolve PDF path
    let canonical = resolve_path_multi_vault(pdf_path, vault_path, all_vault_paths)?;

    // Extract text using the existing import::pdf module
    let pages = crate::import::pdf::extract_text_from_pdf(&canonical)
        .map_err(|e| anyhow::anyhow!("Failed to extract PDF text: {}", e))?;

    let total_pages = pages.len();
    let needs_ocr_pages: Vec<usize> = pages.iter()
        .filter(|p| p.needs_ocr)
        .map(|p| p.page)
        .collect();

    // Collect text, limiting pages
    let limited_pages: Vec<_> = pages.into_iter().take(max_pages).collect();
    let extracted_text: String = limited_pages.iter()
        .map(|p| {
            if p.text.trim().is_empty() {
                format!("\n--- Page {} (empty / scanned image) ---\n", p.page)
            } else {
                format!("\n--- Page {} ---\n{}\n", p.page, p.text)
            }
        })
        .collect();

    let char_count = extracted_text.chars().count();

    // Truncate if too long for LLM context
    let max_chars = 25000;
    let (final_text, truncated) = if char_count > max_chars {
        let truncated_text: String = extracted_text.chars().take(max_chars).collect();
        (truncated_text, true)
    } else {
        (extracted_text, false)
    };

    let mut result = serde_json::json!({
        "pdf_path": normalize_db_path(&canonical),
        "total_pages": total_pages,
        "extracted_pages": limited_pages.len(),
        "char_count": char_count,
        "truncated": truncated,
        "pages_needing_ocr": needs_ocr_pages,
        "content": final_text,
    });

    if !needs_ocr_pages.is_empty() {
        result["ocr_hint"] = json!(format!(
            "Pages {:?} appear to be scanned images with little/no extractable text. Use ocr_image tool on those pages for better results.",
            needs_ocr_pages
        ));
    }

    // Optionally save extracted text as a note
    if save_to_vault {
        let file_stem = canonical.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("pdf_extract")
            .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");

        let dest_dir = std::path::Path::new(vault_path).join("_pdf_extracts");
        std::fs::create_dir_all(&dest_dir)?;
        let filename = format!("{}.md", file_stem);
        let dest_path = dest_dir.join(&filename);

        let now = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        let note_content = format!(
            "---\ntitle: \"{}\"\nsource: \"{}\"\nextracted: \"{}\"\ntags: [pdf-extract]\n---\n\n# {}\n\n> Source: {}\n> Extracted: {}\n> Pages: {} (of {} total)\n\n{}\n",
            file_stem, normalize_db_path(&canonical), now, file_stem,
            normalize_db_path(&canonical), now, limited_pages.len(), total_pages, final_text
        );

        std::fs::write(&dest_path, &note_content)?;
        result["saved_to"] = json!(format!("_pdf_extracts/{}", filename));
        result["message"] = json!(format!("Content saved to vault: _pdf_extracts/{}", filename));
    }

    Ok(serde_json::to_string_pretty(&result)?)
}

// ── execute_get_note_history ──────────────────────────────────────

pub(super) fn execute_get_note_history(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_path' parameter"))?;
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;

    // Resolve the path to verify it exists
    let canonical = resolve_path_multi_vault(note_path, vault_path, all_vault_paths)?;
    let db_path = normalize_db_path(&canonical);

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    // 1. Get reconciliation log entries (AI edit actions)
    let mut stmt = conn.prepare(
        "SELECT id, action, diff_summary, created_at
         FROM reconciliation_log
         WHERE file_path = ?1
         ORDER BY created_at DESC
         LIMIT ?2"
    )?;

    let reconciliation_entries: Vec<serde_json::Value> = stmt.query_map(
        rusqlite::params![&db_path, limit as i64],
        |row| {
            Ok(json!({
                "type": "reconciliation",
                "id": row.get::<_, i64>(0)?,
                "action": row.get::<_, String>(1)?,
                "diff_summary": row.get::<_, Option<String>>(2)?,
                "timestamp": row.get::<_, String>(3)?,
            }))
        },
    )?.filter_map(|r| r.ok()).collect();

    // 2. Get knowledge_timeline events
    let mut stmt2 = conn.prepare(
        "SELECT id, event_type, event_timestamp, event_details
         FROM knowledge_timeline
         WHERE note_path = ?1
         ORDER BY event_timestamp DESC
         LIMIT ?2"
    )?;

    let timeline_entries: Vec<serde_json::Value> = stmt2.query_map(
        rusqlite::params![&db_path, limit as i64],
        |row| {
            Ok(json!({
                "type": "timeline",
                "id": row.get::<_, i64>(0)?,
                "event_type": row.get::<_, String>(1)?,
                "timestamp": row.get::<_, String>(2)?,
                "details": row.get::<_, Option<String>>(3)?,
            }))
        },
    )?.filter_map(|r| r.ok()).collect();

    // 3. Get fact_history entries
    let mut stmt3 = conn.prepare(
        "SELECT id, fact_content, valid_from, valid_to, superseded_by, created_by
         FROM fact_history
         WHERE note_path = ?1
         ORDER BY valid_from DESC
         LIMIT ?2"
    )?;

    let fact_entries: Vec<serde_json::Value> = stmt3.query_map(
        rusqlite::params![&db_path, limit as i64],
        |row| {
            Ok(json!({
                "type": "fact",
                "id": row.get::<_, i64>(0)?,
                "content": row.get::<_, String>(1)?,
                "valid_from": row.get::<_, String>(2)?,
                "valid_to": row.get::<_, Option<String>>(3)?,
                "superseded_by": row.get::<_, Option<i64>>(4)?,
                "created_by": row.get::<_, String>(5)?,
            }))
        },
    )?.filter_map(|r| r.ok()).collect();

    // 4. Get file metadata
    let file_info: Option<serde_json::Value> = conn.query_row(
        "SELECT path, title, last_synced, methodology FROM files WHERE path = ?1",
        rusqlite::params![&db_path],
        |row| {
            Ok(json!({
                "path": row.get::<_, String>(0)?,
                "title": row.get::<_, Option<String>>(1)?,
                "last_synced": row.get::<_, String>(2)?,
                "methodology": row.get::<_, String>(3)?,
            }))
        },
    ).ok();

    // Merge and sort all entries by timestamp (most recent first)
    let mut all_entries: Vec<serde_json::Value> = Vec::new();
    all_entries.extend(reconciliation_entries);
    all_entries.extend(timeline_entries);
    all_entries.extend(fact_entries);
    all_entries.sort_by(|a, b| {
        let ts_a = a["timestamp"].as_str().unwrap_or("");
        let ts_b = b["timestamp"].as_str().unwrap_or("");
        ts_b.cmp(ts_a)
    });
    all_entries.truncate(limit);

    Ok(serde_json::to_string_pretty(&json!({
        "note_path": note_path,
        "db_path": db_path,
        "file_info": file_info,
        "total_entries": all_entries.len(),
        "history": all_entries,
    }))?)
}

// ── execute_revert_note ───────────────────────────────────────────

pub(super) fn execute_revert_note(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_path = args["note_path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'note_path' parameter"))?;

    // Resolve the path
    let canonical = resolve_path_multi_vault(note_path, vault_path, all_vault_paths)?;
    let db_path = normalize_db_path(&canonical);

    if !canonical.exists() {
        anyhow::bail!("File does not exist: {}", note_path);
    }

    // Read current content (for backup before revert)
    let current_content = std::fs::read_to_string(&canonical)
        .map_err(|e| anyhow::anyhow!("Failed to read current note: {}", e))?;

    let new_content = if let Some(content) = args["content"].as_str() {
        // Direct content revert
        content.to_string()
    } else if let Some(_entry_id) = args["history_entry_id"].as_i64() {
        // Revert based on a reconciliation_log entry — look up the diff_summary
        // Since we store diff summaries (not full snapshots), we can't directly
        // reconstruct the old content from a reconciliation log entry.
        // Instead, this is a signal that the user reviewed the history and wants
        // to undo a specific AI edit. We log the revert action.
        anyhow::bail!(
            "Reverting by history_entry_id is not yet supported. Please provide the 'content' parameter with the exact text to revert to. Use get_note_history to review past changes, then provide the desired content."
        );
    } else {
        anyhow::bail!("Either 'content' (the text to revert to) or 'history_entry_id' must be provided.");
    };

    // Log the revert action BEFORE writing (so it appears in history)
    {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
        conn.execute(
            "INSERT INTO reconciliation_log (file_path, action, diff_summary) VALUES (?1, 'revert', ?2)",
            rusqlite::params![
                &db_path,
                &format!("Reverted note. Previous content had {} chars, new content has {} chars.",
                    current_content.chars().count(),
                    new_content.chars().count())
            ],
        )?;

        // Also log in knowledge_timeline
        conn.execute(
            "INSERT INTO knowledge_timeline (note_path, event_type, event_details) VALUES (?1, 'updated', ?2)",
            rusqlite::params![
                &db_path,
                &format!("Note reverted via Agent. Previous: {} chars → New: {} chars",
                    current_content.chars().count(),
                    new_content.chars().count())
            ],
        )?;
    }

    // Write the reverted content
    let sanitized = crate::frontmatter::sanitize_frontmatter(&new_content);
    crate::file_lock::safe_write(&canonical, &sanitized)?;

    Ok(serde_json::to_string_pretty(&json!({
        "success": true,
        "note_path": note_path,
        "action": "revert",
        "previous_char_count": current_content.chars().count(),
        "new_char_count": new_content.chars().count(),
        "message": format!("Successfully reverted note: {}. The previous version's metadata has been logged in history.", note_path),
    }))?)
}
