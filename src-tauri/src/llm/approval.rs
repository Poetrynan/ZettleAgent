/**
 * Agent Approval Gate — human-in-the-loop approval for tool calls.
 *
 * Deny-by-default: a tool runs unattended only if it is on the verified
 * read-only whitelist (`is_read_only_tool`) or is an explicitly-justified
 * derived-index writer. Everything else — including unknown internal tools
 * and third-party `mcp_*` tools — requires user approval.
 *
 * On top of that binary gate sits a three-part policy layer:
 *
 * - `PermissionMode` — how much the user currently trusts the agent
 *   (`ReadOnly` / `Standard` / `Trusted`).
 * - `RiskLevel` — what the user loses if this specific call is wrong
 *   (`Low` / `Medium` / `High` / `Critical`), escalated dynamically by the
 *   hub-note / batch heuristics in `tool_hooks` and by turn taint.
 * - `approval_rules` — user-authored "stop asking me about this" rules,
 *   scoped to a tool + path prefix + max risk, for one session or forever.
 *
 * `decide()` folds the three into a single `Allow` / `Ask` / `Deny`.
 *
 * The frontend shows a diff preview; the user clicks approve or reject.
 */
use crate::error::ZettelError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::State;
use tokio::sync::{Mutex, oneshot};

/// Diff data sent to the frontend for approval preview.
/// Field names must match the frontend `ApprovalDiffData` interface in tauri.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDiffData {
    pub tool_name: String,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path_alt: Option<String>,
    /// One of: create, edit, patch, apply_edit, append, delete, rename, move, other
    pub diff_type: String,
    /// The raw tool arguments JSON — frontend parses this for line-level diff rendering
    pub tool_args_json: String,
    /// Human-readable action title shown in the approval card header
    pub title: String,
    /// Effective risk level of this call: "low" | "medium" | "high" | "critical".
    /// Always present. Drives the badge colour on the approval card.
    pub risk_level: String,
    /// Why the risk was escalated above the tool's base level (hub note, batch
    /// mutation, tainted turn). `None` when the call sits at its base level.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_reason: Option<String>,
}

/// Global pending approvals map: approval_id → oneshot sender.
fn pending_approvals() -> &'static Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> {
    static INSTANCE: OnceLock<Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Returns a reference to the pending approvals map (for mod.rs to insert/remove).
pub fn get_pending_approvals() -> Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> {
    pending_approvals().clone()
}

/// Read-only tool whitelist ("class A").
///
/// A tool belongs here **only** if its `execute_*` implementation was verified to
/// perform no filesystem writes and no mutation of user data tables — i.e. it only
/// runs `SELECT`s, reads files, computes, or issues outbound network GETs.
///
/// This list is deliberately conservative: it is the *only* escape hatch from the
/// approval gate, so anything unverified must be left out (see `requires_approval`).
pub fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        // ── Search (search_ops.rs — SELECT / vector search only) ──
        "search_notes"                  // search_ops.rs:23
            | "list_notes"              // search_ops.rs:237
            | "find_similar_notes"      // search_ops.rs:310
            | "search_by_tag"           // search_ops.rs:390
            // ── Note reads (note_ops.rs) ──
            | "read_note"               // note_ops.rs:10
            | "batch_read_notes"        // note_ops.rs:735
            | "resolve_wikilink"        // note_ops.rs:804
            | "get_note_history"        // note_ops.rs:1232
            // LLM-backed but output-only: returns generated text, never writes it
            | "generate_structure_note" // note_ops.rs:871 → returns MOC markdown
            | "compare_notes"           // note_ops.rs:1002 → returns analysis JSON
            // ── Graph reads (graph_ops.rs) ──
            | "get_graph"               // graph_ops.rs:20
            | "get_local_graph"         // graph_ops.rs:69
            | "find_shortest_path"      // graph_ops.rs:107
            | "get_timeline"            // graph_ops.rs:149
            | "get_backlinks"           // graph_ops.rs:170
            | "get_note_tags"           // graph_ops.rs:240
            | "get_note_metadata"       // graph_ops.rs:308
            | "query_relations"         // graph_ops.rs:384
            | "get_relations_by_type"   // graph_ops.rs:505
            | "get_note_facts"          // graph_ops.rs:532
            | "get_global_timeline"     // graph_ops.rs:563
            | "explain_relationship"    // graph_ops.rs:591 → reads + LLM, no write
            | "query_temporal"          // graph_ops.rs:825
            // ── Web (outbound GET only) ──
            | "web_search"              // web_ops.rs:6
            // ── Canvas read ──
            | "read_canvas"             // canvas_ops.rs:41
            // ── Workspace reads (workspace_ops.rs) ──
            | "list_workspace_folders"  // workspace_ops.rs:8
            | "get_vault_stats"         // workspace_ops.rs:197
            | "run_lint"                // workspace_ops.rs:126 → lint::run_vault_lint (lint.rs:215) is read-only
            | "read_memory"             // workspace_ops.rs:429
            | "search_memory"           // workspace_ops.rs:481
            | "query_database"          // workspace_ops.rs:744 → fixed parameterized SELECT, no raw SQL
            | "get_directory_tree"      // workspace_ops.rs:680
            | "get_embedding_status"     // workspace_ops.rs:843
            // ── Skill system (reads SKILL.md off disk, nothing else) ──
            | "read_skill"              // skill_loader.rs → execute_read_skill
            // ── Tool discovery (reads a compile-time catalogue) ──
            // Escape hatch for the narrowed default schema list. Must be read-only
            // or the model would trip an approval prompt just to ask what exists,
            // and nobody would use the hatch.
            | crate::tools::LIST_AVAILABLE_TOOLS  // tools/mod.rs → execute_list_available_tools
    )
}

/// Decide whether a tool call must be approved by the user before it executes.
///
/// Inverted gate: **deny by default**. Only explicitly verified-safe tools skip
/// approval, so a newly added tool (or any third-party `mcp_*` tool) is gated
/// until someone classifies it here.
pub fn requires_approval(name: &str) -> bool {
    // Agent-internal control plane: `todo_write` only updates the UI checklist
    // (handled inline in llm/mod.rs, never reaches tools::execute_tool) and
    // touches no user data.
    if name == "todo_write" {
        return false;
    }

    // Verified read-only tools.
    if is_read_only_tool(name) {
        return false;
    }

    // Class C — writes ONLY to derived indexes that can be recomputed from the
    // user's `.md` / `.canvas` files at any time. No user-authored content can be
    // lost or silently altered, so gating these would be pure friction:
    //   - extract_facts (graph_ops.rs:798-812): rewrites `fact_history` rows for one
    //     note; re-runnable, and `is_current` bookkeeping is regenerated each time.
    //   - trigger_sync (workspace_ops.rs:871): re-reads `.md` files from disk into
    //     `files`/`chunks`; disk is the source of truth, never written to.
    //   - rebuild_semantic_edges (workspace_ops.rs:925): recomputes the
    //     `semantic_edges` table from existing embeddings.
    if matches!(name, "extract_facts" | "trigger_sync" | "rebuild_semantic_edges") {
        return false;
    }

    // Everything else: known writers, unknown/new internal tools, `mcp_*` tools
    // from third-party servers, and `skill_*` tools. Fail closed.
    true
}

