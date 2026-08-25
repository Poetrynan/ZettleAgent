//! ChangeSet：Agent 写入的唯一合法通道 / the only legal channel for agent writes.
//!
//! ## 为什么写入不能直接落盘
//!
//! 一个 Agent 直接调 `note_ops::execute_edit_note` 的世界里，用户看到的是"文件变了"，
//! 看不到"为什么变、依据是什么、改之前是什么样、能不能退回去"。这四个问题的答案必须
//! 在**写之前**就存在，否则事后补不出来。
//!
//! 所以每次 Agent 写入都要经过：
//!
//! ```text
//! propose → add_op → validate（scope + capability + 越权）
//!         → dry_run（读现状、算 diff、检 expected_version/checksum）
//!         → 审批（llm::approval::decide / decide_ambient，本模块不重新发明）
//!         → commit（真实写回由调用方的 note_ops 完成）
//!         → record_commit（追加 object_versions + audit + 索引刷新）
//! ```
//!
//! ## 本模块不做什么
//!
//! **不写文件。** 真实写回仍然是 `tools::internal_tools::note_ops` 的职责——那里有
//! 快照、回收站、journal、undo、wikilink retarget。本模块负责的是写之前的把关和写
//! 之后的记账。硬要把文件 IO 塞进 rusqlite 事务里，只会得到一个既不原子也不可回滚的
//! 四不像：SQLite 能回滚，磁盘不能。
//!
//! 分工的边界是 [`record_commit`]：调用方写盘成功后调它，失败则调
//! [`mark_failed`]。两边都不调 = changeset 停在 `approved`，`stale_changesets`
//! 能查出来，不会静静消失。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::object_store::{self, ObjectError, ObjectResult};
use super::types::*;
use crate::tools::capability;

/// 提议一次变更 / propose one change set.
#[derive(Debug, Clone)]
pub struct NewChangeSet {
    pub actor: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub intent: Option<String>,
    /// 允许写入的路径前缀。**空表示不允许写任何东西**，不是"允许全部"。
    ///
    /// 这个默认值方向刻意与 `ToolScope` 一致：空集合读成"全部"是那种一年后才爆的 bug。
    pub scopes: Vec<String>,
    pub evidence_ids: Vec<String>,
}

impl NewChangeSet {
    pub fn new(actor: impl Into<String>) -> Self {
        Self {
            actor: actor.into(),
            session_id: None,
            run_id: None,
            intent: None,
            scopes: Vec::new(),
            evidence_ids: Vec::new(),
        }
    }
}

/// 要加进 changeset 的一个操作 / one operation to stage.
#[derive(Debug, Clone)]
pub struct NewOp {
    pub op_kind: ChangeOpKind,
    /// 目标对象。为 `None` 时靠 `legacy_path` 定位（backfill 未覆盖的笔记）。
    pub target_object_id: Option<String>,
    pub legacy_path: Option<String>,
    pub legacy_chunk_id: Option<i64>,
    pub new_content: Option<String>,
    pub patch: Option<String>,
    pub reason: Option<String>,
    pub evidence_ids: Vec<String>,
    /// 产生这个操作的工具名。能力校验按它来判，而不是按 op_kind 猜。
    pub tool_name: String,
    /// 操作针对的对象类型，用于越权检查。
    pub target_kind: ObjectKind,
    /// 除了改内容之外还会发生什么（改名的新路径、合并的目标）。
    ///
    /// 落在库里而不是只存在调用方的内存里：一次改名如果写盘成功、进程随后被杀，
    /// 重绑信息还得能从 `changeset_ops` 里捞出来，否则对象就永久指着旧路径。
    pub side_effects: Option<String>,
    /// Agent 真正读到的那一版 / the version the agent actually read.
    ///
    /// 给了就用它当乐观并发的基线，而不是用"准备写入这一刻"的当前版本。这条是
    /// 读→写窗口的唯一防线：不给的话，用户在 Agent 读完之后的手改会被当成不存在。
    pub observed_read: Option<ObservedRead>,
}

/// 一次读留下的基线 / the baseline one read established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedRead {
    pub version: i64,
    pub checksum: Option<String>,
    pub read_at_ms: i64,
}

/// 一条关系操作的完整载荷 / everything one relation operation needs.
///
/// 存在 `changeset_ops.patch` 里，而不是塞进 `new_content`。两个理由：
///
/// - `record_commit` 看见 `new_content` 就会给对象追加一个新版本并把这段字符串当成
///   笔记正文的指纹。关系不是正文，那样记出来的是假指纹。
/// - 关系操作的目标是**一对**对象，`legacy_path` 只装得下一个。源放 `legacy_path`
///   （scope 检查要用），另一端和关系语义放这里。
///
/// `old_*` 是删除时的原值：撤销一次删除要能把置信度和理由一起还原，否则"撤销"会
/// 悄悄把一条用户确认过的边降级成默认值。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationOp {
    pub source_path: String,
    pub target_path: String,
    pub relation_type: String,
    pub confidence: f64,
    pub reason: Option<String>,
    /// 谁提出的：`user_link` / `agent_proposed` / `semantic` / `external`。
    pub origin: String,
    pub old_confidence: Option<f64>,
    pub old_reason: Option<String>,
    /// 提交时源/目标笔记应该是哪一版。只用于审计与 verify，不参与冲突判定——
    /// 关系行的冲突在关系本身（已存在/不存在/被用户拒过），而不是在正文版本上。
    pub expected_source_version: Option<i64>,
    pub expected_target_version: Option<i64>,
}

impl RelationOp {
    /// 人话一行 / one line a human can read in the review UI.
    pub fn summary(&self) -> String {
        format!(
            "{} --[{}]--> {} (confidence {:.2})",
            self.source_path, self.relation_type, self.target_path, self.confidence
        )
    }
}

