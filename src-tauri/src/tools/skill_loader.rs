use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::llm::{ToolDef, ToolFunction};

/// Information about a discovered skill.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub version: String,
    pub tools: Vec<String>,
    pub directory: String,
    pub enabled: bool,
    pub has_skill_md: bool,
}

/// A fully-specified tool declared in a skill manifest.
///
/// Skills can declare tools in three ways (in priority order):
/// 1. `maps_to` — delegate execution to another tool. Two forms:
///    - `"mcp:{server}_{tool}"` → dispatches to the named MCP tool
///    - `"internal:{tool_name}"` → dispatches to an existing internal tool
///      (e.g. `internal:search_notes`). The skill's tool name is an alias.
/// 2. (default) prompt-guided — the LLM emits the call and `SKILL.md` tells
///    it how to fulfil it; `execute_skill_tool` returns a guidance message.
#[derive(Debug, Clone, Deserialize)]
pub struct SkillToolDef {
    /// Tool name as exposed to the LLM (without the `skill_{skill}_` prefix).
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for the tool's parameters (defaults to empty object).
    #[serde(default = "default_parameters")]
    pub parameters: Value,
    /// Optional delegation target. See [`SkillToolDef`] docs for formats.
    #[serde(default, skip_serializing)]
    pub maps_to: Option<String>,
}

fn default_parameters() -> Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

/// Raw manifest.json structure.
#[derive(Debug, Deserialize)]
struct SkillManifest {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_version")]
    version: String,
    /// Legacy: bare tool names (prompt-guided, empty schema).
    #[serde(default)]
    tools: Vec<String>,
    /// New: full tool definitions with schema + optional `maps_to`.
    #[serde(default)]
    tools_def: Vec<SkillToolDef>,
    #[serde(default)]
    mcp_servers: Vec<serde_json::Value>,
}

fn default_version() -> String {
    "0.1.0".to_string()
}

/// Parsed YAML frontmatter from the top of a `SKILL.md` file.
///
/// This mirrors the Anthropic Agent Skills convention: a skill carries its
/// identity (name/description) in a `---`-delimited YAML header, and the body
/// below is the on-demand instruction payload. We only parse the fields we
/// consume; unknown keys are ignored so a skill author can add their own
/// metadata (author, homepage, …) without tripping the loader.
///
/// Every field is optional here so the caller can layer fallbacks
/// (frontmatter → manifest.json → directory name) — see `load_skill_info`.
#[derive(Debug, Default)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
    version: Option<String>,
    tools: Vec<String>,
}

/// Parse the YAML frontmatter block at the top of a SKILL.md file.
///
/// Deliberately a hand-rolled line scanner rather than a full YAML parser:
/// this matches the sibling `db::sync::parse_frontmatter` (sync.rs:26) and
/// avoids pulling a YAML crate in for four scalar fields. Recognises the same
/// `key: value` / `[a, b]` shapes the rest of the vault already uses.
///
/// Returns `None` when there is no well-formed `---`…`---` block, which the
/// caller treats as "no frontmatter" (not an error — a bare SKILL.md still
/// loads with directory-name fallback for backward compatibility).
fn parse_skill_frontmatter(content: &str) -> Option<SkillFrontmatter> {
    let mut lines = content.lines();

    // Opening delimiter must be exactly `---` on the first line.
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut fm = SkillFrontmatter::default();
    let mut closed = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            closed = true;
            break;
        }
        // `key: value` — split on the first colon so descriptions may contain colons.
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim().to_lowercase();
            let value = value.trim();
            match key.as_str() {
                "name" if !value.is_empty() => fm.name = Some(value.to_string()),
                "description" if !value.is_empty() => fm.description = Some(value.to_string()),
                "version" if !value.is_empty() => fm.version = Some(value.to_string()),
                "tools" => fm.tools = parse_tools_list(value),
                _ => {} // unknown key — ignore, don't fail
            }
        }
    }

    // A block with no closing `---` is malformed; refuse it so we don't
    // silently swallow the whole file body as "frontmatter".
    if closed { Some(fm) } else { None }
}

