use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{State, Emitter};
use rusqlite::Connection;
use crate::AppState;
use crate::error::ZettelError;
use crate::db::sync;
use crate::llm::LlmConfig;
use crate::scheduler::{self, SchedulerConfig, SchedulerStatus};
use crate::pipeline_log;
use super::{SyncResult, StartSchedulerRequest, RunSchedulerNowRequest};

fn batch_in_progress(state: &AppState) -> Result<(), ZettelError> {
    let guard = state.scheduler.batch_continue.lock()?;
    if guard.is_some() {
        return Err(ZettelError::System(
            "An organize run is already in progress. Wait for it to finish or stop it first.".to_string(),
        ));
    }
    Ok(())
}

fn end_batch(state: &AppState) {
    if let Ok(mut guard) = state.scheduler.batch_continue.lock() {
        *guard = None;
    }
}

fn begin_batch(state: &AppState) -> Result<Arc<AtomicBool>, ZettelError> {
    let mut guard = state.scheduler.batch_continue.lock()?;
    if guard.is_some() {
        return Err(ZettelError::System(
            "An organize run is already in progress. Wait for it to finish or stop it first.".to_string(),
        ));
    }
    let flag = Arc::new(AtomicBool::new(true));
    *guard = Some(flag.clone());
    Ok(flag)
}

fn cancel_current_batch(state: &AppState) {
    if let Ok(guard) = state.scheduler.batch_continue.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(false, Ordering::SeqCst);
        }
    }
}

fn walk_and_sync_vault(
    dir: &Path,
    conn: &Connection,
    files_updated: &mut usize,
    total_files: &mut usize,
) -> Result<(), ZettelError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" || name == "build" {
                    continue;
                }
            }
            walk_and_sync_vault(&path, conn, files_updated, total_files)?;
        } else if path.extension().is_some_and(|ext| ext == "md") {
            *total_files += 1;
            if sync::sync_file(conn, &path)? {
                *files_updated += 1;
            }
        }
    }
    Ok(())
}

/// Sync vault markdown files into the DB (no watcher setup — used between hourly batches).
fn sync_vault_db(db: &Arc<Mutex<Connection>>, vault_path: &str) -> Result<(), ZettelError> {
    let vault = PathBuf::from(vault_path);
    if !vault.exists() {
        return Err(ZettelError::System(format!("Vault path does not exist: {}", vault_path)));
    }

    let mut conn = db.lock()?;
    let mut files_updated = 0;
    let mut total_files = 0;
    let tx = conn.transaction()?;
    walk_and_sync_vault(&vault, &tx, &mut files_updated, &mut total_files)?;
    let _ = sync::remove_deleted_files(&tx, vault_path)?;
    tx.commit()?;
    log::info!(
        "Pre-batch vault sync for {}: {} files, {} updated",
        vault_path,
        total_files,
        files_updated
    );
    Ok(())
}

