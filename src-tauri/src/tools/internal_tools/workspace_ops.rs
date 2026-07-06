use serde_json::json;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

// Workspace operations: list_workspace_folders, create_folder, vault_stats, run_lint, memory


pub(super) fn execute_list_workspace_folders(arguments: &str, all_vault_paths: &[String]) -> anyhow::Result<String> {
    // Parse optional workspace param
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or(json!({}));
    let workspace = args["workspace"].as_str();

    match workspace {
        None | Some("") => {
            // No workspace specified: return all vault root directories (original behavior)
            if all_vault_paths.is_empty() {
                return Ok("No workspace folders are currently mounted.".to_string());
            }
            let result: Vec<serde_json::Value> = all_vault_paths.iter().enumerate().map(|(i, p)| {
                serde_json::json!({
                    "index": i,
                    "path": p,
                    "is_primary": i == 0,
                })
            }).collect();
            Ok(serde_json::to_string_pretty(&result)?)
        }
        Some(ws) => {
            // Workspace specified: resolve to a vault root path, then list subfolders
            let root = resolve_workspace(ws, all_vault_paths)?;
            let root_path = std::path::Path::new(&root);
            if !root_path.is_dir() {
                anyhow::bail!("Workspace path '{}' is not a directory.", root);
            }

            let mut folders: Vec<String> = Vec::new();
            collect_subfolders(root_path, root_path, &mut folders);
            folders.sort();

            if folders.is_empty() {
                return Ok(format!("Workspace '{}' has no subfolders.", root));
            }

            let result = serde_json::json!({
                "workspace": root,
                "folder_count": folders.len(),
                "folders": folders,
            });
            Ok(serde_json::to_string_pretty(&result)?)
        }
    }
}

/// Recursively collect all subdirectory paths relative to `base`.
fn collect_subfolders(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden directories (e.g. .git, .obsidian)
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') {
                    continue;
                }
            }
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/") + "/");
            }
            collect_subfolders(&path, base, out);
        }
    }
}

/// Resolve a workspace identifier (index like "0" or absolute path) to a vault root path.
fn resolve_workspace(ws: &str, all_vault_paths: &[String]) -> anyhow::Result<String> {
    // Try parsing as index first
    if let Ok(idx) = ws.parse::<usize>() {
        if idx < all_vault_paths.len() {
            return Ok(all_vault_paths[idx].clone());
        } else {
            anyhow::bail!("Workspace index {} out of range (have {} workspaces). Use list_workspace_folders to see available workspaces.", idx, all_vault_paths.len());
        }
    }
    // Try as absolute path
    if all_vault_paths.iter().any(|p| p == ws) {
        return Ok(ws.to_string());
    }
    anyhow::bail!("Workspace '{}' is not a recognized workspace folder. Use list_workspace_folders (without params) to see available workspaces.", ws);
}

/// Execute create_folder — creates a new folder inside a workspace vault.
pub(super) fn execute_create_folder(arguments: &str, vault_path: &str, all_vault_paths: &[String]) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let rel_path = args["path"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    // Resolve workspace root
    let root = match args["workspace"].as_str() {
        Some(ws) if !ws.is_empty() => resolve_workspace(ws, all_vault_paths)?,
        _ => vault_path.to_string(),
    };

    // Sanitize: disallow absolute paths, parent traversal
    let clean = rel_path.replace('\\', "/");
    if clean.starts_with('/') || clean.contains("../") || clean.contains("..\\") {
        anyhow::bail!("Folder path must be relative and cannot contain '..'. Got: '{}'", rel_path);
    }

    let full_path = std::path::Path::new(&root).join(&clean);

    if full_path.exists() {
        return Ok(format!("Folder already exists: {}", full_path.display()));
    }

    std::fs::create_dir_all(&full_path)?;
    Ok(format!("Created folder: {}", full_path.display()))
}

// ── Tool Implementations ───────────────────────────────────────────


