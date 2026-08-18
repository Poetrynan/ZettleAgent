//! MCP **server** — exposes the user's vault to external MCP clients
//! (Claude Desktop, Cursor, …) so they can search and read the knowledge base.
//!
//! This is the mirror of [`crate::tools::mcp_client`]: that module lets *us* talk
//! to other people's MCP servers; this one lets other people's agents talk to
//! *us*. Both speak hand-rolled JSON-RPC 2.0 over serde_json — there is no MCP
//! SDK crate in the tree, and adding one just for the server half would mean two
//! protocol implementations. The framing here intentionally matches the client's
//! (`"2024-11-05"` protocol version, `{jsonrpc,id,method,params}` requests,
//! `{jsonrpc,id,result|error}` responses); the request/response structs in
//! `mcp_client` are the *client-side* mirror (Serialize request / Deserialize
//! response), so the server needs the opposite derives and defines its own thin
//! envelope rather than contorting those.
//!
//! ## What is exposed
//! - **Tools**: a read-only subset of the internal tool catalogue, dispatched
//!   straight through [`crate::tools::internal_tools::try_execute`]. No retrieval
//!   logic is reimplemented — `search_notes` here is the exact same hybrid
//!   FTS+vector+RRF path the in-app agent uses.
//! - **Resources**: every note as a `zettel://` URI (see [`uri`]).
//! - **Prompts**: a couple of Zettelkasten method templates.
//!
//! ## Why read-only (the write-approval problem)
//! The app's write gate ([`crate::llm::approval`]) is **Tauri-event driven**: a
//! write raises an event the desktop UI answers with `approve_tool_call` /
//! `reject_tool_call`. An external MCP client over stdio is not in that loop —
//! there is no window to pop, and nobody to click approve. Exposing writes would
//! therefore mean either (a) silently writing the user's vault with no consent,
//! or (b) blocking forever on an approval that can never arrive. Both are wrong,
//! so the server is read-only by construction: only tools that
//! [`crate::llm::approval::is_read_only_tool`] classifies as side-effect-free are
//! ever advertised or dispatched. Opt-in writes are left for a future design that
//! can route approval somewhere the external client can actually see it.
//!
//! ## stdio hygiene
//! In stdio mode **stdout carries protocol frames only**. Every log line goes to
//! stderr (`log::*` → `env_logger`, which defaults to stderr). A stray `println!`
//! would corrupt the JSON-RPC stream — the single most common way an MCP stdio
//! server breaks — so there are none in the serve loop.

pub mod uri;

use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// Protocol version we implement. Kept identical to the client half so the two
/// never drift (`mcp_client` sends the same string in its `initialize`).
const PROTOCOL_VERSION: &str = "2024-11-05";

// ── JSON-RPC 2.0 error codes (spec §5.1) ──────────────────────────────────
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

/// The tools we expose to external clients.
///
/// Deliberately a *hand-picked* subset, not "everything read-only": each entry
/// is (1) classified read-only by [`crate::llm::approval::is_read_only_tool`] and
/// (2) pure retrieval that needs no `LlmConfig` (so we can dispatch with a
/// default config and never make a surprise outbound LLM call on a client's
/// behalf). A unit test enforces the read-only half of that invariant.
const EXPOSED_TOOLS: &[&str] = &[
    "search_notes",       // hybrid FTS+vector search — search_ops.rs:23
    "read_note",          // note_ops.rs:10 (path-safe via resolve_path_multi_vault)
    "list_notes",         // search_ops.rs:237
    "find_similar_notes", // vector neighbours — search_ops.rs:310
    "search_by_tag",      // search_ops.rs:390
    "get_backlinks",      // Zettelkasten link following — graph_ops.rs:170
    "get_note_tags",      // graph_ops.rs:240
    "get_note_metadata",  // graph_ops.rs:308
];

/// Shared server state. Mirrors what `execute_tool` receives in-app: a DB handle
/// plus the vault list that bounds every path.
pub struct McpServerState {
    pub db: Arc<Mutex<Connection>>,
    /// Primary vault (containment fallback + default create root, though we never
    /// create here).
    pub vault_path: String,
    /// All vault roots a path may legally resolve inside.
    pub all_vault_paths: Vec<String>,
}

impl McpServerState {
    pub fn new(db: Arc<Mutex<Connection>>, vault_path: String, all_vault_paths: Vec<String>) -> Self {
        Self { db, vault_path, all_vault_paths }
    }
}

// ── JSON-RPC envelope ─────────────────────────────────────────────────────

