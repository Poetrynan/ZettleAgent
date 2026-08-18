
// Shared helper functions used across all tool modules

pub(crate) fn walk_md_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut result = Vec::new();
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    // Skip hidden directories and common non-vault dirs
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if name.starts_with('.') || name == "node_modules" || name == "target" {
                            continue;
                        }
                    }
                    walk(&p, out);
                } else if p.extension().map(|e| e == "md").unwrap_or(false) {
                    out.push(p);
                }
            }
        }
    }
    walk(dir, &mut result);
    result
}

// ── P0-3: Path normalization helper ────────────────────────────────

/// Normalize a path for consistent DB storage.
/// Canonicalizes and converts backslashes to forward slashes so that
/// path comparisons always match regardless of OS path separator.
pub(crate) fn normalize_db_path(path: &std::path::Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical.to_string_lossy().replace('\\', "/")
}

// ── Write-ahead snapshots for Agent edits ──────────────────────────

/// Strip the Windows verbatim prefixes (`\\?\`, `\\?\UNC\`) that `canonicalize`
/// prepends. No-op on other platforms and on paths that never had one.
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// Build the `note_snapshots.file_path` key for `path`.
///
/// This must match what the editor uses, or Agent snapshots would be invisible in
/// the version-history UI. The frontend passes `activeFile` straight through to
/// `save_note_snapshot` / `get_note_snapshots`, and `activeFile` originates from
/// `list_directory_tree` (`commands/file_commands.rs`) — i.e. a *raw* absolute path
/// with native separators and no `\\?\` prefix. Same string `db::sync::sync_file`
/// stores in `files.path`.
///
/// Deliberately NOT `normalize_db_path`: that rewrites separators to `/` and keeps
/// the verbatim prefix, neither of which the frontend ever does.
pub(crate) fn snapshot_path_key(path: &std::path::Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim_prefix(&resolved.to_string_lossy())
}

/// Record the current on-disk content of `path` before an Agent overwrites it.
///
/// Returns the `note_snapshots.id` of the restore point, or `Ok(None)` when there is
/// nothing to preserve (the file does not exist yet). The id is what
/// [`journal_write`] stores so a whole-turn undo knows which body to write back.
///
/// Fail-closed on purpose: a read or DB failure returns `Err` so the caller aborts
/// its write. If we cannot record a restore point we have no business touching the
/// user's file.
pub(crate) fn snapshot_before_write(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    path: &std::path::Path,
) -> anyhow::Result<Option<i64>> {
    if !path.exists() {
        // A note being created has no pre-image to restore to.
        return Ok(None);
    }

    let key = snapshot_path_key(path);
    let abort = |detail: String| {
        anyhow::anyhow!(
            "aborted: could not record a restore point for {}: {}",
            key,
            detail
        )
    };

    let content = std::fs::read_to_string(path).map_err(|e| abort(e.to_string()))?;

    let conn = db
        .lock()
        .map_err(|_| abort("DB lock error".to_string()))?;

    let snapshot_id =
        crate::commands::file_commands::insert_note_snapshot_returning_id(&conn, &key, &content)
            .map_err(|e| abort(e.to_string()))?;

    log::info!(
        "snapshot_before_write: restore point #{} for {}",
        snapshot_id,
        key
    );

    Ok(Some(snapshot_id))
}

// ── Agent run journal (whole-turn undo) ────────────────────────────

/// Append one row to `agent_run_journal` describing a file mutation the current
/// Agent turn just performed.
///
/// Silently does nothing when no agent run is active: writes arriving from the
/// frontend editor path (or from the background scheduler) do not belong to any
/// turn and must not become undoable-as-a-group.
///
/// Best-effort by design — a failure to journal is logged, never propagated. The
/// file change already happened at this point, so turning a bookkeeping problem
/// into a tool error would only confuse the model.
///
/// `op` is one of `write` | `create` | `delete` | `rename`.
pub(crate) fn journal_write(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    tool_name: &str,
    op: &str,
    file_path: &str,
    new_path: Option<&str>,
    snapshot_id: Option<i64>,
    trash_path: Option<&str>,
) {
    let run_id = match crate::llm::tool_hooks::current_run_id() {
        Some(id) if !id.is_empty() => id,
        _ => return,
    };

    let conn = match db.lock() {
        Ok(c) => c,
        Err(_) => {
            log::warn!("journal_write: DB lock error, {} on {} not journaled", op, file_path);
            return;
        }
    };

    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_run_journal WHERE run_id = ?1",
            rusqlite::params![&run_id],
            |row| row.get(0),
        )
        .unwrap_or(1);

    let now_ms = chrono::Utc::now().timestamp_millis();

    if let Err(e) = conn.execute(
        "INSERT INTO agent_run_journal
            (run_id, seq, tool_name, op, file_path, new_path, snapshot_id, trash_path, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            &run_id,
            seq,
            tool_name,
            op,
            file_path,
            new_path,
            snapshot_id,
            trash_path,
            now_ms
        ],
    ) {
        log::warn!("journal_write: failed to record {} on {}: {}", op, file_path, e);
    }
}

