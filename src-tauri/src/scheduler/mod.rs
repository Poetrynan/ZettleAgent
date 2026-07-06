use std::sync::{Arc, Mutex};
use std::time::Duration;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::llm::LlmConfig;

pub mod task;
pub mod reconcile_task;

pub use task::SchedulerTask;
pub use reconcile_task::ReconcileTask;

/// Configuration for the reconciliation scheduler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerConfig {
    pub enabled: bool,
    pub interval_secs: u64,
    pub batch_size: usize,
    pub max_api_calls: usize,
    pub llm_config: LlmConfig,
    /// Number of search results to retrieve for candidate note alignment (default: 8)
    pub search_result_count: usize,
    /// Max characters of note content to send to LLM (default: 3000)
    pub content_truncation_limit: usize,
    /// Whether to include journal/diary notes (default: true)
    pub include_journals: bool,
    /// Absolute path to the daily notes folder (used to skip when include_journals is false)
    pub daily_note_path: Option<String>,
    pub min_note_length: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_secs: 86400,
            batch_size: 10,
            max_api_calls: 20,
            llm_config: LlmConfig::default(),
            search_result_count: 8,
            content_truncation_limit: 3000,
            include_journals: true,
            daily_note_path: None,
            min_note_length: 100,
        }
    }
}

/// Status of the scheduler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerStatus {
    pub running: bool,
    pub last_run: Option<String>,
    pub notes_processed: usize,
    pub notes_reconciled: usize,
    pub api_calls_used: usize,
    pub errors: Vec<String>,
}

/// Save scheduler stats to database
pub fn save_scheduler_stats(conn: &Connection, status: &SchedulerStatus) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('scheduler_last_run', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = datetime('now')",
        rusqlite::params![status.last_run.as_deref().unwrap_or("")],
    )?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('scheduler_notes_processed', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = datetime('now')",
        rusqlite::params![status.notes_processed.to_string()],
    )?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('scheduler_notes_reconciled', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = datetime('now')",
        rusqlite::params![status.notes_reconciled.to_string()],
    )?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('scheduler_api_calls_used', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = datetime('now')",
        rusqlite::params![status.api_calls_used.to_string()],
    )?;
    Ok(())
}

/// Load scheduler stats from database
pub fn load_scheduler_stats(conn: &Connection) -> anyhow::Result<SchedulerStatus> {
    let last_run = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'scheduler_last_run'",
        [],
        |row| row.get::<_, String>(0),
    ).ok();

    let notes_processed = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'scheduler_notes_processed'",
        [],
        |row| row.get::<_, String>(0),
    ).ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);

    let notes_reconciled = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'scheduler_notes_reconciled'",
        [],
        |row| row.get::<_, String>(0),
    ).ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);

    let api_calls_used = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'scheduler_api_calls_used'",
        [],
        |row| row.get::<_, String>(0),
    ).ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);

    Ok(SchedulerStatus {
        running: false,
        last_run: last_run.filter(|s| !s.is_empty()),
        notes_processed,
        notes_reconciled,
        api_calls_used,
        errors: Vec::new(),
    })
}

/// Background scheduler for running reconciliation tasks.
pub struct ReconciliationScheduler {
    config: SchedulerConfig,
    status: Arc<Mutex<SchedulerStatus>>,
    db: Arc<Mutex<Connection>>,
}

impl ReconciliationScheduler {
    pub fn new(config: SchedulerConfig, db: Arc<Mutex<Connection>>) -> Self {
        Self {
            config,
            status: Arc::new(Mutex::new(SchedulerStatus {
                running: false,
                last_run: None,
                notes_processed: 0,
                notes_reconciled: 0,
                api_calls_used: 0,
                errors: Vec::new(),
            })),
            db,
        }
    }

    pub fn status(&self) -> SchedulerStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn start(&self) -> tokio::task::JoinHandle<()> {
        let config = self.config.clone();
        let status = self.status.clone();
        let db = self.db.clone();

        tokio::spawn(async move {
            if !config.enabled {
                log::info!("Reconciliation scheduler is disabled");
                return;
            }

            log::info!(
                "Reconciliation scheduler started (interval: {}s, batch: {})",
                config.interval_secs,
                config.batch_size
            );

            loop {
                tokio::time::sleep(Duration::from_secs(config.interval_secs)).await;

                log::info!("Running scheduled reconciliation...");
                {
                    let mut s = status.lock().unwrap();
                    s.running = true;
                    s.errors.clear();
                }

                let dummy_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
                let task = ReconcileTask;
                match task.run(&db, &config, dummy_running, None, false, "zettelkasten".to_string(), None).await {
                    Ok((processed, reconciled, calls)) => {
                        let mut s = status.lock().unwrap();
                        s.notes_processed = processed;
                        s.notes_reconciled = reconciled;
                        s.api_calls_used = calls;
                        s.last_run = Some(chrono::Utc::now().to_rfc3339());
                        s.running = false;
                        // Persist stats to database
                        if let Ok(conn) = db.lock() {
                            if let Err(e) = save_scheduler_stats(&conn, &s) {
                                log::warn!("Failed to save scheduler stats: {}", e);
                            }
                        }
                        log::info!(
                            "Reconciliation complete: {}/{} notes reconciled, {} API calls",
                            reconciled, processed, calls
                        );
                    }
                    Err(e) => {
                        let mut s = status.lock().unwrap();
                        s.running = false;
                        s.errors.push(e.to_string());
                        log::error!("Reconciliation failed: {}", e);
                    }
                }
            }
        })
    }
}

/// Run a single batch of reconciliation (public entry point for commands).
pub async fn run_reconciliation_batch_public(
    db: &Arc<Mutex<Connection>>,
    config: &SchedulerConfig,
    running: Arc<std::sync::atomic::AtomicBool>,
    app: Option<tauri::AppHandle>,
    force: bool,
    methodology: String,
    path_prefix: Option<String>,
) -> anyhow::Result<(usize, usize, usize)> {
    let task = ReconcileTask;
    task.run(db, config, running, app, force, methodology, path_prefix).await
}