pub(super) fn execute_run_lint(
    db: &Arc<Mutex<Connection>>,
    _vault_path: &str,
) -> anyhow::Result<String> {
    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let report = crate::lint::run_vault_lint(&conn)?;

    let gh = &report.graph_health;
    let fragmentation = if gh.total_nodes > 0 {
        format!("{:.0}%", (1.0 - gh.largest_component_size as f64 / gh.total_nodes as f64) * 100.0)
    } else {
        "N/A".to_string()
    };

    let output = json!({
        "_summary": format!(
            "Vault health: {} orphans, {} broken links, {} missing metadata. Graph: {} nodes, {} edges, {} components (fragmentation: {}), {} hub overloads, {} unidirectional, {} missing embeddings",
            report.orphans.len(), report.broken_links.len(), report.missing_metadata.len(),
            gh.total_nodes, gh.total_edges, gh.connected_components, fragmentation,
            gh.hub_overload.len(), gh.unidirectional_relations.len(), gh.missing_embeddings
        ),
        "orphan_notes": report.orphans.len(),
        "orphans": report.orphans.iter().take(20).map(|o| json!({
            "file_path": o.file_path,
            "title": o.title,
        })).collect::<Vec<_>>(),
        "broken_links": report.broken_links.len(),
        "broken": report.broken_links.iter().take(20).map(|b| json!({
            "file_path": b.file_path,
            "target": b.target_title,
            "line": b.line_number,
        })).collect::<Vec<_>>(),
        "missing_metadata": report.missing_metadata.len(),
        "graph_health": {
            "connected_components": gh.connected_components,
            "largest_component_size": gh.largest_component_size,
            "total_nodes": gh.total_nodes,
            "total_edges": gh.total_edges,
            "fragmentation": fragmentation,
            "hub_overload_count": gh.hub_overload.len(),
            "hub_overload": gh.hub_overload.iter().take(10).map(|h| json!({
                "file_path": h.file_path,
                "title": h.title,
                "degree": h.degree,
            })).collect::<Vec<_>>(),
            "unidirectional_count": gh.unidirectional_relations.len(),
            "unidirectional": gh.unidirectional_relations.iter().take(10).map(|u| json!({
                "source": u.source,
                "target": u.target,
                "relation": u.relation_type,
            })).collect::<Vec<_>>(),
            "missing_embeddings": gh.missing_embeddings,
        },
        "semantic_duplicates_count": report.semantic_duplicates.len(),
        "semantic_duplicates": report.semantic_duplicates.iter().take(10).map(|d| json!({
            "title_a": d.title_a,
            "title_b": d.title_b,
            "similarity": d.similarity,
        })).collect::<Vec<_>>(),
        "hidden_connections_count": report.hidden_connections.len(),
        "hidden_connections": report.hidden_connections.iter().take(10).map(|h| json!({
            "title_a": h.title_a,
            "title_b": h.title_b,
            "similarity": h.similarity,
        })).collect::<Vec<_>>(),
    });

    Ok(serde_json::to_string_pretty(&output)?)
}


