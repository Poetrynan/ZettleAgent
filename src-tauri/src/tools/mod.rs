pub mod internal_tools;
pub mod mcp_client;
/// Server half of MCP: exposes this vault to external agents. Lives next to the
/// client on purpose — they share the protocol version and framing convention,
/// and keeping them siblings makes a drift between the two obvious.
pub mod mcp_server;
pub mod skill_loader;

use crate::llm::{ToolDef, ToolFunction};
use serde_json::json;

/// The tool surface the **default (unified) agent** shows the model.
///
/// Why this exists: `get_internal_tool_defs()` ships 62 tools. Handing all of
/// them to every request costs ~6k tokens of schema on *every* turn (see
/// `crate::llm::estimate_tool_schema_tokens`) and measurably dilutes tool
/// choice — the model has to pick `search_notes` out of a list that also
/// contains `arrange_canvas_by` and `rebuild_semantic_edges`.
///
/// Selection rule (deliberately not invented from scratch): a tool is core if
/// it appears in **all three** role lists in `agents/mod.rs`
/// (`KNOWLEDGE_TOOLS` ∩ `CREATOR_TOOLS` ∩ `CURATOR_TOOLS`) — that intersection
/// is the author's own answer to "what does every kind of work need" — plus the
/// everyday write path (`create_note` / `edit_note` / `patch_note` /
/// `append_to_note`), link following (`get_backlinks`), the web pair the UI
/// toggle re-adds anyway, and the discovery escape hatch below.
///
/// Nothing is *removed* by this list. Everything else stays reachable two ways:
///   1. `list_available_tools` lets the model discover it by name, and
///   2. `execute_tool` dispatches purely on name, so a discovered tool can be
///      called immediately without re-negotiating the schema list.
/// Approval is untouched: narrowing the schema list is a prompt-budget
/// decision, and every writer still goes through `llm::approval` when called.
pub const CORE_TOOLS: &[&str] = &[
    // Control plane — must stay: `chat_commands` re-adds it unconditionally and
    // it is the only guarantee that the `tools` array is non-empty (some
    // providers reject an empty array when the key is present).
    "todo_write",
    // Read path — the bread and butter of every request.
    "search_notes",          // internal_tools/search_ops.rs:23
    "list_notes",            // internal_tools/search_ops.rs:237
    "read_note",             // internal_tools/note_ops.rs:10
    "batch_read_notes",      // internal_tools/note_ops.rs:735 — one call instead of N
    "find_similar_notes",    // internal_tools/search_ops.rs:310
    "search_by_tag",         // internal_tools/search_ops.rs:390
    "get_note_tags",         // internal_tools/graph_ops.rs:240
    "get_backlinks",         // internal_tools/graph_ops.rs:170 — Zettelkasten link following
    "resolve_wikilink",      // internal_tools/note_ops.rs:804 — needed before writing a link
    "get_directory_tree",    // internal_tools/workspace_ops.rs:680
    "query_database",        // internal_tools/workspace_ops.rs:744 — fixed parameterized SELECTs
    // Write path — the four verbs a note-taking agent uses daily.
    "create_note",           // internal_tools/note_ops.rs (execute_create_note)
    "edit_note",             // internal_tools/note_ops.rs (execute_edit_note)
    "patch_note",            // internal_tools/note_ops.rs (execute_patch_note)
    "append_to_note",        // internal_tools/note_ops.rs (execute_append_to_note)
    "add_relation",          // internal_tools/graph_ops.rs (execute_add_relation)
    // Memory — in all three role lists; "remember this" is a common ask.
    "read_memory",           // internal_tools/workspace_ops.rs:429
    "search_memory",         // internal_tools/workspace_ops.rs:481
    "update_memory",         // internal_tools/workspace_ops.rs (execute_update_memory)
    // Web — also force-added by `chat_commands` when the UI toggle is on, so
    // leaving them out would only create an inconsistency.
    "web_search",            // internal_tools/web_ops.rs:6
    "fetch_web_content",     // internal_tools/web_ops.rs (execute_fetch_web_content)
    // Canvas & GraphRAG (Phase 3 Core Capabilities)
    "compile_canvas_to_note",
    "generate_canvas_from_notes",
    "query_graph_communities",
    "generate_community_summaries",
    // Escape hatch — how the model reaches the other ~40 tools.
    LIST_AVAILABLE_TOOLS,
];

/// Name of the discovery tool. Kept as a constant because it is referenced from
/// `CORE_TOOLS`, the def builder, and the dispatcher — a typo in any one of the
/// three would silently disable the escape hatch.
pub const LIST_AVAILABLE_TOOLS: &str = "list_available_tools";

