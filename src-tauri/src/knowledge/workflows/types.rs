use serde::{Deserialize, Serialize};

/// 自动化工作流类型 / Fixed knowledge workflow kinds
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowKind {
    /// 新资料入库整理 (监控/导入 _sources，解析元数据、识别核心主张并提炼待审变更)
    SourceIngestion,
    /// 事实修改联动审查 (笔记/主张修改后，基于影响追踪检测断链与陈旧引用，生成修补提案)
    FactImpactSentinel,
    /// 每周知识回顾 (聚合本周增量、盘点活跃研究、扫描争议主张并整合 FSRS 到期卡片生成周报)
    WeeklyReview,
}

impl WorkflowKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SourceIngestion => "source_ingestion",
            Self::FactImpactSentinel => "fact_impact_sentinel",
            Self::WeeklyReview => "weekly_review",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "source_ingestion" => Some(Self::SourceIngestion),
            "fact_impact_sentinel" => Some(Self::FactImpactSentinel),
            "weekly_review" => Some(Self::WeeklyReview),
            _ => None,
        }
    }
}

/// 触发器定义 / Workflow trigger specification
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowTrigger {
    Manual,
    Scheduled { interval_secs: u64 },
    FileEvent { path_pattern: String, debounce_ms: u64 },
}

/// 作用域限定 / Scope boundaries to avoid full-vault unconstrained scanning
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowScope {
    pub path_patterns: Vec<String>,
    pub tag_filters: Vec<String>,
    pub ignore_patterns: Vec<String>,
}

impl Default for WorkflowScope {
    fn default() -> Self {
        Self {
            path_patterns: vec!["**/*.md".to_string()],
            tag_filters: Vec::new(),
            ignore_patterns: vec![
                ".*".to_string(),
                "node_modules/**".to_string(),
                "_archive/**".to_string(),
                "_templates/**".to_string(),
            ],
        }
    }
}

/// 预算上限熔断配置 / Hard budget cap to prevent accidental runaway execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetCap {
    /// 单次运行最大 API 调用数 (LLM, web, external APIs)
    pub max_api_calls: usize,
    /// 单次运行最大预估 Token 上限
    pub max_tokens: usize,
    /// 单次运行最大执行超时秒数
    pub timeout_secs: u64,
}

impl Default for BudgetCap {
    fn default() -> Self {
        Self {
            max_api_calls: 20,
            max_tokens: 30_000,
            timeout_secs: 180,
        }
    }
}

/// 审批审查模式 / Approval & Review Mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowApprovalMode {
    /// 强制生成 ChangeSet 待审，严禁静默覆写 (推荐默认)
    ReviewRequired,
    /// 仅限完全无副作用/只读预览
    ReadOnlyPreview,
}