/// 这个 op 改的是关系而不是文件吗 / does this op touch an edge rather than a file?
pub fn is_relation_kind(kind: ChangeOpKind) -> bool {
    matches!(
        kind,
        ChangeOpKind::AddRelation | ChangeOpKind::DeleteRelation
    )
}

/// 取出关系载荷 / the relation payload this op carries, if any.
pub fn relation_payload(op: &ChangeSetOp) -> Option<RelationOp> {
    if !is_relation_kind(op.op_kind) {
        return None;
    }
    serde_json::from_str(op.patch.as_deref()?).ok()
}


impl NewOp {
    pub fn new(op_kind: ChangeOpKind, tool_name: impl Into<String>) -> Self {
        Self {
            op_kind,
            target_object_id: None,
            legacy_path: None,
            legacy_chunk_id: None,
            new_content: None,
            patch: None,
            reason: None,
            evidence_ids: Vec::new(),
            tool_name: tool_name.into(),
            target_kind: ObjectKind::Document,
            side_effects: None,
            observed_read: None,
        }
    }

    pub fn on_path(mut self, path: impl Into<String>) -> Self {
        self.legacy_path = Some(path.into());
        self
    }

    pub fn on_object(mut self, object_id: impl Into<String>) -> Self {
        self.target_object_id = Some(object_id.into());
        self
    }

    pub fn with_content(mut self, content: impl Into<String>) -> Self {
        self.new_content = Some(content.into());
        self
    }

    pub fn because(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

/// 为什么一个操作被拒 / why an operation was refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum Refusal {
    /// 目标路径不在允许的 scope 内。
    OutOfScope(String),
    /// 工具没有声明可以碰这一类对象。
    NotPermitted(String),
    /// 既没有对象 ID 也没有路径——无法定位要改什么。
    NoTarget,
    /// 写入内容为空但操作要求内容。
    MissingContent,
    /// 这次调用被认成写入，但从参数里解析不出**任何**一个真实操作。
    ///
    /// 独立变体而不是复用 `NoTarget`：那个说的是"某一个 op 没有目标"，这个说的是
    /// "整次调用一个 op 都建不出来"。处置都是拒绝，但给模型的话不同——后者要它把参数
    /// 补全重试，而不是换个目标。
    NoResolvableOperation(String),
    /// 这个写工具的参数形状没人登记过，改动无法预演也无法回滚。
    ///
    /// 与 `NoResolvableOperation` 分开，因为原因和出路都不同：那个是这一次的参数没填
    /// 全，重试有用；这个是工具本身还没接进 ChangeSet，重试多少次都一样。告诉模型
    /// "补全参数"在这里是假建议。
    UnmappedWriteTool(String),
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Self::OutOfScope(path) => format!("`{path}` 不在本次允许写入的范围内"),
            Self::NotPermitted(what) => format!("工具没有声明可以修改 {what}"),
            Self::NoTarget => "操作没有指定目标笔记或对象".to_string(),
            Self::MissingContent => "操作需要新内容，但内容为空".to_string(),
            Self::NoResolvableOperation(tool) => format!(
                "`{tool}` 是写入操作，但参数里解析不出要改哪一处，已拒绝执行；请补全参数后重试"
            ),
            Self::UnmappedWriteTool(tool) => format!(
                "`{tool}` 的写入还不能被预览或撤销，已拒绝执行；请改用笔记写入工具，\
                 或让用户自己完成这一步"
            ),
        }
    }
}

// ── 提议与登记 / proposing and staging ──────────────────────────────────────

/// 新建一个 changeset / open a change set.
///
/// 初始状态 `proposed`、`dry_run = 1`、`requires_approval = 1`。三个默认值都朝
/// "更保守"的方向：一个刚建出来的 changeset 不该已经获得提交许可。
pub fn propose(conn: &Connection, req: &NewChangeSet) -> ObjectResult<ChangeSet> {
    let id = new_object_id();
    let now = now_ms();
    let evidence = serde_json::to_string(&req.evidence_ids).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "INSERT INTO changesets
            (id, actor, session_id, run_id, intent, state, risk, requires_approval,
             dry_run, evidence_ids, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, 'proposed', 'low', 1, 1, ?6, ?7, ?7)",
        params![
            id,
            req.actor,
            req.session_id,
            req.run_id,
            req.intent,
            evidence,
            now
        ],
    )?;

    // scope 存在 audit 里而不是 changesets 表：它属于"这次提议的约束条件"，
    // 与操作一起被审计，而不是一个可以事后改的列。
    object_store::record_audit(
        conn,
        &req.actor,
        "changeset_proposed",
        "proposed",
        None,
        None,
        req.run_id.as_deref(),
        req.session_id.as_deref(),
        req.scopes.first().map(|s| s.as_str()),
        None,
        None,
        Some(&serde_json::json!({ "scopes": req.scopes, "intent": req.intent }).to_string()),
    )?;

    get(conn, &id)?.ok_or_else(|| ObjectError::NotFound(id))
}