pub(super) fn execute_get_vault_stats(
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    let total_notes: i64 = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    let total_chunks: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
    let total_relations: i64 = conn.query_row("SELECT COUNT(*) FROM note_relations", [], |r| r.get(0))?;
    let total_with_meta: i64 = conn.query_row("SELECT COUNT(*) FROM card_meta", [], |r| r.get(0))?;

    // Orphan count (notes with no relations)
    let orphan_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM files f
         WHERE NOT EXISTS (SELECT 1 FROM note_relations nr WHERE nr.source_path = f.path OR nr.target_path = f.path)",
        [], |r| r.get(0)
    ).unwrap_or(0);

    // Hub count (notes with 5+ connections)
    let hub_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
            SELECT source_path, COUNT(*) as cnt FROM note_relations GROUP BY source_path HAVING cnt >= 5
        )",
        [], |r| r.get(0)
    ).unwrap_or(0);

    // Notes with embeddings
    let embedded_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT file_path) FROM chunks WHERE embedding IS NOT NULL",
        [], |r| r.get(0)
    ).unwrap_or(0);

    // Recent activity (last 7 days)
    let recent_updated: i64 = conn.query_row(
        "SELECT COUNT(*) FROM files WHERE last_synced > datetime('now', '-7 days')",
        [], |r| r.get(0)
    ).unwrap_or(0);

    // Top tags
    let mut tag_stmt = conn.prepare("SELECT tags FROM card_meta WHERE tags IS NOT NULL AND tags != ''")?;
    let tag_rows = tag_stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut tag_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for row in tag_rows {
        if let Ok(tags_str) = row {
            let tags: Vec<String> = if tags_str.starts_with('[') {
                serde_json::from_str(&tags_str).unwrap_or_default()
            } else {
                tags_str.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
            };
            for tag in tags { *tag_counts.entry(tag).or_insert(0) += 1; }
        }
    }
    let mut sorted_tags: Vec<_> = tag_counts.into_iter().collect();
    sorted_tags.sort_by(|a, b| b.1.cmp(&a.1));
    let top_tags: Vec<serde_json::Value> = sorted_tags.iter().take(10).map(|(t, c)| json!({"tag": t, "count": c})).collect();

    Ok(serde_json::to_string_pretty(&json!({
        "total_notes": total_notes,
        "total_chunks": total_chunks,
        "total_connections": total_relations,
        "notes_with_metadata": total_with_meta,
        "notes_with_embeddings": embedded_count,
        "orphan_notes": orphan_count,
        "hub_notes": hub_count,
        "recently_updated_7d": recent_updated,
        "top_tags": top_tags
    }))?)
}

// ── Structured Agent Memory (2026 MemGPT-style Core Memory) ─────────

/// Predefined memory sections in display order
const MEMORY_SECTIONS: &[&str] = &[
    "User Preferences",
    "Workflow Habits",
    "Important Decisions",
    "Vault Context",
    "Research Topics",
];

/// Structured memory with ordered sections
#[derive(Debug, Clone)]
pub struct StructuredMemory {
    pub version: u32,
    pub last_updated: Option<String>,
    pub sections: Vec<(String, Vec<String>)>, // (section_name, items)
}

impl Default for StructuredMemory {
    fn default() -> Self {
        Self {
            version: 2,
            last_updated: None,
            sections: MEMORY_SECTIONS
                .iter()
                .map(|s| (s.to_string(), Vec::new()))
                .collect(),
        }
    }
}

/// Parse structured memory from file content.
/// Handles both v2 (with sections) and v1 (plain text) formats.
pub fn parse_structured_memory(raw: &str) -> StructuredMemory {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return StructuredMemory::default();
    }

    // Check for v2 format: starts with "---" YAML frontmatter
    if trimmed.starts_with("---") {
        return parse_v2_memory(trimmed);
    }

    // v1 format: plain text → auto-migrate into "User Preferences" section
    auto_migrate_v1_to_v2(trimmed)
}

fn parse_v2_memory(raw: &str) -> StructuredMemory {
    let mut mem = StructuredMemory::default();

    // Extract frontmatter
    let parts: Vec<&str> = raw.splitn(3, "---").collect();
    let (frontmatter, body) = if parts.len() >= 3 {
        (parts[1].trim(), parts[2].trim())
    } else {
        ("", raw)
    };

    // Parse version and last_updated from frontmatter
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("version:") {
            mem.version = v.trim().parse().unwrap_or(2);
        } else if let Some(ts) = line.strip_prefix("last_updated:") {
            mem.last_updated = Some(ts.trim().to_string());
        }
    }

    // Parse sections from body
    let mut current_section: Option<String> = None;
    for line in body.lines() {
        let line_trimmed = line.trim();
        if let Some(header) = line_trimmed.strip_prefix("## ") {
            current_section = Some(header.trim().to_string());
            // Ensure section exists
            if !mem.sections.iter().any(|(name, _)| name == header.trim()) {
                mem.sections.push((header.trim().to_string(), Vec::new()));
            }
        } else if let Some(item) = line_trimmed.strip_prefix("- ") {
            if let Some(ref section) = current_section {
                let item = item.trim().to_string();
                if !item.is_empty() {
                    if let Some((_, items)) = mem.sections.iter_mut().find(|(name, _)| name == section) {
                        items.push(item);
                    }
                }
            }
        }
    }

    mem
}