/// Best-effort vault root for `file`, used when something has to be moved into the
/// vault-local recycle bin but the caller has no vault list to hand.
///
/// Order: the vault registered for the active turn (when it actually contains the
/// file) → the nearest ancestor that already has a `.zettelagent` directory → the
/// file's own parent. The last fallback still keeps the trash next to the note
/// instead of failing the operation.
pub(crate) fn infer_vault_root(file: &std::path::Path) -> std::path::PathBuf {
    let resolved = resolve_for_containment(file);

    if let Some(vault) = crate::llm::tool_hooks::active_vault_path() {
        let candidate = std::path::PathBuf::from(&vault);
        if resolved.starts_with(resolve_for_containment(&candidate)) {
            return candidate;
        }
    }

    let mut cursor = file.parent();
    while let Some(dir) = cursor {
        if dir.join(".zettelagent").is_dir() {
            return dir.to_path_buf();
        }
        cursor = dir.parent();
    }

    file.parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

// ── P1-9: User-friendly error mapping ──────────────────────────────

/// Map internal errors to user-readable messages (bilingual).
pub(crate) fn user_friendly_error(e: &anyhow::Error) -> String {
    let msg = e.to_string();
    if msg.contains("DB lock error") || msg.contains("database is locked") {
        "The database is temporarily busy. Please try again in a moment.\n数据库暂时繁忙，请稍后重试。".to_string()
    } else if msg.contains("Access denied") || msg.contains("outside all vaults") {
        format!("Cannot access this file — it's outside your vault folder.\n无法访问此文件——它不在你的知识库文件夹内。\nDetail: {}", msg)
    } else if msg.contains("does not exist") || msg.contains("No such file") || msg.contains("os error 2") {
        format!("File not found. It may have been moved or deleted.\n文件未找到，可能已被移动或删除。\nDetail: {}", msg)
    } else if msg.contains("already exists") {
        format!("A file with this name already exists.\n同名文件已存在。\nDetail: {}", msg)
    } else if msg.contains("No embedding found") || msg.contains("embedding") {
        "This note hasn't been processed yet. Please run 'Sync Vault' first to generate embeddings.\n此笔记尚未被处理，请先运行「同步知识库」以生成向量索引。".to_string()
    } else if msg.contains("network error") || msg.contains("timeout") || msg.contains("reqwest") {
        "Network request failed. Please check your internet connection.\n网络请求失败，请检查网络连接。".to_string()
    } else if msg.contains("Missing") && msg.contains("parameter") {
        format!("A required parameter is missing. Please provide all required fields.\n缺少必要参数。\nDetail: {}", msg)
    } else {
        msg
    }
}

// ── Multi-vault path resolution ────────────────────────────────────

/// Resolve a note path, checking against ALL vault paths (multi-vault support).
/// If the path is absolute, verify it belongs to any vault.
/// If relative, try to resolve against each vault path, returning the first match.
pub(crate) fn resolve_path_multi_vault(
    path: &str,
    primary_vault: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<std::path::PathBuf> {
    let p = std::path::Path::new(path);

    if p.is_absolute() {
        // Absolute path: verify it's within ANY vault.
        // `resolve_for_containment` (not bare `canonicalize`) is required so that a
        // non-existent path carrying `..` cannot pass the component-wise `starts_with`.
        let canonical = resolve_for_containment(p);
        for vp in all_vault_paths {
            let vc = resolve_for_containment(std::path::Path::new(vp));
            if canonical.starts_with(&vc) {
                return Ok(canonical);
            }
        }
        // Fallback: also check primary vault (in case all_vault_paths is empty)
        if !primary_vault.is_empty() {
            let vc = resolve_for_containment(std::path::Path::new(primary_vault));
            if canonical.starts_with(&vc) {
                return Ok(canonical);
            }
        }
        anyhow::bail!("Access denied: path is outside all vaults ({:?})", canonical);
    }

    // Relative path: try each vault, return first existing match
    for vp in all_vault_paths {
        let full = std::path::PathBuf::from(vp).join(path);
        if full.exists() {
            let canonical = full.canonicalize()?;
            let vc = std::path::Path::new(vp)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(vp));
            if canonical.starts_with(&vc) {
                return Ok(canonical);
            }
        }
    }

    // If not found in any vault, try basename-only fallback
    // This handles cases where DB stores "notes/File.md" but the file is at vault root
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string());
    if let Some(ref fname) = filename {
        for vp in all_vault_paths {
            // Walk the vault root (1 level deep) to find the file
            if let Ok(entries) = std::fs::read_dir(vp) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy() == *fname && entry.path().is_file() {
                        if let Ok(canonical) = entry.path().canonicalize() {
                            log::info!("Path fallback: '{}' resolved to '{}'", path, canonical.display());
                            return Ok(canonical);
                        }
                    }
                }
            }
            // Also check common subdirectories
            for subdir in &["notes", "日记", "diary", "archive"] {
                let sub_path = std::path::PathBuf::from(vp).join(subdir).join(fname);
                if sub_path.exists() {
                    if let Ok(canonical) = sub_path.canonicalize() {
                        log::info!("Path fallback (subdir): '{}' resolved to '{}'", path, canonical.display());
                        return Ok(canonical);
                    }
                }
            }
        }
    }

    // If not found in any vault, default to primary vault (for new files, etc.)
    if !primary_vault.is_empty() {
        let full = std::path::PathBuf::from(primary_vault).join(path);
        let canonical = full.canonicalize().unwrap_or(full.clone());
        let vc = std::path::Path::new(primary_vault)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(primary_vault));
        if canonical.starts_with(&vc) || !full.exists() {
            // For non-existing files (e.g. about to be created), just return the path
            return Ok(full);
        }
    }

    anyhow::bail!("Access denied: path '{}' is outside all vaults", path);
}