/// 校验并登记一个操作 / validate and stage one operation.
///
/// 校验在**入库前**做：一个越权的操作根本不该出现在 changeset 里，否则 dry-run 的
/// diff 会显示一个永远不会被执行的改动，那比拒绝更让人困惑。
pub fn add_op(
    conn: &Connection,
    changeset_id: &str,
    scopes: &[String],
    op: &NewOp,
) -> ObjectResult<Result<ChangeSetOp, Refusal>> {
    if let Some(refusal) = validate_op(scopes, op) {
        return Ok(Err(refusal));
    }

    // 目标对象的基线：优先用 Agent 读到的那一版，退回到"此刻的当前版本"。
    let (old_version, expected_checksum) = baseline_of(conn, op)?;
    let baseline_read_at_ms = op
        .observed_read
        .as_ref()
        .filter(|_| old_version.is_some())
        .map(|r| r.read_at_ms);

    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM changeset_ops WHERE changeset_id = ?1",
            params![changeset_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let id = new_object_id();
    conn.execute(
        "INSERT INTO changeset_ops
            (id, changeset_id, seq, target_object_id, legacy_path, legacy_chunk_id, op_kind,
             old_version, expected_checksum, new_content, patch, reason, evidence_ids,
             affected_objects, side_effects, baseline_read_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, '[]', ?14, ?15)",
        params![
            id,
            changeset_id,
            seq,
            op.target_object_id,
            op.legacy_path,
            op.legacy_chunk_id,
            op.op_kind.as_str(),
            old_version,
            expected_checksum,
            op.new_content,
            op.patch,
            op.reason,
            serde_json::to_string(&op.evidence_ids).unwrap_or_else(|_| "[]".into()),
            op.side_effects,
            baseline_read_at_ms,
        ],
    )?;

    touch(conn, changeset_id)?;
    let staged = get_op(conn, &id)?.ok_or_else(|| ObjectError::NotFound(id))?;
    Ok(Ok(staged))
}

/// 纯函数式的校验 / the validation, with no database involved.
///
/// 单独抽出来是为了能被直接测：scope 与能力判断不该只有跑一次完整 changeset 才能验证。
pub fn validate_op(scopes: &[String], op: &NewOp) -> Option<Refusal> {
    if op.target_object_id.is_none() && op.legacy_path.is_none() {
        return Some(Refusal::NoTarget);
    }

    if !capability::may_target(&op.tool_name, op.target_kind) {
        return Some(Refusal::NotPermitted(op.target_kind.as_str().to_string()));
    }

    if let Some(path) = &op.legacy_path {
        if !path_in_scope(path, scopes) {
            return Some(Refusal::OutOfScope(path.clone()));
        }
    }

    // 关系操作的两端都要在 scope 内，而且载荷必须解得开。
    //
    // 只检查 `legacy_path`（源）是不够的：一条边把库内的笔记连到库外的路径，写进
    // `note_relations` 之后每个读关系表的地方都会看到一个库外目标。载荷解不开则说明
    // 这个 op 根本没法预览也没法撤销，拒绝比"先记下来再说"安全。
    if is_relation_kind(op.op_kind) {
        let Some(raw) = op.patch.as_deref() else {
            return Some(Refusal::NoResolvableOperation(op.tool_name.clone()));
        };
        let Ok(payload) = serde_json::from_str::<RelationOp>(raw) else {
            return Some(Refusal::NoResolvableOperation(op.tool_name.clone()));
        };
        if payload.relation_type.trim().is_empty() {
            return Some(Refusal::NoResolvableOperation(op.tool_name.clone()));
        }
        if !path_in_scope(&payload.target_path, scopes) {
            return Some(Refusal::OutOfScope(payload.target_path.clone()));
        }
    }

    // create/edit 必须带内容；patch 带 patch 就够。
    let needs_content = matches!(
        op.op_kind,
        ChangeOpKind::Create | ChangeOpKind::Edit | ChangeOpKind::Append
    );
    if needs_content && op.new_content.as_deref().unwrap_or("").is_empty() {
        return Some(Refusal::MissingContent);
    }

    None
}

/// scope 判断 / is this path inside one of the allowed prefixes.
///
/// 空 scope 集合 = 什么都不允许。见 [`NewChangeSet::scopes`] 的说明。
fn path_in_scope(path: &str, scopes: &[String]) -> bool {
    if scopes.is_empty() {
        return false;
    }
    let normalized = path.replace('\\', "/");
    scopes.iter().any(|s| {
        let prefix = s.replace('\\', "/");
        normalized == prefix || normalized.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
    })
}

/// 取乐观并发的基线 / the optimistic-concurrency baseline.
///
/// 优先级是**先读记录、后当前版本**，这个顺序就是读→写窗口的防线：
///
/// - Agent 在这一轮读过这篇笔记 → 基线是它读到的那一版。用户在读之后的手改会让
///   版本号对不上，冲突被如实报出来。
/// - 没有读记录（新建、backfill 未覆盖、或者写工具压根没先读） → 退回到此刻的
///   当前版本。这拦得住"提议与提交之间有人改过"，拦不住读→写窗口——但没有读记录时
///   也确实无从知道 Agent 看到的是哪一版，编一个只会制造假冲突。
///
/// 校验和住在 `object_versions` 而不是 `knowledge_objects`：对象行只记"当前是第几版"，
/// 内容指纹跟着版本走，否则回滚到旧版时校验和就对不上了。
fn baseline_of(conn: &Connection, op: &NewOp) -> ObjectResult<(Option<i64>, Option<String>)> {
    // 关系操作没有"正文基线"。硬给它一个源笔记的版本号，用户在 Agent 读完笔记之后
    // 改一个错别字就会让一条完全无关的连线报冲突——那是假冲突，会训练用户无脑点通过。
    // 源/目标的版本号记在 `RelationOp::expected_*_version` 里供审计和 verify 使用。
    if is_relation_kind(op.op_kind) {
        return Ok((None, None));
    }

    let object = match (&op.target_object_id, &op.legacy_path) {
        (Some(id), _) => object_store::get_object(conn, id)?,
        (None, Some(path)) => object_store::find_by_source(conn, &SourceRef::file(path))?,
        (None, None) => None,
    };

    let Some(object) = object else {
        // backfill 还没覆盖到：没有基线可用，如实留空而不是编一个 0。
        return Ok((None, None));
    };

    if let Some(read) = &op.observed_read {
        return Ok((Some(read.version), read.checksum.clone()));
    }

    let checksum = object_store::get_object_version(conn, &object.id, object.current_version)?
        .map(|v| v.checksum);
    Ok((Some(object.current_version), checksum))
}

// ── 预演 / dry run ──────────────────────────────────────────────────────────

/// 一个操作的预演结果 / what one staged op would do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpPreview {
    pub op_id: String,
    pub seq: i64,
    pub op_kind: ChangeOpKind,
    pub target_object_id: Option<String>,
    pub path: Option<String>,
    /// 改之前的内容。`None` 表示新建，或者目标读不到（这两件事由 `conflict` 区分）。
    pub before: Option<String>,
    pub after: Option<String>,
    pub reason: Option<String>,
    pub evidence_ids: Vec<String>,
    /// 会被顺带改到的其它对象（wikilink retarget 之类）。
    pub affected_objects: Vec<String>,
    /// 有值就意味着这一步现在不能提交。
    pub conflict: Option<Conflict>,
    /// 冲突的人话版本 / the conflict, phrased for a human.
    ///
    /// 措辞留在 Rust 一份：`kind` 是给程序看的，UI 直接渲染 `kind` 就等于把内部枚举
    /// 名字甩给用户。两边各写一套文案，迟早有一套是错的。
    pub conflict_message: Option<String>,
    /// 关系操作的两端与语义。见 [`OpDetail::relation`]。
    pub relation: Option<RelationOp>,
}