fn auto_migrate_v1_to_v2(raw: &str) -> StructuredMemory {
    let mut mem = StructuredMemory::default();
    mem.last_updated = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

    // Parse existing bullet points or lines into "User Preferences"
    let items: Vec<String> = raw
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| {
            // Strip leading "- " if present
            l.strip_prefix("- ").unwrap_or(l).to_string()
        })
        .collect();

    if let Some((_, pref_items)) = mem.sections.iter_mut().find(|(name, _)| name == "User Preferences") {
        *pref_items = items;
    }

    mem
}

/// Serialize StructuredMemory back to file content
pub fn serialize_structured_memory(mem: &StructuredMemory) -> String {
    let mut out = String::new();

    // YAML frontmatter
    out.push_str("---\n");
    out.push_str(&format!("version: {}\n", mem.version));
    if let Some(ref ts) = mem.last_updated {
        out.push_str(&format!("last_updated: {}\n", ts));
    }
    out.push_str("---\n\n");

    // Sections (only emit non-empty ones)
    for (section_name, items) in &mem.sections {
        if !items.is_empty() {
            out.push_str(&format!("## {}\n", section_name));
            for item in items {
                out.push_str(&format!("- {}\n", item));
            }
            out.push('\n');
        }
    }

    out
}

/// Map user-friendly section aliases to canonical section names
fn resolve_section_name(section: &str) -> String {
    match section.to_lowercase().as_str() {
        "preferences" | "prefs" | "user preferences" | "偏好" => "User Preferences".to_string(),
        "habits" | "workflow" | "workflow habits" | "习惯" => "Workflow Habits".to_string(),
        "decisions" | "important decisions" | "决策" => "Important Decisions".to_string(),
        "vault" | "vault context" | "context" | "上下文" => "Vault Context".to_string(),
        "research" | "research topics" | "topics" | "研究主题" => "Research Topics".to_string(),
        other => {
            // Capitalize first letter for custom sections
            let mut c = other.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        }
    }
}

// ── 21. read_memory ────────────────────────────────────────────────

pub(super) fn execute_read_memory(vault_path: &str) -> anyhow::Result<String> {
    let memory_path = std::path::PathBuf::from(vault_path)
        .join(".zettelagent")
        .join("memory.md");

    if !memory_path.exists() {
        return Ok("No persistent memory found. Use update_memory with a `section` parameter to create structured memory.\n\nAvailable sections: User Preferences, Workflow Habits, Important Decisions, Vault Context".to_string());
    }

    let content = std::fs::read_to_string(&memory_path)?;
    let mem = parse_structured_memory(&content);

    // Auto-migrate v1 → v2 on first read
    if !content.trim().starts_with("---") && !content.trim().is_empty() {
        let migrated = serialize_structured_memory(&mem);
        let _ = std::fs::write(&memory_path, &migrated); // best-effort migration
    }

    // Format output for Agent
    let mut output = String::from("## Agent Core Memory\n\n");
    let mut has_content = false;
    for (section, items) in &mem.sections {
        if !items.is_empty() {
            has_content = true;
            output.push_str(&format!("### {}\n", section));
            for item in items {
                output.push_str(&format!("- {}\n", item));
            }
            output.push('\n');
        }
    }

    if !has_content {
        output.push_str("(empty — use update_memory to add entries)\n");
    }

    if let Some(ref ts) = mem.last_updated {
        output.push_str(&format!("_Last updated: {}_\n", ts));
    }

    Ok(output)
}

// ── 22. update_memory ──────────────────────────────────────────────

