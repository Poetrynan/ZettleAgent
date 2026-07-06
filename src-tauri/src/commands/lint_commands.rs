use crate::AppState;
use crate::error::ZettelError;
use tauri::State;

#[tauri::command]
pub async fn run_vault_lint(
    state: State<'_, AppState>,
) -> Result<crate::lint::LintReport, ZettelError> {
    let conn = state.db.lock()?;
    let report = crate::lint::run_vault_lint(&conn)?;
    Ok(report)
}

#[tauri::command]
pub async fn fix_broken_link(
    file_path: String,
    target_title: String,
    line_number: usize,
    action: String,
    replacement: Option<String>,
) -> Result<(), ZettelError> {
    crate::lint::fix_broken_link_in_file(
        &file_path,
        &target_title,
        line_number,
        &action,
        replacement.as_deref(),
    )?;
    Ok(())
}

/// Create a stub note for a broken wikilink target.
/// After creation, syncs the vault so the new file appears in the DB and graph.
#[tauri::command]
pub async fn create_note_for_link(
    state: State<'_, AppState>,
    title: String,
) -> Result<String, ZettelError> {
    let conn = state.db.lock()?;
    let created_path = crate::lint::create_note_stub(&conn, &title)?;

    // Sync the newly created file so it appears in the DB immediately
    let _ = crate::db::sync::sync_file(&conn, std::path::Path::new(&created_path));

    Ok(created_path)
}
