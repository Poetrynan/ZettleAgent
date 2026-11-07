use crate::AppState;
use crate::error::ZettelError;
use tauri::State;

#[tauri::command]
pub async fn get_note_facts(
    state: State<'_, AppState>,
    note_path: String,
    include_history: bool,
) -> Result<Vec<crate::temporal::TemporalFact>, ZettelError> {
    state.read(|conn| {
        Ok(if include_history {
            crate::temporal::get_fact_history(conn, &note_path)?
        } else {
            crate::temporal::get_active_facts(conn, &note_path)?
        })
    })
}

#[tauri::command]
pub async fn get_note_timeline(
    state: State<'_, AppState>,
    note_path: String,
) -> Result<Vec<crate::temporal::TimelineEvent>, ZettelError> {
    state.read(|conn| Ok(crate::temporal::get_timeline(conn, &note_path)?))
}

#[tauri::command]
pub async fn get_global_timeline(
    state: State<'_, AppState>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<crate::temporal::TimelineEvent>, ZettelError> {
    let start = start_date.unwrap_or_else(|| "1970-01-01".to_string());
    let end = end_date.unwrap_or_else(|| "2099-12-31".to_string());
    state.read(|conn| Ok(crate::temporal::get_timeline_range(conn, &start, &end)?))
}