/// 几种不同的冲突 / the distinct kinds of conflict.
///
/// 分开是因为处理方式不同：版本冲突意味着"有人改过了，重新生成一份"，校验和冲突
/// 意味着"磁盘上的内容不是我读到的那份，先让用户看看"。混成一个"写失败"会让 UI
/// 只能给出"重试"这个既无用又危险的选项。
///
/// `StaleRead` 与 `Version` 的区别不在数据上而在**该怎么跟人解释**：前者是"你在
/// Agent 读完之后改过这篇笔记"，责任和处置都清楚；后者只能说"有人改过"。同一个
/// 提示文案覆盖两件事，用户就无从判断自己那次编辑到底还在不在。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Conflict {
    Version { expected: i64, actual: i64 },
    /// Agent 读到的是旧版，之后这篇笔记被改过。
    #[serde(rename_all = "camelCase")]
    StaleRead {
        /// Agent 读到的版本。
        read_version: i64,
        /// 现在的版本。
        actual: i64,
        /// Agent 读的时刻。
        read_at_ms: i64,
    },
    Checksum { expected: String, actual: String },
    /// 目标已经不存在了（被删/被改名）。
    TargetGone { target: String },
    /// 要新增的关系已经在库里了。
    ///
    /// 不是错误，但也**不是成功**：以前 `INSERT OR IGNORE` 把这件事咽了下去，于是
    /// "写了 5 条关系"里可能有 5 条都什么也没做。分成一种冲突，UI 才能如实说
    /// "已存在，未新增"。
    #[serde(rename_all = "camelCase")]
    RelationExists {
        source: String,
        target: String,
        relation_type: String,
    },
    /// 要删除的关系不在库里。
    #[serde(rename_all = "camelCase")]
    RelationMissing {
        source: String,
        target: String,
        relation_type: String,
    },
    /// 用户明确拒绝过这条关系。
    ///
    /// 拦在提交之前而不是提交之后：下一次语义刷新或 Auto-Fix 用同样的理由再建一遍，
    /// 就是"AI 建议反复骚扰"本身。
    #[serde(rename_all = "camelCase")]
    RelationRejectedByUser {
        source: String,
        target: String,
        relation_type: String,
    },
}

impl Conflict {
    pub fn message(&self) -> String {
        match self {
            Self::Version { expected, actual } => {
                format!("目标已从 v{expected} 变到 v{actual}，这份改动是基于旧版本算的")
            }
            Self::StaleRead {
                read_version,
                actual,
                ..
            } => format!(
                "这篇笔记在 Agent 读到 v{read_version} 之后被改到了 v{actual}。\
                 这份改动是基于改之前的内容算的，所以没有落盘——你的编辑还在。"
            ),
            Self::Checksum { .. } => "磁盘上的内容与生成这份改动时读到的不一致".to_string(),
            Self::TargetGone { target } => format!("目标 `{target}` 已不存在"),
            Self::RelationExists {
                source,
                target,
                relation_type,
            } => format!("`{source}` → `{target}` 的 {relation_type} 关系已经存在，不会重复新增"),
            Self::RelationMissing {
                source,
                target,
                relation_type,
            } => format!("`{source}` → `{target}` 没有 {relation_type} 关系可删"),
            Self::RelationRejectedByUser {
                source,
                target,
                relation_type,
            } => format!(
                "你之前拒绝过 `{source}` → `{target}` 的 {relation_type} 关系，\
                 除非重新允许，不会再自动建立"
            ),
        }
    }
}

/// 整个 changeset 的预演 / the whole change set, previewed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunReport {
    pub changeset_id: String,
    pub ops: Vec<OpPreview>,
    /// 有冲突时 `commit` 会被拒绝。UI 据此决定显示"应用"还是"重新生成"。
    pub has_conflicts: bool,
    pub touched_paths: Vec<String>,
}

