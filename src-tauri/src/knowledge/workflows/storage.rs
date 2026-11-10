use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use super::types::*;

pub struct WorkflowStorage;

impl WorkflowStorage {
    pub fn new() -> Self {
        Self
    }

    /// 加载所有工作流配置；若数据库为空，自动初始化写入出厂三大配置
    pub fn load_configs(&self, conn: &Connection) -> Result<Vec<WorkflowConfig>> {
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, enabled, trigger_json, scope_json, budget_json, created_at, updated_at
             FROM workflow_configs
             ORDER BY kind ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let kind_str: String = row.get(1)?;
            let name: String = row.get(2)?;
            let enabled: bool = row.get::<_, i64>(3)? != 0;
            let trigger_json: String = row.get(4)?;
            let scope_json: String = row.get(5)?;
            let budget_json: String = row.get(6)?;
            let created_at: String = row.get(7)?;
            let updated_at: String = row.get(8)?;

            Ok((id, kind_str, name, enabled, trigger_json, scope_json, budget_json, created_at, updated_at))
        })?;

        let mut configs = Vec::new();
        for r in rows {
            let (id, kind_str, name, enabled, trigger_json, scope_json, budget_json, created_at, updated_at) = r?;
            let kind = WorkflowKind::from_str(&kind_str).unwrap_or(WorkflowKind::SourceIngestion);
            let trigger: WorkflowTrigger = serde_json::from_str(&trigger_json)
                .unwrap_or(WorkflowTrigger::Manual);
            let scope: WorkflowScope = serde_json::from_str(&scope_json)
                .unwrap_or_default();
            let budget: BudgetCap = serde_json::from_str(&budget_json)
                .unwrap_or_default();

            configs.push(WorkflowConfig {
                id,
                kind,
                name,
                description: String::new(), // Will be populated from defaults if needed
                enabled,
                trigger,
                scope,
                budget,
                approval_mode: WorkflowApprovalMode::ReviewRequired,
                created_at,
                updated_at,
            });
        }

        if configs.is_empty() {
            // Seed defaults
            let defaults = WorkflowConfig::defaults();
            for def in &defaults {
                self.save_config(conn, def)?;
            }
            return Ok(defaults);
        }

        // Attach static descriptions
        let defaults = WorkflowConfig::defaults();
        for c in &mut configs {
            if let Some(d) = defaults.iter().find(|d| d.id == c.id) {
                c.description = d.description.clone();
            }
        }

        Ok(configs)
    }

    /// 根据 ID 检索单个工作流配置
    pub fn load_config_by_id(&self, conn: &Connection, id: &str) -> Result<Option<WorkflowConfig>> {
        let configs = self.load_configs(conn)?;
        Ok(configs.into_iter().find(|c| c.id == id))
    }

    /// 持久化保存或更新配置
    pub fn save_config(&self, conn: &Connection, config: &WorkflowConfig) -> Result<()> {
        let trigger_json = serde_json::to_string(&config.trigger)?;
        let scope_json = serde_json::to_string(&config.scope)?;
        let budget_json = serde_json::to_string(&config.budget)?;

        conn.execute(
            "INSERT INTO workflow_configs (id, kind, name, enabled, trigger_json, scope_json, budget_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                kind = ?2,
                name = ?3,
                enabled = ?4,
                trigger_json = ?5,
                scope_json = ?6,
                budget_json = ?7,
                updated_at = datetime('now')",
            params![
                config.id,
                config.kind.as_str(),
                config.name,
                if config.enabled { 1 } else { 0 },
                trigger_json,
                scope_json,
                budget_json,
            ],
        ).context("Failed to save workflow config")?;

        Ok(())
    }

    /// 记录运行开始
    pub fn record_run_start(&self, conn: &Connection, run: &WorkflowRunRecord) -> Result<()> {
        conn.execute(
            "INSERT INTO workflow_runs (
                id, workflow_id, kind, status, is_dry_run, started_at, completed_at,
                duration_ms, api_calls_used, tokens_used, items_processed,
                changeset_id, summary_json, error_message
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                run.id,
                run.workflow_id,
                run.kind.as_str(),
                run.status.as_str(),
                if run.is_dry_run { 1 } else { 0 },
                run.started_at,
                run.completed_at,
                run.duration_ms as i64,
                run.api_calls_used as i64,
                run.tokens_used as i64,
                run.items_processed as i64,
                run.changeset_id,
                run.summary_json,
                run.error_message,
            ],
        ).context("Failed to record workflow run start")?;

        Ok(())
    }

    /// 更新运行结束状态与指标
    pub fn record_run_finish(&self, conn: &Connection, run: &WorkflowRunRecord) -> Result<()> {
        conn.execute(
            "UPDATE workflow_runs SET
                status = ?2,
                completed_at = ?3,
                duration_ms = ?4,
                api_calls_used = ?5,
                tokens_used = ?6,
                items_processed = ?7,
                changeset_id = ?8,
                summary_json = ?9,
                error_message = ?10
             WHERE id = ?1",
            params![
                run.id,
                run.status.as_str(),
                run.completed_at,
                run.duration_ms as i64,
                run.api_calls_used as i64,
                run.tokens_used as i64,
                run.items_processed as i64,
                run.changeset_id,
                run.summary_json,
                run.error_message,
            ],
        ).context("Failed to record workflow run finish")?;

        Ok(())
    }

    /// 检索历史运行记录
    pub fn get_run_history(
        &self,
        conn: &Connection,
        workflow_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<WorkflowRunRecord>> {
        let sql = if workflow_id.is_some() {
            "SELECT id, workflow_id, kind, status, is_dry_run, started_at, completed_at,
                    duration_ms, api_calls_used, tokens_used, items_processed,
                    changeset_id, summary_json, error_message
             FROM workflow_runs
             WHERE workflow_id = ?1
             ORDER BY started_at DESC
             LIMIT ?2"
        } else {
            "SELECT id, workflow_id, kind, status, is_dry_run, started_at, completed_at,
                    duration_ms, api_calls_used, tokens_used, items_processed,
                    changeset_id, summary_json, error_message
             FROM workflow_runs
             ORDER BY started_at DESC
             LIMIT ?1"
        };

        let mut stmt = conn.prepare(sql)?;
        let limit_param = limit.clamp(1, 200) as i64;

        let mapper = |row: &rusqlite::Row| {
            let id: String = row.get(0)?;
            let wf_id: String = row.get(1)?;
            let kind_str: String = row.get(2)?;
            let status_str: String = row.get(3)?;
            let is_dry_run: bool = row.get::<_, i64>(4)? != 0;
            let started_at: String = row.get(5)?;
            let completed_at: Option<String> = row.get(6)?;
            let duration_ms: i64 = row.get(7)?;
            let api_calls_used: i64 = row.get(8)?;
            let tokens_used: i64 = row.get(9)?;
            let items_processed: i64 = row.get(10)?;
            let changeset_id: Option<String> = row.get(11)?;
            let summary_json: Option<String> = row.get(12)?;
            let error_message: Option<String> = row.get(13)?;

            Ok(WorkflowRunRecord {
                id,
                workflow_id: wf_id,
                kind: WorkflowKind::from_str(&kind_str).unwrap_or(WorkflowKind::SourceIngestion),
                status: WorkflowRunStatus::from_str(&status_str).unwrap_or(WorkflowRunStatus::Completed),
                is_dry_run,
                started_at,
                completed_at,
                duration_ms: duration_ms as u64,
                api_calls_used: api_calls_used as usize,
                tokens_used: tokens_used as usize,
                items_processed: items_processed as usize,
                changeset_id,
                summary_json,
                error_message,
            })
        };

        let rows: Vec<WorkflowRunRecord> = if let Some(wid) = workflow_id {
            stmt.query_map(params![wid, limit_param], mapper)?
                .filter_map(|r| r.ok())
                .collect()
        } else {
            stmt.query_map(params![limit_param], mapper)?
                .filter_map(|r| r.ok())
                .collect()
        };

        Ok(rows)
    }
}
