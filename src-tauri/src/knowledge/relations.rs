//! 关系表的唯一写入口 / the one place that writes `note_relations`.
//!
//! ## 为什么要有这个模块
//!
//! 在这之前，关系有三个写入者：`graph_ops` 的 `add_relation` / `delete_relation` /
//! `batch_link_notes`（直接 SQL）、`schema::migrate_links_to_relations`（wikilink 迁移）、
//! 以及 `scheduler::reconcile_task`。它们各写各的，于是出现了三处不一致：
//!
//! - **置信度**：`add_relation` 硬写 `1.0`，`batch_link_notes` 什么都不写（落到默认
//!   `0.5`）。同一个模型猜出来的两条边，置信度差一倍。
//! - **`INSERT OR IGNORE`**：主键冲突被咽掉，工具照样回 `"success": true`。用户看到
//!   "已建立 5 条关系"，实际可能一条都没新增。
//! - **删除范围**：`DELETE ... WHERE source = ? AND target = ?` 不带 `relation_type`，
//!   一次"删掉这条 AI 关系"会把两篇笔记之间**所有**类型的边一起删掉，包括用户手连的。
//!
//! 这个模块把这三件事收成一份实现，并且是 ChangeSet 提交阶段唯一被允许碰关系表的地方。
//! 路径必须已经是索引里的那个拼法（`snapshot_path_key` 的产物）——写一个 vault 相对
//! 路径进去等于造一个幽灵节点，图谱、backlinks、related notes、lint 全都会看到它。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::changeset::{self, RelationOp};
use super::object_store::ObjectResult;
use super::types::{now_ms, ChangeOpKind};

/// 用户手写的 wikilink 迁进来的边。
pub const ORIGIN_USER_LINK: &str = "user_link";
/// Agent 提议、经审批写入的边。
pub const ORIGIN_AGENT: &str = "agent_proposed";

/// 一次关系写入的结果 / what one edge write actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationOutcome {
    Added,
    /// 已经在库里，没有重复新增。**不是成功**。
    AlreadyExists,
    Deleted,
    /// 要删的边不存在。
    Missing,
    /// 用户拒绝过这条边，不再自动建立。
    RejectedByUser,
}

impl RelationOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::AlreadyExists => "already_exists",
            Self::Deleted => "deleted",
            Self::Missing => "missing",
            Self::RejectedByUser => "rejected_by_user",
        }
    }

    /// 这次写入真的改变了库里的状态吗 / did this actually change the graph?
    ///
    /// UI 的"成功"必须建立在这个判断上，而不是"调用没报错"。
    pub fn changed_graph(self) -> bool {
        matches!(self, Self::Added | Self::Deleted)
    }
}

/// 逐条结果 / one row of the honest report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationItemResult {
    pub source: String,
    pub target: String,
    pub relation_type: String,
    pub outcome: RelationOutcome,
    pub message: String,
}

/// 一批关系写入的真实结果 / the real outcome of a batch.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationBatchReport {
    pub applied: usize,
    pub already_existed: usize,
    pub missing: usize,
    pub rejected_by_user: usize,
    pub failed: usize,
    pub details: Vec<RelationItemResult>,
}

impl RelationBatchReport {
    fn record(&mut self, item: RelationItemResult) {
        match item.outcome {
            RelationOutcome::Added | RelationOutcome::Deleted => self.applied += 1,
            RelationOutcome::AlreadyExists => self.already_existed += 1,
            RelationOutcome::Missing => self.missing += 1,
            RelationOutcome::RejectedByUser => self.rejected_by_user += 1,
        }
        self.details.push(item);
    }

    fn fail(&mut self, source: &str, target: &str, relation_type: &str, message: String) {
        self.failed += 1;
        self.details.push(RelationItemResult {
            source: source.to_string(),
            target: target.to_string(),
            relation_type: relation_type.to_string(),
            outcome: RelationOutcome::Missing,
            message,
        });
    }

    /// 有没有任何一条真的落库 / did anything actually land?
    pub fn changed_anything(&self) -> bool {
        self.applied > 0
    }
}

