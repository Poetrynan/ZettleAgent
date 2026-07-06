
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
        // Absolute path: verify it's within ANY vault
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        for vp in all_vault_paths {
            let vc = std::path::Path::new(vp)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(vp));
            if canonical.starts_with(&vc) {
                return Ok(canonical);
            }
        }
        // Fallback: also check primary vault (in case all_vault_paths is empty)
        if !primary_vault.is_empty() {
            let vc = std::path::Path::new(primary_vault)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(primary_vault));
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

/// Check if a canonical path is within ANY vault.
pub(crate) fn is_path_in_any_vault(
    canonical: &std::path::Path,
    primary_vault: &str,
    all_vault_paths: &[String],
) -> bool {
    for vp in all_vault_paths {
        let vc = std::path::Path::new(vp)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(vp));
        if canonical.starts_with(&vc) {
            return true;
        }
    }
    // Fallback to primary vault
    if !primary_vault.is_empty() {
        let vc = std::path::Path::new(primary_vault)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(primary_vault));
        if canonical.starts_with(&vc) {
            return true;
        }
    }
    false
}