/// `{"jsonrpc":"2.0","id":<id>,"result":<result>}`
fn success(id: Value, result: Value) -> String {
    // `to_string` on a Value cannot fail for these shapes, but fall back rather
    // than unwrap: a panic in the serve loop would kill the connection.
    serde_json::to_string(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
        .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"serialize failed"}}"#.to_string())
}

/// `{"jsonrpc":"2.0","id":<id>,"error":{code,message}}`
fn failure(id: Value, code: i64, message: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message},
    }))
    .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"serialize failed"}}"#.to_string())
}

/// MCP `tools/call` / `resources/read` payloads are always a content array.
fn text_content(text: String, is_error: bool) -> Value {
    json!({
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    })
}

// ── Dispatcher ────────────────────────────────────────────────────────────

/// Handle one JSON-RPC message.
///
/// Returns `Some(response_json)` for requests and `None` for notifications and
/// blank lines. Notifications get **no** reply even when malformed — JSON-RPC
/// §4.1 forbids responding to them, and a client that receives an unsolicited
/// frame for its `notifications/initialized` will usually drop the session.
///
/// `rt` is used to drive [`crate::tools::internal_tools::try_execute`], which is
/// `async` because *some* tools in the catalogue are; every tool in
/// [`EXPOSED_TOOLS`] is synchronous underneath, so this never actually parks.
pub fn handle_message(
    state: &McpServerState,
    rt: &tokio::runtime::Runtime,
    raw: &str,
) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let msg: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        // Unparseable input has no recoverable id, so the spec says reply with
        // id = null and -32700.
        Err(e) => {
            log::warn!("MCP server: parse error: {}", e);
            return Some(failure(Value::Null, PARSE_ERROR, "Parse error: invalid JSON"));
        }
    };

    // A batch (top-level array) is legal JSON-RPC but not used by MCP; refuse
    // explicitly instead of silently ignoring half of it.
    if !msg.is_object() {
        return Some(failure(
            Value::Null,
            INVALID_REQUEST,
            "Invalid Request: expected a JSON-RPC object (batches are not supported)",
        ));
    }

    // Absent `id` == notification. `id: null` is technically a request with a
    // null id; treat it as a request so the client still gets its reply.
    let is_notification = msg.get("id").is_none();
    let id = msg.get("id").cloned().unwrap_or(Value::Null);

    let method = match msg.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => {
            if is_notification {
                return None;
            }
            return Some(failure(id, INVALID_REQUEST, "Invalid Request: missing 'method'"));
        }
    };

    let params = msg.get("params").cloned().unwrap_or(json!({}));

    if is_notification {
        // The only notifications we care about are lifecycle pings; everything
        // else is safely ignorable per spec.
        log::debug!("MCP server: notification '{}'", method);
        return None;
    }

    let outcome: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(initialize_result()),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list_result()),
        "tools/call" => handle_tools_call(state, rt, &params),
        "resources/list" => handle_resources_list(state, &params),
        "resources/read" => handle_resources_read(state, rt, &params),
        "prompts/list" => Ok(prompts_list_result()),
        "prompts/get" => handle_prompts_get(&params),
        other => Err((
            METHOD_NOT_FOUND,
            format!("Method not found: {}", other),
        )),
    };

    Some(match outcome {
        Ok(result) => success(id, result),
        Err((code, message)) => failure(id, code, &message),
    })
}

// ── initialize ────────────────────────────────────────────────────────────

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            // Empty objects = "supported, no sub-features". We do not emit
            // list-changed notifications, so no `listChanged: true`.
            "tools": {},
            "resources": {},
            "prompts": {},
        },
        "serverInfo": {
            "name": "ZettelAgent",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "Read-only access to a ZettelAgent knowledge vault. Use `search_notes` for hybrid semantic+keyword search, `read_note` to fetch a note by path, and the `zettel://` resources to browse notes. Writes are intentionally not exposed.",
    })
}

// ── tools/list + tools/call ────────────────────────────────────────────────

fn tools_list_result() -> Value {
    // Reuse the in-app tool schemas verbatim so descriptions/params never drift
    // from what the internal agent sees. We only project the exposed subset and
    // rename `parameters` → `inputSchema` (the one field name MCP and the
    // OpenAI-style `ToolDef` disagree on).
    let defs = crate::tools::internal_tools::get_internal_tool_defs();
    let tools: Vec<Value> = defs
        .into_iter()
        .filter(|d| EXPOSED_TOOLS.contains(&d.function.name.as_str()))
        .map(|d| {
            json!({
                "name": d.function.name,
                "description": d.function.description,
                "inputSchema": d.function.parameters,
            })
        })
        .collect();
    json!({ "tools": tools })
}

