use tauri::State;
use crate::AppState;
use crate::error::ZettelError;
use crate::knowledge::workflows::{
    WorkflowConfig, WorkflowEngine, WorkflowRunRecord, WorkflowRunResult,
};

#[tauri::command]
pub fn get_workflow_configs(state: State<'_, AppState>) -> Result<Vec<WorkflowConfig>, ZettelError> {
    let conn = state.db.lock()?;
    let engine = WorkflowEngine::new();
    let configs = engine
        .storage()
        .load_configs(&conn)
        .map_err(|e| ZettelError::System(format!("Failed to load workflow configs: {}", e)))?;
    Ok(configs)
}

#[tauri::command]
pub fn update_workflow_config(
    state: State<'_, AppState>,
    config: WorkflowConfig,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    let engine = WorkflowEngine::new();
    engine
        .storage()
        .save_config(&conn, &config)
        .map_err(|e| ZettelError::System(format!("Failed to update workflow config: {}", e)))?;
    Ok(())
}

#[tauri::command]
pub async fn run_workflow_now(
    state: State<'_, AppState>,
    workflow_id: String,
    dry_run: bool,
    vault_path: Option<String>,
) -> Result<WorkflowRunResult, ZettelError> {
    // 获取当前活动 vault 路径
    let resolved_vault = vault_path.unwrap_or_else(|| {
        let conn = state.db.lock().ok();
        conn.and_then(|c| {
            c.query_row(
                "SELECT value FROM app_settings WHERE key = 'current_vault_path'",
                [],
                |row| row.get::<_, String>(0),
            ).ok()
        }).unwrap_or_else(|| ".".to_string())
    });

    let conn = state.db.lock()?;
    let engine = WorkflowEngine::new();
    let result = engine
        .execute_workflow(&conn, &resolved_vault, &workflow_id, dry_run, None)
        .map_err(|e| ZettelError::System(format!("Workflow execution failed: {}", e)))?;

    Ok(result)
}

#[tauri::command]
pub fn get_workflow_history(
    state: State<'_, AppState>,
    workflow_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkflowRunRecord>, ZettelError> {
    let conn = state.db.lock()?;
    let engine = WorkflowEngine::new();
    let history = engine
        .storage()
        .get_run_history(&conn, workflow_id.as_deref(), limit.unwrap_or(20))
        .map_err(|e| ZettelError::System(format!("Failed to get workflow history: {}", e)))?;
    Ok(history)
}
