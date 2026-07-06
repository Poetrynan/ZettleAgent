pub mod internal_tools;
pub mod mcp_client;
pub mod skill_loader;

use crate::llm::ToolDef;

/// Get all available tool definitions (internal + external MCP + skill tools)
pub fn get_all_tool_defs(mcp_tools: &[ToolDef], skill_dirs: &[String]) -> Vec<ToolDef> {
    let mut tools = internal_tools::get_internal_tool_defs();
    tools.extend(mcp_tools.iter().cloned());
    tools.extend(skill_loader::collect_skill_tool_defs(skill_dirs));
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