fn handle_tools_call(
    state: &McpServerState,
    rt: &tokio::runtime::Runtime,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or((INVALID_PARAMS, "Invalid params: missing tool 'name'".to_string()))?;

    // Gate on the exposed allow-list *before* touching the dispatcher. This is
    // the enforcement point for read-only: a client asking for `create_note`
    // (or any un-exposed / write tool) is refused here, never dispatched.
    if !EXPOSED_TOOLS.contains(&name) {
        return Err((
            INVALID_PARAMS,
            format!("Unknown or unavailable tool '{}'. This server is read-only; call tools/list.", name),
        ));
    }

    // MCP nests the args under `arguments`; try_execute wants a JSON string.
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let args_str = args.to_string();

    // Default LlmConfig is fine: every exposed tool is pure retrieval and never
    // consults it. Dispatch through `internal_tools::try_execute` directly —
    // NOT `tools::execute_tool` — to keep the MCP *client* branch (and its
    // comctl32/TaskDialog link dependency) out of this call graph, exactly as
    // the note in tools/mod.rs's test explains.
    let config = crate::llm::LlmConfig::default();
    let dispatched = rt.block_on(crate::tools::internal_tools::try_execute(
        name,
        &args_str,
        &state.db,
        &state.vault_path,
        &state.all_vault_paths,
        &config,
    ));

    match dispatched {
        // Tool error (bad path, missing note, …) is a *tool* result with
        // isError:true, not a protocol error — that is how MCP clients surface
        // it to their model without aborting the session.
        Some(Ok(text)) => Ok(text_content(text, false)),
        Some(Err(e)) => Ok(text_content(format!("Error: {}", e), true)),
        // Should be unreachable given the allow-list, but map it honestly.
        None => Err((INTERNAL_ERROR, format!("Tool '{}' is not dispatchable", name))),
    }
}

// ── resources/list + resources/read ────────────────────────────────────────

/// One `resources/list` page. A vault of 10k notes must not arrive as one frame,
/// so we honour MCP's cursor pagination rather than silently truncating.
const RESOURCE_PAGE_SIZE: usize = 200;