// ══════════════════════════════════════════════════════════════════════
//  Permission modes
// ══════════════════════════════════════════════════════════════════════

/// How much unattended latitude the agent currently has.
///
/// Deliberately three levels — there is **no YOLO / fully-automatic mode**.
/// IDE agents can offer one because the code they touch lives in git and a bad
/// edit is one `git checkout` away. A knowledge vault is different: the notes
/// *are* the product, and the overwhelming majority of vaults are not under
/// version control. So the ceiling here is `Trusted`, and `Critical` risk
/// (deletion) is never auto-allowed at any level — see `decide`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// "Look, don't touch": every non-read-only tool is refused outright, with
    /// no approval prompt at all. Lets the user hand the whole vault to the
    /// agent for research without watching it.
    ReadOnly,
    /// Default. Anything that needs approval prompts, unless a user-authored
    /// allow rule covers it.
    Standard,
    /// Low- and Medium-risk writes run unattended. High and Critical still ask.
    Trusted,
}

impl PermissionMode {
    /// Wire format shared with the frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::ReadOnly => "readOnly",
            PermissionMode::Standard => "standard",
            PermissionMode::Trusted => "trusted",
        }
    }

    /// Parse the wire format. Unknown strings are rejected rather than
    /// silently defaulting, so a typo cannot quietly widen permissions.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "readOnly" => Some(PermissionMode::ReadOnly),
            "standard" => Some(PermissionMode::Standard),
            "trusted" => Some(PermissionMode::Trusted),
            _ => None,
        }
    }
}

// ── Process-global current mode (same OnceLock+Mutex shape as tool_hooks) ──

fn mode_slot() -> &'static std::sync::Mutex<PermissionMode> {
    static SLOT: OnceLock<std::sync::Mutex<PermissionMode>> = OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(PermissionMode::Standard))
}

/// The permission mode in force for this process. Defaults to `Standard`.
pub fn permission_mode() -> PermissionMode {
    mode_slot().lock().map(|g| *g).unwrap_or(PermissionMode::Standard)
}

/// Overwrite the in-memory mode. Persistence (DB) is handled by the
/// `set_permission_mode` Tauri command; this is the raw process-state write,
/// also used by the startup restore path and tests.
pub fn store_permission_mode(mode: PermissionMode) {
    if let Ok(mut g) = mode_slot().lock() {
        *g = mode;
    }
}

/// Restore the persisted mode at startup. Called from `run()` after the schema
/// is set up. A missing/garbage value leaves the default `Standard` in place.
pub fn restore_permission_mode(conn: &Connection) {
    if let Ok(Some(v)) = crate::db::schema::get_setting(conn, PERMISSION_MODE_SETTING_KEY) {
        if let Some(mode) = PermissionMode::parse(&v) {
            store_permission_mode(mode);
        }
    }
}

/// `app_settings` key the mode is persisted under.
const PERMISSION_MODE_SETTING_KEY: &str = "permission_mode";

// ── Ambient DB handle (so the mod.rs decision site can reach approval_rules) ──
//
// The approval decision is taken in `chat_completion_with_tools`, which is only
// handed a `tool_executor` closure — never the DB. Rather than thread an
// `Arc<Mutex<Connection>>` through the whole agent loop signature, we register
// it process-side the same way the vault path is registered in `tool_hooks`.

fn db_slot() -> &'static std::sync::Mutex<Option<Arc<std::sync::Mutex<Connection>>>> {
    static SLOT: OnceLock<std::sync::Mutex<Option<Arc<std::sync::Mutex<Connection>>>>> =
        OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Register the app's DB handle for the active turn so `decide` can consult the
/// `approval_rules` table from the orchestrator loop.
pub fn set_active_db(db: Arc<std::sync::Mutex<Connection>>) {
    if let Ok(mut g) = db_slot().lock() {
        *g = Some(db);
    }
}

/// The DB handle registered for this turn, if any.
pub fn active_db() -> Option<Arc<std::sync::Mutex<Connection>>> {
    db_slot().lock().ok().and_then(|g| g.clone())
}

// ══════════════════════════════════════════════════════════════════════
//  Risk levels
// ══════════════════════════════════════════════════════════════════════

/// What the user stands to lose if this call is wrong.
///
/// Ordered `Low < Medium < High < Critical` (the derived `Ord` follows
/// declaration order), so risk comparisons and rule `max_risk` caps are just
/// `<=`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    /// Adds brand-new content, overwrites nothing.
    Low,
    /// Rewrites one object's content; a pre-write snapshot exists to undo it.
    Medium,
    /// Touches many objects, changes structure, or is hard to eyeball.
    High,
    /// Irreversible / deletes user-authored content.
    Critical,
}

impl RiskLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskLevel::Low => "low",
            RiskLevel::Medium => "medium",
            RiskLevel::High => "high",
            RiskLevel::Critical => "critical",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "low" => Some(RiskLevel::Low),
            "medium" => Some(RiskLevel::Medium),
            "high" => Some(RiskLevel::High),
            "critical" => Some(RiskLevel::Critical),
            _ => None,
        }
    }

    /// Bump one level, saturating at `Critical`.
    fn escalate(self) -> Self {
        match self {
            RiskLevel::Low => RiskLevel::Medium,
            RiskLevel::Medium => RiskLevel::High,
            RiskLevel::High => RiskLevel::Critical,
            RiskLevel::Critical => RiskLevel::Critical,
        }
    }
}

/// Static risk of a tool, judged by "what does the user lose if this is wrong",
/// *not* by "does it write a file".
///
/// Unknown internal tools, all `mcp_*` and `skill_*` tools default to `High`:
/// they come from third-party / unclassified sources and are not trusted to be
/// cheap to undo.
pub fn base_risk_level(tool_name: &str) -> RiskLevel {
    match tool_name {
        // Low — additive, overwrites nothing.
        "create_note" | "create_folder" | "create_canvas" | "append_to_note" => RiskLevel::Low,

        // Medium — rewrites one object; a pre-write snapshot can restore it.
        "edit_note" | "patch_note" | "apply_edit" | "modify_canvas" | "group_canvas_nodes"
        | "arrange_canvas_by" | "add_relation" | "update_memory" | "ocr_image"
        | "extract_pdf_text" | "fetch_web_content" => RiskLevel::Medium,

        // High — many objects / structural / hard to review one-by-one.
        "rename_note" | "move_note" | "merge_notes" | "batch_link_notes" | "delete_relation"
        | "propagate_fact_update" | "fix_broken_link" | "revert_note" => RiskLevel::High,

        // Critical — irreversible / deletes user-authored content.
        "delete_note" | "delete_folder" => RiskLevel::Critical,

        // Third-party / unknown → untrusted → High.
        _ => RiskLevel::High,
    }
}

