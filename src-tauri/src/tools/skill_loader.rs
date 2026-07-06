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

/// Detail view of a skill (manifest + SKILL.md content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetail {
    pub info: SkillInfo,
    pub skill_md_content: Option<String>,
    pub mcp_servers: Vec<serde_json::Value>,
}

/// Scan a directory for skills. Each subdirectory that contains a manifest.json is a skill.
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

        // Check for manifest.json
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            // Also try SKILL.md without manifest (simpler skill format)
            let skill_md_path = path.join("SKILL.md");
            if skill_md_path.exists() {
                // Infer skill info from directory name
                let name = path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                skills.push(SkillInfo {
                    name: name.clone(),
                    description: format!("Skill from {}", name),
                    version: "0.1.0".to_string(),
                    tools: Vec::new(),
                    directory: path.to_string_lossy().to_string(),
                    enabled: true,
                    has_skill_md: true,
                });
            }
            continue;
        }

        match parse_manifest(&manifest_path) {
            Ok(manifest) => {
                let skill_md_path = path.join("SKILL.md");
                skills.push(SkillInfo {
                    name: manifest.name,
                    description: manifest.description,
                    version: manifest.version,
                    tools: manifest.tools,
                    directory: path.to_string_lossy().to_string(),
                    enabled: true,
                    has_skill_md: skill_md_path.exists(),
                });
            }
            Err(e) => {
                log::warn!("Failed to parse manifest at {:?}: {}", manifest_path, e);
            }
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

    let manifest_path = dir.join("manifest.json");
    let skill_md_path = dir.join("SKILL.md");

    let (name, description, version, tools, mcp_servers) = if manifest_path.exists() {
        let content = std::fs::read_to_string(&manifest_path)?;
        let manifest: SkillManifest = serde_json::from_str(&content)?;
        (manifest.name, manifest.description, manifest.version, manifest.tools, manifest.mcp_servers)
    } else {
        let name = dir.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        (name.clone(), format!("Skill from {}", name), "0.1.0".to_string(), Vec::new(), Vec::new())
    };

    let skill_md_content = if skill_md_path.exists() {
        Some(std::fs::read_to_string(&skill_md_path)?)
    } else {
        None
    };

    Ok(SkillDetail {
        info: SkillInfo {
            name,
            description,
            version,
            tools,
            directory: skill_dir.to_string(),
            enabled: true,
            has_skill_md: skill_md_content.is_some(),
        },
        skill_md_content,
        mcp_servers,
    })
}

/// Scan all configured skill directories and return combined results.
pub fn scan_all_skill_directories(directories: &[String]) -> Vec<SkillInfo> {
    let mut all_skills = Vec::new();
    for dir in directories {
        match scan_skill_directory(dir) {
            Ok(skills) => all_skills.extend(skills),
            Err(e) => log::warn!("Failed to scan skill directory '{}': {}", dir, e),
        }
    }
    all_skills
}

/// Collect all SKILL.md contents from configured directories for prompt injection.
/// Returns a combined string with each skill's instructions separated by headers.
pub fn collect_skill_prompts(directories: &[String]) -> String {
    let mut combined = String::new();
    let skills = scan_all_skill_directories(directories);

    for skill in &skills {
        if !skill.enabled || !skill.has_skill_md {
            continue;
        }
        let skill_md_path = std::path::Path::new(&skill.directory).join("SKILL.md");
        match std::fs::read_to_string(&skill_md_path) {
            Ok(content) => {
                // Truncate very long skill files to avoid blowing up context window
                let truncated = if content.len() > 4000 {
                    format!("{}...\n[Truncated — full content: {} chars]", &content[..4000], content.len())
                } else {
                    content
                };
                combined.push_str(&format!("### Skill: {} (v{})\n{}\n\n", skill.name, skill.version, truncated));
            }
            Err(e) => {
                log::warn!("Failed to read SKILL.md for '{}': {}", skill.name, e);
            }
        }
    }

    combined
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
            let skill_md_path = std::path::Path::new(&skill.directory).join("SKILL.md");
            let skill_md_hint = if skill_md_path.exists() {
                "Refer to the loaded SKILL.md instructions for how to fulfil it using your built-in tools."
            } else {
                "No SKILL.md found — answer directly using your best judgement and built-in tools."
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