fn handle_resources_list(state: &McpServerState, params: &Value) -> Result<Value, (i64, String)> {
    // The cursor is just the last `path` of the previous page. Keyset pagination
    // (`WHERE path > cursor`) instead of OFFSET so a note added mid-walk cannot
    // make the client skip a row, and so it stays O(log n) per page.
    let cursor = params
        .get("cursor")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let conn = state
        .db
        .lock()
        .map_err(|_| (INTERNAL_ERROR, "DB lock error".to_string()))?;

    // Read from the index rather than walking the filesystem: `files` is what
    // the rest of the app treats as the source of truth for "which notes exist",
    // and it already carries titles.
    let mut stmt = conn
        .prepare(
            "SELECT path, COALESCE(title, '') FROM files
             WHERE path > ?1 ORDER BY path LIMIT ?2",
        )
        .map_err(|e| (INTERNAL_ERROR, format!("query failed: {}", e)))?;

    let rows = stmt
        .query_map(rusqlite::params![&cursor, RESOURCE_PAGE_SIZE as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| (INTERNAL_ERROR, format!("query failed: {}", e)))?;

    let mut resources = Vec::new();
    let mut last_path = String::new();
    let mut raw_rows = 0usize;
    for (path, title) in rows.flatten() {
        raw_rows += 1;
        last_path = path.clone();

        // Only advertise notes this server can actually serve. The `files` table
        // is app-wide and can hold rows for vaults the current invocation was not
        // given (`--vault` narrows us, and a stale row can outlive a removed
        // vault). Listing those would hand the client URIs whose `resources/read`
        // is guaranteed to be denied — confusing, and it leaks the existence of
        // paths outside the served scope. Same helper the read path uses, so the
        // two can never disagree.
        if !crate::tools::internal_tools::helpers::is_path_in_any_vault(
            std::path::Path::new(&path),
            &state.vault_path,
            &state.all_vault_paths,
        ) {
            continue;
        }

        let name = if title.is_empty() {
            // Fall back to the file name. Splitting on '/' is safe for non-ASCII
            // paths: '/' is ASCII and can never appear inside a UTF-8 multi-byte
            // sequence, so this cannot land mid-codepoint.
            path.replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .to_string()
        } else {
            title
        };
        resources.push(json!({
            "uri": uri::encode_note_uri(&path),
            "name": name,
            "mimeType": "text/markdown",
        }));
    }

    // Cursor is driven by *rows scanned*, not rows kept: a page that was full but
    // fully filtered out must still hand back a cursor, or pagination would stop
    // before reaching the notes that do belong to this vault.
    let mut result = json!({ "resources": resources });
    if raw_rows >= RESOURCE_PAGE_SIZE {
        result["nextCursor"] = json!(last_path);
    }
    Ok(result)
}

fn handle_resources_read(
    state: &McpServerState,
    rt: &tokio::runtime::Runtime,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let raw_uri = params
        .get("uri")
        .and_then(|u| u.as_str())
        .ok_or((INVALID_PARAMS, "Invalid params: missing 'uri'".to_string()))?;

    let path = uri::decode_note_uri(raw_uri).ok_or((
        INVALID_PARAMS,
        format!("Invalid params: '{}' is not a zettel:// URI", raw_uri),
    ))?;

    // Path safety is *not* re-implemented here. The decoded value is handed to
    // `read_note`, whose `resolve_path_multi_vault` (helpers.rs:239) does the
    // vault-containment check — including the two traps a naive check misses:
    // `Path::starts_with` compares whole components, and Windows `canonicalize`
    // returns a `\\?\` verbatim prefix that must be on both sides of the compare.
    // A `../../../etc/passwd` payload therefore dies in that function, which is
    // the single audited gate for this whole process.
    let config = crate::llm::LlmConfig::default();
    let args = json!({ "path": path }).to_string();
    let dispatched = rt.block_on(crate::tools::internal_tools::try_execute(
        "read_note",
        &args,
        &state.db,
        &state.vault_path,
        &state.all_vault_paths,
        &config,
    ));

    match dispatched {
        Some(Ok(text)) => Ok(json!({
            "contents": [{
                "uri": raw_uri,
                "mimeType": "text/markdown",
                "text": text,
            }]
        })),
        // A denied path or missing file is a legitimate client error, not a
        // server fault: -32602 so the client knows the *argument* was bad.
        Some(Err(e)) => Err((INVALID_PARAMS, format!("Cannot read resource: {}", e))),
        None => Err((INTERNAL_ERROR, "read_note is not dispatchable".to_string())),
    }
}

// ── prompts/list + prompts/get ──────────────────────────────────────────────
//
// Cheap value-add: a couple of Zettelkasten method templates so a client can
// offer "turn this into a permanent note" without the user hand-writing the
// instruction each time. Static text, no vault access — practically free.

/// (name, description, single `{{topic}}`-style argument name or none).
const PROMPTS: &[(&str, &str, Option<&str>)] = &[
    (
        "permanent_note",
        "Rewrite rough input as an atomic Zettelkasten permanent note: one idea, in your own words, densely linkable.",
        Some("source"),
    ),
    (
        "find_connections",
        "Given a note, brainstorm non-obvious links to other ideas in the vault (use search_notes to check they exist first).",
        Some("note"),
    ),
];

fn prompts_list_result() -> Value {
    let prompts: Vec<Value> = PROMPTS
        .iter()
        .map(|(name, desc, arg)| {
            let arguments = match arg {
                Some(a) => json!([{ "name": a, "description": format!("The {}", a), "required": true }]),
                None => json!([]),
            };
            json!({ "name": name, "description": desc, "arguments": arguments })
        })
        .collect();
    json!({ "prompts": prompts })
}

fn handle_prompts_get(params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or((INVALID_PARAMS, "Invalid params: missing prompt 'name'".to_string()))?;

    let arg_val = params
        .get("arguments")
        .and_then(|a| a.get(prompt_arg_name(name).unwrap_or("")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let text = match name {
        "permanent_note" => format!(
            "You are helping build a Zettelkasten. Rewrite the following into a single \
             atomic permanent note: express ONE idea in your own words, self-contained, \
             and phrased so it can be linked from other notes. Suggest 2-3 [[wikilinks]] \
             to related concepts.\n\nSource:\n{}",
            arg_val
        ),
        "find_connections" => format!(
            "Given the note below, propose non-obvious connections to other ideas. For \
             each, name the concept and explain the link in one sentence. Prefer links \
             that would surprise the author.\n\nNote:\n{}",
            arg_val
        ),
        other => return Err((INVALID_PARAMS, format!("Unknown prompt '{}'", other))),
    };

    Ok(json!({
        "messages": [{
            "role": "user",
            "content": { "type": "text", "text": text },
        }]
    }))
}

fn prompt_arg_name(prompt: &str) -> Option<&'static str> {
    PROMPTS.iter().find(|(n, _, _)| *n == prompt).and_then(|(_, _, a)| *a)
}

// ── stdio entrypoint ────────────────────────────────────────────────────────

/// Resolve the vault list for a standalone server run.
///
/// Precedence: explicit `--vault` overrides (repeatable) win; otherwise fall
/// back to the single `vault_path` persisted in `app_settings` (the same key
/// `lint.rs` reads). Returns `(primary, all)`. `all` is always non-empty on
/// success so the containment check has something to compare against.
pub fn resolve_vaults(
    conn: &Connection,
    overrides: &[String],
) -> anyhow::Result<(String, Vec<String>)> {
    let mut vaults: Vec<String> = overrides.iter().filter(|s| !s.trim().is_empty()).cloned().collect();

    if vaults.is_empty() {
        if let Ok(Some(v)) = crate::db::schema::get_setting(conn, "vault_path") {
            if !v.trim().is_empty() {
                vaults.push(v);
            }
        }
    }

    if vaults.is_empty() {
        anyhow::bail!(
            "No vault configured. Pass --vault <path> or set the vault in the app first."
        );
    }
    let primary = vaults[0].clone();
    Ok((primary, vaults))
}

/// Serve MCP over stdio until stdin closes.
///
/// **stdout is protocol-only.** All diagnostics go through `log::*` (stderr).
/// One JSON-RPC frame per line, in and out (newline-delimited JSON — the
/// framing the client half in `mcp_client` also uses).
pub fn serve_stdio(db: Arc<Mutex<Connection>>, vault_overrides: Vec<String>) -> anyhow::Result<()> {
    use std::io::{BufRead, Write};

    let (vault_path, all_vault_paths) = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("DB lock error"))?;
        resolve_vaults(&conn, &vault_overrides)?
    };
    log::info!(
        "MCP server: stdio ready, vault(s)={:?}, {} tools exposed",
        all_vault_paths,
        EXPOSED_TOOLS.len()
    );

    let state = McpServerState::new(db, vault_path, all_vault_paths);
    // One runtime for the whole session; every tool call parks on it briefly.
    let rt = tokio::runtime::Runtime::new()?;

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::warn!("MCP server: stdin read error: {}", e);
                break;
            }
        };
        if let Some(response) = handle_message(&state, &rt, &line) {
            // A write failure means the client's pipe is gone — nothing left to
            // serve, so stop rather than spin.
            if writeln!(out, "{}", response).and_then(|_| out.flush()).is_err() {
                log::warn!("MCP server: stdout closed, shutting down");
                break;
            }
        }
    }
    log::info!("MCP server: stdin closed, exiting");
    Ok(())
}