/// 跑一次预演 / run the dry run.
///
/// 只读：不写文件、不改对象，只把"如果提交会发生什么"算出来。跑完把状态推到
/// `previewed`（有冲突则 `conflicted`），因为"预演过了"本身是提交的前置条件。
pub fn dry_run(conn: &Connection, changeset_id: &str) -> ObjectResult<DryRunReport> {
    let ops = list_ops(conn, changeset_id)?;
    let mut previews = Vec::with_capacity(ops.len());
    let mut touched = Vec::new();

    for op in ops {
        let conflict = detect_conflict(conn, &op)?;
        let before = current_content(conn, &op)?;
        // 关系载荷只解析一次，摘要和结构化字段都从它来。解析两遍就有两份"这条边是什么"。
        let relation = relation_payload(&op);
        // 关系操作的 "after" 从载荷算，不从 `new_content` 取：删除的 after 是"没有这条
        // 边"（`None`），新增的 after 是这条边将长成什么样。
        let after = match (is_relation_kind(op.op_kind), relation.as_ref()) {
            (true, Some(payload)) if op.op_kind == ChangeOpKind::AddRelation => {
                let mut text = payload.summary();
                if let Some(reason) = &payload.reason {
                    text.push('\n');
                    text.push_str(reason);
                }
                Some(text)
            }
            (true, _) => None,
            (false, _) => op.new_content.clone(),
        };

        if let Some(path) = &op.legacy_path {
            if !touched.contains(path) {
                touched.push(path.clone());
            }
        }

        previews.push(OpPreview {
            op_id: op.id,
            seq: op.seq,
            op_kind: op.op_kind,
            target_object_id: op.target_object_id,
            path: op.legacy_path,
            before,
            after,
            reason: op.reason,
            evidence_ids: op.evidence_ids,
            affected_objects: op.affected_objects,
            conflict_message: conflict.as_ref().map(|c| c.message()),
            conflict,
            relation,
        });
    }

    let has_conflicts = previews.iter().any(|p| p.conflict.is_some());
    let next = if has_conflicts {
        ChangeSetState::Conflicted
    } else {
        ChangeSetState::Previewed
    };
    set_state(conn, changeset_id, next, None)?;

    Ok(DryRunReport {
        changeset_id: changeset_id.to_string(),
        ops: previews,
        has_conflicts,
        touched_paths: touched,
    })
}

/// 版本与校验和检查 / the optimistic-concurrency check.
fn detect_conflict(conn: &Connection, op: &ChangeSetOp) -> ObjectResult<Option<Conflict>> {
    if is_relation_kind(op.op_kind) {
        return detect_relation_conflict(conn, op);
    }

    // 没有基线的操作（backfill 未覆盖，或者是新建）无从比较。这不是冲突：
    // 报一个假冲突会让一次完全正常的写入卡住。
    let Some(expected_version) = op.old_version else {
        return Ok(None);
    };
    let Some(object_id) = op.target_object_id.as_deref() else {
        return Ok(None);
    };

    let Some(current) = object_store::get_object(conn, object_id)? else {
        return Ok(Some(Conflict::TargetGone {
            target: object_id.to_string(),
        }));
    };

    if current.current_version != expected_version {
        // 基线来自一次读，就按"读→写窗口"来解释；否则只能说"有人改过"。
        return Ok(Some(match op.baseline_read_at_ms {
            Some(read_at_ms) => Conflict::StaleRead {
                read_version: expected_version,
                actual: current.current_version,
                read_at_ms,
            },
            None => Conflict::Version {
                expected: expected_version,
                actual: current.current_version,
            },
        }));
    }

    // 版本相同但校验和不同 = 有人绕过对象层直接改了文件。这是最需要让用户看一眼的
    // 情况，绝不能静默覆盖。
    let stored = object_store::get_object_version(conn, object_id, current.current_version)?
        .map(|v| v.checksum);
    if let (Some(expected), Some(actual)) = (&op.expected_checksum, &stored) {
        if expected != actual {
            return Ok(Some(Conflict::Checksum {
                expected: expected.clone(),
                actual: actual.clone(),
            }));
        }
    }

    Ok(None)
}

/// 关系操作的冲突 / the conflicts an edge operation can hit.
///
/// 关系没有版本号，所以这里问的是四件事实，而不是比较版本：两端还在不在、这条边现在
/// 在不在、以及用户是不是已经拒绝过它。前两件以前被 `INSERT OR IGNORE` /
/// `DELETE ... WHERE` 的返回值咽掉了，第三件以前根本没人记。
fn detect_relation_conflict(
    conn: &Connection,
    op: &ChangeSetOp,
) -> ObjectResult<Option<Conflict>> {
    let Some(payload) = relation_payload(op) else {
        return Ok(None);
    };

    let file_exists = |path: &str| -> ObjectResult<bool> {
        let hit: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM files WHERE path = ?1 COLLATE NOCASE",
                params![path],
                |r| r.get(0),
            )
            .optional()?;
        Ok(hit.is_some())
    };

    for end in [&payload.source_path, &payload.target_path] {
        if !file_exists(end)? {
            return Ok(Some(Conflict::TargetGone {
                target: end.clone(),
            }));
        }
    }

    let existing = relation_exists(
        conn,
        &payload.source_path,
        &payload.target_path,
        &payload.relation_type,
    )?;

    match op.op_kind {
        ChangeOpKind::AddRelation => {
            if existing {
                return Ok(Some(Conflict::RelationExists {
                    source: payload.source_path,
                    target: payload.target_path,
                    relation_type: payload.relation_type,
                }));
            }
            if relation_rejected(
                conn,
                &payload.source_path,
                &payload.target_path,
                &payload.relation_type,
            )? {
                return Ok(Some(Conflict::RelationRejectedByUser {
                    source: payload.source_path,
                    target: payload.target_path,
                    relation_type: payload.relation_type,
                }));
            }
        }
        ChangeOpKind::DeleteRelation => {
            if !existing {
                return Ok(Some(Conflict::RelationMissing {
                    source: payload.source_path,
                    target: payload.target_path,
                    relation_type: payload.relation_type,
                }));
            }
        }
        _ => {}
    }

    Ok(None)
}

/// 这条边现在在库里吗 / is this exact edge in the table right now?
pub fn relation_exists(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
) -> ObjectResult<bool> {
    let hit: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM note_relations
             WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
            params![source, target, relation_type],
            |r| r.get(0),
        )
        .optional()?;
    Ok(hit.is_some())
}