#[tauri::command]
pub fn sync_vault(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    vault_path: String
) -> Result<SyncResult, ZettelError> {
    let mut conn = state.db.lock()?;
    let vault = PathBuf::from(&vault_path);

    if !vault.exists() {
        return Err(ZettelError::System(format!("Vault path does not exist: {}", vault_path)));
    }

    // Manage background watcher — one per vault (multi-vault support)
    {
        let mut watcher_guard = state.watcher.lock()?;
        let needs_start = !watcher_guard.contains_key(&vault_path);

        if needs_start {
            log::info!("Starting file watcher for vault path: {}", vault_path);

            match crate::watcher::create_watcher(&vault) {
                Ok((debouncer, rx)) => {
                    let db_clone = state.db.clone();
                    let app_clone = app_handle.clone();
                    std::thread::spawn(move || {
                        while let Ok(events) = rx.recv() {
                            println!("[WATCHER] Received events: {:?}", events);
                            if let Ok(mut conn) = db_clone.lock() {
                                if let Ok(tx) = conn.transaction() {
                                    let mut updated_files = Vec::new();
                                    let mut deleted_files = Vec::new();
                                    for event in events {
                                        match event {
                                            crate::watcher::WatcherEvent::FileChanged(path) => {
                                                println!("[WATCHER] FileChanged path: {:?}", path);
                                                match crate::db::sync::sync_file(&tx, &path) {
                                                    Ok(true) => {
                                                        println!("[WATCHER] sync_file updated DB for {:?}", path);
                                                        updated_files.push(path.to_string_lossy().to_string());
                                                    }
                                                    Ok(false) => {
                                                        println!("[WATCHER] sync_file skipped (no change/already up-to-date) for {:?}", path);
                                                    }
                                                    Err(e) => {
                                                        log::error!("Failed to sync file on watch event {:?}: {}", path, e);
                                                    }
                                                }
                                            }
                                            crate::watcher::WatcherEvent::FileDeleted(path) => {
                                                println!("[WATCHER] FileDeleted path: {:?}", path);
                                                let path_str = path.to_string_lossy().to_string();
                                                if let Err(e) = tx.execute("DELETE FROM files WHERE path = ?1", rusqlite::params![path_str]) {
                                                    log::error!("Failed to delete file from DB on watch event {}: {}", path_str, e);
                                                } else {
                                                    deleted_files.push(path_str);
                                                }
                                            }
                                        }
                                    }
                                    if let Err(e) = tx.commit() {
                                        log::error!("Failed to commit watcher transaction: {}", e);
                                    } else {
                                        println!("[WATCHER] Transaction committed. Emitting events. Updated: {:?}, Deleted: {:?}", updated_files, deleted_files);
                                        if !updated_files.is_empty() {
                                            let _ = app_clone.emit("file-watcher-synced", updated_files.clone());
                                        }
                                        if !deleted_files.is_empty() {
                                            let _ = app_clone.emit("file-watcher-deleted", deleted_files.clone());
                                        }
                                    }
                                }
                            }
                        }
                    });
                    watcher_guard.insert(vault_path.clone(), debouncer);
                }
                Err(e) => {
                    log::error!("Failed to create file watcher: {}", e);
                }
            }
        }
    }

    let mut files_updated = 0;
    let mut total_files = 0;

    let tx = conn.transaction()?;

    walk_and_sync_vault(&vault, &tx, &mut files_updated, &mut total_files)?;

    // Remove records for deleted files
    let files_removed = sync::remove_deleted_files(&tx, &vault_path)?;

    tx.commit()?;

    Ok(SyncResult {
        files_updated,
        files_removed,
        total_files,
    })
}