/// Dynamic risk: `base_risk_level` plus context-driven escalation.
///
/// - Reuses the *exact* hub-note / batch heuristics that drive the approval
///   card text (`tool_hooks::knowledge_write_escalation`) — a hit bumps one
///   level (capped at `Critical`).
/// - A turn that tripped the injection heuristic
///   (`tool_hooks::turn_taint_is_injection`) is forced to at least `High`: a
///   write immediately after ingesting hostile external content is the shape
///   of an indirect prompt injection.
///
/// Deliberately does NOT call an LLM to score risk: locally it is not worth the
/// latency, and it would hand the risk judgement to a model that may already be
/// under injection.
pub fn effective_risk_level(tool_name: &str, args_json: &str) -> RiskLevel {
    let mut level = base_risk_level(tool_name);

    if crate::llm::tool_hooks::knowledge_write_escalation(tool_name, args_json).is_some() {
        level = level.escalate();
    }

    if crate::llm::tool_hooks::turn_taint_is_injection() && level < RiskLevel::High {
        level = RiskLevel::High;
    }

    level
}

// ══════════════════════════════════════════════════════════════════════
//  Allow rules
// ══════════════════════════════════════════════════════════════════════

/// A user-authored "stop asking me about this" rule. Mirrors the
/// `approval_rules` table exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRule {
    pub id: i64,
    /// Specific tool name, or `'*'` for "any tool at/under `max_risk`".
    pub tool_name: String,
    /// Vault-relative path prefix, or `''` for "no path restriction".
    pub path_prefix: String,
    /// Highest risk level this rule waives approval for. Never `critical`.
    pub max_risk: String,
    /// `'session'` (dropped on restart) or `'persistent'`.
    pub scope: String,
    pub created_at_ms: i64,
    /// Human-readable provenance, shown on the settings review page.
    pub note: Option<String>,
}