/// 用户拒绝过这条边吗 / did the user already say no to this edge?
pub fn relation_rejected(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
) -> ObjectResult<bool> {
    let decision: Option<String> = conn
        .query_row(
            "SELECT decision FROM relation_decisions
             WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
            params![source, target, relation_type],
            |r| r.get(0),
        )
        .optional()?;
    Ok(decision.as_deref() == Some("rejected"))
}

/// 记下用户对一条边的判断 / remember what the user decided about an edge.
///
/// `decision` 只有 `accepted` / `rejected` 两种。写这张表是为了让下一次语义刷新和
/// Auto-Fix 能闭嘴，所以即使关系行本身被删了，判断也要留下。
pub fn record_relation_decision(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
    decision: &str,
    reason: Option<&str>,
) -> ObjectResult<()> {
    conn.execute(
        "INSERT INTO relation_decisions
            (source_path, target_path, relation_type, decision, reason, decided_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(source_path, target_path, relation_type) DO UPDATE SET
            decision = ?4, reason = ?5, decided_at_ms = ?6",
        params![source, target, relation_type, decision, reason, now_ms()],
    )?;
    Ok(())
}

/// 取目标当前内容用于 diff / read the current content for the diff.
///
/// `document` 对象不存内容副本（只存校验和），所以内容要从 `chunks` 拼回来——
/// 那是这个进程能看到的、最接近磁盘的东西。
fn current_content(conn: &Connection, op: &ChangeSetOp) -> ObjectResult<Option<String>> {
    // 关系操作的 "before" 是这条边现在的样子，不是源笔记的全文。拼全文会让审查界面
    // 显示"整篇笔记将被替换"，而实际上只多了一行边。
    if is_relation_kind(op.op_kind) {
        let Some(payload) = relation_payload(op) else {
            return Ok(None);
        };
        let existing: Option<(f64, Option<String>, String)> = conn
            .query_row(
                "SELECT confidence, reason, COALESCE(origin, 'user_link') FROM note_relations
                 WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
                params![
                    payload.source_path,
                    payload.target_path,
                    payload.relation_type
                ],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        return Ok(existing.map(|(confidence, reason, origin)| {
            format!(
                "{} --[{}]--> {} (confidence {:.2}, origin {}){}",
                payload.source_path,
                payload.relation_type,
                payload.target_path,
                confidence,
                origin,
                reason
                    .map(|r| format!("\n{r}"))
                    .unwrap_or_default()
            )
        }));
    }

    let Some(path) = &op.legacy_path else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT content FROM chunks WHERE file_path = ?1 ORDER BY chunk_index",
    )?;
    let parts: Vec<String> = stmt
        .query_map(params![path], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(parts.join("\n\n")))
}

// ── 状态机 / the state machine ──────────────────────────────────────────────

/// 允许的状态迁移 / which transitions are legal.
///
/// 显式列出而不是"随便改"：`committed → proposed` 之类的迁移会让审计线索变成假的。
/// 非法迁移返回 `false`，调用方拿到 `Err`，而不是数据库里出现一个不可能的状态。
fn transition_allowed(from: ChangeSetState, to: ChangeSetState) -> bool {
    use ChangeSetState::*;
    match (from, to) {
        // 预演可以反复跑（内容或磁盘变了都要重算，或者已批准的批次在落盘前重新校验）。
        (Proposed | Previewed | Conflicted | Approved, Previewed | Conflicted) => true,
        (Previewed, AwaitingApproval | Approved) => true,
        (AwaitingApproval, Approved | Rejected) => true,
        (Approved, Committed | Failed) => true,
        (Committed, RolledBack) => true,
        // 任何还没进终态的批次都可以被用户否掉（`AwaitingApproval` 已在上面覆盖）。
        (Proposed | Previewed | Conflicted, Rejected) => true,
        _ => false,
    }
}

/// 推进状态 / move the change set to a new state.
pub fn set_state(
    conn: &Connection,
    changeset_id: &str,
    to: ChangeSetState,
    error: Option<&str>,
) -> ObjectResult<ChangeSet> {
    let current = get(conn, changeset_id)?
        .ok_or_else(|| ObjectError::NotFound(changeset_id.to_string()))?;

    if current.state == to {
        return Ok(current);
    }
    if !transition_allowed(current.state, to) {
        return Err(ObjectError::Search(format!(
            "illegal changeset transition {} → {}",
            current.state.as_str(),
            to.as_str()
        )));
    }

    conn.execute(
        "UPDATE changesets SET state = ?2, updated_at_ms = ?3, commit_error = COALESCE(?4, commit_error)
         WHERE id = ?1",
        params![changeset_id, to.as_str(), now_ms(), error],
    )?;

    object_store::record_audit(
        conn,
        &current.actor,
        "changeset_state",
        to.as_str(),
        None,
        None,
        current.run_id.as_deref(),
        current.session_id.as_deref(),
        None,
        None,
        None,
        Some(&serde_json::json!({ "from": current.state.as_str(), "to": to.as_str() }).to_string()),
    )?;

    get(conn, changeset_id)?.ok_or_else(|| ObjectError::NotFound(changeset_id.to_string()))
}

/// 记录用户的裁决 / record the user's decision.
///
/// 审批本身由 `llm::approval` 决定（规则、ambient 模式、风险上限），本模块只把结果
/// 落到状态机上——审批逻辑有两份实现的那天，就是它们开始不一致的那天。
pub fn record_decision(
    conn: &Connection,
    changeset_id: &str,
    approved: bool,
) -> ObjectResult<ChangeSet> {
    let target = if approved {
        ChangeSetState::Approved
    } else {
        ChangeSetState::Rejected
    };
    set_state(conn, changeset_id, target, None)
}

/// 写盘成功后记账 / book-keeping after the real write landed.
///
/// **必须在文件写成功之后调用。** 这里做三件事，全部在一个事务里：
///
/// 1. 给每个被改的对象追加一条 `object_versions`（谁改的、哪个 changeset、新校验和）；
/// 2. 把 changeset 推到 `committed`；
/// 3. 记一条审计事件。
///
/// 事务保证的是"版本记录与状态一致"。文件已经落盘了，那部分不在事务里也不该在——
/// 见模块文档关于 SQLite 能回滚而磁盘不能的说明。
pub fn record_commit(conn: &Connection, changeset_id: &str) -> ObjectResult<usize> {
    let cs = get(conn, changeset_id)?
        .ok_or_else(|| ObjectError::NotFound(changeset_id.to_string()))?;
    if cs.state != ChangeSetState::Approved {
        return Err(ObjectError::Search(format!(
            "changeset {} is {} — only an approved change set can be committed",
            changeset_id,
            cs.state.as_str()
        )));
    }

    let ops = list_ops(conn, changeset_id)?;
    let mut versioned = 0usize;

    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| -> ObjectResult<()> {
        for op in &ops {
            let Some(object_id) = &op.target_object_id else {
                continue;
            };
            match op.op_kind {
                // 文件已经不在了。写一条空内容的新版本等于宣称"这篇笔记现在是空的"，
                // 而事实是它被删了——墓碑才是那个事实。
                ChangeOpKind::Delete => {
                    object_store::tombstone_object(conn, object_id)?;
                }
                // 改名/移动不改内容，不该占一个版本号。`source_id` 的重绑由调用方
                // 在写盘成功后做（它才知道新路径），见 `write_guard::settle`。
                ChangeOpKind::Rename | ChangeOpKind::Move => continue,
                _ => {
                    // 没有落定内容就没有可信的校验和。跳过比记一个假指纹强：假指纹
                    // 会让下一次写入报出一个不存在的 checksum 冲突。
                    let Some(content) = op.new_content.as_deref() else {
                        continue;
                    };
                    object_store::update_object_patch(
                        conn,
                        object_id,
                        object_store::ObjectPatch {
                            content: Some(content.to_string()),
                            expected_version: op.old_version,
                            changeset_id: Some(changeset_id.to_string()),
                            actor: cs.actor.clone(),
                            run_id: cs.run_id.clone(),
                            session_id: cs.session_id.clone(),
                            ..Default::default()
                        },
                    )?;
                }
            }
            versioned += 1;
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT;")?;
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            // 版本记账失败但文件已经写了：这是必须让用户知道的不一致，不是可以
            // 咽下去的错误。状态推到 failed 并留下原因。
            let _ = set_state(conn, changeset_id, ChangeSetState::Failed, Some(&e.to_string()));
            return Err(e);
        }
    }

    set_state(conn, changeset_id, ChangeSetState::Committed, None)?;
    object_store::record_audit(
        conn,
        &cs.actor,
        "changeset_committed",
        "committed",
        None,
        None,
        cs.run_id.as_deref(),
        cs.session_id.as_deref(),
        None,
        None,
        None,
        Some(&serde_json::json!({ "ops": ops.len(), "versioned": versioned }).to_string()),
    )?;
    Ok(versioned)
}

/// 写盘失败 / the real write failed.
pub fn mark_failed(conn: &Connection, changeset_id: &str, error: &str) -> ObjectResult<ChangeSet> {
    set_state(conn, changeset_id, ChangeSetState::Failed, Some(error))
}

// ── 查询 / reads ────────────────────────────────────────────────────────────

/// 一个批次的完整明细 / one change set, read without moving it.
///
/// 与 [`dry_run`] 的区别是**它不改状态**。`dry_run` 会把批次推到 `previewed` /
/// `conflicted`，所以它只能看还没落地的批次；已经 `committed` 的批次一调用就报非法迁
/// 移。审阅界面要能回看历史，所以这一份是纯读的。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSetDetail {
    pub changeset: ChangeSet,
    pub ops: Vec<OpDetail>,
}