#[tauri::command]
pub async fn start_scheduler(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: StartSchedulerRequest,
) -> Result<String, ZettelError> {
    if state.scheduler.running.load(Ordering::SeqCst) {
        return Ok("Scheduler is already running".to_string());
    }

    batch_in_progress(&state)?;

    // Validate LLM configuration — refuse to start without explicit config
    let api_url = request.api_url.unwrap_or_default();
    let model = request.model.unwrap_or_default();
    if api_url.trim().is_empty() || model.trim().is_empty() {
        return Err(ZettelError::System(
            "LLM API is not configured. Please set up your API endpoint and model in Settings → Model Configuration.".to_string()
        ));
    }

    let llm_config = LlmConfig {
        api_url,
        api_key: request.api_key,
        model,
        provider_id: request.provider_id,
        ..Default::default()
    };

    let config = SchedulerConfig {
        enabled: true,
        interval_secs: request.interval_secs.unwrap_or(3600),
        batch_size: request.batch_size.unwrap_or(10),
        max_api_calls: request.max_api_calls.unwrap_or(20),
        llm_config,
        search_result_count: request.search_result_count.unwrap_or(8),
        content_truncation_limit: request.content_truncation_limit.unwrap_or(3000),
        include_journals: request.include_journals.unwrap_or(true),
        daily_note_path: request.daily_note_path,
        min_note_length: request.min_note_length.unwrap_or(100),
    };

    let db = state.db.clone();
    let status_arc = state.scheduler.status.clone();
    let background_active = state.scheduler.running.clone();
    let batch_slot = state.scheduler.batch_continue.clone();
    let app_clone = app.clone();
    let methodology = request.methodology.unwrap_or_else(|| "zettelkasten".to_string());
    let vault_paths = request.vault_paths.unwrap_or_default();

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);

    {
        let mut tx_guard = state.scheduler.stop_tx.lock()?;
        *tx_guard = Some(stop_tx);
    }

    background_active.store(true, Ordering::SeqCst);
    {
        let mut s = status_arc.lock()?;
        s.errors.clear();
    }

    tokio::spawn(async move {
        let interval = config.interval_secs;
        log::info!("Scheduler started (interval: {}s, batch: {})", interval, config.batch_size);

        loop {
            if !background_active.load(Ordering::SeqCst) {
                break;
            }

            log::info!("Running scheduled reconciliation batch...");
            {
                let mut s = status_arc.lock().unwrap_or_else(|e| e.into_inner());
                s.errors.clear();
            }

            for vp in &vault_paths {
                if let Err(e) = sync_vault_db(&db, vp) {
                    log::warn!("Pre-batch vault sync failed for {}: {}", vp, e);
                    let mut s = status_arc.lock().unwrap_or_else(|e| e.into_inner());
                    s.errors.push(format!("Vault sync failed ({}): {}", vp, e));
                }
            }

            let batch_continue = Arc::new(AtomicBool::new(true));
            {
                if let Ok(mut guard) = batch_slot.lock() {
                    *guard = Some(batch_continue.clone());
                }
            }

            match scheduler::run_reconciliation_batch_public(
                &db,
                &config,
                batch_continue.clone(),
                Some(app_clone.clone()),
                false,
                methodology.clone(),
                None,
            )
            .await
            {
                Ok((processed, reconciled, calls)) => {
                    let mut s = status_arc.lock().unwrap_or_else(|e| e.into_inner());
                    s.notes_processed += processed;
                    s.notes_reconciled += reconciled;
                    s.api_calls_used += calls;
                    s.last_run = Some(chrono::Utc::now().to_rfc3339());
                    log::info!("Batch done: {}/{} notes, {} API calls", reconciled, processed, calls);
                    if let Ok(conn) = db.lock() {
                        if let Err(e) = scheduler::save_scheduler_stats(&conn, &s) {
                            log::warn!("Failed to save scheduler stats: {}", e);
                        }
                    }
                }
                Err(e) => {
                    let mut s = status_arc.lock().unwrap_or_else(|e| e.into_inner());
                    s.errors.push(e.to_string());
                    log::error!("Reconciliation batch failed: {}", e);
                }
            }

            {
                if let Ok(mut guard) = batch_slot.lock() {
                    *guard = None;
                }
            }

            if !background_active.load(Ordering::SeqCst) {
                break;
            }

            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval)) => {}
                _ = stop_rx.changed() => {
                    log::info!("Scheduler stopped via signal");
                    batch_continue.store(false, Ordering::SeqCst);
                    break;
                }
            }
        }

        background_active.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = batch_slot.lock() {
            *guard = None;
        }
    });

    Ok("Scheduler started".to_string())
}

#[tauri::command]
pub fn stop_scheduler(state: State<'_, AppState>) -> Result<String, ZettelError> {
    cancel_current_batch(&state);

    let tx_guard = state.scheduler.stop_tx.lock()?;
    if let Some(ref tx) = *tx_guard {
        let _ = tx.send(true);
    }
    drop(tx_guard);

    state.scheduler.running.store(false, Ordering::SeqCst);

    Ok("Scheduler stopped".to_string())
}

