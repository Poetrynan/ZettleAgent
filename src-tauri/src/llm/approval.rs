/**
 * Agent Approval Gate — human-in-the-loop approval for write tools.
 *
 * Write tools require user approval before execution.
 * The frontend shows a diff preview; the user clicks approve or reject.
 */
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
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

/// Check if a tool name is a write tool that requires approval.
/// Must stay in sync with the actual tool defs in `tools::internal_tools`.
pub fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        // Note file writes
        "create_note"
            | "edit_note"
            | "patch_note"
            | "apply_edit"
            | "append_to_note"
            | "delete_note"
            | "rename_note"
            | "move_note"
            | "merge_notes"
            | "revert_note"
            // Knowledge-graph writes
            | "add_relation"
            | "delete_relation"
            | "batch_link_notes"
            // Canvas writes
            | "modify_canvas"
            | "create_canvas"
            | "group_canvas_nodes"
            | "arrange_canvas_by"
    )
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
        _ => ("other", String::new(), None, "Write operation"),
    };

    let diff = ApprovalDiffData {
        tool_name: tool_name.to_string(),
        file_path,
        file_path_alt: file_path_alt.filter(|s| !s.is_empty()),
        diff_type: diff_type.to_string(),
        tool_args_json: args.to_string(),
        title: title.to_string(),
    };
    serde_json::to_string(&diff).unwrap_or_default()
}
