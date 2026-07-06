use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::llm::ToolDef;

/// Configuration for an MCP server, stored in app_settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    pub enabled: bool,
}

impl McpServerConfig {
    /// Returns true if the command field looks like a URL (Remote MCP / SSE).
    pub fn is_remote(&self) -> bool {
        self.command.starts_with("http://") || self.command.starts_with("https://")
    }
}

// ── Transport abstraction ────────────────────────────────────────

enum McpTransport {
    /// Local stdio-based transport (spawned process)
    Stdio {
        process: Child,
    },
    /// Remote SSE-based transport (HTTP)
    Sse {
        /// The base SSE endpoint URL
        #[allow(dead_code)]
        base_url: String,
        /// The session-specific messages endpoint (from SSE event)
        messages_url: Option<String>,
        /// HTTP client
        client: reqwest::blocking::Client,
    },
}

/// A running MCP server connection.
pub struct McpServer {
    transport: McpTransport,
    pub server_name: String,
    pub tools: Vec<ToolDef>,
    request_id: u64,
}

/// JSON-RPC 2.0 request
#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 response
#[derive(Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

impl McpServer {
    /// Connect to an MCP server — auto-detects stdio vs SSE based on command.
    pub fn connect(command: &str, args: &[String], server_name: &str, env: &std::collections::HashMap<String, String>) -> anyhow::Result<Self> {
        if command.starts_with("http://") || command.starts_with("https://") {
            Self::connect_sse(command, server_name, env)
        } else {
            Self::connect_stdio(command, args, server_name, env)
        }
    }

    // ── SSE Transport ────────────────────────────────────────────

    fn connect_sse(url: &str, server_name: &str, env: &std::collections::HashMap<String, String>) -> anyhow::Result<Self> {
        log::info!("MCP: Connecting to remote server '{}' via SSE: {}", server_name, url);

        let mut headers = reqwest::header::HeaderMap::new();
        // Pass API key as Bearer token if provided
        if let Some(api_key) = env.get("API_KEY") {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", api_key))?,
            );
        }

        let client = reqwest::blocking::Client::builder()
            .default_headers(headers.clone())
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        // Step 1: Connect to SSE endpoint to get session/messages URL
        // The SSE endpoint typically sends an "endpoint" event with the messages URL
        let messages_url = Self::discover_sse_endpoint(url, &headers)?;
        log::info!("MCP: SSE messages endpoint for '{}': {}", server_name, messages_url);

        let mut server = Self {
            transport: McpTransport::Sse {
                base_url: url.to_string(),
                messages_url: Some(messages_url),
                client,
            },
            server_name: server_name.to_string(),
            tools: Vec::new(),
            request_id: 0,
        };