/// Extension tools are registered at *runtime*, not compiled into any list:
/// MCP servers the user configured, skill-provided tools, and `read_skill`
/// (only offered when skill dirs exist). A hand-written allow-list can never
/// name them, so filtering against `CORE_TOOLS` would silently uninstall the
/// user's integrations. `AgentInstance::filter_tools` lets these through for
/// agents that opt in.
pub fn is_extension_tool(name: &str) -> bool {
    name.starts_with("mcp_") || name.starts_with("skill_") || name == "read_skill"
}

/// Get all available tool definitions (internal + external MCP + skill tools).
/// The unified agent narrows this down via `CORE_TOOLS`; role agents narrow it
/// via their own lists in `agents/mod.rs`.
pub fn get_all_tool_defs(mcp_tools: &[ToolDef], skill_dirs: &[String]) -> Vec<ToolDef> {
    let mut tools = internal_tools::get_internal_tool_defs();
    tools.push(list_available_tools_tool_def());
    tools.extend(mcp_tools.iter().cloned());
    tools.extend(skill_loader::collect_skill_tool_defs(skill_dirs));
    // Progressive disclosure: the system prompt only carries a name+description
    // index of installed skills, so the model needs `read_skill` to fetch a
    // body. Only offered when skill directories are configured — otherwise it
    // is a tool that can never succeed.
    if !skill_dirs.is_empty() {
        tools.push(skill_loader::read_skill_tool_def());
    }
    tools
}

/// Execute a tool call by name
pub async fn execute_tool(
    name: &str,
    arguments: &str,
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    vault_path: &str,
    all_vault_paths: &[String],
    config: &crate::llm::LlmConfig,
    skill_dirs: &[String],
) -> anyhow::Result<String> {
    // Guard: empty or whitespace-only tool names
    if name.trim().is_empty() {
        return Ok("Error: Empty tool name. No tool was called. Please respond to the user directly without calling tools.".to_string());
    }

    // `read_skill` is dispatched here, not in `internal_tools::try_execute`,
    // because it is the only tool that needs the configured `skill_dirs`.
    if name == "read_skill" {
        return skill_loader::execute_read_skill(arguments, skill_dirs);
    }

    // Discovery tool: answers "what else can you do?" from the catalogue itself,
    // so the narrowed `CORE_TOOLS` schema list is a default, not a ceiling.
    // Dispatched here (like `read_skill`) because it needs `skill_dirs`.
    if name == LIST_AVAILABLE_TOOLS {
        return execute_list_available_tools(arguments, skill_dirs);
    }

    // Try internal tools first
    if let Some(result) = internal_tools::try_execute(name, arguments, db, vault_path, all_vault_paths, config).await {
        return result;
    }

    // Try MCP tools (name format: mcp_{server}_{tool})
    if name.starts_with("mcp_") {
        return execute_mcp_tool(name, arguments, db);
    }

    // Try Skill tools (name format: skill_{skill}_{tool})
    if name.starts_with("skill_") {
        if let Some(result) = skill_loader::execute_skill_tool(
            name,
            &arguments.to_string(),
            db,
            vault_path,
            all_vault_paths,
            config,
            skill_dirs,
        ).await {
            return result;
        }
    }

    anyhow::bail!("Unknown tool: {}", name)
}

/// Execute a tool call on an MCP server.
/// Tool names are formatted as: mcp_{server_name}_{tool_name}
fn execute_mcp_tool(
    full_name: &str,
    arguments: &str,
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
) -> anyhow::Result<String> {
    // Parse: mcp_{server}_{tool} → server_name, tool_name
    let without_prefix = full_name.strip_prefix("mcp_")
        .ok_or_else(|| anyhow::anyhow!("Invalid MCP tool name: {}", full_name))?;

    // Find the server name by checking configured servers
    let configs = get_mcp_configs(db)?;

    for config in &configs {
        if !config.enabled {
            continue;
        }
        let prefix = format!("{}_", config.name);
        if let Some(tool_name) = without_prefix.strip_prefix(&prefix) {
            // Use pooled connection instead of connect→call→disconnect
            return mcp_client::call_tool_pooled(config, tool_name, arguments);
        }
    }

    anyhow::bail!("No MCP server found for tool: {}", full_name)
}

/// Helper to read MCP configs from app_settings
fn get_mcp_configs(db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>) -> anyhow::Result<Vec<mcp_client::McpServerConfig>> {
    let conn = db.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    let json_str = crate::db::schema::get_setting(&conn, "mcp_servers")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let configs: Vec<mcp_client::McpServerConfig> = serde_json::from_str(&json_str)
        .unwrap_or_default();
    Ok(configs)
}