/// CLI flag that switches the binary from "launch the desktop app" to "be an
/// MCP server on stdio". Kept here (not in `main.rs`) so the whole contract —
/// flag name, arg parsing, DB bootstrap — lives in one file.
pub const MCP_SERVER_FLAG: &str = "--mcp-server";

/// Bootstrap and serve from raw process args.
///
/// Recognised: `--db <path>` (required, or `ZETTELAGENT_DB`) and `--vault <path>`
/// (repeatable; defaults to the `vault_path` in `app_settings`). The DB path is
/// explicit rather than re-derived because Tauri's `app_data_dir()` needs an app
/// handle we do not have here, and `db_config.json` may point somewhere custom —
/// guessing wrong would silently serve an empty vault. The app's Settings page
/// already surfaces the real path (`get_db_path`), and the generated client
/// config snippet bakes it into the args.
pub fn serve_stdio_from_args(args: &[String]) -> anyhow::Result<()> {
    let mut db_path: Option<String> = std::env::var("ZETTELAGENT_DB").ok();
    let mut vaults: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--db" => {
                db_path = args.get(i + 1).cloned();
                i += 2;
            }
            "--vault" => {
                if let Some(v) = args.get(i + 1) {
                    vaults.push(v.clone());
                }
                i += 2;
            }
            _ => i += 1,
        }
    }

    let db_path = db_path.filter(|p| !p.trim().is_empty()).ok_or_else(|| {
        anyhow::anyhow!("--mcp-server requires --db <path> (see Settings → database path)")
    })?;
    let db_path = std::path::PathBuf::from(&db_path);
    if !db_path.is_file() {
        // Refuse rather than let `Connection::open` create a fresh empty file:
        // a typo'd path would otherwise present as a vault with zero notes.
        anyhow::bail!("Database not found at {}", db_path.display());
    }

    // Must precede *any* connection or `chunks_vec` fails with `no such module: vec0`.
    crate::db::register_sqlite_vec();

    // Defence in depth: the tool allow-list already excludes every writer, but
    // opening read-only means even a bug cannot mutate the user's vault index.
    // Falls back to read-write because a WAL database needs a writable `-shm`
    // when no other process has it open, and refusing to serve at all would be
    // worse than serving with the allow-list as the only guard.
    let conn = match rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("MCP server: read-only open failed ({}), retrying read-write", e);
            rusqlite::Connection::open(&db_path)?
        }
    };

    serve_stdio(Arc::new(Mutex::new(conn)), vaults)
}