/// 明细里的一步 / one operation, with both sides of the change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpDetail {
    pub op_id: String,
    pub seq: i64,
    pub op_kind: ChangeOpKind,
    pub path: Option<String>,
    /// 改名/移动之后的路径。
    pub new_path: Option<String>,
    pub target_object_id: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    /// `before` 是哪来的：`recorded_version` = 提交时记下的上一版，`current_index` =
    /// 索引里的当前内容，`none` = 两处都没有（新建，或者索引还没覆盖到）。
    ///
    /// 给出来是因为这两件事对用户的意义不同：前者是"改动发生前它长这样"，后者只是
    /// "它现在长这样"。UI 拿代码去查文案，不自己猜。
    pub before_source: &'static str,
    pub reason: Option<String>,
    pub evidence_ids: Vec<String>,
    pub affected_objects: Vec<String>,
    /// 只对还没落地的批次算。已落地的批次谈"冲突"没有意义——它已经写完了。
    pub conflict: Option<Conflict>,
    pub conflict_message: Option<String>,
    /// 关系操作的两端与语义 / the two endpoints of a relation operation.
    ///
    /// 只有 `AddRelation` / `DeleteRelation` 会有。给出来是因为一条边不能当文本 diff
    /// 渲染：`before` 和 `after` 那两行字符串是给人读的摘要，UI 想显示"从哪指向哪、
    /// 什么关系、几分置信度"就只能去解析那行字——解析摘要迟早解析错。
    pub relation: Option<RelationOp>,
}