/// Get all MCP server configs: user-configured + skill-defined
pub fn get_all_mcp_configs(db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>, skill_dirs: &[String]) -> Vec<mcp_client::McpServerConfig> {
    let mut configs = get_mcp_configs(db).unwrap_or_default();
    let skill_configs = skill_loader::collect_skill_mcp_configs(skill_dirs);
    configs.extend(skill_configs);
    configs
}

/// Shutdown all MCP pooled connections. Call on app exit.
pub fn shutdown_mcp() {
    mcp_client::shutdown_mcp_pool();
}

// ── Escape hatch: tool discovery ───────────────────────────────────────────
//
// The unified agent sees `CORE_TOOLS` only. Without a way back to the rest of
// the catalogue that would be a real capability cut, so this tool exists to
// turn the narrowing into progressive disclosure — the same pattern the skill
// system already uses (`read_skill`): a cheap index in the prompt, the full
// body fetched on demand.

/// Schema for the discovery tool. Intentionally tiny (two optional params) —
/// it has to pay for itself out of the tokens the narrowing saved.
pub fn list_available_tools_tool_def() -> ToolDef {
    ToolDef {
        tool_type: "function".to_string(),
        function: ToolFunction {
            name: LIST_AVAILABLE_TOOLS.to_string(),
            description: "List additional tools that exist but are not in your current tool list (canvas editing, note history/revert, rename/move/delete/merge, graph traversal, lint, OCR, PDF extraction, index maintenance, and more). Any tool returned here can be called directly by name with the arguments described — you do not need permission first. Use this before telling the user something is impossible.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Optional keyword to filter by tool name or description, e.g. 'canvas', 'history', 'delete'. Omit to list everything available."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of tools to return (default 40, max 100)",
                        "default": 40
                    }
                }
            }),
        },
    }
}

/// Truncate on a character boundary. Byte slicing would panic on the CJK text
/// that shows up in skill-provided tool descriptions.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let head: String = s.chars().take(max_chars).collect();
    format!("{}…", head)
}

