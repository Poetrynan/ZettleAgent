//! The UI and Agent use the same source/research implementations.
use serde_json::Value;
use tauri::State;
use crate::{AppState, error::ZettelError, knowledge::sources};

#[tauri::command]
pub async fn research_read_source(vault_path: String, request: Value) -> Result<Value, ZettelError> {
    tauri::async_runtime::spawn_blocking(move || sources::read_source_range(&request, &vault_path, &[vault_path.clone()]))
        .await.map_err(|e| ZettelError::System(e.to_string()))?.map_err(Into::into)
}

#[tauri::command]
pub async fn research_verify_quote(vault_path: String, request: Value) -> Result<Value, ZettelError> {
    tauri::async_runtime::spawn_blocking(move || sources::verify_quote(&request, &vault_path, &[vault_path.clone()]))
        .await.map_err(|e| ZettelError::System(e.to_string()))?.map_err(Into::into)
}

#[tauri::command]
pub async fn research_capture_source(state: State<'_, AppState>, vault_path: String, request: Value) -> Result<Value, ZettelError> {
    sources::capture_source(&request, &state.db, &vault_path, &[vault_path.clone()]).await.map_err(Into::into)
}

#[tauri::command]
pub async fn research_action(
    state: State<'_, AppState>,
    vault_path: String,
    action: String,
    args: Value,
) -> Result<Value, ZettelError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ZettelError::System(e.to_string()))?;
        crate::knowledge::research::execute(&conn, &vault_path, &action, &args)
            .map_err(|e| ZettelError::System(e.to_string()))
    })
    .await
    .map_err(|e| ZettelError::System(e.to_string()))?
}