        // Step 2: Initialize
        let init_params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "ZettelAgent",
                "version": "0.1.0"
            }
        });
        let _init_response = server.send_request("initialize", Some(init_params))?;
        log::info!("MCP: Remote server '{}' initialized", server_name);

        // Step 3: Send initialized notification
        server.send_notification("notifications/initialized", None)?;

        // Step 4: List tools
        let tools_response = server.send_request("tools/list", None)?;
        Self::parse_tools(&mut server.tools, &tools_response, server_name);

        log::info!("MCP: Remote server '{}' provides {} tools", server_name, server.tools.len());
        Ok(server)
    }

    /// Discover the messages endpoint from the SSE connection.
    /// Remote MCP servers send an SSE event like: `event: endpoint\ndata: /messages?session_id=xxx`
    fn discover_sse_endpoint(sse_url: &str, headers: &reqwest::header::HeaderMap) -> anyhow::Result<String> {
        let client = reqwest::blocking::Client::builder()
            .default_headers(headers.clone())
            .timeout(std::time::Duration::from_secs(15))
            .build()?;

        let response = client.get(sse_url)
            .header("Accept", "text/event-stream")
            .send()?;

        if !response.status().is_success() {
            anyhow::bail!("SSE connection failed: HTTP {}", response.status());
        }

        let reader = BufReader::new(response);
        let mut current_event = String::new();

        for line in reader.lines() {
            let line = line?;
            if line.starts_with("event:") {
                current_event = line.trim_start_matches("event:").trim().to_string();
            } else if line.starts_with("data:") && current_event == "endpoint" {
                let data = line.trim_start_matches("data:").trim().to_string();
                // The data may be a relative path or absolute URL
                if data.starts_with("http://") || data.starts_with("https://") {
                    return Ok(data);
                } else {
                    // Relative path — resolve against base URL
                    let base = url::Url::parse(sse_url)
                        .map_err(|e| anyhow::anyhow!("Invalid SSE URL: {}", e))?;
                    let resolved = base.join(&data)
                        .map_err(|e| anyhow::anyhow!("Failed to resolve endpoint: {}", e))?;
                    return Ok(resolved.to_string());
                }
            } else if line.is_empty() {
                // SSE event boundary — reset
                current_event.clear();
            }
        }

        anyhow::bail!("SSE endpoint discovery timed out: no 'endpoint' event received from {}", sse_url)
    }

    // ── Stdio Transport ──────────────────────────────────────────

    fn connect_stdio(command: &str, args: &[String], server_name: &str, env: &std::collections::HashMap<String, String>) -> anyhow::Result<Self> {
        log::info!("MCP: Connecting to server '{}' via stdio: {} {:?}", server_name, command, args);

        // Primary MCP path is Remote SSE (URL + API Key). Stdio is optional (system PATH).
        #[cfg(windows)]
        let resolved_command = if !command.contains('.') && !command.contains('\\') && !command.contains('/') {
            let cmd_name = format!("{}.cmd", command);
            let found_cmd = std::env::var("PATH").ok().map(|path| {
                path.split(';').any(|dir| std::path::Path::new(dir).join(&cmd_name).exists())
            }).unwrap_or(false);
            if found_cmd { cmd_name } else { command.to_string() }
        } else {
            command.to_string()
        };
        #[cfg(not(windows))]
        let resolved_command = command.to_string();

        let mut cmd = Command::new(&resolved_command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for (key, value) in env {
            cmd.env(key, value);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let child = cmd.spawn()
            .map_err(|e| anyhow::anyhow!("Failed to start MCP server '{}': {}. Command: {} {:?}", server_name, e, command, args))?;

        let mut server = Self {
            transport: McpTransport::Stdio { process: child },
            server_name: server_name.to_string(),
            tools: Vec::new(),
            request_id: 0,
        };

        // Initialize
        let init_params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "ZettelAgent",
                "version": "0.1.0"
            }
        });
        let _init_response = server.send_request("initialize", Some(init_params))?;
        log::info!("MCP: Server '{}' initialized", server_name);

        server.send_notification("notifications/initialized", None)?;

        let tools_response = server.send_request("tools/list", None)?;
        Self::parse_tools(&mut server.tools, &tools_response, server_name);

        log::info!("MCP: Server '{}' provides {} tools", server_name, server.tools.len());
        Ok(server)
    }

    // ── Shared helpers ───────────────────────────────────────────

    fn parse_tools(tools: &mut Vec<ToolDef>, tools_response: &serde_json::Value, server_name: &str) {
        if let Some(tools_val) = tools_response.get("tools") {
            if let Some(tools_arr) = tools_val.as_array() {
                for tool in tools_arr {
                    let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let description = tool.get("description").and_then(|v| v.as_str()).unwrap_or("");
                    let input_schema = tool.get("inputSchema").cloned().unwrap_or(serde_json::json!({"type": "object", "properties": {}}));

                    tools.push(ToolDef {
                        tool_type: "function".to_string(),
                        function: crate::llm::ToolFunction {
                            name: format!("mcp_{}_{}", server_name, name),
                            description: format!("[MCP:{}] {}", server_name, description),
                            parameters: input_schema,
                        },
                    });
                }
            }
        }
    }

    /// Send a JSON-RPC request and wait for response.
    fn send_request(&mut self, method: &str, params: Option<serde_json::Value>) -> anyhow::Result<serde_json::Value> {
        self.request_id += 1;
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: self.request_id,
            method: method.to_string(),
            params,
        };

        match &mut self.transport {
            McpTransport::Stdio { process } => {
                Self::send_request_stdio(process, &request)
            }
            McpTransport::Sse { messages_url, client, .. } => {
                let url = messages_url.as_ref()
                    .ok_or_else(|| anyhow::anyhow!("SSE messages endpoint not discovered"))?;
                Self::send_request_sse(client, url, &request)
            }
        }
    }

    fn send_request_stdio(process: &mut Child, request: &JsonRpcRequest) -> anyhow::Result<serde_json::Value> {
        let request_str = serde_json::to_string(request)?;
        log::debug!("MCP: → {}", request_str);

        if let Some(ref mut stdin) = process.stdin {
            writeln!(stdin, "{}", request_str)?;
            stdin.flush()?;
        } else {
            anyhow::bail!("MCP server stdin not available");
        }

        if let Some(ref mut stdout) = process.stdout {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();

            loop {
                line.clear();
                let bytes_read = reader.read_line(&mut line)?;
                if bytes_read == 0 {
                    anyhow::bail!("MCP server closed stdout unexpectedly");
                }

                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }

                if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
                    log::debug!("MCP: ← {}", trimmed);
                    if let Some(err) = response.error {
                        anyhow::bail!("MCP error: {}", err.message);
                    }
                    return Ok(response.result.unwrap_or(serde_json::Value::Null));
                }

                log::debug!("MCP: (skipping non-JSON line): {}", trimmed);
            }
        } else {
            anyhow::bail!("MCP server stdout not available");
        }
    }

    fn send_request_sse(client: &reqwest::blocking::Client, url: &str, request: &JsonRpcRequest) -> anyhow::Result<serde_json::Value> {
        let request_str = serde_json::to_string(request)?;
        log::debug!("MCP SSE: → {}", request_str);

        let response = client.post(url)
            .header("Content-Type", "application/json")
            .body(request_str)
            .send()?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            anyhow::bail!("MCP SSE request failed: HTTP {} — {}", status, body);
        }

        let body = response.text()?;
        log::debug!("MCP SSE: ← {}", body);

        // SSE responses may come as text/event-stream or plain JSON
        // Try parsing as JSON-RPC first
        if let Ok(rpc_response) = serde_json::from_str::<JsonRpcResponse>(&body) {
            if let Some(err) = rpc_response.error {
                anyhow::bail!("MCP error: {}", err.message);
            }
            return Ok(rpc_response.result.unwrap_or(serde_json::Value::Null));
        }

        // Might be SSE format — parse events
        for line in body.lines() {
            if line.starts_with("data:") {
                let data = line.trim_start_matches("data:").trim();
                if let Ok(rpc_response) = serde_json::from_str::<JsonRpcResponse>(data) {
                    if let Some(err) = rpc_response.error {
                        anyhow::bail!("MCP error: {}", err.message);
                    }
                    return Ok(rpc_response.result.unwrap_or(serde_json::Value::Null));
                }
            }
        }

        anyhow::bail!("MCP SSE: Failed to parse response from {}", url)
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    fn send_notification(&mut self, method: &str, params: Option<serde_json::Value>) -> anyhow::Result<()> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or(serde_json::json!({})),
        });

        let notification_str = serde_json::to_string(&notification)?;
        log::debug!("MCP: → (notification) {}", notification_str);

        match &mut self.transport {
            McpTransport::Stdio { process } => {
                if let Some(ref mut stdin) = process.stdin {
                    writeln!(stdin, "{}", notification_str)?;
                    stdin.flush()?;
                }
            }
            McpTransport::Sse { messages_url, client, .. } => {
                if let Some(url) = messages_url.as_ref() {
                    let _ = client.post(url)
                        .header("Content-Type", "application/json")
                        .body(notification_str)
                        .send();
                }
            }
        }

        Ok(())
    }

    /// Call a tool on this MCP server.
    pub fn call_tool(&mut self, tool_name: &str, arguments: &str) -> anyhow::Result<String> {
        let args: serde_json::Value = serde_json::from_str(arguments)
            .unwrap_or(serde_json::json!({}));

        let params = serde_json::json!({
            "name": tool_name,
            "arguments": args,
        });

        let result = self.send_request("tools/call", Some(params))?;

        // Extract text content from result
        if let Some(content) = result.get("content") {
            if let Some(arr) = content.as_array() {
                let texts: Vec<String> = arr.iter()
                    .filter_map(|c| {
                        if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                            c.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                        } else {
                            None
                        }
                    })
                    .collect();
                if !texts.is_empty() {
                    return Ok(texts.join("\n"));
                }
            }
        }

        // Fallback: return raw JSON
        Ok(serde_json::to_string_pretty(&result)?)
    }

    /// Disconnect and kill the MCP server process.
    pub fn disconnect(&mut self) {
        match &mut self.transport {
            McpTransport::Stdio { process } => {
                log::info!("MCP: Disconnecting stdio server '{}'", self.server_name);
                let _ = process.kill();
                let _ = process.wait();
            }
            McpTransport::Sse { .. } => {
                log::info!("MCP: Disconnecting SSE server '{}'", self.server_name);
                // No persistent process to kill for SSE
            }
        }
    }

    /// Check if the process is still alive (stdio only; SSE always returns true).
    pub fn is_alive(&mut self) -> bool {
        match &mut self.transport {
            McpTransport::Stdio { process } => {
                match process.try_wait() {
                    Ok(None) => true,
                    Ok(Some(_)) => false,
                    Err(_) => false,
                }
            }
            McpTransport::Sse { .. } => true,
        }
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.disconnect();
    }
}