/// 新增一条边 / add one edge.
///
/// 不用 `INSERT OR IGNORE`：先问一次"在不在"，再决定回哪个结果。差别不在 SQL 的行数上，
/// 而在于调用方能不能如实告诉用户"这条已经有了"。
pub fn add_relation(
    conn: &Connection,
    op: &RelationOp,
    changeset_id: Option<&str>,
    run_id: Option<&str>,
) -> ObjectResult<RelationOutcome> {
    if changeset::relation_exists(conn, &op.source_path, &op.target_path, &op.relation_type)? {
        return Ok(RelationOutcome::AlreadyExists);
    }
    // 用户拒绝过就不再自动建立。这条判断留在写入口而不是只留在预演里：预演之后到提交
    // 之间用户可能刚拒绝过，而"拒绝"必须比"计划"更晚生效才有意义。
    if changeset::relation_rejected(conn, &op.source_path, &op.target_path, &op.relation_type)? {
        return Ok(RelationOutcome::RejectedByUser);
    }

    conn.execute(
        "INSERT INTO note_relations
            (source_path, target_path, relation_type, confidence, reason, origin,
             confirmed, changeset_id, run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
        params![
            op.source_path,
            op.target_path,
            op.relation_type,
            op.confidence,
            op.reason,
            op.origin,
            changeset_id,
            run_id,
        ],
    )?;
    Ok(RelationOutcome::Added)
}

/// 删除一条边 / remove one edge.
///
/// `relation_type` 是必填参数而不是可选过滤条件。旧实现省掉它，于是"删除这条 AI 推断"
/// 会连用户手连的 wikilink 边一起删。
pub fn delete_relation(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
) -> ObjectResult<RelationOutcome> {
    let removed = conn.execute(
        "DELETE FROM note_relations
         WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
        params![source, target, relation_type],
    )?;
    Ok(if removed > 0 {
        RelationOutcome::Deleted
    } else {
        RelationOutcome::Missing
    })
}

/// 把一条边标记成用户已确认 / the user vouched for this edge.
pub fn confirm_relation(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
) -> ObjectResult<bool> {
    let updated = conn.execute(
        "UPDATE note_relations SET confirmed = 1
         WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
        params![source, target, relation_type],
    )?;
    changeset::record_relation_decision(conn, source, target, relation_type, "accepted", None)?;
    Ok(updated > 0)
}

/// 用户拒绝一条边 / the user rejected this edge.
///
/// 两件事一起做：把现有的行删掉（如果有），并把这个判断记住。只删不记的话，下一次
/// 语义刷新会用同样的理由把它再建一遍。
pub fn reject_relation(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
    reason: Option<&str>,
) -> ObjectResult<RelationOutcome> {
    let outcome = delete_relation(conn, source, target, relation_type)?;
    changeset::record_relation_decision(conn, source, target, relation_type, "rejected", reason)?;
    Ok(outcome)
}

/// 执行一个批次里所有关系操作 / apply every relation op in one change set.
///
/// 整批一个事务。半批落库的关系图比一条都没写更难修：用户看到"新增 3 条"，实际是
/// 前 3 条写了、第 4 条炸了、剩下的没跑，而这个状态没有任何地方记着。
///
/// 事务里**不**碰文件系统，所以这里的回滚是真回滚（见 `changeset` 模块文档关于
/// SQLite 能回滚而磁盘不能的说明）。
pub fn apply_changeset_relations(
    conn: &Connection,
    changeset_id: &str,
) -> ObjectResult<RelationBatchReport> {
    let ops = changeset::list_ops(conn, changeset_id)?;
    let run_id = changeset::get(conn, changeset_id)?.and_then(|cs| cs.run_id);
    let mut report = RelationBatchReport::default();

    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| -> ObjectResult<()> {
        for op in &ops {
            let Some(payload) = changeset::relation_payload(op) else {
                continue;
            };
            let outcome = match op.op_kind {
                ChangeOpKind::AddRelation => {
                    add_relation(conn, &payload, Some(changeset_id), run_id.as_deref())?
                }
                ChangeOpKind::DeleteRelation => delete_relation(
                    conn,
                    &payload.source_path,
                    &payload.target_path,
                    &payload.relation_type,
                )?,
                _ => continue,
            };
            report.record(RelationItemResult {
                source: payload.source_path.clone(),
                target: payload.target_path.clone(),
                relation_type: payload.relation_type.clone(),
                message: describe(outcome, &payload),
                outcome,
            });
        }
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT;")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            let mut failed = RelationBatchReport::default();
            failed.fail("", "", "", format!("批次未写入：{e}"));
            return Ok(failed);
        }
    }
    Ok(report)
}