/// 读一个批次 / load one change set and its operations.
pub fn detail(conn: &Connection, changeset_id: &str) -> ObjectResult<Option<ChangeSetDetail>> {
    let Some(changeset) = get(conn, changeset_id)? else {
        return Ok(None);
    };
    let settled = matches!(
        changeset.state,
        ChangeSetState::Committed
            | ChangeSetState::RolledBack
            | ChangeSetState::Rejected
            | ChangeSetState::Failed
    );

    let mut ops = Vec::new();
    for op in list_ops(conn, changeset_id)? {
        // 已落地的批次要给"改之前那一版"，而不是"现在的内容"——现在的内容就是改动
        // 之后的结果，拿它当 before 会画出一个空 diff。
        let recorded = match (&op.target_object_id, op.old_version) {
            (Some(id), Some(v)) => object_store::get_object_version(conn, id, v)?
                .and_then(|version| version.content),
            _ => None,
        };
        let (before, before_source) = match recorded {
            Some(content) => (Some(content), "recorded_version"),
            None => match current_content(conn, &op)? {
                Some(content) => (Some(content), "current_index"),
                None => (None, "none"),
            },
        };

        let conflict = if settled {
            None
        } else {
            detect_conflict(conn, &op)?
        };
        let relation = relation_payload(&op);


        ops.push(OpDetail {
            op_id: op.id,
            seq: op.seq,
            op_kind: op.op_kind,
            new_path: op
                .side_effects
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .and_then(|v| {
                    v.get("new_path")
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string())
                }),
            path: op.legacy_path,
            target_object_id: op.target_object_id,
            before,
            before_source,
            // 关系操作没有 `new_content`（一条边不是一篇正文）。给出摘要而不是 `None`，
            // 否则界面会以为"内容没记下来"，把一次正常的加边显示成一次可疑的写入。
            after: match (&relation, op.op_kind) {
                (Some(payload), ChangeOpKind::AddRelation) => Some(payload.summary()),
                (Some(_), ChangeOpKind::DeleteRelation) => None,
                _ => op.new_content,
            },
            reason: op.reason,
            evidence_ids: op.evidence_ids,
            affected_objects: op.affected_objects,
            conflict_message: conflict.as_ref().map(|c| c.message()),
            conflict,
            relation,
        });
    }

    Ok(Some(ChangeSetDetail { changeset, ops }))
}

pub fn get(conn: &Connection, id: &str) -> ObjectResult<Option<ChangeSet>> {
    conn.query_row(
        "SELECT id, actor, session_id, run_id, intent, state, risk, requires_approval,
                dry_run, evidence_ids, created_at_ms, updated_at_ms, commit_error
         FROM changesets WHERE id = ?1",
        params![id],
        |r| {
            Ok(ChangeSet {
                id: r.get(0)?,
                actor: r.get(1)?,
                session_id: r.get(2)?,
                run_id: r.get(3)?,
                intent: r.get(4)?,
                state: ChangeSetState::parse(&r.get::<_, String>(5)?)
                    .unwrap_or(ChangeSetState::Proposed),
                risk: r.get(6)?,
                requires_approval: r.get::<_, i64>(7)? != 0,
                dry_run: r.get::<_, i64>(8)? != 0,
                evidence_ids: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
                created_at_ms: r.get(10)?,
                updated_at_ms: r.get(11)?,
                commit_error: r.get(12)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn get_op(conn: &Connection, id: &str) -> ObjectResult<Option<ChangeSetOp>> {
    let ops = query_ops(conn, "WHERE id = ?1", params![id])?;
    Ok(ops.into_iter().next())
}

pub fn list_ops(conn: &Connection, changeset_id: &str) -> ObjectResult<Vec<ChangeSetOp>> {
    query_ops(conn, "WHERE changeset_id = ?1 ORDER BY seq", params![changeset_id])
}

fn query_ops(
    conn: &Connection,
    clause: &str,
    args: impl rusqlite::Params,
) -> ObjectResult<Vec<ChangeSetOp>> {
    let sql = format!(
        "SELECT id, changeset_id, seq, target_object_id, legacy_path, legacy_chunk_id, op_kind,
                old_version, expected_checksum, new_content, patch, reason, evidence_ids,
                affected_objects, side_effects, baseline_read_at_ms
         FROM changeset_ops {clause}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(args, |r| {
            Ok(ChangeSetOp {
                id: r.get(0)?,
                changeset_id: r.get(1)?,
                seq: r.get(2)?,
                target_object_id: r.get(3)?,
                legacy_path: r.get(4)?,
                legacy_chunk_id: r.get(5)?,
                op_kind: ChangeOpKind::parse(&r.get::<_, String>(6)?)
                    .unwrap_or(ChangeOpKind::Edit),
                old_version: r.get(7)?,
                expected_checksum: r.get(8)?,
                new_content: r.get(9)?,
                patch: r.get(10)?,
                reason: r.get(11)?,
                evidence_ids: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
                affected_objects: serde_json::from_str(&r.get::<_, String>(13)?)
                    .unwrap_or_default(),
                side_effects: r.get(14)?,
                baseline_read_at_ms: r.get(15)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 卡住的 changeset / change sets that never reached a terminal state.
///
/// `approved` 但迟迟没有 `committed`/`failed` 的，说明有人写盘之后没记账（进程被杀、
/// 异常路径）。这类记录必须能被查出来，否则它们只是静静地消失。
pub fn stale_changesets(conn: &Connection, older_than_ms: i64) -> ObjectResult<Vec<ChangeSet>> {
    let cutoff = now_ms() - older_than_ms;
    let mut stmt = conn.prepare(
        "SELECT id FROM changesets
         WHERE state IN ('proposed', 'previewed', 'awaiting_approval', 'approved')
           AND updated_at_ms < ?1
         ORDER BY updated_at_ms",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![cutoff], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(cs) = get(conn, &id)? {
            out.push(cs);
        }
    }
    Ok(out)
}

fn touch(conn: &Connection, changeset_id: &str) -> ObjectResult<()> {
    conn.execute(
        "UPDATE changesets SET updated_at_ms = ?2 WHERE id = ?1",
        params![changeset_id, now_ms()],
    )?;
    Ok(())
}