/// Try to connect to an MCP server and return its tool count (for testing).
pub fn test_mcp_connection(config: &McpServerConfig) -> anyhow::Result<Vec<String>> {
    let mut server = McpServer::connect(&config.command, &config.args, &config.name, &config.env)?;
    let tool_names: Vec<String> = server.tools.iter()
        .map(|t| t.function.name.clone())
        .collect();
    server.disconnect();
    Ok(tool_names)
}

// ── Persistent Connection Pool ──────────────────────────────────

static MCP_POOL: OnceLock<Mutex<HashMap<String, McpServer>>> = OnceLock::new();

fn get_pool() -> &'static Mutex<HashMap<String, McpServer>> {
    MCP_POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Call a tool on an MCP server, using a persistent pooled connection.
/// Creates a new connection if one doesn't exist or if the existing connection is dead.
pub fn call_tool_pooled(config: &McpServerConfig, tool_name: &str, arguments: &str) -> anyhow::Result<String> {
    let pool = get_pool();
    let mut servers = pool.lock().map_err(|e| anyhow::anyhow!("Pool lock: {}", e))?;

    let key = format!("{}:{}", config.name, config.command);

    // Check if existing connection is alive
    if let Some(server) = servers.get_mut(&key) {
        if server.is_alive() {
            return server.call_tool(tool_name, arguments);
        }
        // Dead process — remove and reconnect
        servers.remove(&key);
    }

    // Create new connection
    let mut server = McpServer::connect(&config.command, &config.args, &config.name, &config.env)?;
    let result = server.call_tool(tool_name, arguments);
    servers.insert(key, server);
    result
}