pub(super) fn execute_update_memory(arguments: &str, vault_path: &str) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let content = args["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'content' parameter"))?;

    let section = args["section"].as_str();
    let action = args["action"].as_str().unwrap_or("add");

    let zettelagent_dir = std::path::PathBuf::from(vault_path).join(".zettelagent");
    std::fs::create_dir_all(&zettelagent_dir)?;
    let memory_path = zettelagent_dir.join("memory.md");

    // If no section specified → legacy full-replace mode (backward compatible)
    if section.is_none() {
        // But still wrap in v2 format
        let mut mem = StructuredMemory::default();
        mem.last_updated = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

        // Parse the content as bullet points into "User Preferences"
        let items: Vec<String> = content
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| l.strip_prefix("- ").unwrap_or(l).to_string())
            .collect();

        if let Some((_, pref_items)) = mem.sections.iter_mut().find(|(name, _)| name == "User Preferences") {
            *pref_items = items;
        }

        let serialized = serialize_structured_memory(&mem);
        std::fs::write(&memory_path, &serialized)?;
        return Ok("Memory replaced (full update). Tip: use `section` parameter for incremental updates.".to_string());
    }

    // Section-based incremental update
    let section_name = resolve_section_name(section.unwrap());

    // Read existing memory
    let mut mem = if memory_path.exists() {
        let raw = std::fs::read_to_string(&memory_path)?;
        parse_structured_memory(&raw)
    } else {
        StructuredMemory::default()
    };

    // Ensure section exists
    if !mem.sections.iter().any(|(name, _)| name == &section_name) {
        mem.sections.push((section_name.clone(), Vec::new()));
    }

    let items_ref = &mut mem.sections.iter_mut()
        .find(|(name, _)| name == &section_name)
        .unwrap()
        .1;

    match action {
        "add" => {
            // Add new items (avoid duplicates)
            let new_items: Vec<String> = content
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .map(|l| l.strip_prefix("- ").unwrap_or(l).to_string())
                .collect();

            for item in new_items {
                if !items_ref.iter().any(|existing| existing.to_lowercase() == item.to_lowercase()) {
                    items_ref.push(item);
                }
            }
        }
        "remove" => {
            // Remove items matching content (case-insensitive substring match)
            let lower_content = content.to_lowercase();
            items_ref.retain(|item| !item.to_lowercase().contains(&lower_content));
        }
        "replace_section" => {
            // Replace entire section content
            *items_ref = content
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .map(|l| l.strip_prefix("- ").unwrap_or(l).to_string())
                .collect();
        }
        _ => {
            return Err(anyhow::anyhow!("Unknown action '{}'. Use: add, remove, replace_section", action));
        }
    }

    // Update timestamp
    mem.last_updated = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

    // Write back
    let serialized = serialize_structured_memory(&mem);
    std::fs::write(&memory_path, &serialized)?;

    let item_count = mem.sections.iter()
        .find(|(name, _)| name == &section_name)
        .map(|(_, items)| items.len())
        .unwrap_or(0);

    Ok(format!(
        "Memory updated: [{}] now has {} items (action: {})",
        section_name, item_count, action
    ))
}

// ── delete_folder ──────────────────────────────────────────────────

pub(super) fn execute_delete_folder(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let folder = args["path"].as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'path' parameter"))?;

    let full_path = if std::path::Path::new(folder).is_absolute() {
        std::path::PathBuf::from(folder)
    } else {
        std::path::PathBuf::from(vault_path).join(folder)
    };

    if !super::helpers::is_path_in_any_vault(&full_path, vault_path, all_vault_paths) {
        anyhow::bail!("Access denied: path is outside vault");
    }

    if !full_path.is_dir() {
        anyhow::bail!("Path '{}' is not a directory", full_path.display());
    }

    // Only delete empty folders for safety
    let entries: Vec<_> = std::fs::read_dir(&full_path)?.collect();
    if !entries.is_empty() {
        anyhow::bail!("Folder is not empty ({} items). Delete contents first.", entries.len());
    }

    std::fs::remove_dir(&full_path)?;
    Ok(json!({
        "success": true,
        "message": format!("Deleted empty folder: {}", full_path.display())
    }).to_string())
}

// ── get_directory_tree ─────────────────────────────────────────────

