//! 统一知识对象层的类型 / types for the unified knowledge-object layer.
//!
//! 这一层不替换 `files`/`chunks`/`ai_memory`，而是在它们之上给 Agent 一个稳定、
//! 可寻址、可解释的身份层。原始 Markdown 仍然是内容权威，这里的每一行都可以从
//! vault 重建。
//!
//! ## 为什么新表的时间统一用毫秒整数
//!
//! 旧表混用 `TEXT DEFAULT (datetime('now'))`（`files`、`note_relations`）和
//! `INTEGER` 毫秒（`note_snapshots`、`agent_run_journal`、`review_cards`）。新表
//! 一律用 `_ms INTEGER`：排序和区间查询不必解析字符串，也不会因为某次写入带了
//! 本地时区而让比较失效。`valid_from_ms` / `valid_to_ms` 沿用 `fact_history` 的
//! 双时间线语义，只是换成同一种可比较的表示。

use serde::{Deserialize, Serialize};

/// 一个跨重索引不变的对象 ID / an object id that survives reindexing.
///
/// 用 UUID v4 而不是 `file_path` 或 `chunk_id`：重命名笔记、重新分块、重建索引
/// 都不能改变对象身份，否则 evidence、relation、changeset 全部悬空。
pub fn new_object_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 当前时间（毫秒）/ wall-clock now in milliseconds.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 内容校验和 / the content checksum stored on versions and evidence.
///
/// 与 `embedding_cache` 的 key 同一种算法（SHA-256 十六进制），这样"内容是否变过"
/// 在缓存层和对象层是同一个判断。
pub fn checksum(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 定义一个「存成字符串的枚举」/ define an enum persisted as a text column.
///
/// `parse` 对未知取值返回 `None` 而不是回退到某个默认值：新工具、新 kind、新
/// lifecycle 默认 fail closed，不能因为读到不认识的字符串就被当成安全值。
macro_rules! str_enum {
    (
        $(#[$meta:meta])*
        $name:ident { $( $variant:ident => $text:literal ),+ $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $( $variant ),+ }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self { $( Self::$variant => $text ),+ }
            }

            /// 未知取值返回 `None` / an unrecognised value yields `None`.
            pub fn parse(s: &str) -> Option<Self> {
                match s { $( $text => Some(Self::$variant), )+ _ => None }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

str_enum! {
    /// 对象种类 / what a `knowledge_objects` row represents.
    ///
    /// `Document` 与 `Block` 分别以 `files` 和 `chunks` 为 legacy backing store，
    /// 其余种类以本层为事实源。
    ObjectKind {
        Document => "document",
        Block => "block",
        Memory => "memory",
        Fact => "fact",
        Claim => "claim",
        Event => "event",
        Task => "task",
        Skill => "skill",
        Resource => "resource",
        Collection => "collection",
    }
}

str_enum! {
    /// 对象状态 / object lifecycle status.
    ///
    /// `Deleted` 是墓碑，不是物理删除：撤销一轮 Agent 变更要能找回对象身份。
    ObjectStatus {
        Active => "active",
        Archived => "archived",
        Superseded => "superseded",
        Deleted => "deleted",
    }
}

str_enum! {
    /// 记忆生命周期 / the memory lifecycle this layer replaces DELETE+INSERT with.
    MemoryLifecycle {
        Candidate => "candidate",
        Verified => "verified",
        Active => "active",
        Superseded => "superseded",
        Expired => "expired",
        Archived => "archived",
        Forgotten => "forgotten",
    }
}

str_enum! {
    /// 记忆种类 / memory kind.
    MemoryKind {
        Episodic => "episodic",
        Semantic => "semantic",
        Profile => "profile",
        Procedural => "procedural",
        Resource => "resource",
        Error => "error",
        Task => "task",
    }
}

str_enum! {
    /// 关系来源 / how a relation came to exist.
    ///
    /// 这是「不得让未经确认的 LLM 推断伪装成用户事实」在关系表上的落点：
    /// `Observed` 是文本里真实存在的 wikilink，`Inferred` 是模型算出来的。
    RelationProvenance {
        Observed => "observed",
        Extracted => "extracted",
        Inferred => "inferred",
        Proposed => "proposed",
        UserAuthored => "user_authored",
    }
}

str_enum! {
    /// ChangeSet 状态机 / the change-set state machine.
    ChangeSetState {
        Proposed => "proposed",
        Previewed => "previewed",
        AwaitingApproval => "awaiting_approval",
        Approved => "approved",
        Committed => "committed",
        Rejected => "rejected",
        Conflicted => "conflicted",
        RolledBack => "rolled_back",
        Failed => "failed",
    }
}

str_enum! {
    /// 单个写操作的类型 / the operation a `changeset_ops` row performs.
    ///
    /// 一一对应 `note_ops` 里已有的真实写回函数，不新造写入语义。
    ChangeOpKind {
        Create => "create",
        Edit => "edit",
        Patch => "patch",
        Append => "append",
        Rename => "rename",
        Move => "move",
        Delete => "delete",
        Merge => "merge",
    }
}

str_enum! {
    /// 可恢复任务状态 / ingestion job status.
    JobStatus {
        Pending => "pending",
        Running => "running",
        Succeeded => "succeeded",
        Failed => "failed",
        Cancelled => "cancelled",
    }
}

str_enum! {
    /// 承诺/任务状态 / commitment status.
    CommitmentStatus {
        Proposed => "proposed",
        Active => "active",
        Done => "done",
        Snoozed => "snoozed",
        Dismissed => "dismissed",
        Expired => "expired",
    }
}

/// 对象来自哪里 / where an object's content physically lives.
///
/// backfill 完成前 `source_id` 就是 `files.path` 或 `chunks.id`；对象层对外只承诺
/// `object_id` 稳定，不承诺 `source_id` 稳定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub source_type: String,
    pub source_id: String,
}

impl SourceRef {
    pub fn file(path: &str) -> Self {
        Self { source_type: "file".into(), source_id: path.to_string() }
    }

    pub fn chunk(chunk_id: i64) -> Self {
        Self { source_type: "chunk".into(), source_id: chunk_id.to_string() }
    }

    pub fn session(session_id: &str) -> Self {
        Self { source_type: "chat_session".into(), source_id: session_id.to_string() }
    }
}

/// 一个知识对象 / one addressable knowledge object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObject {
    pub id: String,
    pub kind: ObjectKind,
    /// vault 根路径。跨 vault 召回要能被标记 warning，所以 scope 是一等字段。
    pub scope: String,
    pub parent_id: Option<String>,
    pub source: Option<SourceRef>,
    pub title: Option<String>,
    /// `Document`/`Block` 留空——内容权威在 Markdown 里，这里存副本只会产生第二事实源。
    pub canonical_content: Option<String>,
    pub content_format: String,
    pub status: ObjectStatus,
    pub current_version: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub valid_from_ms: Option<i64>,
    pub valid_to_ms: Option<i64>,
    pub supersedes_id: Option<String>,
    pub confidence: f64,
    pub user_confirmed: bool,
    /// 任意附加字段的 JSON 对象。schema 演进先落在这里，稳定后再提列。
    pub metadata_json: Option<String>,
}

/// 对象的一个历史版本 / one historical version of an object.
///
/// `expected_version` 冲突检测读的就是这张表：提交时比对 `checksum`，不匹配即冲突，
/// 绝不静默覆盖用户编辑。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectVersion {
    pub object_id: String,
    pub version: i64,
    pub content: Option<String>,
    pub checksum: String,
    /// `user` / `agent` / `scheduler` / `migration`——审计里"谁改的"。
    pub actor: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub changeset_id: Option<String>,
    pub created_at_ms: i64,
    pub valid_from_ms: Option<i64>,
    pub valid_to_ms: Option<i64>,
}

/// 一条证据 / one piece of evidence backing a claim.
///
/// `locator` 是"回到原文哪一行"的可点击坐标（如 `path#L12-L18` 或 `chunk:41`）。
/// 没有 locator 的事实在 UI 上只能显示为不可验证。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub id: String,
    pub source_type: String,
    pub source_id: String,
    pub locator: Option<String>,
    pub excerpt: Option<String>,
    pub checksum: Option<String>,
    pub captured_at_ms: i64,
    pub author: Option<String>,
    /// 抽取这条证据的模型与 pipeline 版本。换模型后旧结论要能被重新评估。
    pub extraction_model: Option<String>,
    pub pipeline_version: Option<String>,
}

