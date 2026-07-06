mod file_lock;
pub mod db;
mod chunker;
mod watcher;
mod reconciler;
mod commands;
pub mod llm;
pub mod scheduler;
mod canvas;
pub mod lint;
pub mod temporal;
pub mod error;
pub mod tools;
pub mod agents;
pub mod import;
pub mod db_config;
pub mod frontmatter;
mod app_paths;
mod chat_file_log;
mod pipeline_log;
mod gpu;

use std::sync::{Arc, Mutex};
use rusqlite::Connection;
use tauri::Manager;
use tokio::sync::watch;

/// Scheduler runtime state: tracks running status, stop signal, and metrics.
pub struct SchedulerState {
    /// Background scheduler loop is active (UI toggle).
    pub running: Arc<std::sync::atomic::AtomicBool>,
    /// Cancel flag for the batch currently in progress (manual or background).
    pub batch_continue: Arc<Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>>,
    pub stop_tx: Mutex<Option<watch::Sender<bool>>>,
    pub status: Arc<Mutex<scheduler::SchedulerStatus>>,
}

impl SchedulerState {
    fn new(db: &Arc<Mutex<Connection>>) -> Self {
        // Load persisted stats from database
        let status = if let Ok(conn) = db.lock() {
            scheduler::load_scheduler_stats(&conn)
                .unwrap_or_else(|e| {
                    log::warn!("Failed to load scheduler stats: {}", e);
                    scheduler::SchedulerStatus {
                        running: false,
                        last_run: None,
                        notes_processed: 0,
                        notes_reconciled: 0,
                        api_calls_used: 0,
                        errors: Vec::new(),
                    }
                })
        } else {
            scheduler::SchedulerStatus {
                running: false,
                last_run: None,
                notes_processed: 0,
                notes_reconciled: 0,
                api_calls_used: 0,
                errors: Vec::new(),
            }
        };

        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            batch_continue: Arc::new(Mutex::new(None)),
            stop_tx: Mutex::new(None),
            status: Arc::new(Mutex::new(status)),
        }
    }
}

/// Application state shared across all Tauri commands.
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub scheduler: SchedulerState,
    pub watcher: Arc<Mutex<std::collections::HashMap<String, notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logger
    env_logger::init();

    // Register sqlite-vec auto-extension (must be before any connection is opened)
    db::register_sqlite_vec();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Resolve app data directory for the database
            if let Ok(resource_dir) = app.path().resource_dir() {
                app_paths::init_resource_dir(resource_dir);
            }

            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data directory");

            let db_path = db_config::resolve_db_path(&app_data_dir);

            chat_file_log::init(&app_data_dir);
pipeline_log::init(&app_data_dir);

            // Initialize database
            let conn = db::initialize_database(&db_path)
                .expect("Failed to initialize database");

            // Run vec dimension migration
            if let Ok(migrated) = db::schema::migrate_vec_dimensions(&conn) {
                if migrated {
                    log::info!("Vector dimension migration completed to 768");
                }
            }

            // Store connection in managed state
            let db_arc = Arc::new(Mutex::new(conn));
            app.manage(AppState {
                db: db_arc.clone(),
                scheduler: SchedulerState::new(&db_arc),
                watcher: Arc::new(Mutex::new(std::collections::HashMap::new())),
            });



            // Dynamic window sizing: adapt to screen resolution
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let screen = monitor.size();
                    let scale = monitor.scale_factor();
                    // Use ~85% of screen size (in logical pixels)
                    let logical_w = (screen.width as f64 / scale * 0.85) as f64;
                    let logical_h = (screen.height as f64 / scale * 0.85) as f64;
                    // Clamp to reasonable bounds
                    let w = logical_w.max(960.0).min(1720.0);
                    let h = logical_h.max(620.0).min(980.0);
                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                    let _ = window.center();
                    log::info!("Window resized to {}x{} (screen: {}x{}, scale: {:.1})", w as u32, h as u32, screen.width, screen.height, scale);
                }
                // Show window only after sizing is finalized (prevents visible resize jump)
                let _ = window.show();
            }

            log::info!("ZettelAgent application started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::get_app_info,
            commands::set_vault_path,
            commands::sync_vault,
            commands::chunk_document,
            commands::search_chunks,
            commands::read_markdown_file,
            commands::read_binary_file,
            commands::write_markdown_file,
            commands::save_note_snapshot,
            commands::get_note_snapshots,
            commands::delete_note_snapshot,
            commands::delete_file,
            commands::list_markdown_files,
            commands::chat_with_llm,
            commands::chat_with_llm_stream,
            commands::rag_search_and_chat,
            commands::rag_search_and_stream,
            commands::generate_card_metadata,
            commands::get_knowledge_graph,
            commands::get_local_graph,
            commands::export_canvas,
            commands::save_canvas_to_file,
            commands::add_canvas_relation,
            commands::delete_canvas_relation,
            commands::add_note_relation,
            commands::delete_note_relation,
            commands::explain_relationship,
            commands::start_scheduler,
            commands::stop_scheduler,
            commands::get_scheduler_status,
            commands::run_scheduler_now,
            commands::get_unindexed_chunks,
            commands::save_chunk_embeddings,
            commands::finalize_embedding_index,
            commands::get_embedding_stats,
            commands::clear_data,
            commands::clear_data_selective,
            commands::resolve_wikilink,
            commands::get_backlinks,
            commands::run_vault_lint,
            commands::fix_broken_link,
            commands::create_note_for_link,
            commands::get_note_facts,
            commands::get_note_timeline,
            commands::get_global_timeline,
            commands::get_data_path,
            commands::get_db_path,
            commands::get_custom_db_path,
            commands::set_custom_db_path,
            commands::list_directory_tree,
            commands::create_file,
            commands::create_folder,
            commands::rename_path,
            commands::move_path,
            commands::delete_folder,
            commands::save_image_to_vault,
            commands::agent_chat,
            commands::cancel_agent_turn,
            commands::get_edges_by_relation,
            // MCP + Skill management (Phase 3.3)
            commands::list_mcp_servers,
            commands::add_mcp_server,
            commands::remove_mcp_server,
            commands::test_mcp_connection,
            commands::list_skill_directories,
            commands::add_skill_directory,
            commands::remove_skill_directory,
            commands::scan_skills,
            commands::get_skill_detail,
            // Chat history + AI memory (Phase 6)
            commands::list_chat_sessions,
            commands::get_chat_session,
            commands::create_chat_session,
            commands::save_chat_message,
            commands::delete_chat_session,
            commands::rename_chat_session,
            commands::export_chat_session,
            commands::export_all_sessions,
            commands::get_ai_memories,
            commands::add_ai_memory,
            commands::delete_ai_memory,
            commands::get_setting,
            commands::set_setting,
            // Import (Phase 8a)
            commands::import_files,
            commands::open_file_external,
            commands::import_attachments,
            // Internal tool summaries + persistent memory (Tier 2)
            commands::list_internal_tools,
            commands::read_memory_file,
            commands::write_memory_file,
            // Bases (database view)
            commands::get_bases_data,
            // Conflict detection and resolution
            commands::detect_file_conflicts,
            commands::resolve_conflict,
            // Agent approval gate
            llm::approval::approve_tool_call,
            llm::approval::reject_tool_call,
            // Demo vault
            commands::init_demo_vault,
            // GPU hardware detection
            gpu::get_gpu_info,
            gpu::get_gpu_info_async,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                crate::tools::shutdown_mcp();
            }
        });
}