/// Check if a path is within ANY vault.
///
/// Both sides are resolved first: `Path::starts_with` compares *components*, so an
/// un-normalized `<vault>/../../..` still "starts with" `<vault>` and would slip through.
/// That was exploitable via `get_directory_tree({"path":"../../.."})`, which would list
/// the user's whole home directory and feed it to the LLM provider.
pub(crate) fn is_path_in_any_vault(
    path: &std::path::Path,
    primary_vault: &str,
    all_vault_paths: &[String],
) -> bool {
    let resolved = resolve_for_containment(path);
    for vp in all_vault_paths {
        if resolved.starts_with(resolve_for_containment(std::path::Path::new(vp))) {
            return true;
        }
    }
    // Fallback to primary vault
    if !primary_vault.is_empty()
        && resolved.starts_with(resolve_for_containment(std::path::Path::new(primary_vault)))
    {
        return true;
    }
    false
}

/// Resolve `.` and `..` purely lexically, without touching the filesystem.
/// Unlike `canonicalize` this also works for paths that do not exist yet.
pub(crate) fn lexically_normalize(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // Only pop real directory names; never climb past the root/prefix.
                let pops_a_name = out
                    .components()
                    .next_back()
                    .is_some_and(|c| matches!(c, Component::Normal(_)));
                if pops_a_name {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Produce a comparable absolute form of `path` for containment checks.
///
/// Prefers `canonicalize` (which also resolves symlinks and, on Windows, yields the
/// `\\?\` verbatim prefix). For paths that don't exist yet — a note about to be created —
/// it canonicalizes the deepest existing ancestor and re-appends the remainder, so both
/// sides of the comparison end up in the same prefix form.
pub(crate) fn resolve_for_containment(path: &std::path::Path) -> std::path::PathBuf {
    let normalized = lexically_normalize(path);
    if let Ok(canonical) = normalized.canonicalize() {
        return canonical;
    }

    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = normalized.as_path();
    while let (Some(parent), Some(name)) = (cursor.parent(), cursor.file_name()) {
        suffix.push(name.to_os_string());
        if let Ok(canonical_parent) = parent.canonicalize() {
            let mut out = canonical_parent;
            for part in suffix.iter().rev() {
                out.push(part);
            }
            return out;
        }
        cursor = parent;
    }

    normalized
}

#[cfg(test)]
mod path_containment_tests {
    use super::{is_path_in_any_vault, lexically_normalize};
    use std::path::{Path, PathBuf};

    fn temp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("zettel_vault_{}_{}", tag, std::process::id()));
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        dir
    }

    #[test]
    fn normalizes_parent_segments() {
        assert_eq!(lexically_normalize(Path::new("a/b/../c")), PathBuf::from("a/c"));
        assert_eq!(lexically_normalize(Path::new("a/./b")), PathBuf::from("a/b"));
    }

    #[test]
    fn never_climbs_above_root() {
        // A leading `..` must be preserved, not silently dropped into an absolute path.
        assert_eq!(lexically_normalize(Path::new("../../x")), PathBuf::from("../../x"));
    }

    #[test]
    fn rejects_traversal_out_of_vault() {
        let vault = temp_vault("escape");
        let vaults = vec![vault.to_string_lossy().to_string()];

        // Regression: this is the `get_directory_tree({"path":"../../.."})` payload.
        let escaped = vault.join("..").join("..").join("..");
        assert!(
            !is_path_in_any_vault(&escaped, "", &vaults),
            "traversal above the vault must be denied"
        );
        assert!(!is_path_in_any_vault(&vault.join("../sibling"), "", &vaults));

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn accepts_paths_inside_vault_including_not_yet_created() {
        let vault = temp_vault("inside");
        let vaults = vec![vault.to_string_lossy().to_string()];

        assert!(is_path_in_any_vault(&vault.join("notes"), "", &vaults));
        // A note that does not exist yet must still be accepted, otherwise creating
        // files would break.
        assert!(is_path_in_any_vault(&vault.join("notes").join("new.md"), "", &vaults));
        // Traversal that stays inside is fine.
        assert!(is_path_in_any_vault(&vault.join("notes").join("..").join("notes"), "", &vaults));

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn primary_vault_fallback_still_works() {
        let vault = temp_vault("primary");
        assert!(is_path_in_any_vault(
            &vault.join("notes"),
            &vault.to_string_lossy(),
            &[]
        ));
        let _ = std::fs::remove_dir_all(&vault);
    }
}