/// 对象与证据的绑定 / the object↔evidence binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectEvidence {
    pub object_id: String,
    pub evidence_id: String,
    /// `supports` / `contradicts` / `source` / `completion`。
    pub role: String,
    pub confidence: f64,
}

/// 带 provenance 的关系 / a relation that knows where it came from.
///
/// 与 `note_relations` 并存：那张表按路径连边、被图谱和 backlinks 读取，继续可用；
/// 这张表按对象 ID 连边，并且能表达 provenance、有效期、冲突与被取代。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelationV2 {
    pub id: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub relation_type: String,
    pub provenance: RelationProvenance,
    pub confidence: f64,
    pub valid_from_ms: Option<i64>,
    pub valid_to_ms: Option<i64>,
    pub status: ObjectStatus,
    pub evidence_ids: Vec<String>,
    pub supersedes_id: Option<String>,
    pub conflicts_with_id: Option<String>,
    pub created_at_ms: i64,
}

/// 一条对象化记忆 / one lifecycle-managed memory item.
///
/// `ai_memory` 继续作为 legacy recall 的后端；这张表是生命周期、证据、取代链和
/// 冲突集的事实源。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    pub object_id: Option<String>,
    pub kind: MemoryKind,
    pub lifecycle: MemoryLifecycle,
    pub claim: String,
    pub scope: String,
    pub confidence: f64,
    pub importance: f64,
    pub source: Option<SourceRef>,
    pub valid_from_ms: Option<i64>,
    pub valid_to_ms: Option<i64>,
    pub supersedes_id: Option<String>,
    pub conflicts_with_id: Option<String>,
    /// 谁确认的（`user` / `null`）。模型自己不能把自己升级成 verified。
    pub confirmed_by: Option<String>,
    pub confirmed_at_ms: Option<i64>,
    pub requires_user_confirmation: bool,
    pub last_accessed_ms: Option<i64>,
    pub expires_at_ms: Option<i64>,
    /// 兼容 `memory.md` 的五个 canonical section 之一。
    pub section: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 一批待审批的写入 / one batch of proposed writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub id: String,
    pub actor: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub intent: Option<String>,
    pub state: ChangeSetState,
    pub risk: String,
    pub requires_approval: bool,
    pub dry_run: bool,
    pub evidence_ids: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub commit_error: Option<String>,
}