/// Parse a YAML inline list of tool names: `[read_file, "grep"]` or a bare
/// single value. Mirrors `db::sync::parse_tags_value` (sync.rs:78).
fn parse_tools_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let inner = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        return vec![trimmed.to_string()];
    };
    inner
        .split(',')
        .map(|t| t.trim().trim_matches('"').trim_matches('\'').trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Resolve a single directory into a `SkillInfo`, layering the two metadata
/// sources so both new and legacy skills load.
///
/// A directory counts as a skill if it contains **either** a SKILL.md **or** a
/// manifest.json. Field precedence is frontmatter → manifest → fallback:
/// - a progressive-disclosure skill declares everything in SKILL.md frontmatter;
/// - a legacy skill has only manifest.json (must keep working — hard requirement);
/// - a skill with both gets frontmatter priority, with manifest filling any gaps.
///
/// Returns `None` for a directory that is neither, so scanning skips it.
fn load_skill_info(path: &Path) -> Option<SkillInfo> {
    let manifest_path = path.join("manifest.json");
    let skill_md_path = path.join("SKILL.md");
    let has_manifest = manifest_path.exists();
    let has_skill_md = skill_md_path.exists();
    if !has_manifest && !has_skill_md {
        return None;
    }

    // Parse manifest (may fail → treat as absent but log, matching prior behaviour).
    let manifest: Option<SkillManifest> = if has_manifest {
        match parse_manifest(&manifest_path) {
            Ok(m) => Some(m),
            Err(e) => {
                log::warn!("Failed to parse manifest at {:?}: {}", manifest_path, e);
                None
            }
        }
    } else {
        None
    };

    // Parse SKILL.md frontmatter (only reads the header region we split off).
    let frontmatter: Option<SkillFrontmatter> = if has_skill_md {
        std::fs::read_to_string(&skill_md_path)
            .ok()
            .and_then(|c| parse_skill_frontmatter(&c))
    } else {
        None
    };

    // A directory with a broken manifest and no readable frontmatter, yet no
    // SKILL.md at all, is not a usable skill.
    if manifest.is_none() && !has_skill_md {
        return None;
    }

    let dir_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // name: frontmatter → manifest → directory name (A.4).
    let name = frontmatter
        .as_ref()
        .and_then(|f| f.name.clone())
        .or_else(|| manifest.as_ref().map(|m| m.name.clone()))
        .unwrap_or_else(|| dir_name.clone());

    // description: frontmatter → manifest. Empty is allowed but warned (A.4):
    // the skill still loads so its tools remain usable.
    let description = frontmatter
        .as_ref()
        .and_then(|f| f.description.clone())
        .or_else(|| {
            manifest
                .as_ref()
                .map(|m| m.description.clone())
                .filter(|d| !d.is_empty())
        })
        .unwrap_or_default();
    if description.is_empty() {
        log::warn!(
            "Skill '{}' ({:?}) has no description — loading anyway, but the model \
             will have nothing to route on in the compact skill index.",
            name, path
        );
    }

    let version = frontmatter
        .as_ref()
        .and_then(|f| f.version.clone())
        .or_else(|| manifest.as_ref().map(|m| m.version.clone()))
        .unwrap_or_else(default_version);

    // tools: frontmatter list wins if present, else the manifest's legacy list.
    // (Full `tools_def` schemas still come from the manifest in
    // `collect_skill_tool_defs`; frontmatter only carries bare names.)
    let tools = frontmatter
        .as_ref()
        .filter(|f| !f.tools.is_empty())
        .map(|f| f.tools.clone())
        .or_else(|| manifest.as_ref().map(|m| m.tools.clone()))
        .unwrap_or_default();

    Some(SkillInfo {
        name,
        description,
        version,
        tools,
        directory: path.to_string_lossy().to_string(),
        enabled: true,
        has_skill_md,
    })
}

/// Detail view of a skill (manifest + SKILL.md content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetail {
    pub info: SkillInfo,
    pub skill_md_content: Option<String>,
    pub mcp_servers: Vec<serde_json::Value>,
}