/// Load every rule, newest first.
pub fn list_approval_rules_db(conn: &Connection) -> rusqlite::Result<Vec<ApprovalRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, tool_name, path_prefix, max_risk, scope, created_at_ms, note
         FROM approval_rules ORDER BY created_at_ms DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ApprovalRule {
            id: r.get(0)?,
            tool_name: r.get(1)?,
            path_prefix: r.get(2)?,
            max_risk: r.get(3)?,
            scope: r.get(4)?,
            created_at_ms: r.get(5)?,
            note: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// Insert a rule, enforcing the hard constraints:
/// - `max_risk` must parse and must **not** be `critical` (deletion is never
///   auto-allowed);
/// - `scope` must be `session` or `persistent`.
pub fn add_approval_rule_db(
    conn: &Connection,
    tool_name: &str,
    path_prefix: &str,
    max_risk: &str,
    scope: &str,
    note: Option<&str>,
) -> Result<i64, String> {
    let parsed = RiskLevel::parse(max_risk)
        .ok_or_else(|| format!("invalid max_risk `{}`", max_risk))?;
    if parsed == RiskLevel::Critical {
        return Err(
            "max_risk='critical' is not allowed: deletion always requires approval".to_string(),
        );
    }
    if scope != "session" && scope != "persistent" {
        return Err(format!("invalid scope `{}` (want 'session' | 'persistent')", scope));
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO approval_rules
            (tool_name, path_prefix, max_risk, scope, created_at_ms, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![tool_name, path_prefix, parsed.as_str(), scope, now_ms, note],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Delete a rule by id.
pub fn delete_approval_rule_db(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM approval_rules WHERE id = ?1", rusqlite::params![id])?;
    Ok(())
}

/// Drop all `session`-scoped rules. Called once at startup so a session grant
/// never survives an app restart.
pub fn cleanup_session_rules(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM approval_rules WHERE scope = 'session'", [])
}

/// Extract the path this call operates on, per-tool, for rule matching.
fn rule_target_path(tool_name: &str, parsed: &serde_json::Value) -> String {
    let get = |k: &str| parsed.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match tool_name {
        "rename_note" => get("old_path"),
        "merge_notes" => get("source_path"),
        "create_canvas" | "modify_canvas" | "group_canvas_nodes" | "arrange_canvas_by" => {
            get("canvas_path")
        }
        "ocr_image" => get("image_path"),
        "extract_pdf_text" => get("pdf_path"),
        "fetch_web_content" => get("url"),
        "fix_broken_link" => get("file_path"),
        "revert_note" => get("note_path"),
        "add_relation" | "delete_relation" => get("source_path"),
        // create_note / edit_note / patch_note / apply_edit / append_to_note /
        // move_note / delete_note / create_folder / delete_folder / update_memory
        _ => get("path"),
    }
}

/// Reduce an absolute-or-relative path to its vault-relative form so it can be
/// compared against a rule's `path_prefix`. Purely a prefix strip — never a
/// byte slice — so multi-byte (e.g. Chinese) segments stay intact.
fn to_vault_relative(path: &str, vault_path: &str) -> String {
    let p = path.replace('\\', "/");
    if vault_path.is_empty() {
        return p.trim_start_matches('/').to_string();
    }
    let v = vault_path.replace('\\', "/");
    let v = v.trim_end_matches('/');
    match p.strip_prefix(v) {
        Some(rest) => rest.trim_start_matches('/').to_string(),
        None => p.trim_start_matches('/').to_string(),
    }
}

/// Does any stored rule waive approval for this call?
///
/// A rule matches when **all** hold:
/// 1. `tool_name` equals the call's tool, or the rule is the wildcard `'*'`;
/// 2. the call's vault-relative target path starts with `path_prefix`
///    (empty prefix = no restriction);
/// 3. this call's `risk` is `<= max_risk`.
///
/// `max_risk` is defensively clamped to `High`: even a row inserted directly
/// into the DB with `max_risk='critical'` can never cover more than `High`, so
/// a `Critical` call is unreachable here regardless (and `decide` already
/// short-circuits `Critical` before ever calling this).
fn matching_rule(
    conn: &Connection,
    tool_name: &str,
    args_json: &str,
    vault_path: &str,
    risk: RiskLevel,
) -> Option<String> {
    let rules = list_approval_rules_db(conn).ok()?;
    let parsed: serde_json::Value =
        serde_json::from_str(args_json).unwrap_or(serde_json::Value::Null);
    let target = rule_target_path(tool_name, &parsed);
    let rel = to_vault_relative(&target, vault_path);

    for rule in rules {
        if rule.tool_name != "*" && rule.tool_name != tool_name {
            continue;
        }
        if !rel.starts_with(&rule.path_prefix) {
            continue;
        }
        let cap = match RiskLevel::parse(&rule.max_risk) {
            Some(r) => r.min(RiskLevel::High),
            None => continue,
        };
        if risk <= cap {
            let where_ = if rule.path_prefix.is_empty() {
                "anywhere".to_string()
            } else {
                format!("under {}", rule.path_prefix)
            };
            return Some(format!("matched rule: {} {}", rule.tool_name, where_));
        }
    }
    None
}

// ══════════════════════════════════════════════════════════════════════
//  Unified decision
// ══════════════════════════════════════════════════════════════════════

/// The three outcomes of the approval policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Run unattended.
    Allow,
    /// Prompt the user with the diff card.
    Ask,
    /// Refuse without prompting; feed the reason back to the model.
    Deny,
}

/// Fold permission mode + risk + allow rules into a single decision.
///
/// Priority order (checked top-down — the first match wins):
/// 1. read-only / `todo_write` / derived-index tools → `Allow`
/// 2. `ReadOnly` mode → `Deny`
/// 3. `Critical` risk → `Ask` (ignores mode AND rules — the hard invariant)
/// 4. a matching allow rule → `Allow`
/// 5. `Trusted` mode and risk `<= Medium` → `Allow`
/// 6. otherwise → `Ask`
///
/// The third return value is a human-readable reason for logs and the UI.
pub fn decide(
    conn: &Connection,
    mode: PermissionMode,
    tool_name: &str,
    args_json: &str,
    vault_path: &str,
) -> (ApprovalDecision, RiskLevel, Option<String>) {
    // 1. Verified read-only / control-plane / derived-index writers never gate.
    if !requires_approval(tool_name) {
        return (
            ApprovalDecision::Allow,
            RiskLevel::Low,
            Some("read-only or exempt tool".to_string()),
        );
    }

    let risk = effective_risk_level(tool_name, args_json);

    // 2. Look-but-don't-touch: refuse every write, no prompt.
    if mode == PermissionMode::ReadOnly {
        return (
            ApprovalDecision::Deny,
            risk,
            Some(
                "read-only mode is active — this tool cannot modify the vault. \
                 Ask the user to switch the permission mode to Standard or Trusted."
                    .to_string(),
            ),
        );
    }

    // 3. Critical is always confirmed, whatever the mode or the rule table says.
    //    This is the hard, test-protected invariant of the whole design.
    if risk == RiskLevel::Critical {
        return (
            ApprovalDecision::Ask,
            risk,
            Some("critical risk (deletion) always requires approval".to_string()),
        );
    }

    // 4. A user allow rule covers it.
    if let Some(reason) = matching_rule(conn, tool_name, args_json, vault_path, risk) {
        return (ApprovalDecision::Allow, risk, Some(reason));
    }

    // 5. Trusted mode auto-runs Low/Medium.
    if mode == PermissionMode::Trusted && risk <= RiskLevel::Medium {
        return (
            ApprovalDecision::Allow,
            risk,
            Some("trusted mode auto-allows low/medium risk".to_string()),
        );
    }

    // 6. Default: ask.
    (ApprovalDecision::Ask, risk, None)
}

/// `decide` for callers that have no DB handle in scope (the agent loop in
/// `llm/mod.rs`): resolves the mode, the vault path and the DB from the
/// process-global slots.
///
/// If the DB handle is unavailable (never registered, or the mutex is
/// poisoned), the rule table is treated as empty — i.e. the gate falls back to
/// asking. Fail closed: a broken DB must never widen permissions.
pub fn decide_ambient(tool_name: &str, args_json: &str) -> (ApprovalDecision, RiskLevel, Option<String>) {
    let mode = permission_mode();
    let vault = crate::llm::tool_hooks::active_vault_path().unwrap_or_default();

    if let Some(db) = active_db() {
        if let Ok(conn) = db.lock() {
            return decide(&conn, mode, tool_name, args_json, &vault);
        }
    }

    // No DB: replicate steps 1/2/3/5/6, skipping rule lookup (step 4).
    if !requires_approval(tool_name) {
        return (
            ApprovalDecision::Allow,
            RiskLevel::Low,
            Some("read-only or exempt tool".to_string()),
        );
    }
    let risk = effective_risk_level(tool_name, args_json);
    if mode == PermissionMode::ReadOnly {
        return (
            ApprovalDecision::Deny,
            risk,
            Some(
                "read-only mode is active — this tool cannot modify the vault. \
                 Ask the user to switch the permission mode to Standard or Trusted."
                    .to_string(),
            ),
        );
    }
    if risk == RiskLevel::Critical {
        return (
            ApprovalDecision::Ask,
            risk,
            Some("critical risk (deletion) always requires approval".to_string()),
        );
    }
    if mode == PermissionMode::Trusted && risk <= RiskLevel::Medium {
        return (
            ApprovalDecision::Allow,
            risk,
            Some("trusted mode auto-allows low/medium risk".to_string()),
        );
    }
    (ApprovalDecision::Ask, risk, None)
}

// ══════════════════════════════════════════════════════════════════════
//  Tauri commands — permission mode + rule management
// ══════════════════════════════════════════════════════════════════════

/// Current permission mode: `"readOnly" | "standard" | "trusted"`.
#[tauri::command]
pub fn get_permission_mode() -> Result<String, ZettelError> {
    Ok(permission_mode().as_str().to_string())
}

/// Switch the permission mode and persist it in `app_settings`.
/// Rejects anything that is not one of the three known modes.
#[tauri::command]
pub fn set_permission_mode(
    state: State<'_, crate::AppState>,
    mode: String,
) -> Result<(), ZettelError> {
    let parsed = PermissionMode::parse(&mode).ok_or_else(|| {
        ZettelError::System(format!(
            "invalid permission mode `{}` (want readOnly | standard | trusted)",
            mode
        ))
    })?;
    store_permission_mode(parsed);
    let conn = state.db.lock()?;
    crate::db::schema::set_setting(&conn, PERMISSION_MODE_SETTING_KEY, parsed.as_str())
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(())
}

/// All allow rules, newest first.
#[tauri::command]
pub fn list_approval_rules(
    state: State<'_, crate::AppState>,
) -> Result<Vec<ApprovalRule>, ZettelError> {
    let conn = state.db.lock()?;
    Ok(list_approval_rules_db(&conn)?)
}

/// Create an allow rule. Returns the new row id.
/// `max_risk='critical'` is rejected — deletion is never auto-allowed.
#[tauri::command]
pub fn add_approval_rule(
    state: State<'_, crate::AppState>,
    tool_name: String,
    path_prefix: String,
    max_risk: String,
    scope: String,
    note: Option<String>,
) -> Result<i64, ZettelError> {
    let conn = state.db.lock()?;
    add_approval_rule_db(
        &conn,
        &tool_name,
        &path_prefix,
        &max_risk,
        &scope,
        note.as_deref(),
    )
    .map_err(ZettelError::System)
}

/// Delete an allow rule by id.
#[tauri::command]
pub fn delete_approval_rule(
    state: State<'_, crate::AppState>,
    id: i64,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    delete_approval_rule_db(&conn, id)?;
    Ok(())
}

/// Approve a pending tool call. Returns true if the approval was found and approved.
#[tauri::command]
pub async fn approve_tool_call(approval_id: String) -> Result<bool, String> {
    let mut pending = pending_approvals().lock().await;
    if let Some(tx) = pending.remove(&approval_id) {
        let _ = tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Reject a pending tool call. Returns true if the approval was found and rejected.
#[tauri::command]
pub async fn reject_tool_call(approval_id: String) -> Result<bool, String> {
    let mut pending = pending_approvals().lock().await;
    if let Some(tx) = pending.remove(&approval_id) {
        let _ = tx.send(false);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Build structured diff data for the approval UI.
/// Returns a JSON string that the frontend decodes for the diff view
/// (see `DiffApprovalCard.tsx` — diff_type drives which renderer is used).
pub fn build_approval_diff_data(tool_name: &str, args: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
    let get = |key: &str| parsed.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();

    let (diff_type, file_path, file_path_alt, title) = match tool_name {
        "create_note" => ("create", get("path"), None, "Create note"),
        "edit_note" => ("edit", get("path"), None, "Rewrite note"),
        "patch_note" => ("patch", get("path"), None, "Patch note"),
        "apply_edit" => ("apply_edit", get("path"), None, "Edit note"),
        "append_to_note" => ("append", get("path"), None, "Append to note"),
        "delete_note" => ("delete", get("path"), None, "Delete note"),
        "rename_note" => ("rename", get("old_path"), Some(get("new_path")), "Rename note"),
        "move_note" => ("move", get("path"), Some(get("destination")), "Move note"),
        "merge_notes" => ("move", get("source_path"), Some(get("target_path")), "Merge notes"),
        "add_relation" => ("other", get("source_path"), Some(get("target_path")), "Add relation"),
        "delete_relation" => ("other", get("source_path"), Some(get("target_path")), "Remove relation"),
        "batch_link_notes" => ("other", String::new(), None, "Batch link notes"),
        "create_canvas" => ("create", get("canvas_path"), None, "Create canvas"),
        "modify_canvas" => ("other", get("canvas_path"), None, "Modify canvas"),
        "group_canvas_nodes" => ("other", get("canvas_path"), None, "Group canvas nodes"),
        "arrange_canvas_by" => ("other", get("canvas_path"), None, "Arrange canvas"),
        // ── Newly gated tools (previously executed with zero approval) ──
        // NOTE: diff_type is picked to match what `DiffApprovalCard.tsx` can actually
        // render from these tools' arguments. Tools without a `content`/`patches`
        // argument use "other" (FallbackView renders the raw args) rather than
        // "create"/"edit", which would show an empty 0-line diff.
        "propagate_fact_update" => ("other", String::new(), None, "Propagate fact to dependent notes"),
        "create_folder" => ("other", get("path"), None, "Create folder"),
        "delete_folder" => ("delete", get("path"), None, "Delete folder"),
        "update_memory" => ("other", ".zettelagent/memory.md".to_string(), None, "Update agent memory"),
        "ocr_image" => ("other", get("image_path"), None, "OCR image into a note"),
        "extract_pdf_text" => ("other", get("pdf_path"), None, "Extract PDF text into a note"),
        "fetch_web_content" => ("other", get("url"), None, "Save web content to vault"),
        "fix_broken_link" => ("other", get("file_path"), None, "Fix broken wikilink"),
        // revert_note carries the full replacement text in `content`.
        "revert_note" => ("edit", get("note_path"), None, "Revert note to earlier version"),
        // External MCP tools are opaque — we cannot infer a file path or diff shape.
        name if name.starts_with("mcp_") => (
            "other",
            String::new(),
            None,
            "External MCP tool",
        ),
        _ => ("other", String::new(), None, "Write operation"),
    };

    // `title` is a &'static str for all fixed arms; MCP needs the tool name inlined.
    let title = if tool_name.starts_with("mcp_") {
        format!("External MCP tool: {}", tool_name)
    } else {
        title.to_string()
    };

    // ── Untrusted-provenance warning ─────────────────────────────────
    // A write request that arrives *after* the agent ingested web / MCP /
    // flagged content is the exact shape of an indirect prompt injection. We
    // cannot tell intent apart automatically, so we surface it on the card the
    // user is already looking at. `title` is rendered verbatim by
    // `DiffApprovalCard.tsx`, so no frontend or schema change is needed.
    let title = match crate::llm::tool_hooks::turn_taint() {
        Some(source) => {
            let source: String = source.chars().take(80).collect();
            if crate::llm::tool_hooks::turn_taint_is_injection() {
                format!("⚠ 本轮检测到疑似注入内容（{}） — {}", source, title)
            } else {
                format!("⚠ 本轮曾读取外部内容（{}） — {}", source, title)
            }
        }
        None => title,
    };

    let diff = ApprovalDiffData {
        tool_name: tool_name.to_string(),
        file_path,
        file_path_alt: file_path_alt.filter(|s| !s.is_empty()),
        diff_type: diff_type.to_string(),
        tool_args_json: args.to_string(),
        title: title.to_string(),
        // Risk is computed here rather than passed in so every producer of an
        // approval card gets the same number as the gate that raised it.
        risk_level: effective_risk_level(tool_name, args).as_str().to_string(),
        risk_reason: risk_escalation_reason(tool_name, args),
    };
    serde_json::to_string(&diff).unwrap_or_default()
}

/// Why `effective_risk_level` sits above `base_risk_level`, if it does.
/// Surfaced on the approval card as `risk_reason`.
fn risk_escalation_reason(tool_name: &str, args: &str) -> Option<String> {
    let mut reasons: Vec<String> = Vec::new();
    if let Some(r) = crate::llm::tool_hooks::knowledge_write_escalation(tool_name, args) {
        reasons.push(r);
    }
    if crate::llm::tool_hooks::turn_taint_is_injection() {
        reasons.push(
            "本轮命中注入检测，风险等级已提升至至少 High".to_string(),
        );
    }
    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join(" · "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unknown / third-party tool names must fail closed.
    #[test]
    fn unknown_and_mcp_tools_require_approval() {
        for name in [
            "mcp_anything",
            "mcp_filesystem_write_file",
            "mcp_",
            "some_future_tool",
            "skill_foo_bar",
            "",
            "DELETE_EVERYTHING",
        ] {
            assert!(
                requires_approval(name),
                "`{}` must require approval (deny-by-default)",
                name
            );
        }
    }

    /// The 17 tools from the original `is_write_tool` blacklist must stay gated.
    #[test]
    fn legacy_write_blacklist_still_requires_approval() {
        for name in [
            "create_note",
            "edit_note",
            "patch_note",
            "apply_edit",
            "append_to_note",
            "delete_note",
            "rename_note",
            "move_note",
            "merge_notes",
            "revert_note",
            "add_relation",
            "delete_relation",
            "batch_link_notes",
            "modify_canvas",
            "create_canvas",
            "group_canvas_nodes",
            "arrange_canvas_by",
        ] {
            assert!(requires_approval(name), "`{}` must require approval", name);
            assert!(!is_read_only_tool(name), "`{}` is not read-only", name);
        }
    }

    /// Write-capable tools that previously executed with zero approval.
    #[test]
    fn newly_gated_write_tools_require_approval() {
        for name in [
            "propagate_fact_update",
            "create_folder",
            "delete_folder",
            "update_memory",
            "ocr_image",
            "extract_pdf_text",
            "fetch_web_content",
            "fix_broken_link",
        ] {
            assert!(requires_approval(name), "`{}` must require approval", name);
        }
    }

    #[test]
    fn read_only_tools_skip_approval() {
        for name in [
            "read_note",
            "search_notes",
            "get_graph",
            "get_backlinks",
            "list_notes",
            "run_lint",
            "query_database",
            "web_search",
            "read_canvas",
            "get_note_history",
        ] {
            assert!(is_read_only_tool(name), "`{}` should be read-only", name);
            assert!(!requires_approval(name), "`{}` should skip approval", name);
        }
    }

    #[test]
    fn todo_write_skips_approval() {
        assert!(!requires_approval("todo_write"));
        // It is control-plane, not a read-only data tool.
        assert!(!is_read_only_tool("todo_write"));
    }

    /// Derived-index writers are exempt but must NOT be in the read-only whitelist.
    #[test]
    fn derived_index_writers_are_exempt_but_not_read_only() {
        for name in ["extract_facts", "trigger_sync", "rebuild_semantic_edges"] {
            assert!(!requires_approval(name), "`{}` is class C (exempt)", name);
            assert!(!is_read_only_tool(name), "`{}` is not read-only", name);
        }
    }

    /// Drift guard: any tool whose own description advertises that it needs
    /// approval must actually be gated by `requires_approval`.
    #[test]
    fn descriptions_claiming_approval_match_implementation() {
        let defs = crate::tools::internal_tools::get_internal_tool_defs();
        let mut checked = 0;
        for def in &defs {
            if def
                .function
                .description
                .to_lowercase()
                .contains("requires user approval")
            {
                checked += 1;
                assert!(
                    requires_approval(&def.function.name),
                    "tool `{}` advertises 'requires user approval' but requires_approval() returned false",
                    def.function.name
                );
            }
        }
        assert!(
            checked > 0,
            "expected at least one tool description mentioning 'requires user approval'"
        );
    }

    /// Every tool the dispatcher knows about must be classified deliberately:
    /// either read-only, an exempt derived-index writer, or approval-gated.
    #[test]
    fn every_internal_tool_is_classified() {
        for def in crate::tools::internal_tools::get_internal_tool_defs() {
            let name = def.function.name;
            let gated = requires_approval(&name);
            let read_only = is_read_only_tool(&name);
            assert!(
                !(gated && read_only),
                "`{}` cannot be both read-only and approval-gated",
                name
            );
        }
    }

    /// Tests that read or write the process-global turn taint must serialize:
    /// `cargo test` runs the crate in one multi-threaded process.
    fn taint_guard() -> std::sync::MutexGuard<'static, ()> {
        let lock = crate::llm::tool_hooks::taint_test_lock();
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        crate::llm::tool_hooks::clear_turn_taint();
        guard
    }

    #[test]
    fn diff_data_titles_are_meaningful_for_gated_tools() {
        let _g = taint_guard();
        // Newly gated tools must not fall through to the generic label.
        for name in [
            "propagate_fact_update",
            "create_folder",
            "delete_folder",
            "update_memory",
            "ocr_image",
            "extract_pdf_text",
            "fetch_web_content",
            "fix_broken_link",
            "revert_note",
        ] {
            let json = build_approval_diff_data(name, "{}");
            let parsed: ApprovalDiffData = serde_json::from_str(&json).unwrap();
            assert_ne!(parsed.title, "Write operation", "`{}` needs a title", name);
            assert!(
                matches!(
                    parsed.diff_type.as_str(),
                    "create" | "edit" | "patch" | "apply_edit" | "append" | "delete" | "rename"
                        | "move" | "other"
                ),
                "`{}` produced unsupported diff_type `{}`",
                name,
                parsed.diff_type
            );
        }
    }

    #[test]
    fn mcp_diff_data_uses_generic_external_title() {
        let _g = taint_guard();
        let json = build_approval_diff_data("mcp_fs_write_file", r#"{"path":"/tmp/x"}"#);
        let parsed: ApprovalDiffData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.title, "External MCP tool: mcp_fs_write_file");
        assert_eq!(parsed.diff_type, "other");
    }

    /// (4) Turn taint must be visible on the approval card without any frontend
    /// change — the warning rides on the existing `title` field.
    #[test]
    fn tainted_turn_prefixes_the_approval_title() {
        let _g = taint_guard();

        let clean = build_approval_diff_data("edit_note", r#"{"path":"a.md"}"#);
        let clean: ApprovalDiffData = serde_json::from_str(&clean).unwrap();
        assert_eq!(clean.title, "Rewrite note", "untainted turn must not be decorated");

        crate::llm::tool_hooks::mark_turn_tainted("web:https://evil.example/post");
        let tainted = build_approval_diff_data("edit_note", r#"{"path":"a.md"}"#);
        let tainted: ApprovalDiffData = serde_json::from_str(&tainted).unwrap();
        assert!(tainted.title.starts_with("⚠ 本轮曾读取外部内容"), "got `{}`", tainted.title);
        assert!(tainted.title.ends_with("Rewrite note"), "original title must survive");

        // Injection-level taint outranks the plain external read.
        crate::llm::tool_hooks::mark_turn_tainted("injection:ignore_previous_zh via read_note");
        let hostile = build_approval_diff_data("update_memory", "{}");
        let hostile: ApprovalDiffData = serde_json::from_str(&hostile).unwrap();
        assert!(hostile.title.starts_with("⚠ 本轮检测到疑似注入内容"), "got `{}`", hostile.title);
        assert!(hostile.title.ends_with("Update agent memory"));

        crate::llm::tool_hooks::clear_turn_taint();
        let after = build_approval_diff_data("edit_note", r#"{"path":"a.md"}"#);
        let after: ApprovalDiffData = serde_json::from_str(&after).unwrap();
        assert_eq!(after.title, "Rewrite note");
    }

    // ══════════════════════════════════════════════════════════════════
    //  Permission tiers / risk ladder / allow rules
    // ══════════════════════════════════════════════════════════════════

    /// `setup_database_schema` creates vec0 virtual tables, so the extension has
    /// to be registered before the connection is opened (repo convention).
    fn mem_db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn base_risk_level_samples_per_tier() {
        for name in ["create_note", "append_to_note"] {
            assert_eq!(base_risk_level(name), RiskLevel::Low, "{}", name);
        }
        for name in ["edit_note", "modify_canvas"] {
            assert_eq!(base_risk_level(name), RiskLevel::Medium, "{}", name);
        }
        for name in ["rename_note", "merge_notes"] {
            assert_eq!(base_risk_level(name), RiskLevel::High, "{}", name);
        }
        for name in ["delete_note", "delete_folder"] {
            assert_eq!(base_risk_level(name), RiskLevel::Critical, "{}", name);
        }
        // Third-party / unclassified tools are untrusted by default.
        for name in ["mcp_foo", "skill_whatever", "some_future_tool", ""] {
            assert_eq!(base_risk_level(name), RiskLevel::High, "{}", name);
        }
    }

    #[test]
    fn risk_ladder_is_ordered() {
        assert!(RiskLevel::Low < RiskLevel::Medium);
        assert!(RiskLevel::Medium < RiskLevel::High);
        assert!(RiskLevel::High < RiskLevel::Critical);
    }

    #[test]
    fn effective_risk_escalates_on_hub_and_batch() {
        let _g = taint_guard();
        // `rename_note` is already High and the hook always flags it → Critical.
        assert_eq!(
            effective_risk_level("rename_note", r#"{"old_path":"a.md","new_path":"b.md"}"#),
            RiskLevel::Critical
        );
        // Batch under the hook's threshold stays at its base level.
        assert_eq!(
            effective_risk_level("batch_link_notes", r#"{"links":[{"a":1}]}"#),
            RiskLevel::High
        );
        // A hub-looking delete is already Critical and cannot go higher.
        assert_eq!(
            effective_risk_level("delete_note", r#"{"path":"MOC/index.md"}"#),
            RiskLevel::Critical
        );
    }

    #[test]
    fn injection_taint_forces_at_least_high() {
        let _g = taint_guard();
        // Baseline without taint.
        assert_eq!(effective_risk_level("create_note", r#"{"path":"a.md"}"#), RiskLevel::Low);
        assert_eq!(effective_risk_level("edit_note", r#"{"path":"a.md"}"#), RiskLevel::Medium);

        crate::llm::tool_hooks::mark_turn_tainted("injection:ignore_previous_zh via read_note");
        assert_eq!(
            effective_risk_level("create_note", r#"{"path":"a.md"}"#),
            RiskLevel::High,
            "Low must jump straight to High on an injection-tainted turn"
        );
        assert_eq!(effective_risk_level("edit_note", r#"{"path":"a.md"}"#), RiskLevel::High);
        // Already-Critical work is not pushed past Critical.
        assert_eq!(
            effective_risk_level("delete_note", r#"{"path":"a.md"}"#),
            RiskLevel::Critical
        );

        // A merely-external read is not an injection hit → no forced upgrade.
        crate::llm::tool_hooks::clear_turn_taint();
        crate::llm::tool_hooks::mark_turn_tainted("web:https://example.com");
        assert_eq!(effective_risk_level("create_note", r#"{"path":"a.md"}"#), RiskLevel::Low);
    }

    // ── decide(): the six priority rungs ─────────────────────────────

    /// (1) Read-only / exempt tools short-circuit to Allow in every mode.
    #[test]
    fn decide_priority_1_read_only_allows_in_every_mode() {
        let _g = taint_guard();
        let db = mem_db();
        for mode in [PermissionMode::ReadOnly, PermissionMode::Standard, PermissionMode::Trusted] {
            for tool in ["read_note", "search_notes", "todo_write", "trigger_sync"] {
                let (d, _, _) = decide(&db, mode, tool, "{}", "");
                assert_eq!(d, ApprovalDecision::Allow, "{} in {:?}", tool, mode);
            }
        }
    }

    /// (2) ReadOnly mode denies writes outright — and never prompts.
    #[test]
    fn decide_priority_2_read_only_mode_denies_writes() {
        let _g = taint_guard();
        let db = mem_db();
        let (d, risk, reason) = decide(
            &db,
            PermissionMode::ReadOnly,
            "edit_note",
            r#"{"path":"a.md"}"#,
            "",
        );
        assert_eq!(d, ApprovalDecision::Deny);
        assert_eq!(risk, RiskLevel::Medium);
        assert!(reason.unwrap().contains("read-only mode"));

        // Reads still work in the same mode — that is the entire point of the tier.
        let (d, _, _) = decide(&db, PermissionMode::ReadOnly, "read_note", r#"{"path":"a.md"}"#, "");
        assert_eq!(d, ApprovalDecision::Allow);
    }

    /// (3) Critical risk always asks — the hard invariant.
    #[test]
    fn decide_priority_3_trusted_mode_still_asks_for_delete() {
        let _g = taint_guard();
        let db = mem_db();
        let (d, risk, _) = decide(
            &db,
            PermissionMode::Trusted,
            "delete_note",
            r#"{"path":"a.md"}"#,
            "",
        );
        assert_eq!(d, ApprovalDecision::Ask, "Trusted must NOT auto-delete notes");
        assert_eq!(risk, RiskLevel::Critical);
    }

    /// (3, hardened) Even a hand-inserted `max_risk='critical'` row cannot make
    /// a deletion auto-run: `decide` short-circuits Critical before rules.
    #[test]
    fn decide_critical_rule_row_cannot_allow_delete() {
        let _g = taint_guard();
        let db = mem_db();
        // Bypass `add_approval_rule_db`'s validation on purpose.
        db.execute(
            "INSERT INTO approval_rules (tool_name, path_prefix, max_risk, scope, created_at_ms, note)
             VALUES ('*', '', 'critical', 'persistent', 1, 'hand-inserted')",
            [],
        )
        .unwrap();
        for mode in [PermissionMode::Standard, PermissionMode::Trusted] {
            for tool in ["delete_note", "delete_folder"] {
                let (d, risk, _) = decide(&db, mode, tool, r#"{"path":"a.md"}"#, "");
                assert_eq!(d, ApprovalDecision::Ask, "{} in {:?}", tool, mode);
                assert_eq!(risk, RiskLevel::Critical);
            }
        }
    }

    /// (4) A matching rule allows without prompting, even in Standard mode.
    #[test]
    fn decide_priority_4_matching_rule_allows() {
        let _g = taint_guard();
        let db = mem_db();
        add_approval_rule_db(&db, "append_to_note", "journal/", "low", "session", None).unwrap();
        let (d, _, reason) = decide(
            &db,
            PermissionMode::Standard,
            "append_to_note",
            r#"{"path":"journal/2026-08-17.md"}"#,
            "",
        );
        assert_eq!(d, ApprovalDecision::Allow);
        let reason = reason.unwrap();
        assert!(reason.starts_with("matched rule:"), "got `{}`", reason);
        assert!(reason.contains("journal/"), "got `{}`", reason);
    }

    /// (5) Trusted auto-allows Low/Medium, still asks for High.
    #[test]
    fn decide_priority_5_trusted_allows_up_to_medium() {
        let _g = taint_guard();
        let db = mem_db();
        for tool in ["create_note", "edit_note"] {
            let (d, _, _) = decide(&db, PermissionMode::Trusted, tool, r#"{"path":"a.md"}"#, "");
            assert_eq!(d, ApprovalDecision::Allow, "{}", tool);
        }
        // High risk is above the Trusted ceiling.
        let (d, risk, _) = decide(
            &db,
            PermissionMode::Trusted,
            "propagate_fact_update",
            "{}",
            "",
        );
        assert_eq!(d, ApprovalDecision::Ask);
        assert_eq!(risk, RiskLevel::High);
    }

    /// (6) Default: Standard mode with no rule asks.
    #[test]
    fn decide_priority_6_standard_asks_by_default() {
        let _g = taint_guard();
        let db = mem_db();
        let (d, risk, reason) = decide(
            &db,
            PermissionMode::Standard,
            "edit_note",
            r#"{"path":"a.md"}"#,
            "",
        );
        assert_eq!(d, ApprovalDecision::Ask);
        assert_eq!(risk, RiskLevel::Medium);
        assert!(reason.is_none());
    }

    // ── Rule storage + matching ──────────────────────────────────────

    #[test]
    fn add_approval_rule_rejects_critical_max_risk() {
        let db = mem_db();
        let err = add_approval_rule_db(&db, "delete_note", "", "critical", "persistent", None)
            .expect_err("critical must be rejected");
        assert!(err.contains("critical"), "got `{}`", err);
        // Nothing was written.
        assert!(list_approval_rules_db(&db).unwrap().is_empty());

        // Bad risk string and bad scope are rejected too.
        assert!(add_approval_rule_db(&db, "edit_note", "", "nope", "session", None).is_err());
        assert!(add_approval_rule_db(&db, "edit_note", "", "low", "forever", None).is_err());
    }

    #[test]
    fn rule_path_prefix_hit_and_miss() {
        let _g = taint_guard();
        let db = mem_db();
        add_approval_rule_db(&db, "edit_note", "projects/", "medium", "persistent", None).unwrap();

        let (hit, _, _) = decide(
            &db,
            PermissionMode::Standard,
            "edit_note",
            r#"{"path":"projects/alpha.md"}"#,
            "",
        );
        assert_eq!(hit, ApprovalDecision::Allow, "prefix hit must skip approval");

        let (miss, _, _) = decide(
            &db,
            PermissionMode::Standard,
            "edit_note",
            r#"{"path":"inbox/alpha.md"}"#,
            "",
        );
        assert_eq!(miss, ApprovalDecision::Ask, "prefix miss must still ask");

        // Same prefix but a risk above the rule's cap → no waiver.
        let (over, risk, _) = decide(
            &db,
            PermissionMode::Standard,
            "move_note",
            r#"{"path":"projects/alpha.md","destination":"archive/"}"#,
            "",
        );
        assert_eq!(risk, RiskLevel::High);
        assert_eq!(over, ApprovalDecision::Ask);
    }

    #[test]
    fn wildcard_rule_matches_any_tool_within_cap() {
        let _g = taint_guard();
        let db = mem_db();
        add_approval_rule_db(&db, "*", "", "medium", "session", Some("blanket low/medium"))
            .unwrap();
        for tool in ["create_note", "edit_note", "modify_canvas"] {
            let (d, _, reason) = decide(
                &db,
                PermissionMode::Standard,
                tool,
                r#"{"path":"a.md","canvas_path":"a.canvas"}"#,
                "",
            );
            assert_eq!(d, ApprovalDecision::Allow, "{}", tool);
            assert!(reason.unwrap().contains('*'));
        }
        // Above the cap the wildcard does not apply.
        let (d, _, _) = decide(&db, PermissionMode::Standard, "merge_notes", "{}", "");
        assert_eq!(d, ApprovalDecision::Ask);
    }

    #[test]
    fn chinese_path_prefix_matches() {
        let _g = taint_guard();
        let db = mem_db();
        add_approval_rule_db(&db, "append_to_note", "日记/", "low", "persistent", None).unwrap();

        let (hit, _, reason) = decide(
            &db,
            PermissionMode::Standard,
            "append_to_note",
            r#"{"path":"日记/2026-08-17.md"}"#,
            "",
        );
        assert_eq!(hit, ApprovalDecision::Allow);
        assert!(reason.unwrap().contains("日记/"));

        // Absolute path under a vault whose own path contains Chinese.
        let (abs, _, _) = decide(
            &db,
            PermissionMode::Standard,
            "append_to_note",
            r#"{"path":"D:\\我的笔记库\\日记\\2026-08-17.md"}"#,
            "D:\\我的笔记库",
        );
        assert_eq!(abs, ApprovalDecision::Allow, "vault prefix must be stripped");

        let (miss, _, _) = decide(
            &db,
            PermissionMode::Standard,
            "append_to_note",
            r#"{"path":"周报/2026-W33.md"}"#,
            "",
        );
        assert_eq!(miss, ApprovalDecision::Ask);
    }

    #[test]
    fn session_rules_die_on_restart_persistent_survive() {
        let db = mem_db();
        add_approval_rule_db(&db, "edit_note", "", "medium", "session", None).unwrap();
        add_approval_rule_db(&db, "create_note", "", "low", "persistent", None).unwrap();
        assert_eq!(list_approval_rules_db(&db).unwrap().len(), 2);

        let removed = cleanup_session_rules(&db).unwrap();
        assert_eq!(removed, 1);
        let left = list_approval_rules_db(&db).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].tool_name, "create_note");
        assert_eq!(left[0].scope, "persistent");
    }

    #[test]
    fn delete_rule_removes_the_row() {
        let db = mem_db();
        let id = add_approval_rule_db(&db, "edit_note", "", "medium", "session", None).unwrap();
        delete_approval_rule_db(&db, id).unwrap();
        assert!(list_approval_rules_db(&db).unwrap().is_empty());
    }

    // ── Invariant regression ─────────────────────────────────────────

    /// The one non-negotiable property: nothing — no mode, no rule, no taint
    /// state — may turn a Critical tool into an unattended Allow.
    #[test]
    fn critical_tools_are_never_auto_allowed() {
        let _g = taint_guard();
        let db = mem_db();
        // Every rule shape a user (or a bug) could produce, including the
        // illegal `critical` cap inserted directly.
        for (tool, prefix, risk) in [
            ("*", "", "high"),
            ("delete_note", "", "high"),
            ("delete_folder", "", "high"),
            ("*", "", "critical"),
            ("delete_note", "日记/", "critical"),
        ] {
            db.execute(
                "INSERT INTO approval_rules (tool_name, path_prefix, max_risk, scope, created_at_ms, note)
                 VALUES (?1, ?2, ?3, 'persistent', 1, 'invariant test')",
                rusqlite::params![tool, prefix, risk],
            )
            .unwrap();
        }
        let args = [
            r#"{"path":"日记/a.md"}"#,
            r#"{"path":"MOC/index.md"}"#,
            "{}",
        ];
        for mode in [PermissionMode::ReadOnly, PermissionMode::Standard, PermissionMode::Trusted] {
            for tool in ["delete_note", "delete_folder"] {
                for a in args {
                    let (d, risk, _) = decide(&db, mode, tool, a, "");
                    assert_ne!(
                        d,
                        ApprovalDecision::Allow,
                        "{} in {:?} with args {} must never be auto-allowed",
                        tool,
                        mode,
                        a
                    );
                    assert_eq!(risk, RiskLevel::Critical);
                }
            }
        }
    }

    /// Every tool classified `Critical` must also be approval-gated by the
    /// underlying binary gate — the two layers must not disagree.
    #[test]
    fn critical_tools_are_also_gated_by_requires_approval() {
        for def in crate::tools::internal_tools::get_internal_tool_defs() {
            if base_risk_level(&def.function.name) == RiskLevel::Critical {
                assert!(
                    requires_approval(&def.function.name),
                    "`{}` is Critical but requires_approval() said false",
                    def.function.name
                );
            }
        }
    }

    #[test]
    fn permission_mode_wire_format_roundtrips() {
        for mode in [PermissionMode::ReadOnly, PermissionMode::Standard, PermissionMode::Trusted] {
            assert_eq!(PermissionMode::parse(mode.as_str()), Some(mode));
        }
        assert!(PermissionMode::parse("yolo").is_none());
        assert!(PermissionMode::parse("").is_none());
        for risk in [RiskLevel::Low, RiskLevel::Medium, RiskLevel::High, RiskLevel::Critical] {
            assert_eq!(RiskLevel::parse(risk.as_str()), Some(risk));
        }
        assert!(RiskLevel::parse("catastrophic").is_none());
    }

    /// The approval card must carry the same risk level the gate computed.
    #[test]
    fn diff_data_carries_risk_level() {
        let _g = taint_guard();
        let json = build_approval_diff_data("delete_note", r#"{"path":"a.md"}"#);
        let parsed: ApprovalDiffData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.risk_level, "critical");
        assert!(parsed.risk_reason.is_none());

        let json = build_approval_diff_data("create_note", r#"{"path":"a.md"}"#);
        let parsed: ApprovalDiffData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.risk_level, "low");

        // Hub-note escalation surfaces both the level and the reason.
        let json = build_approval_diff_data("rename_note", r#"{"old_path":"a.md"}"#);
        let parsed: ApprovalDiffData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.risk_level, "critical");
        assert!(parsed.risk_reason.unwrap().contains("Renaming"));
    }

}
