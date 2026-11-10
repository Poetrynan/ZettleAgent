use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};
use anyhow::{anyhow, bail, Result};
use rusqlite::Connection;

use super::types::*;
use super::storage::WorkflowStorage;
use super::source_ingestion::run_source_ingestion;
use super::fact_impact::run_fact_impact_sentinel;
use super::weekly_review::run_weekly_review;

/// 系统自动化标识前缀 / System workflow actor prefix for anti-reentrancy
pub const SYSTEM_WORKFLOW_ACTOR_PREFIX: &str = "system:workflow:";

/// 检查给定来源是否为系统自动化生成，防止级联重入 / Anti-reentrancy check
pub fn is_reentrant_source(actor_or_meta: &str) -> bool {
    actor_or_meta.starts_with(SYSTEM_WORKFLOW_ACTOR_PREFIX)
        || actor_or_meta.contains("generated_by: system:workflow")
        || actor_or_meta.contains("\"source\":\"system:workflow")
}

/// 预算追踪与熔断监视器 / Budget Tracker and Circuit Breaker
#[derive(Debug, Clone)]
pub struct BudgetTracker {
    pub cap: BudgetCap,
    pub api_calls: usize,
    pub tokens_used: usize,
    pub started_at: Instant,
}

impl BudgetTracker {
    pub fn new(cap: BudgetCap) -> Self {
        Self {
            cap,
            api_calls: 0,
            tokens_used: 0,
            started_at: Instant::now(),
        }
    }

    /// 记录一次 API 交互并校验熔断条件
    pub fn record_api_call(&mut self, tokens: usize) -> Result<()> {
        self.api_calls += 1;
        self.tokens_used += tokens;

        if self.api_calls > self.cap.max_api_calls {
            bail!(
                "Budget cap exceeded: API calls ({}) exceeded maximum allowed ({})",
                self.api_calls,
                self.cap.max_api_calls
            );
        }

        if self.tokens_used > self.cap.max_tokens {
            bail!(
                "Budget cap exceeded: Token usage ({}) exceeded maximum allowed ({})",
                self.tokens_used,
                self.cap.max_tokens
            );
        }

        self.check_timeout()?;
        Ok(())
    }

    /// 检查是否超时
    pub fn check_timeout(&self) -> Result<()> {
        if self.started_at.elapsed() > Duration::from_secs(self.cap.timeout_secs) {
            bail!(
                "Workflow execution timed out after {}s (limit: {}s)",
                self.started_at.elapsed().as_secs(),
                self.cap.timeout_secs
            );
        }
        Ok(())
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

/// 工作流核心调度引擎 / Workflow Engine
pub struct WorkflowEngine {
    storage: WorkflowStorage,
}

impl WorkflowEngine {
    pub fn new() -> Self {
        Self {
            storage: WorkflowStorage::new(),
        }
    }

    pub fn storage(&self) -> &WorkflowStorage {
        &self.storage
    }

    /// 统一执行指定工作流 (支持 Dry Run 模拟与真实受控执行)
    pub fn execute_workflow(
        &self,
        conn: &Connection,
        vault_path: &str,
        workflow_id: &str,
        dry_run: bool,
        cancel_flag: Option<&Arc<AtomicBool>>,
    ) -> Result<WorkflowRunResult> {
        let config = self
            .storage
            .load_config_by_id(conn, workflow_id)?
            .ok_or_else(|| anyhow!("Workflow config not found: {}", workflow_id))?;

        if !config.enabled && !dry_run {
            bail!("Workflow '{}' is currently disabled", config.name);
        }

        let run_id = format!("run_{}_{}", workflow_id, chrono::Utc::now().timestamp_millis());
        let started_at = chrono::Utc::now().to_rfc3339();

        let mut record = WorkflowRunRecord {
            id: run_id.clone(),
            workflow_id: workflow_id.to_string(),
            kind: config.kind,
            status: WorkflowRunStatus::Running,
            is_dry_run: dry_run,
            started_at: started_at.clone(),
            completed_at: None,
            duration_ms: 0,
            api_calls_used: 0,
            tokens_used: 0,
            items_processed: 0,
            changeset_id: None,
            summary_json: None,
            error_message: None,
        };

        if !dry_run {
            let _ = self.storage.record_run_start(conn, &record);
        }

        let mut tracker = BudgetTracker::new(config.budget.clone());

        // Dispatch based on pipeline kind
        let execution_result = match config.kind {
            WorkflowKind::SourceIngestion => {
                run_source_ingestion(conn, vault_path, &config, dry_run, &mut tracker, cancel_flag)
            }
            WorkflowKind::FactImpactSentinel => {
                run_fact_impact_sentinel(conn, vault_path, &config, None, dry_run, &mut tracker, cancel_flag)
            }
            WorkflowKind::WeeklyReview => {
                run_weekly_review(conn, vault_path, &config, dry_run, &mut tracker, cancel_flag)
            }
        };

        let now_completed = chrono::Utc::now().to_rfc3339();
        record.completed_at = Some(now_completed);
        record.duration_ms = tracker.elapsed_ms();
        record.api_calls_used = tracker.api_calls;
        record.tokens_used = tracker.tokens_used;

        match execution_result {
            Ok(res) => {
                record.status = res.status;
                record.items_processed = res.items_processed;
                record.changeset_id = res.changeset_id.clone();
                record.summary_json = Some(
                    serde_json::to_string(&res.actions).unwrap_or_default(),
                );
                if !dry_run {
                    let _ = self.storage.record_run_finish(conn, &record);
                }
                Ok(res)
            }
            Err(e) => {
                let err_str = e.to_string();
                record.status = if err_str.contains("Budget cap exceeded") {
                    WorkflowRunStatus::BudgetExhausted
                } else if err_str.contains("Cancelled") {
                    WorkflowRunStatus::Cancelled
                } else {
                    WorkflowRunStatus::Failed
                };
                record.error_message = Some(err_str.clone());

                if !dry_run {
                    let _ = self.storage.record_run_finish(conn, &record);
                }

                Err(anyhow!(err_str))
            }
        }
    }
}