pub(super) fn execute_get_directory_tree(
    arguments: &str,
    vault_path: &str,
    all_vault_paths: &[String],
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or(json!({}));
    let root = args["path"].as_str().unwrap_or("");
    let max_depth = args["max_depth"].as_u64().unwrap_or(5) as usize;

    let root_path = if root.is_empty() {
        std::path::PathBuf::from(vault_path)
    } else if std::path::Path::new(root).is_absolute() {
        std::path::PathBuf::from(root)
    } else {
        std::path::PathBuf::from(vault_path).join(root)
    };

    if !super::helpers::is_path_in_any_vault(&root_path, vault_path, all_vault_paths) {
        anyhow::bail!("Access denied: path is outside vault");
    }

    fn build_tree(dir: &std::path::Path, depth: usize, max_depth: usize) -> serde_json::Value {
        if depth >= max_depth || !dir.is_dir() {
            return json!(null);
        }
        let mut children = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut sorted: Vec<_> = entries.flatten().collect();
            sorted.sort_by_key(|e| e.file_name());
            for entry in sorted {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                if path.is_dir() {
                    let subtree = build_tree(&path, depth + 1, max_depth);
                    children.push(json!({
                        "name": name,
                        "type": "folder",
                        "children": subtree
                    }));
                } else {
                    children.push(json!({
                        "name": name,
                        "type": "file",
                        "size": path.metadata().map(|m| m.len()).unwrap_or(0)
                    }));
                }
            }
        }
        json!(children)
    }

    let tree = build_tree(&root_path, 0, max_depth);
    Ok(json!({
        "root": root_path.display().to_string(),
        "max_depth": max_depth,
        "tree": tree
    }).to_string())
}

// ── query_database ─────────────────────────────────────────────────

pub(super) fn execute_query_database(
    arguments: &str,
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let note_type = args["note_type"].as_str();
    let tag = args["tag"].as_str();
    let folder = args["folder"].as_str();
    let sort_by = args["sort_by"].as_str().unwrap_or("path");
    let limit = args["limit"].as_u64().unwrap_or(50) as usize;

    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;

    // Build dynamic query
    let mut sql = String::from(
        "SELECT f.path, f.title, COALESCE(cm.note_type, 'permanent') AS note_type,
         COALESCE(cm.tags, '[]') AS tags_json,
         COALESCE(cm.links, '[]') AS links_json,
         cm.confidence,
         f.last_synced
         FROM files f
         LEFT JOIN card_meta cm ON f.path = cm.file_path
         WHERE 1=1"
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(nt) = note_type {
        sql.push_str(&format!(" AND COALESCE(cm.note_type, 'permanent') = ?{}", params.len() + 1));
        params.push(Box::new(nt.to_string()));
    }
    if let Some(f) = folder {
        sql.push_str(&format!(" AND f.path LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("{}%", f)));
    }

    match sort_by {
        "date" => sql.push_str(" ORDER BY f.last_synced DESC"),
        "size" => sql.push_str(" ORDER BY length(f.title) DESC"),
        _ => sql.push_str(" ORDER BY f.path"),
    }

    sql.push_str(&format!(" LIMIT {}", limit.min(200)));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let path: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let note_type: String = row.get(2)?;
        let tags_json: String = row.get(3)?;
        let links_json: String = row.get(4)?;
        let confidence: Option<f64> = row.get(5)?;
        let last_synced: Option<String> = row.get(6)?;
        Ok((path, title, note_type, tags_json, links_json, confidence, last_synced))
    })?;

    let mut results = Vec::new();
    for row in rows {
        let (path, title, note_type, tags_json, links_json, confidence, last_synced) = row?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let link_count: usize = serde_json::from_str::<Vec<serde_json::Value>>(&links_json)
            .map(|v| v.len()).unwrap_or(0);

        // Filter by tag in Rust (since JSON array in SQLite)
        if let Some(t) = tag {
            if !tags.iter().any(|tg| tg.eq_ignore_ascii_case(t)) {
                continue;
            }
        }

        let display_title = title.unwrap_or_else(|| {
            path.replace('\\', "/").rsplit('/').next().unwrap_or(&path).replace(".md", "")
        });

        results.push(json!({
            "path": path,
            "title": display_title,
            "type": note_type,
            "tags": tags,
            "links": link_count,
            "confidence": confidence,
            "last_synced": last_synced,
        }));
    }

    Ok(json!({
        "count": results.len(),
        "filters": {
            "note_type": note_type,
            "tag": tag,
            "folder": folder,
            "sort_by": sort_by,
        },
        "entries": results
    }).to_string())
}

// ── get_embedding_status ───────────────────────────────────────────

pub(super) fn execute_get_embedding_status(
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let total_chunks: usize = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    let indexed_chunks: usize = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |row| row.get(0)
    )?;
    let total_files: usize = conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;

    let coverage = if total_chunks > 0 {
        (indexed_chunks as f64 / total_chunks as f64 * 100.0).round()
    } else {
        0.0
    };

    Ok(json!({
        "total_files": total_files,
        "total_chunks": total_chunks,
        "indexed_chunks": indexed_chunks,
        "coverage_percent": coverage,
        "has_index": indexed_chunks > 0,
        "message": format!("{}/{} chunks indexed ({}%)", indexed_chunks, total_chunks, coverage)
    }).to_string())
}