/// Scan a directory for skills. A subdirectory is a skill if it contains a
/// SKILL.md (progressive-disclosure format) **or** a manifest.json (legacy).
/// Metadata resolution (frontmatter → manifest → dir name) lives in
/// [`load_skill_info`].
pub fn scan_skill_directory(dir_path: &str) -> anyhow::Result<Vec<SkillInfo>> {
    let dir = Path::new(dir_path);
    if !dir.exists() || !dir.is_dir() {
        anyhow::bail!("Skill directory does not exist: {}", dir_path);
    }

    let mut skills = Vec::new();

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        if let Some(info) = load_skill_info(&path) {
            skills.push(info);
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

/// Parse a manifest.json file.
fn parse_manifest(path: &PathBuf) -> anyhow::Result<SkillManifest> {
    let content = std::fs::read_to_string(path)?;
    let manifest: SkillManifest = serde_json::from_str(&content)?;
    Ok(manifest)
}

/// Get detailed information about a skill, including SKILL.md content.
pub fn get_skill_detail(skill_dir: &str) -> anyhow::Result<SkillDetail> {
    let dir = Path::new(skill_dir);
    if !dir.exists() || !dir.is_dir() {
        anyhow::bail!("Skill directory does not exist: {}", skill_dir);
    }

    // Same precedence as scanning, so the detail view and the prompt index can
    // never disagree about a skill's name/description.
    let info = load_skill_info(dir)
        .ok_or_else(|| anyhow::anyhow!("Not a skill directory (no SKILL.md or manifest.json): {}", skill_dir))?;

    // `mcp_servers` only ever lives in manifest.json — frontmatter has no
    // equivalent, so this stays a manifest-only read.
    let manifest_path = dir.join("manifest.json");
    let mcp_servers = if manifest_path.exists() {
        parse_manifest(&manifest_path)
            .map(|m| m.mcp_servers)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let skill_md_path = dir.join("SKILL.md");
    let skill_md_content = if skill_md_path.exists() {
        Some(std::fs::read_to_string(&skill_md_path)?)
    } else {
        None
    };

    Ok(SkillDetail {
        info,
        skill_md_content,
        mcp_servers,
    })
}

/// Scan all configured skill directories and return combined results.
/// Scan every configured directory, with a mtime-keyed cache.
///
/// This runs at least twice on every agent turn (`collect_skill_prompts` for
/// the system prompt, `collect_skill_tool_defs` for the tool list), and each
/// call does `read_dir` + parses every `manifest.json`. Cache the parsed result
/// keyed by a fingerprint of the directory list plus each dir's mtime, so an
/// unchanged skill folder is scanned from disk once, not on every message. A
/// new/removed/edited skill bumps the containing dir's mtime → cache miss.
static SCAN_CACHE: std::sync::OnceLock<std::sync::Mutex<(u64, Vec<SkillInfo>)>> =
    std::sync::OnceLock::new();

fn scan_fingerprint(directories: &[String]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for dir in directories {
        dir.hash(&mut hasher);
        // Fold in the directory's own mtime (catches add/remove of a skill) and
        // each immediate subdirectory's mtime (catches edits to a manifest).
        if let Ok(meta) = std::fs::metadata(dir) {
            if let Ok(m) = meta.modified() {
                if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                    d.as_secs().hash(&mut hasher);
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut sub: Vec<(String, u64)> = Vec::new();
            for e in entries.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_dir() {
                        let secs = meta
                            .modified()
                            .ok()
                            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        sub.push((e.file_name().to_string_lossy().into_owned(), secs));
                    }
                }
            }
            // read_dir order is not stable across platforms — sort for a stable hash.
            sub.sort();
            sub.hash(&mut hasher);
        }
    }
    hasher.finish()
}

pub fn scan_all_skill_directories(directories: &[String]) -> Vec<SkillInfo> {
    let key = scan_fingerprint(directories);
    let cache = SCAN_CACHE.get_or_init(|| std::sync::Mutex::new((0, Vec::new())));

    if let Ok(guard) = cache.lock() {
        if guard.0 == key && !directories.is_empty() {
            return guard.1.clone();
        }
    }

    let mut all_skills = Vec::new();
    for dir in directories {
        match scan_skill_directory(dir) {
            Ok(skills) => all_skills.extend(skills),
            Err(e) => log::warn!("Failed to scan skill directory '{}': {}", dir, e),
        }
    }

    if let Ok(mut guard) = cache.lock() {
        *guard = (key, all_skills.clone());
    }
    all_skills
}

/// Maximum characters of SKILL.md body returned by one `read_skill` call.
///
/// Generous compared to the old 4000-char whole-prompt budget: this payload is
/// paid for once, only when the model actually asks for it, instead of on every
/// turn for every skill.
const SKILL_BODY_MAX_CHARS: usize = 12_000;

/// Build the compact skill *index* injected into the system prompt.
///
/// Progressive disclosure: this emits only `name` + `description` (one line per
/// skill) and never the SKILL.md body. The model pulls the full instructions on
/// demand via the `read_skill` tool ([`execute_read_skill`]).
///
/// Why: the previous design pasted every skill's SKILL.md (truncated at 4000
/// chars *each*) into the prompt on every single turn. With a handful of skills
/// installed that is tens of thousands of tokens of instructions the model
/// mostly does not need, re-sent every message. The index costs ~20 tokens per
/// skill instead.
///
/// The function name is kept (`collect_skill_prompts`) because the call site in
/// `commands::chat_commands` (chat_commands.rs:777) feeds it straight into the
/// `## Loaded Skills` prompt section.
pub fn collect_skill_prompts(directories: &[String]) -> String {
    let mut combined = String::new();
    let skills = scan_all_skill_directories(directories);

    for skill in &skills {
        if !skill.enabled {
            continue;
        }
        // Descriptions may legitimately be missing (see `load_skill_info`); emit
        // a placeholder rather than a dangling colon so the line stays parseable.
        let description = if skill.description.is_empty() {
            "(no description provided)"
        } else {
            skill.description.as_str()
        };
        combined.push_str(&format!(
            "- `{}` (v{}): {}\n",
            skill.name, skill.version, description
        ));
    }

    combined
}

/// Return a skill's full SKILL.md body — the second half of progressive
/// disclosure, invoked by the `read_skill` tool.
///
/// Errors (rather than panics) on an unknown skill name or a skill that has no
/// SKILL.md, and lists what *is* available so the model can self-correct
/// instead of retrying the same wrong name.
pub fn read_skill_body(directories: &[String], skill_name: &str) -> anyhow::Result<String> {
    let skills = scan_all_skill_directories(directories);

    // Exact match first, then case-insensitive — models frequently re-case names.
    let skill = skills
        .iter()
        .find(|s| s.name == skill_name)
        .or_else(|| skills.iter().find(|s| s.name.eq_ignore_ascii_case(skill_name)));

    let skill = match skill {
        Some(s) => s,
        None => {
            let available: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
            anyhow::bail!(
                "No skill named '{}'. Available skills: {}",
                skill_name,
                if available.is_empty() { "(none loaded)".to_string() } else { available.join(", ") }
            );
        }
    };

    let skill_md_path = std::path::Path::new(&skill.directory).join("SKILL.md");
    if !skill_md_path.exists() {
        anyhow::bail!(
            "Skill '{}' has no SKILL.md — it only declares tools in manifest.json, so there are no extra instructions to read.",
            skill.name
        );
    }

    let content = std::fs::read_to_string(&skill_md_path)?;

    // Count chars, not bytes — byte slicing panics mid-codepoint on CJK skills.
    let char_count = content.chars().count();
    if char_count > SKILL_BODY_MAX_CHARS {
        let head: String = content.chars().take(SKILL_BODY_MAX_CHARS).collect();
        Ok(format!(
            "{}...\n[Truncated — full content: {} chars]",
            head, char_count
        ))
    } else {
        Ok(content)
    }
}

/// Tool definition for `read_skill`.
///
/// Lives here rather than in `internal_tools::get_internal_tool_defs` because
/// execution needs the configured `skill_dirs`, which only
/// `tools::execute_tool` has in scope (tools/mod.rs:16).
pub fn read_skill_tool_def() -> ToolDef {
    ToolDef {
        tool_type: "function".to_string(),
        function: ToolFunction {
            name: "read_skill".to_string(),
            description: "Load the full instructions of an installed skill. The system prompt lists each skill's name and one-line description; call this with the skill's name to read its complete SKILL.md guidance before acting on it. Read-only.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Skill name exactly as listed in the '## Loaded Skills' section of the system prompt."
                    }
                },
                "required": ["name"]
            }),
        },
    }
}