/// Report the tools that are *not* already visible to the caller.
///
/// Echoing the core set back would burn tokens on information the model can
/// already see, so `CORE_TOOLS` entries are skipped. MCP tools are also absent:
/// enumerating them means talking to every configured server, and they are never
/// filtered out for the unified agent anyway (`is_extension_tool`).
pub fn execute_list_available_tools(arguments: &str, skill_dirs: &[String]) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or(json!({}));
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(40)
        .clamp(1, 100) as usize;

    let catalogue = get_all_tool_defs(&[], skill_dirs);
    let mut hidden_total = 0usize;
    let mut matched = Vec::new();

    for tool in &catalogue {
        let name = tool.function.name.as_str();
        if CORE_TOOLS.contains(&name) {
            continue;
        }
        hidden_total += 1;
        if !query.is_empty() {
            let haystack = format!("{} {}", name, tool.function.description).to_lowercase();
            if !haystack.contains(&query) {
                continue;
            }
        }
        if matched.len() < limit {
            matched.push(json!({
                "name": name,
                "description": truncate_chars(&tool.function.description, 200),
            }));
        }
    }

    Ok(serde_json::to_string(&json!({
        "hidden_tool_count": hidden_total,
        "returned": matched.len(),
        "tools": matched,
        "hint": "Call any of these directly by name. Write operations still require user approval, exactly as the tools in your default list do.",
    }))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::estimate_tool_schema_tokens;

    fn catalogue() -> Vec<ToolDef> {
        get_all_tool_defs(&[], &[])
    }

    fn core_defs() -> Vec<ToolDef> {
        catalogue()
            .into_iter()
            .filter(|t| CORE_TOOLS.contains(&t.function.name.as_str()))
            .collect()
    }

    #[test]
    fn core_tools_all_exist_and_are_unique() {
        let names: Vec<String> = catalogue().iter().map(|t| t.function.name.clone()).collect();
        for core in CORE_TOOLS {
            assert!(
                names.iter().any(|n| n == core),
                "CORE_TOOLS names a tool that does not exist: {core}"
            );
        }
        let mut sorted = CORE_TOOLS.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len(), "CORE_TOOLS contains a duplicate");
    }

    #[test]
    fn core_set_is_substantially_smaller_than_the_catalogue() {
        let all = catalogue().len();
        let core = CORE_TOOLS.len();
        // Guards the point of the change: if someone grows CORE_TOOLS back
        // toward the full catalogue, the prompt-budget win silently evaporates.
        assert!(
            core * 2 < all,
            "core set ({core}) should be less than half the catalogue ({all})"
        );
        assert_eq!(core_defs().len(), core, "every core name must resolve to a def");
    }

    #[test]
    fn core_set_keeps_the_non_negotiable_tools() {
        // `todo_write`: chat_commands re-adds it unconditionally and it is the
        // only guarantee the `tools` array is never empty.
        // Read + write basics: the agent is useless without them.
        for required in [
            "todo_write",
            "search_notes",
            "read_note",
            "list_notes",
            "create_note",
            "edit_note",
            "append_to_note",
            "patch_note",
            LIST_AVAILABLE_TOOLS,
        ] {
            assert!(
                CORE_TOOLS.contains(&required),
                "{required} must stay in the core set"
            );
        }
    }

    #[test]
    fn narrowing_the_surface_cuts_schema_tokens() {
        let all_tokens = estimate_tool_schema_tokens(&catalogue());
        let core_tokens = estimate_tool_schema_tokens(&core_defs());
        eprintln!(
            "tool schema tokens: all={} ({} tools) core={} ({} tools) saved={}",
            all_tokens,
            catalogue().len(),
            core_tokens,
            core_defs().len(),
            all_tokens - core_tokens
        );
        assert!(core_tokens < all_tokens, "narrowing must reduce the estimate");
        assert!(
            core_tokens * 2 < all_tokens,
            "expected to save more than half the schema budget: core={core_tokens} all={all_tokens}"
        );
    }

    #[test]
    fn discovery_tool_reports_the_hidden_tools_only() {
        let out = execute_list_available_tools("{}", &[]).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        let listed: Vec<&str> = parsed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();

        // Tools deliberately left out of the core set must be discoverable.
        for hidden in ["modify_canvas", "revert_note", "merge_notes", "run_lint"] {
            assert!(listed.contains(&hidden), "{hidden} should be discoverable");
        }
        // Core tools are already in the model's schema list; repeating them here
        // would just spend tokens on what it can already see.
        for visible in ["search_notes", "create_note", LIST_AVAILABLE_TOOLS] {
            assert!(!listed.contains(&visible), "{visible} is already visible");
        }
        assert!(parsed["hidden_tool_count"].as_u64().unwrap() > 20);
    }

    #[test]
    fn discovery_tool_filters_by_query() {
        let out = execute_list_available_tools(r#"{"query":"canvas"}"#, &[]).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        let listed: Vec<String> = parsed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(listed.iter().any(|n| n == "modify_canvas"));
        assert!(!listed.iter().any(|n| n == "revert_note"));

        // Malformed args must degrade to "list everything", not fail: a tool that
        // errors on a missing optional arg is a dead end for the model.
        let fallback = execute_list_available_tools("not json", &[]).unwrap();
        assert!(fallback.contains("modify_canvas"));
    }

    #[test]
    fn truncate_chars_never_splits_a_codepoint() {
        // Byte slicing here would panic; CJK descriptions come from skill YAML.
        assert_eq!(truncate_chars("知识库笔记", 3), "知识库…");
        assert_eq!(truncate_chars("abc", 10), "abc");
    }

    #[test]
    fn non_core_tools_are_still_dispatchable() {
        // The other half of the escape hatch: discovery is pointless if the
        // dispatcher refuses names outside the schema list. Dispatch is a plain
        // name match with no reference to `CORE_TOOLS`, so a tool the model
        // discovers is callable on the next turn.
        //
        // This drives `internal_tools::try_execute` rather than the outer
        // `execute_tool` on purpose: referencing `execute_tool` from a unit test
        // pulls the MCP branch into the test binary's link graph, which drags in
        // an import of `comctl32!TaskDialogIndirect` (Common-Controls v6 only).
        // The test harness exe carries no SxS manifest, so Windows then fails to
        // load it at all — the whole suite dies with STATUS_ENTRYPOINT_NOT_FOUND
        // before a single test runs. `execute_tool` adds no name filtering on top
        // of `try_execute`, so nothing about the property under test is lost.
        crate::db::register_sqlite_vec();
        let db = std::sync::Arc::new(std::sync::Mutex::new(
            rusqlite::Connection::open_in_memory().unwrap(),
        ));
        {
            let conn = db.lock().unwrap();
            crate::db::schema::setup_database_schema(&conn).unwrap();
        }

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let config = crate::llm::LlmConfig::default();
            assert!(!CORE_TOOLS.contains(&"get_vault_stats"));
            let routed =
                internal_tools::try_execute("get_vault_stats", "{}", &db, ".", &[], &config).await;
            let out = routed
                .expect("dispatch must recognise a non-core tool name")
                .expect("a non-core tool must still execute");
            assert!(out.contains("total_notes") || out.contains('{'), "got: {out}");

            // And an unknown name is still an error — narrowing did not turn the
            // dispatcher into a wildcard.
            assert!(
                internal_tools::try_execute("no_such_tool", "{}", &db, ".", &[], &config)
                    .await
                    .is_none()
            );
        });
    }
}