/// 自动化工作流配置实体 / Workflow configuration entity
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowConfig {
    pub id: String,
    pub kind: WorkflowKind,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: WorkflowTrigger,
    pub scope: WorkflowScope,
    pub budget: BudgetCap,
    pub approval_mode: WorkflowApprovalMode,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkflowConfig {
    /// 默认预置：新资料入库整理 (Source Ingestion)
    pub fn default_source_ingestion() -> Self {
        Self {
            id: "wf_source_ingestion".to_string(),
            kind: WorkflowKind::SourceIngestion,
            name: "新资料入库整理".to_string(),
            description: "监控 _sources 目录导入，自动抽取元数据与核心主张，提炼文献笔记与概念关联待审方案。".to_string(),
            enabled: true,
            trigger: WorkflowTrigger::FileEvent {
                path_pattern: "_sources/**".to_string(),
                debounce_ms: 2000,
            },
            scope: WorkflowScope {
                path_patterns: vec!["_sources/**".to_string()],
                tag_filters: Vec::new(),
                ignore_patterns: vec![".*".to_string(), "_archive/**".to_string()],
            },
            budget: BudgetCap {
                max_api_calls: 15,
                max_tokens: 25_000,
                timeout_secs: 120,
            },
            approval_mode: WorkflowApprovalMode::ReviewRequired,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            updated_at: "2026-11-10T00:00:00Z".to_string(),
        }
    }

    /// 默认预置：事实修改联动审查 (Fact Impact Sentinel)
    pub fn default_fact_impact_sentinel() -> Self {
        Self {
            id: "wf_fact_impact_sentinel".to_string(),
            kind: WorkflowKind::FactImpactSentinel,
            name: "事实修改联动审查".to_string(),
            description: "主张或事实笔记修改后，反向追踪下游依赖笔记与项目，检测语义断链并生成非侵入式修补提案。".to_string(),
            enabled: true,
            trigger: WorkflowTrigger::Manual,
            scope: WorkflowScope {
                path_patterns: vec!["**/*.md".to_string()],
                tag_filters: vec!["claim".to_string(), "fact".to_string()],
                ignore_patterns: vec![".*".to_string(), "_sources/**".to_string()],
            },
            budget: BudgetCap {
                max_api_calls: 10,
                max_tokens: 20_000,
                timeout_secs: 90,
            },
            approval_mode: WorkflowApprovalMode::ReviewRequired,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            updated_at: "2026-11-10T00:00:00Z".to_string(),
        }
    }

    /// 默认预置：每周知识回顾 (Weekly Review Digest)
    pub fn default_weekly_review() -> Self {
        Self {
            id: "wf_weekly_review".to_string(),
            kind: WorkflowKind::WeeklyReview,
            name: "每周知识回顾".to_string(),
            description: "定期盘点本周笔记增量、活跃研究项目与 FSRS 到期记忆卡片，提炼结构化周记与下周推进建议。".to_string(),
            enabled: true,
            trigger: WorkflowTrigger::Scheduled {
                interval_secs: 604_800, // 7 days
            },
            scope: WorkflowScope {
                path_patterns: vec!["**/*.md".to_string()],
                tag_filters: Vec::new(),
                ignore_patterns: vec![".*".to_string(), "_archive/**".to_string()],
            },
            budget: BudgetCap {
                max_api_calls: 20,
                max_tokens: 35_000,
                timeout_secs: 240,
            },
            approval_mode: WorkflowApprovalMode::ReviewRequired,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            updated_at: "2026-11-10T00:00:00Z".to_string(),
        }
    }

    /// 返回出厂预置的 3 大固定流程集合
    pub fn defaults() -> Vec<Self> {
        vec![
            Self::default_source_ingestion(),
            Self::default_fact_impact_sentinel(),
            Self::default_weekly_review(),
        ]
    }
}

/// 运行状态枚举 / Workflow run execution status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus {
    Queued,
    Running,
    Completed,
    BudgetExhausted,
    Failed,
    Cancelled,
}

impl WorkflowRunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::BudgetExhausted => "budget_exhausted",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "budget_exhausted" => Some(Self::BudgetExhausted),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// 历史运行记录实体 / Workflow run execution record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRunRecord {
    pub id: String,
    pub workflow_id: String,
    pub kind: WorkflowKind,
    pub status: WorkflowRunStatus,
    pub is_dry_run: bool,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: u64,
    pub api_calls_used: usize,
    pub tokens_used: usize,
    pub items_processed: usize,
    pub changeset_id: Option<String>,
    pub summary_json: Option<String>,
    pub error_message: Option<String>,
}

/// 动作预览条目 / Detailed action preview item for dry run & audit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSummary {
    /// 动作类型: create_note, update_relation, flag_obsolete, generate_digest 等
    pub action_type: String,
    pub target: String,
    pub description: String,
    pub diff_preview: Option<String>,
}

/// 试运行预览结果 / Dry Run Simulation Result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDryRunResult {
    pub workflow_id: String,
    pub kind: WorkflowKind,
    pub simulated_at: String,
    pub actions_preview: Vec<ActionSummary>,
    pub estimated_api_calls: usize,
    pub estimated_tokens: usize,
    pub summary_markdown: Option<String>,
    pub generated_changeset_draft: Option<serde_json::Value>,
}

/// 真实执行结果 / Real Execution Output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRunResult {
    pub run_id: String,
    pub workflow_id: String,
    pub kind: WorkflowKind,
    pub status: WorkflowRunStatus,
    pub is_dry_run: bool,
    pub items_processed: usize,
    pub api_calls_used: usize,
    pub tokens_used: usize,
    pub changeset_id: Option<String>,
    pub summary_markdown: String,
    pub actions: Vec<ActionSummary>,
}