/// Execute a `read_skill` call. Dispatched from `tools::execute_tool`.
pub fn execute_read_skill(arguments: &str, skill_dirs: &[String]) -> anyhow::Result<String> {
    let args: Value = serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("read_skill requires a non-empty 'name' argument"))?;

    read_skill_body(skill_dirs, name)
}

/// Collect tool definitions from all skills' manifest.json.
///
/// Two sources merged:
/// - `tools_def` (new): full definitions with schema + optional `maps_to`
/// - `tools` (legacy): bare names (prompt-guided, empty schema)
///
/// Tool name format exposed to the LLM: `skill_{skill_name}_{tool_name}`.
/// Execution is handled by [`crate::tools::execute_skill_tool`].
pub fn collect_skill_tool_defs(directories: &[String]) -> Vec<ToolDef> {
    let skills = scan_all_skill_directories(directories);
    let mut tools = Vec::new();

    for skill in &skills {
        if !skill.enabled {
            continue;
        }

        // Re-parse the manifest to access full tool defs.
        let manifest_path = std::path::Path::new(&skill.directory).join("manifest.json");
        let manifest: Option<SkillManifest> = if manifest_path.exists() {
            std::fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|c| serde_json::from_str::<SkillManifest>(&c).ok())
        } else {
            None
        };

        // 1. Full tool definitions (new path)
        if let Some(ref m) = manifest {
            for td in &m.tools_def {
                tools.push(ToolDef {
                    tool_type: "function".to_string(),
                    function: ToolFunction {
                        name: format!("skill_{}_{}", m.name, td.name),
                        description: if td.description.is_empty() {
                            format!("[Skill:{}] {}", m.name, td.name)
                        } else {
                            format!("[Skill:{}] {}", m.name, td.description)
                        },
                        parameters: td.parameters.clone(),
                    },
                });
            }
        }

        // 2. Legacy bare tool names — only add if not already declared in tools_def
        let declared_names: std::collections::HashSet<&str> = manifest
            .as_ref()
            .map(|m| m.tools_def.iter().map(|t| t.name.as_str()).collect())
            .unwrap_or_default();
        for tool_name in &skill.tools {
            if declared_names.contains(tool_name.as_str()) {
                continue; // already declared with full schema
            }
            tools.push(ToolDef {
                tool_type: "function".to_string(),
                function: ToolFunction {
                    name: format!("skill_{}_{}", skill.name, tool_name),
                    description: format!("[Skill:{}] {} — skill-guided tool", skill.name, tool_name),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {}
                    }),
                },
            });
        }
    }

    tools
}