/// ChangeSet 里的一个写操作 / one operation inside a change set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSetOp {
    pub id: String,
    pub changeset_id: String,
    pub seq: i64,
    pub target_object_id: Option<String>,
    pub legacy_path: Option<String>,
    pub legacy_chunk_id: Option<i64>,
    pub op_kind: ChangeOpKind,
    pub old_version: Option<i64>,
    /// 提交前必须与磁盘现状一致，否则返回 conflict。
    pub expected_checksum: Option<String>,
    pub new_content: Option<String>,
    pub patch: Option<String>,
    pub reason: Option<String>,
    pub evidence_ids: Vec<String>,
    /// rename/merge 会波及别的笔记（wikilink retarget），这里记下来。
    pub affected_objects: Vec<String>,
    /// 无法逐项自动回滚的副作用，撤销 UI 必须如实告知用户。
    pub side_effects: Option<String>,
}

/// 一条审计事件 / one audit event.
///
/// 明确不存：API key、token、完整私密 prompt。`metadata_json` 只放已脱敏内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: String,
    pub actor: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub event: String,
    pub object_id: Option<String>,
    pub tool_name: Option<String>,
    pub scope: Option<String>,
    pub before_version: Option<i64>,
    pub after_version: Option<i64>,
    pub result: String,
    pub metadata_json: Option<String>,
    pub created_at_ms: i64,
}

/// 一个可恢复的 ingestion/backfill 任务 / one resumable ingestion job.
///
/// 大规模 backfill 不能阻塞启动，也不能失败即丢失。`idempotency_key` 唯一，
/// 重复入队是 no-op。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestionJob {
    pub id: String,
    pub idempotency_key: String,
    pub job_type: String,
    pub source_type: String,
    pub source_id: String,
    pub source_checksum: Option<String>,
    pub status: JobStatus,
    pub progress: f64,
    pub attempt: i64,
    pub next_attempt_at_ms: Option<i64>,
    pub last_error: Option<String>,
    pub pipeline_version: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 一条承诺 / open loop / one commitment or open loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCommitment {
    pub id: String,
    pub object_id: Option<String>,
    pub commitment_type: String,
    pub title: String,
    pub source: Option<SourceRef>,
    pub evidence_ids: Vec<String>,
    pub owner: Option<String>,
    pub status: CommitmentStatus,
    pub priority: i64,
    pub due_at_ms: Option<i64>,
    pub remind_at_ms: Option<i64>,
    /// 同一件事只提醒一次的去重键。
    pub dedupe_key: String,
    pub proactive_enabled: bool,
    pub last_notified_at_ms: Option<i64>,
    pub notify_count: i64,
    pub completion_evidence_id: Option<String>,
    /// 完成后把结果写回哪里（object id 或路径）。只把任务标成 done 不算闭环。
    pub return_target: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 一个派生投影的健康状况 / the health of one derived projection.
///
/// 这张表存在的唯一理由是 Index Health 面板必须显示真实数字。任何固定值、
/// 静态 mock 都违反本层的契约。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionHealth {
    pub projection: String,
    pub version: i64,
    pub total_count: i64,
    pub indexed_count: i64,
    pub pending_count: i64,
    pub failed_count: i64,
    pub last_run_at_ms: Option<i64>,
    pub last_error: Option<String>,
    pub updated_at_ms: i64,
}