// ── Tauri commands (registered by the app; see report) ──────────────────────

/// Build the client-config JSON snippet a user pastes into Claude Desktop /
/// Cursor to register this vault. Pure/stateless: takes the resolved db path
/// (frontend already has it via `get_db_path`) and returns ready-to-paste JSON.
///
/// Uses the *current* executable path with a `--mcp-server` flag — the app must
/// wire that flag in `main.rs` (see report). No network, no token: stdio only.
#[tauri::command]
pub fn mcp_server_client_config(db_path: String) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "zettelagent".to_string());

    let snippet = json!({
        "mcpServers": {
            "zettelagent": {
                "command": exe,
                "args": ["--mcp-server", "--db", db_path],
            }
        }
    });
    serde_json::to_string_pretty(&snippet).map_err(|e| e.to_string())
}

/// Report what the server exposes, for a settings-page summary.
#[tauri::command]
pub fn mcp_server_capabilities() -> Result<String, String> {
    let payload = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "readOnly": true,
        "tools": EXPOSED_TOOLS,
        "resources": { "scheme": "zettel://", "mimeType": "text/markdown" },
        "prompts": PROMPTS.iter().map(|(n, _, _)| *n).collect::<Vec<_>>(),
    });
    serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// A live-ish server: in-memory DB with the real schema, plus a temp vault
    /// holding one CJK-named note. `register_sqlite_vec` must come *before* the
    /// connection is opened or `chunks_vec` fails with `no such module: vec0`.
    struct Env {
        state: McpServerState,
        rt: tokio::runtime::Runtime,
        vault: std::path::PathBuf,
        note_stored_path: String,
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    fn env(tag: &str) -> Env {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();

        let vault = std::env::temp_dir().join(format!(
            "zettel_mcp_{}_{}",
            tag,
            std::process::id()
        ));
        std::fs::create_dir_all(vault.join("笔记")).unwrap();
        // CJK + space in the filename: the combination that used to panic when
        // anything sliced bytes instead of chars.
        let note = vault.join("笔记").join("测试 笔记.md");
        std::fs::write(&note, "# 测试\n\n这是一个关于知识管理的中文笔记。\n").unwrap();

        let stored = crate::tools::internal_tools::helpers::normalize_db_path(&note);
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, ?2, ?3)",
            params![&stored, "deadbeef", "测试 笔记"],
        )
        .unwrap();
        crate::db::schema::set_setting(&conn, "vault_path", &vault.to_string_lossy()).unwrap();

        let vault_str = vault.to_string_lossy().to_string();
        Env {
            state: McpServerState::new(
                Arc::new(Mutex::new(conn)),
                vault_str.clone(),
                vec![vault_str],
            ),
            rt: tokio::runtime::Runtime::new().unwrap(),
            vault,
            note_stored_path: stored,
        }
    }

    fn call(e: &Env, raw: &str) -> Value {
        let out = handle_message(&e.state, &e.rt, raw).expect("expected a response");
        serde_json::from_str(&out).expect("response must be valid JSON")
    }

    fn err_code(v: &Value) -> i64 {
        v["error"]["code"].as_i64().unwrap_or_else(|| panic!("expected an error, got {v}"))
    }

    // ── JSON-RPC framing ──────────────────────────────────────────────

    #[test]
    fn malformed_json_is_parse_error() {
        let e = env("parse");
        let v = call(&e, "{not json at all");
        assert_eq!(err_code(&v), PARSE_ERROR);
        // Spec: an unparseable frame has no recoverable id, so it must be null.
        assert!(v["id"].is_null());
    }

    #[test]
    fn non_object_frame_is_invalid_request() {
        let e = env("batch");
        // Legal JSON, illegal MCP: batches are not part of the protocol.
        assert_eq!(err_code(&call(&e, "[1,2,3]")), INVALID_REQUEST);
    }

    #[test]
    fn missing_method_is_invalid_request() {
        let e = env("nomethod");
        let v = call(&e, r#"{"jsonrpc":"2.0","id":7}"#);
        assert_eq!(err_code(&v), INVALID_REQUEST);
        assert_eq!(v["id"], json!(7));
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let e = env("nomethodfound");
        let v = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"vault/nuke"}"#);
        assert_eq!(err_code(&v), METHOD_NOT_FOUND);
    }

    #[test]
    fn notifications_never_get_a_response() {
        let e = env("notify");
        // No `id` → notification. Even a bogus one must stay silent, or the
        // client sees an unsolicited frame and usually drops the session.
        assert!(handle_message(&e.state, &e.rt, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
        assert!(handle_message(&e.state, &e.rt, r#"{"jsonrpc":"2.0","method":"nonsense"}"#).is_none());
        // Blank lines are framing noise, not errors.
        assert!(handle_message(&e.state, &e.rt, "   ").is_none());
    }

    #[test]
    fn initialize_advertises_all_three_capabilities() {
        let e = env("init");
        let v = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
        assert_eq!(v["result"]["protocolVersion"], json!(PROTOCOL_VERSION));
        for cap in ["tools", "resources", "prompts"] {
            assert!(v["result"]["capabilities"][cap].is_object(), "missing capability {cap}");
        }
        assert_eq!(v["result"]["serverInfo"]["name"], json!("ZettelAgent"));
        // `id` must be echoed verbatim.
        assert_eq!(v["id"], json!(1));
    }

    // ── tools ─────────────────────────────────────────────────────────

    #[test]
    fn tools_list_has_a_well_formed_schema_per_tool() {
        let e = env("toolslist");
        let v = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        let tools = v["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), EXPOSED_TOOLS.len());
        for t in tools {
            assert!(t["name"].is_string(), "tool needs a name: {t}");
            assert!(
                !t["description"].as_str().unwrap_or("").is_empty(),
                "tool {} needs a description",
                t["name"]
            );
            // MCP calls it `inputSchema`, not `parameters` — getting this wrong
            // makes every client report "tool has no arguments".
            assert_eq!(t["inputSchema"]["type"], json!("object"), "bad schema for {}", t["name"]);
            assert!(t["inputSchema"]["properties"].is_object());
            assert!(t.get("parameters").is_none(), "must not leak the OpenAI field name");
        }
    }

    #[test]
    fn read_only_mode_hides_and_refuses_write_tools() {
        let e = env("readonly");
        let v = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        for writer in ["create_note", "edit_note", "patch_note", "delete_note", "append_to_note", "move_note"] {
            assert!(!names.contains(&writer), "{writer} must not be advertised");
        }

        // Not advertised is not enough — a client can still *ask*. The allow-list
        // has to refuse it before the dispatcher sees it, otherwise this is a
        // silent write-through backdoor into the user's vault.
        let denied = call(
            &e,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_note","arguments":{"path":"x.md","content":"pwned"}}}"#,
        );
        assert_eq!(err_code(&denied), INVALID_PARAMS);
        assert!(!e.vault.join("x.md").exists(), "no file may be created");
    }

    #[test]
    fn every_exposed_tool_is_classified_read_only() {
        // The allow-list and `llm::approval`'s classification must not drift: if
        // someone adds a tool here that the approval gate considers a writer,
        // this fails instead of shipping an unapproved write path.
        for name in EXPOSED_TOOLS {
            assert!(
                crate::llm::approval::is_read_only_tool(name),
                "{name} is exposed over MCP but is not a verified read-only tool"
            );
        }
    }

    #[test]
    fn tools_call_without_name_is_invalid_params() {
        let e = env("callnoname");
        let v = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#);
        assert_eq!(err_code(&v), INVALID_PARAMS);
    }

    #[test]
    fn wrong_argument_type_surfaces_as_a_tool_error_not_a_crash() {
        let e = env("badargs");
        // `query` must be a string; passing a number used to be the shape that
        // reached `as_str().ok_or(...)` and became a tool-level error.
        let v = call(
            &e,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":42}}}"#,
        );
        assert_eq!(v["result"]["isError"], json!(true), "got {v}");
    }

    // ── path traversal (the one data-exfil channel) ───────────────────

    #[test]
    fn read_note_rejects_unix_traversal() {
        let e = env("trav_unix");
        let v = call(
            &e,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"../../../etc/passwd"}}}"#,
        );
        // A refused path is a tool-level error, not a crash; the point is that no
        // file content outside the vault comes back.
        assert_eq!(v["result"]["isError"], json!(true), "got {v}");
        let text = v["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(!text.contains("root:"), "must not leak /etc/passwd: {text}");
    }

    #[test]
    fn read_note_rejects_windows_traversal() {
        let e = env("trav_win");
        let v = call(
            &e,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"..\\..\\..\\Windows\\win.ini"}}}"#,
        );
        assert_eq!(v["result"]["isError"], json!(true), "got {v}");
    }

    #[test]
    fn resources_read_rejects_traversal_uri() {
        let e = env("trav_res");
        // Even wrapped in a valid zettel:// URI, the containment check must bite.
        let bad = uri::encode_note_uri("../../../etc/passwd");
        let req = json!({
            "jsonrpc":"2.0","id":1,"method":"resources/read",
            "params": {"uri": bad}
        });
        let v = call(&e, &req.to_string());
        assert_eq!(err_code(&v), INVALID_PARAMS);
    }

    // ── resources ─────────────────────────────────────────────────────

    #[test]
    fn resources_list_then_read_round_trips_a_cjk_note() {
        let e = env("res_roundtrip");
        let list = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"resources/list"}"#);
        let resources = list["result"]["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 1);
        let uri = resources[0]["uri"].as_str().unwrap();
        assert!(uri.starts_with("zettel:///"));
        assert_eq!(resources[0]["mimeType"], json!("text/markdown"));

        // The URI a client got from list must read back the actual note — the
        // CJK + space path has to survive the encode/decode round trip.
        let read = call(
            &e,
            &json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":uri}}).to_string(),
        );
        let text = read["result"]["contents"][0]["text"].as_str().unwrap();
        assert!(text.contains("关于知识管理"), "read wrong note: {text}");
        assert_eq!(read["result"]["contents"][0]["uri"].as_str().unwrap(), uri);
    }

    #[test]
    fn resources_read_bad_uri_is_invalid_params() {
        let e = env("res_baduri");
        let v = call(
            &e,
            r#"{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"http://evil/x"}}"#,
        );
        assert_eq!(err_code(&v), INVALID_PARAMS);
    }

    #[test]
    fn cjk_query_does_not_panic() {
        let e = env("cjk_query");
        // Chinese query over a Chinese note: exercises FTS on CJK text. The
        // assertion is simply "we got a normal result frame, not a panic".
        let v = call(
            &e,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"知识管理"}}}"#,
        );
        assert!(v["result"]["content"].is_array(), "got {v}");
        // Keep the stored path referenced so the fixture field is not dead code.
        assert!(e.note_stored_path.contains("测试"));
    }

    // ── prompts ───────────────────────────────────────────────────────

    #[test]
    fn resources_list_omits_notes_outside_the_served_vaults() {
        let e = env("res_scope");
        // A stale / other-vault row in the app-wide `files` table. Listing it
        // would hand the client a URI that `resources/read` must deny, and would
        // disclose a path outside the served scope.
        {
            let conn = e.state.db.lock().unwrap();
            let outside = e.vault.parent().unwrap().join("outside_vault_note.md");
            conn.execute(
                "INSERT INTO files (path, hash, title) VALUES (?1, ?2, ?3)",
                params![
                    crate::tools::internal_tools::helpers::normalize_db_path(&outside),
                    "cafe",
                    "Outside"
                ],
            )
            .unwrap();
        }

        let list = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"resources/list"}"#);
        let names: Vec<&str> = list["result"]["resources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"测试 笔记"), "in-vault note must be listed: {names:?}");
        assert!(!names.contains(&"Outside"), "out-of-vault note must be hidden");
    }

    #[test]
    fn resources_list_paginates_by_keyset_cursor() {
        let e = env("res_page");
        let list = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"resources/list"}"#);
        // Single note → page is not full → no cursor is advertised, which is how
        // a client knows to stop asking.
        assert!(list["result"]["nextCursor"].is_null());

        // Feeding the last path back as the cursor must not re-serve that row;
        // an OFFSET-based implementation would happily loop forever here.
        let next = call(
            &e,
            &json!({"jsonrpc":"2.0","id":2,"method":"resources/list",
                    "params":{"cursor": e.note_stored_path}})
            .to_string(),
        );
        assert_eq!(next["result"]["resources"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn prompts_list_and_get() {
        let e = env("prompts");
        let list = call(&e, r#"{"jsonrpc":"2.0","id":1,"method":"prompts/list"}"#);
        assert_eq!(list["result"]["prompts"].as_array().unwrap().len(), PROMPTS.len());

        let got = call(
            &e,
            r#"{"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"permanent_note","arguments":{"source":"随手记的一段话"}}}"#,
        );
        let text = got["result"]["messages"][0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("随手记的一段话"), "argument must be interpolated: {text}");

        assert_eq!(
            err_code(&call(&e, r#"{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"ghost"}}"#)),
            INVALID_PARAMS
        );
    }

    #[test]
    fn resolve_vaults_prefers_override_then_setting() {
        let e = env("resolve");
        let conn = e.state.db.lock().unwrap();
        // Override wins.
        let (p, all) = resolve_vaults(&conn, &["C:/override".to_string()]).unwrap();
        assert_eq!(p, "C:/override");
        assert_eq!(all, vec!["C:/override".to_string()]);
        // Falls back to the persisted `vault_path` when no override is given.
        let (p2, _) = resolve_vaults(&conn, &[]).unwrap();
        assert_eq!(p2, e.state.vault_path);
    }
}