/// Remove a specific server from the pool (for disconnect)
pub fn disconnect_pooled(config: &McpServerConfig) {
    let pool = get_pool();
    if let Ok(mut servers) = pool.lock() {
        let key = format!("{}:{}", config.name, config.command);
        if let Some(mut server) = servers.remove(&key) {
            server.disconnect();
        }
    }
}

/// Kill all pooled connections
pub fn shutdown_mcp_pool() {
    let pool = get_pool();
    if let Ok(mut servers) = pool.lock() {
        for (_, mut server) in servers.drain() {
            server.disconnect();
        }
    }
}

/// Connect to all enabled MCP servers and collect their tool definitions.
/// Returns (tool_defs, errors). Errors are non-fatal -- servers that fail to connect are skipped.
pub fn collect_mcp_tools(configs: &[McpServerConfig]) -> (Vec<crate::llm::ToolDef>, Vec<String>) {
    let mut all_tools = Vec::new();
    let mut errors = Vec::new();

    for config in configs {
        if !config.enabled {
            continue;
        }
        match McpServer::connect(&config.command, &config.args, &config.name, &config.env) {
            Ok(mut server) => {
                log::info!("MCP: Collected {} tools from '{}'", server.tools.len(), config.name);
                all_tools.extend(server.tools.drain(..));
                server.disconnect();
            }
            Err(e) => {
                let msg = format!("MCP server '{}' failed to connect: {}", config.name, e);
                log::warn!("{}", msg);
                errors.push(msg);
            }
        }
    }

    (all_tools, errors)
}
