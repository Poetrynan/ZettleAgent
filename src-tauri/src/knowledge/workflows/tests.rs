use rusqlite::Connection;
use crate::db::schema::setup_database_schema;
use crate::knowledge::workflows::storage::WorkflowStorage;
use crate::knowledge::workflows::types::*;
use crate::knowledge::workflows::engine::{is_reentrant_source, BudgetTracker, WorkflowEngine};

fn setup_in_memory_db() -> Connection {
    crate::db::register_sqlite_vec();
    let conn = Connection::open_in_memory().unwrap();
    setup_database_schema(&conn).unwrap();
    crate::knowledge::migration::run_knowledge_migrations(&conn).unwrap();
    conn
}

#[test]
fn test_workflow_storage_crud_and_seed() {
    let conn = setup_in_memory_db();
    let storage = WorkflowStorage::new();

    // 1. Initial load should seed 3 defaults
    let configs = storage.load_configs(&conn).unwrap();
    assert_eq!(configs.len(), 3, "Must seed 3 default workflows");

    let source_wf = configs.iter().find(|c| c.kind == WorkflowKind::SourceIngestion).unwrap();
    assert_eq!(source_wf.name, "新资料入库整理");
    assert!(source_wf.enabled);

    // 2. Update config
    let mut updated = source_wf.clone();
    updated.budget.max_api_calls = 55;
    updated.enabled = false;
    storage.save_config(&conn, &updated).unwrap();

    let loaded = storage.load_config_by_id(&conn, &updated.id).unwrap().unwrap();
    assert_eq!(loaded.budget.max_api_calls, 55);
    assert!(!loaded.enabled);
}

#[test]
fn test_workflow_run_record_lifecycle() {
    let conn = setup_in_memory_db();
    let storage = WorkflowStorage::new();

    let record = WorkflowRunRecord {
        id: "run_test_1".to_string(),
        workflow_id: "wf_weekly_review".to_string(),
        kind: WorkflowKind::WeeklyReview,
        status: WorkflowRunStatus::Running,
        is_dry_run: false,
        started_at: "2026-11-10T10:00:00Z".to_string(),
        completed_at: None,
        duration_ms: 0,
        api_calls_used: 0,
        tokens_used: 0,
        items_processed: 0,
        changeset_id: None,
        summary_json: None,
        error_message: None,
    };

    storage.record_run_start(&conn, &record).unwrap();

    let mut finished = record.clone();
    finished.status = WorkflowRunStatus::Completed;
    finished.completed_at = Some("2026-11-10T10:00:05Z".to_string());
    finished.duration_ms = 5000;
    finished.api_calls_used = 4;
    finished.tokens_used = 2500;
    finished.items_processed = 12;

    storage.record_run_finish(&conn, &finished).unwrap();

    let history = storage.get_run_history(&conn, Some("wf_weekly_review"), 10).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, WorkflowRunStatus::Completed);
    assert_eq!(history[0].api_calls_used, 4);
    assert_eq!(history[0].tokens_used, 2500);
    assert_eq!(history[0].items_processed, 12);
}

#[test]
fn test_budget_exhaustion_limits() {
    let budget = BudgetCap {
        max_api_calls: 2,
        max_tokens: 1000,
        timeout_secs: 60,
    };
    let mut tracker = BudgetTracker::new(budget);

    // Call 1: 400 tokens -> OK
    assert!(tracker.record_api_call(400).is_ok());
    assert_eq!(tracker.api_calls, 1);
    assert_eq!(tracker.tokens_used, 400);

    // Call 2: 400 tokens -> OK
    assert!(tracker.record_api_call(400).is_ok());
    assert_eq!(tracker.api_calls, 2);
    assert_eq!(tracker.tokens_used, 800);

    // Call 3: exceeds max_api_calls (limit is 2)
    let res = tracker.record_api_call(100);
    assert!(res.is_err(), "Must reject call exceeding max_api_calls");
    assert!(res.unwrap_err().to_string().contains("API calls (3) exceeded"));
}

#[test]
fn test_anti_reentrancy_detection() {
    assert!(is_reentrant_source("system:workflow:source_ingestion"));
    assert!(is_reentrant_source("system:workflow:fact_impact"));
    assert!(is_reentrant_source("system:workflow:weekly_review"));
    assert!(is_reentrant_source("---\ngenerated_by: system:workflow\n---"));

    assert!(!is_reentrant_source("user:manual"));
    assert!(!is_reentrant_source("agent:chat_turn"));
    assert!(!is_reentrant_source("mcp:desktop_client"));
}

#[test]
fn test_source_ingestion_dry_run() {
    let conn = setup_in_memory_db();
    let temp_vault = std::env::temp_dir().join(format!("zettel-wf-test-{}", uuid::Uuid::new_v4()));
    let sources_dir = temp_vault.join("_sources");
    std::fs::create_dir_all(&sources_dir).unwrap();

    let sample_paper = "# AlphaGenome Architecture\nAuthor: DeepMind\nPublished: 2026\n\nAlphaGenome demonstrates remarkable accuracy in predicting genomic regulatory effects.";
    std::fs::write(sources_dir.join("alphagenome_paper.md"), sample_paper).unwrap();

    let engine = WorkflowEngine::new();
    let res = engine.execute_workflow(
        &conn,
        temp_vault.to_str().unwrap(),
        "wf_source_ingestion",
        true, // dry_run
        None,
    ).unwrap();

    assert!(res.is_dry_run);
    assert_eq!(res.items_processed, 1);
    assert_eq!(res.actions.len(), 1);
    assert_eq!(res.actions[0].action_type, "create_literature_note");
    assert!(res.changeset_id.is_none(), "Dry run must not stage persistent changeset");

    let _ = std::fs::remove_dir_all(&temp_vault);
}

#[test]
fn test_weekly_review_dry_run() {
    let conn = setup_in_memory_db();
    let temp_vault = std::env::temp_dir().join(format!("zettel-wf-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_vault).unwrap();

    let engine = WorkflowEngine::new();
    let res = engine.execute_workflow(
        &conn,
        temp_vault.to_str().unwrap(),
        "wf_weekly_review",
        true, // dry_run
        None,
    ).unwrap();

    assert!(res.is_dry_run);
    assert_eq!(res.actions.len(), 1);
    assert_eq!(res.actions[0].action_type, "generate_weekly_review");
    assert!(res.actions[0].diff_preview.as_ref().unwrap().contains("知识周回顾"));

    let _ = std::fs::remove_dir_all(&temp_vault);
}