/// 撤销一个批次的关系操作 / undo the relation ops of one change set.
///
/// 逐条反向执行：新增过的删掉，删除过的按原来的置信度和理由放回去。用原值而不是默认值，
/// 否则"撤销"会把一条用户确认过的边悄悄降级成 0.5 的推断。
pub fn rollback_changeset_relations(
    conn: &Connection,
    changeset_id: &str,
) -> ObjectResult<RelationBatchReport> {
    let ops = changeset::list_ops(conn, changeset_id)?;
    let mut report = RelationBatchReport::default();

    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| -> ObjectResult<()> {
        for op in ops.iter().rev() {
            let Some(payload) = changeset::relation_payload(op) else {
                continue;
            };
            let outcome = match op.op_kind {
                ChangeOpKind::AddRelation => delete_relation(
                    conn,
                    &payload.source_path,
                    &payload.target_path,
                    &payload.relation_type,
                )?,
                ChangeOpKind::DeleteRelation => {
                    let restored = RelationOp {
                        confidence: payload.old_confidence.unwrap_or(payload.confidence),
                        reason: payload.old_reason.clone().or_else(|| payload.reason.clone()),
                        ..payload.clone()
                    };
                    add_relation(conn, &restored, Some(changeset_id), None)?
                }
                _ => continue,
            };
            report.record(RelationItemResult {
                source: payload.source_path.clone(),
                target: payload.target_path.clone(),
                relation_type: payload.relation_type.clone(),
                message: describe(outcome, &payload),
                outcome,
            });
        }
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT;")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            let mut failed = RelationBatchReport::default();
            failed.fail("", "", "", format!("撤销未执行：{e}"));
            return Ok(failed);
        }
    }
    Ok(report)
}

/// 一条结果的人话 / one outcome, phrased for a human.
fn describe(outcome: RelationOutcome, op: &RelationOp) -> String {
    match outcome {
        RelationOutcome::Added => format!(
            "已新增 {} --[{}]--> {}",
            op.source_path, op.relation_type, op.target_path
        ),
        RelationOutcome::AlreadyExists => "关系已存在，未重复新增".to_string(),
        RelationOutcome::Deleted => format!(
            "已删除 {} --[{}]--> {}",
            op.source_path, op.relation_type, op.target_path
        ),
        RelationOutcome::Missing => "没有找到这条关系，未执行删除".to_string(),
        RelationOutcome::RejectedByUser => "你拒绝过这条关系，未重新建立".to_string(),
    }
}

/// 这条边现在的样子 / the edge as it stands, for an evidence drawer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationDetail {
    pub source_path: String,
    pub target_path: String,
    pub relation_type: String,
    pub confidence: f64,
    pub reason: Option<String>,
    pub origin: String,
    pub confirmed: bool,
    pub changeset_id: Option<String>,
    pub created_at: Option<String>,
    /// 用户对它下过什么判断（`accepted` / `rejected`），没有就是 `None`。
    pub decision: Option<String>,
}

/// 读一条边的全部细节 / everything the relation drawer needs.
pub fn relation_detail(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
) -> ObjectResult<Option<RelationDetail>> {
    let row = conn
        .query_row(
            "SELECT confidence, reason, COALESCE(origin, 'user_link'),
                    COALESCE(confirmed, 0), changeset_id, created_at
             FROM note_relations
             WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
            params![source, target, relation_type],
            |r| {
                Ok(RelationDetail {
                    source_path: source.to_string(),
                    target_path: target.to_string(),
                    relation_type: relation_type.to_string(),
                    confidence: r.get::<_, Option<f64>>(0)?.unwrap_or(0.5),
                    reason: r.get(1)?,
                    origin: r.get(2)?,
                    confirmed: r.get::<_, i64>(3)? != 0,
                    changeset_id: r.get(4)?,
                    created_at: r.get(5)?,
                    decision: None,
                })
            },
        )
        .optional()?;

    let Some(mut detail) = row else { return Ok(None) };
    detail.decision = conn
        .query_row(
            "SELECT decision FROM relation_decisions
             WHERE source_path = ?1 AND target_path = ?2 AND relation_type = ?3",
            params![source, target, relation_type],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Some(detail))
}

/// 留一个时间戳给审计 / a timestamp for the audit trail.
///
/// 单独包一层是为了让测试能在不依赖系统时钟顺序的前提下断言"记过时间"。
pub fn touched_at_ms() -> i64 {
    now_ms()
}