#[tauri::command]
pub fn get_scheduler_status(state: State<'_, AppState>) -> Result<SchedulerStatus, ZettelError> {
    let is_running = state.scheduler.running.load(Ordering::SeqCst);
    let s = state.scheduler.status.lock()?;
    Ok(SchedulerStatus {
        running: is_running,
        last_run: s.last_run.clone(),
        notes_processed: s.notes_processed,
        notes_reconciled: s.notes_reconciled,
        api_calls_used: s.api_calls_used,
        errors: s.errors.clone(),
    })
}

#[tauri::command]
pub async fn run_scheduler_now(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: RunSchedulerNowRequest,
) -> Result<SchedulerStatus, ZettelError> {
    batch_in_progress(&state)?;

    // Validate LLM configuration — refuse to run without explicit config
    let api_url = request.api_url.unwrap_or_default();
    let model = request.model.unwrap_or_default();
    if api_url.trim().is_empty() || model.trim().is_empty() {
        return Err(ZettelError::System(
            "LLM API is not configured. Please set up your API endpoint and model in Settings → Model Configuration.".to_string()
        ));
    }

    let llm_config = LlmConfig {
        api_url,
        api_key: request.api_key,
        model,
        provider_id: request.provider_id,
        ..Default::default()
    };

    let config = SchedulerConfig {
        enabled: true,
        interval_secs: 0,
        batch_size: request.batch_size.unwrap_or(5),
        max_api_calls: 10,
        llm_config,
        search_result_count: request.search_result_count.unwrap_or(8),
        content_truncation_limit: request.content_truncation_limit.unwrap_or(3000),
        include_journals: request.include_journals.unwrap_or(true),
        daily_note_path: request.daily_note_path,
        min_note_length: request.min_note_length.unwrap_or(100),
    };

    let db = state.db.clone();
    let status_arc = state.scheduler.status.clone();
    let batch_continue = begin_batch(&state)?;

    {
        let mut s = status_arc.lock()?;
        s.errors.clear();
    }

    let _ = app.emit("scheduler-progress", serde_json::json!({
        "stage": "starting",
        "message": "Starting smart organize...",
    }));

    let methodology = request.methodology.unwrap_or_else(|| "zettelkasten".to_string());
    let path_prefix = request.path_prefix;
    let force = request.force.unwrap_or(false);

    pipeline_log::log_organize_info(&format!(
        "run_scheduler_now: force={}, methodology={}, batch_size={}, model={}, path_prefix={:?}",
        force, methodology, config.batch_size, config.llm_config.model, path_prefix,
    ));

    let result = scheduler::run_reconciliation_batch_public(
        &db,
        &config,
        batch_continue.clone(),
        Some(app.clone()),
        force,
        methodology,
        path_prefix,
    )
    .await;

    let was_aborted = !batch_continue.load(Ordering::SeqCst);
    if was_aborted {
        let _ = app.emit("scheduler-progress", serde_json::json!({
            "stage": "aborted",
            "message": "Smart organize stopped by user",
        }));
    } else {
        let _ = app.emit("scheduler-progress", serde_json::json!({
            "stage": "done",
            "message": "Smart organize complete",
        }));
    }

    let mut s = status_arc.lock()?;
    match result {
        Ok((processed, reconciled, calls)) => {
            if state.scheduler.running.load(Ordering::SeqCst) {
                s.notes_processed += processed;
                s.notes_reconciled += reconciled;
                s.api_calls_used += calls;
            } else {
                s.notes_processed = processed;
                s.notes_reconciled = reconciled;
                s.api_calls_used = calls;
            }
            s.last_run = Some(chrono::Utc::now().to_rfc3339());
            if let Ok(conn) = db.lock() {
                if let Err(e) = scheduler::save_scheduler_stats(&conn, &s) {
                    log::warn!("Failed to save scheduler stats: {}", e);
                }
            }
        }
        Err(e) => {
            pipeline_log::log_organize_error(&format!("run_scheduler_now batch failed: {}", e));
            s.errors.push(e.to_string());
        }
    }

    end_batch(&state);

    Ok(s.clone())
}