// ── trigger_sync ───────────────────────────────────────────────────

pub(super) fn execute_trigger_sync(
    db: &Arc<Mutex<Connection>>,
    vault_path: &str,
) -> anyhow::Result<String> {
    let vault = std::path::PathBuf::from(vault_path);
    if !vault.exists() {
        anyhow::bail!("Vault path does not exist: {}", vault_path);
    }

    let mut conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
    let tx = conn.transaction()?;

    let mut files_updated = 0usize;
    let mut total_files = 0usize;

    fn walk_sync(
        dir: &std::path::Path, conn: &rusqlite::Connection,
        updated: &mut usize, total: &mut usize,
    ) -> anyhow::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
                        continue;
                    }
                }
                walk_sync(&path, conn, updated, total)?;
            } else if path.extension().map_or(false, |ext| ext == "md") {
                *total += 1;
                if crate::db::sync::sync_file(conn, &path)? {
                    *updated += 1;
                }
            }
        }
        Ok(())
    }

    walk_sync(&vault, &tx, &mut files_updated, &mut total_files)?;
    let files_removed = crate::db::sync::remove_deleted_files(&tx, vault_path)?;
    tx.commit()?;

    Ok(json!({
        "success": true,
        "total_files": total_files,
        "files_updated": files_updated,
        "files_removed": files_removed,
        "message": format!("Synced vault: {} files ({} updated, {} removed)", total_files, files_updated, files_removed)
    }).to_string())
}

// ── rebuild_semantic_edges ─────────────────────────────────────────

pub(super) fn execute_rebuild_semantic_edges(
    db: &Arc<Mutex<Connection>>,
) -> anyhow::Result<String> {
    let db_path: String = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
        conn.query_row(
            "SELECT file FROM pragma_database_list() WHERE name = 'main'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };

    if db_path.is_empty() {
        // Fallback for in-memory database
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
        crate::db::search::compute_and_store_semantic_edges(&conn, None)
            .map_err(|e| anyhow::anyhow!("Rebuilding semantic edges failed: {}", e))?;
        crate::db::search::invalidate_graph_cache(&conn);
        return Ok(json!({
            "success": true,
            "message": "Semantic edges rebuilt (in-memory)."
        }).to_string());
    }

    // Spawn background thread to prevent blocking the UI
    std::thread::spawn(move || {
        log::info!("Starting background semantic edge rebuild at {}", db_path);
        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("Failed to open database connection in background: {}", e);
                return;
            }
        };

        let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");

        match crate::db::search::compute_and_store_semantic_edges(&conn, None) {
            Ok(edge_count) => {
                log::info!("Background precomputed {} semantic edges successfully", edge_count);
                crate::db::search::invalidate_graph_cache(&conn);
            }
            Err(e) => {
                log::error!("Background semantic edge rebuild failed: {}", e);
            }
        }
    });

    Ok(json!({
        "success": true,
        "message": "Semantic edges rebuilding in background..."
    }).to_string())
}