/// Execute a `skill_{skill}_{tool}` call.
///
/// Resolution order (returns Ok(String) result):
/// 1. Look up `maps_to` in the manifest:
///    - `mcp:{server}_{tool}` → delegate to MCP tool via existing dispatch
///    - `internal:{tool}` → delegate to the internal tool of that name
/// 2. No `maps_to` → prompt-guided: return a guidance message instructing
///    the LLM to follow the SKILL.md instructions to answer using its
///    available built-in tools, instead of bailing with "Unknown tool".
pub async fn execute_skill_tool(
    full_name: &str,
    arguments: &str,
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
    config: &crate::llm::LlmConfig,
    skill_dirs: &[String],
) -> Option<anyhow::Result<String>> {
    // Format: skill_{skill_name}_{tool_name}
    let rest = full_name.strip_prefix("skill_")?;

    let skills = scan_all_skill_directories(skill_dirs);
    for skill in &skills {
        let prefix = format!("{}_", skill.name);
        if let Some(tool_name) = rest.strip_prefix(&prefix) {
            // Re-read the manifest to get the SkillToolDef
            let manifest_path = std::path::Path::new(&skill.directory).join("manifest.json");
            let manifest: Option<SkillManifest> = std::fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|c| serde_json::from_str::<SkillManifest>(&c).ok());

            // Find the tool def (new path first, legacy has no maps_to)
            let tool_def = manifest
                .as_ref()
                .and_then(|m| m.tools_def.iter().find(|t| t.name == tool_name));

            if let Some(td) = tool_def {
                if let Some(ref maps_to) = td.maps_to {
                    let all_vaults_owned: Vec<String> = all_vault_paths.to_vec();
                    let skill_dirs_owned: Vec<String> = skill_dirs.to_vec();
                    return Some(dispatch_mapped(
                        maps_to.clone(),
                        arguments.to_string(),
                        db.clone(),
                        vault_path.to_string(),
                        all_vaults_owned,
                        config.clone(),
                        skill_dirs_owned,
                    ).await);
                }
            }

            // Prompt-guided fallback — instruct the LLM instead of erroring out.
            // SKILL.md is no longer pre-loaded into the prompt (progressive
            // disclosure), so point the model at `read_skill` rather than at
            // instructions it may never have seen.
            let skill_md_path = std::path::Path::new(&skill.directory).join("SKILL.md");
            let skill_md_hint = if skill_md_path.exists() {
                format!(
                    "Call `read_skill` with name \"{}\" to load its instructions, then fulfil this using your built-in tools.",
                    skill.name
                )
            } else {
                "No SKILL.md found — answer directly using your best judgement and built-in tools.".to_string()
            };
            return Some(Ok(format!(
                "This is a skill-guided tool call for `{}::{}`. {}\nArguments: {}",
                skill.name, tool_name, skill_md_hint, arguments
            )));
        }
    }

    None // not a skill tool
}

/// Dispatch a `maps_to` reference to either an MCP or internal tool.
///
/// Takes owned `String`s so the returned boxed future is `'static`
/// (required because `execute_tool` may recurse back here via skill tools).
fn dispatch_mapped(
    maps_to: String,
    arguments: String,
    db: std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    vault_path: String,
    all_vault_paths: Vec<String>,
    config: crate::llm::LlmConfig,
    skill_dirs: Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>> {
    Box::pin(async move {
        if let Some(mcp_target) = maps_to.strip_prefix("mcp:") {
            // mcp:{server}_{tool} → mcp_{server}_{tool}
            let full = format!("mcp_{}", mcp_target);
            // Reuse the existing internal MCP dispatcher
            crate::tools::execute_tool(&full, &arguments, &db, &vault_path, &all_vault_paths, &config, &skill_dirs).await
        } else if let Some(internal_target) = maps_to.strip_prefix("internal:") {
            crate::tools::execute_tool(internal_target, &arguments, &db, &vault_path, &all_vault_paths, &config, &skill_dirs).await
        } else {
            anyhow::bail!(
                "Invalid maps_to value '{}'. Expected 'mcp:{{server}}_{{tool}}' or 'internal:{{tool}}'.",
                maps_to
            )
        }
    })
}

/// Collect MCP server configs defined in skill manifests.
/// These should be auto-started (enabled) when the skill is loaded.
pub fn collect_skill_mcp_configs(directories: &[String]) -> Vec<crate::tools::mcp_client::McpServerConfig> {
    let skills = scan_all_skill_directories(directories);
    let mut configs = Vec::new();

    for skill in &skills {
        if !skill.enabled {
            continue;
        }
        let detail = match get_skill_detail(&skill.directory) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for server_val in &detail.mcp_servers {
            // Parse mcp_server entry — same format as McpServerConfig
            if let Ok(config) = serde_json::from_value::<crate::tools::mcp_client::McpServerConfig>(server_val.clone()) {
                configs.push(config);
            }
        }
    }

    configs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique scratch directory — tests run in parallel in the same process.
    /// Matches the pattern used in `note_ops.rs:1753`; `tempfile` is not a
    /// dependency of this crate.
    fn temp_root(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir()
            .join(format!("zettel_skills_{}_{}_{}", tag, std::process::id(), nanos));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Create `<root>/<name>/` and write the given files into it.
    fn make_skill(root: &std::path::Path, name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        for (file, content) in files {
            std::fs::write(dir.join(file), content).unwrap();
        }
        dir
    }

    #[test]
    fn frontmatter_only_skill_is_discovered() {
        let root = temp_root("fm_only");
        make_skill(
            &root,
            "pdf-dir",
            &[(
                "SKILL.md",
                "---\nname: pdf-tools\ndescription: Extract and split PDFs\nversion: 2.1.0\ntools: [split, merge]\n---\n\n# Body\nDetailed steps.\n",
            )],
        );

        let skills = scan_skill_directory(root.to_str().unwrap()).unwrap();
        assert_eq!(skills.len(), 1, "SKILL.md with frontmatter must be a skill");
        let s = &skills[0];
        assert_eq!(s.name, "pdf-tools");
        assert_eq!(s.description, "Extract and split PDFs");
        assert_eq!(s.version, "2.1.0");
        assert_eq!(s.tools, vec!["split".to_string(), "merge".to_string()]);
        assert!(s.has_skill_md);
    }

    /// Backward compatibility is a hard requirement: skills that predate
    /// frontmatter carry everything in manifest.json and must keep loading.
    #[test]
    fn manifest_only_skill_still_loads() {
        let root = temp_root("manifest_only");
        make_skill(
            &root,
            "legacy-dir",
            &[(
                "manifest.json",
                r#"{"name":"legacy","description":"Old style skill","version":"0.9.0","tools":["do_thing"]}"#,
            )],
        );

        let skills = scan_skill_directory(root.to_str().unwrap()).unwrap();
        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "legacy");
        assert_eq!(s.description, "Old style skill");
        assert_eq!(s.version, "0.9.0");
        assert_eq!(s.tools, vec!["do_thing".to_string()]);
        assert!(!s.has_skill_md, "legacy skill has no SKILL.md body");
    }

    #[test]
    fn frontmatter_wins_over_manifest_but_manifest_fills_gaps() {
        let root = temp_root("both");
        make_skill(
            &root,
            "mixed-dir",
            &[
                // Frontmatter declares name + description but no version.
                (
                    "SKILL.md",
                    "---\nname: from-frontmatter\ndescription: fm description\n---\nBody text.\n",
                ),
                (
                    "manifest.json",
                    r#"{"name":"from-manifest","description":"manifest description","version":"3.0.0","tools":["t1"]}"#,
                ),
            ],
        );

        let skills = scan_skill_directory(root.to_str().unwrap()).unwrap();
        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "from-frontmatter", "frontmatter must take priority");
        assert_eq!(s.description, "fm description");
        // Version absent from frontmatter → manifest supplies it.
        assert_eq!(s.version, "3.0.0");
        // Frontmatter declared no tools → manifest's legacy list is kept.
        assert_eq!(s.tools, vec!["t1".to_string()]);
    }

    #[test]
    fn missing_name_falls_back_to_directory_name() {
        let root = temp_root("no_name");
        make_skill(
            &root,
            "my-skill-dir",
            &[("SKILL.md", "---\ndescription: only a description here\n---\nBody.\n")],
        );

        let skills = scan_skill_directory(root.to_str().unwrap()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-skill-dir");
        assert_eq!(skills[0].description, "only a description here");
    }

    /// A skill with no description still loads (only a log warning) — its tools
    /// must stay reachable.
    #[test]
    fn missing_description_still_loads() {
        let root = temp_root("no_desc");
        make_skill(&root, "quiet", &[("SKILL.md", "---\nname: quiet\n---\nBody.\n")]);

        let skills = scan_skill_directory(root.to_str().unwrap()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "quiet");
        assert!(skills[0].description.is_empty());
    }

    #[test]
    fn directory_without_skill_md_or_manifest_is_ignored() {
        let root = temp_root("not_a_skill");
        make_skill(&root, "random", &[("README.md", "just notes")]);
        assert!(scan_skill_directory(root.to_str().unwrap()).unwrap().is_empty());
    }

    /// The regression this project has been bitten by six times: slicing a CJK
    /// string on a byte boundary panics. Truncation must be char-based.
    #[test]
    fn cjk_description_and_oversized_cjk_body_do_not_panic() {
        let root = temp_root("cjk");
        // Deliberately longer than SKILL_BODY_MAX_CHARS so truncation runs, and
        // built from multi-byte chars so a byte slice would land mid-codepoint.
        let long_body = "知识管理的渐进式披露测试内容。".repeat(2000);
        make_skill(
            &root,
            "中文技能",
            &[(
                "SKILL.md",
                &format!(
                    "---\nname: 中文技能\ndescription: 处理中文笔记的技能，支持摘要与标签\n---\n{}",
                    long_body
                ),
            )],
        );
        let dirs = vec![root.to_str().unwrap().to_string()];

        let skills = scan_skill_directory(root.to_str().unwrap()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "中文技能");
        assert!(skills[0].description.contains("处理中文笔记"));

        let body = read_skill_body(&dirs, "中文技能").expect("body must load");
        assert!(body.contains("[Truncated"), "oversized body must be truncated");
        assert!(
            body.chars().count() < long_body.chars().count(),
            "truncation must actually shrink the payload"
        );

        // The compact index must also survive CJK without panicking.
        let index = collect_skill_prompts(&dirs);
        assert!(index.contains("中文技能"));
    }

    #[test]
    fn read_skill_errors_on_unknown_name_instead_of_panicking() {
        let root = temp_root("unknown");
        make_skill(
            &root,
            "present",
            &[("SKILL.md", "---\nname: present\ndescription: here\n---\nBody.\n")],
        );
        let dirs = vec![root.to_str().unwrap().to_string()];

        let err = read_skill_body(&dirs, "does-not-exist").unwrap_err().to_string();
        assert!(err.contains("does-not-exist"), "error must name the miss: {err}");
        assert!(err.contains("present"), "error must list what is available: {err}");

        // Same via the tool entry point, plus the missing-argument path.
        assert!(execute_read_skill(r#"{"name":"does-not-exist"}"#, &dirs).is_err());
        assert!(execute_read_skill("{}", &dirs).is_err());
        assert!(execute_read_skill("not json at all", &dirs).is_err());
    }

    #[test]
    fn read_skill_errors_when_the_skill_has_no_body() {
        let root = temp_root("no_body");
        make_skill(
            &root,
            "toolsonly",
            &[("manifest.json", r#"{"name":"toolsonly","description":"tools only"}"#)],
        );
        let dirs = vec![root.to_str().unwrap().to_string()];

        let err = read_skill_body(&dirs, "toolsonly").unwrap_err().to_string();
        assert!(err.contains("no SKILL.md"), "unexpected error: {err}");
    }

    #[test]
    fn read_skill_returns_the_full_body_for_a_small_skill() {
        let root = temp_root("small_body");
        make_skill(
            &root,
            "tiny",
            &[("SKILL.md", "---\nname: tiny\ndescription: d\n---\nSTEP-ONE do this.\n")],
        );
        let dirs = vec![root.to_str().unwrap().to_string()];

        let body = read_skill_body(&dirs, "tiny").unwrap();
        assert!(body.contains("STEP-ONE do this."));
        assert!(!body.contains("[Truncated"));
    }

    /// Locks progressive disclosure in place: the prompt fragment must carry
    /// name + description only. If someone reverts to pasting SKILL.md bodies
    /// into the system prompt, this fails.
    #[test]
    fn injected_prompt_fragment_never_contains_the_skill_body() {
        let root = temp_root("no_body_in_prompt");
        make_skill(
            &root,
            "alpha",
            &[(
                "SKILL.md",
                "---\nname: alpha\ndescription: Alpha does alpha things\n---\n\n# Instructions\nUNIQUE_BODY_MARKER_ZQX — step by step guidance.\n",
            )],
        );
        make_skill(
            &root,
            "beta",
            &[("manifest.json", r#"{"name":"beta","description":"Beta legacy skill"}"#)],
        );
        let dirs = vec![root.to_str().unwrap().to_string()];

        let fragment = collect_skill_prompts(&dirs);

        assert!(fragment.contains("alpha"), "index must list the skill name");
        assert!(fragment.contains("Alpha does alpha things"), "index must carry the description");
        assert!(fragment.contains("beta"), "legacy skills belong in the index too");
        assert!(
            !fragment.contains("UNIQUE_BODY_MARKER_ZQX"),
            "SKILL.md body leaked into the system prompt — progressive disclosure regressed:\n{fragment}"
        );
        assert!(!fragment.contains("# Instructions"));
        // One compact line per skill, nothing more.
        assert_eq!(fragment.lines().filter(|l| !l.trim().is_empty()).count(), 2);
    }

    #[test]
    fn frontmatter_parser_rejects_malformed_blocks() {
        // No opening delimiter.
        assert!(parse_skill_frontmatter("name: x\ndescription: y\n").is_none());
        // Opening delimiter but never closed — must not swallow the whole file.
        assert!(parse_skill_frontmatter("---\nname: x\nbody goes on forever\n").is_none());
        // Unknown keys are tolerated.
        let fm = parse_skill_frontmatter("---\nname: x\nauthor: someone\n---\n").unwrap();
        assert_eq!(fm.name.as_deref(), Some("x"));
        assert!(fm.description.is_none());
    }

    #[test]
    fn frontmatter_description_may_contain_colons() {
        let fm = parse_skill_frontmatter(
            "---\nname: x\ndescription: Use when: the user asks for a diagram\n---\n",
        )
        .unwrap();
        assert_eq!(
            fm.description.as_deref(),
            Some("Use when: the user asks for a diagram")
        );
    }

    #[test]
    fn read_skill_tool_def_is_shaped_for_the_llm() {
        let def = read_skill_tool_def();
        assert_eq!(def.function.name, "read_skill");
        assert_eq!(def.function.parameters["required"][0], "name");
        // Must be classified read-only, or the approval gate would prompt the
        // user every time the model looks up a skill.
        assert!(crate::llm::approval::is_read_only_tool("read_skill"));
    }
}
