//! 图谱计划 / the graph plan: goal → observations → proposals → verified result.
//!
//! ## 为什么图谱 AI 需要一个"计划"这层东西
//!
//! 在这之前，图谱上的每个 AI 按钮都是同一件事：拼一段 prompt，把模型回的 Markdown 显示
//! 出来。于是三件事分不开——**它看到了什么**（观察）、**它推断了什么**（结论）、
//! **它想改什么**（操作）。用户只能整体信或整体不信，而"Auto-Fix 完成"这句话的依据
//! 只是"模型回了一段文字"。
//!
//! 本模块把这三件事拆开成可逐项审查的结构：
//!
//! ```text
//! GraphGoal        用户想干什么（类型 + 范围 + 锚点 + 约束）
//! GraphObservation 从库里读到的事实（每条都指得出证据）
//! GraphProposal    想做的一次改动（带理由、置信度、风险、受影响对象）
//! GraphPlan        以上三者 + 验证步骤 + 还没解决的问题
//! ```
//!
//! ## 观察是算出来的，不是模型说的
//!
//! 计划里的观察全部来自 `note_relations`、`semantic_edges`、`files`、`chunks` 的真实
//! 查询：孤立笔记就是关系表里没有它、桥梁候选就是语义相似但没有连线的一对。模型可以
//! 在这之上补解释，但不能凭空多出一个节点或一条边——这是"AI 不能伪造成功"在数据层
//! 的落点。没有 LLM 时这一层照样能给出完整计划。
//!
//! ## 提交走的是同一条门禁
//!
//! [`stage_plan`] 把选中的提议交给 [`write_guard`](super::write_guard) 的同一套
//! `intents_of` → `add_op` → `dry_run` 流程，所以图谱操作与笔记写入共享 scope 校验、
//! 冲突检测、审批记录、审计和撤销。这里**没有**第二套写入路径。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::changeset::{self};
use super::object_store::{self, ObjectResult};
use super::relations;
use super::types::{new_object_id, now_ms, ChangeOpKind};

/// 这次计划管多大范围 / how much of the vault this plan may touch.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScope {
    /// 空 = 整库。给定则只考虑这些路径下的笔记。
    pub paths: Vec<String>,
    /// 只看这个聚类。`None` = 不限。
    pub cluster: Option<usize>,
}

/// 用户的目标 / what the user asked for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphGoal {
    /// `diagnose` / `bridge` / `organize` / `consolidate` / `explain`。
    pub goal_type: String,
    #[serde(default)]
    pub scope: KnowledgeScope,
    /// 锚点笔记路径。`bridge` 用两个，`explain` 用两个，`organize` 用一组。
    #[serde(default)]
    pub anchor_paths: Vec<String>,
    #[serde(default)]
    pub question: String,
    /// 用户写下的限制，例如"不要自动写回原笔记"。原样带进计划，供审查时对照。
    #[serde(default)]
    pub constraints: Vec<String>,
    /// 最多提多少条改动。防止"看起来连接更多"变成批量灌低置信关系。
    #[serde(default)]
    pub max_proposals: Option<usize>,
}

/// 一条从库里读出来的事实 / one fact read from the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphObservation {
    pub id: String,
    /// `orphan` / `island` / `hub_overload` / `duplicate` / `missing_link` / `contradiction`。
    pub kind: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// 支持这条观察的证据。文件级证据要在 UI 上标明是文件级。
    #[serde(default)]
    pub evidence: Vec<GraphEvidence>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 一条证据 / one piece of evidence behind an observation or proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEvidence {
    pub path: String,
    /// 精确到块/片段时给 chunk id；只能给到文件时为 `None`，UI 必须说明这是文件级依据。
    pub chunk_id: Option<i64>,
    pub excerpt: Option<String>,
    /// `relation_table` / `semantic_edge` / `chunk_text` / `title_match`。
    pub kind: String,
}

/// 一次想做的改动 / one change the plan proposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphProposal {
    pub id: String,
    /// `add_relation` / `delete_relation` / `create_moc` / `create_task`。
    pub operation: String,
    pub source_path: String,
    pub target_path: Option<String>,
    pub relation_type: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub evidence: Vec<GraphEvidence>,
    pub confidence: f64,
    /// `low` / `medium` / `high`。删除关系与写回笔记比新增一条边风险高。
    pub risk: String,
    #[serde(default)]
    pub affected_paths: Vec<String>,
    /// 生成时它已经在库里了吗。UI 用它把"已存在"排在后面而不是混在待新增里。
    #[serde(default)]
    pub already_exists: bool,
}

/// 一份完整计划 / the whole plan, ready to be reviewed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPlan {
    pub id: String,
    pub goal: GraphGoal,
    pub observations: Vec<GraphObservation>,
    pub proposals: Vec<GraphProposal>,
    /// 提交后要跑哪些检查。写在计划里而不是藏在代码里：用户有权知道"验证"验的是什么。
    pub validation_steps: Vec<String>,
    /// 这一轮没能回答的问题。空着比编一个答案好。
    pub unresolved_questions: Vec<String>,
    /// 计划是怎么算出来的：`deterministic` 或 `deterministic+llm`。
    pub generated_by: String,
    pub generated_at_ms: i64,
    /// 已经落成 changeset 的话记在这里。
    pub changeset_id: Option<String>,
    pub state: String,
}

// ── 阈值 / the thresholds, named ─────────────────────────────────────────────

/// 高于这个语义相似度才值得提议连线 / the floor for proposing a semantic bridge.
///
/// 0.72 不是随手取的：`compute_and_store_semantic_edges` 已经把低相似度的对过滤掉了，
/// 这里再抬一档，因为"建议用户连线"比"在图上画一条淡线"更需要底气。宁可少提几条。
const BRIDGE_SIMILARITY_FLOOR: f64 = 0.72;

/// 高于这个相似度视为疑似重复 / above this, two notes are probably duplicates.
const DUPLICATE_SIMILARITY_FLOOR: f64 = 0.9;

/// 关系数超过这个值算枢纽过载 / a node with more edges than this is overloaded.
const HUB_DEGREE_CEILING: i64 = 20;

/// 一份计划最多提多少条 / how many proposals one plan may carry by default.
///
/// 上限存在的理由是产品规则而不是性能：连接质量优先于数量，一次给用户 200 条待审关系
/// 等于逼他全选。
const DEFAULT_MAX_PROPOSALS: usize = 20;

// ── 计划生成 / building the plan ─────────────────────────────────────────────

/// 按目标算一份计划 / compute the plan for one goal.
///
/// 全部来自真实查询。没有 LLM 也能跑完——`generated_by` 会如实写 `deterministic`。
pub fn create_plan(conn: &Connection, goal: GraphGoal) -> ObjectResult<GraphPlan> {
    let limit = goal.max_proposals.unwrap_or(DEFAULT_MAX_PROPOSALS);
    let mut observations = Vec::new();
    let mut proposals = Vec::new();
    let mut unresolved = Vec::new();

    match goal.goal_type.as_str() {
        "bridge" => {
            let (obs, props) = bridge_candidates(conn, &goal, limit)?;
            observations.extend(obs);
            proposals.extend(props);
            if proposals.is_empty() {
                unresolved.push(
                    "没有找到语义上足够接近、又还没有连线的一对笔记。可以先补写中间概念，\
                     或者降低范围重试。"
                        .to_string(),
                );
            }
        }
        "consolidate" => {
            observations.extend(duplicate_groups(conn, &goal, limit)?);
            unresolved.push(
                "重复与矛盾只做识别，不自动合并或删除：合并会改写用户正文，必须由你\
                 逐篇确认。"
                    .to_string(),
            );
        }
        // `diagnose` 是默认：它把结构问题全查一遍，并只对其中"缺连线"这一类给出可执行提议。
        _ => {
            observations.extend(orphan_notes(conn, &goal, limit)?);
            observations.extend(hub_overload(conn, &goal)?);
            observations.extend(duplicate_groups(conn, &goal, limit)?);
            let (obs, props) = bridge_candidates(conn, &goal, limit)?;
            observations.extend(obs);
            proposals.extend(props);
            if observations.is_empty() {
                unresolved.push("这次扫描没有发现结构问题。".to_string());
            }
        }
    }

    proposals.truncate(limit);

    Ok(GraphPlan {
        id: new_object_id(),
        goal,
        observations,
        proposals,
        validation_steps: vec![
            "提交后重新统计关系总数，与预期新增数量核对".to_string(),
            "检查每条新关系的两端是否仍存在".to_string(),
            "刷新图谱缓存与语义边".to_string(),
        ],
        unresolved_questions: unresolved,
        generated_by: "deterministic".to_string(),
        generated_at_ms: now_ms(),
        changeset_id: None,
        state: "preview_ready".to_string(),
    })
}

/// 范围过滤的 SQL 片段 / the scope filter, as a predicate on one column.
///
/// 空范围 = 整库。这里与 `changeset::path_in_scope` 的方向刻意不同：那是**写入许可**
/// （空 = 什么都不许写），这是**查询范围**（空 = 全都看）。两个默认值反着来是对的，
/// 混成一个会让"没选范围"要么什么都查不到，要么什么都能写。
fn scope_clause(scope: &KnowledgeScope, column: &str) -> (String, Vec<String>) {
    if scope.paths.is_empty() {
        return ("1=1".to_string(), Vec::new());
    }
    let mut parts = Vec::new();
    let mut binds = Vec::new();
    for p in &scope.paths {
        parts.push(format!("{column} LIKE ?"));
        binds.push(format!("{}%", p.replace('\\', "/")));
    }
    (format!("({})", parts.join(" OR ")), binds)
}

/// 一篇笔记的标题 / the title the graph shows for a path.
fn title_of(conn: &Connection, path: &str) -> String {
    conn.query_row(
        "SELECT COALESCE(title, path) FROM files WHERE path = ?1",
        params![path],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| path.to_string())
}

/// 一篇笔记的第一段，作为文件级证据 / the opening chunk, as file-level evidence.
fn opening_evidence(conn: &Connection, path: &str, kind: &str) -> GraphEvidence {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, content FROM chunks WHERE file_path = ?1 ORDER BY chunk_index LIMIT 1",
            params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap_or(None);
    match row {
        Some((id, content)) => GraphEvidence {
            path: path.to_string(),
            chunk_id: Some(id),
            excerpt: Some(content.chars().take(160).collect()),
            kind: kind.to_string(),
        },
        // 拿不到片段就如实标成文件级依据，而不是编一段摘录。
        None => GraphEvidence {
            path: path.to_string(),
            chunk_id: None,
            excerpt: None,
            kind: "file_level".to_string(),
        },
    }
}

/// 孤立笔记 / notes with no relation at all.
fn orphan_notes(
    conn: &Connection,
    goal: &GraphGoal,
    limit: usize,
) -> ObjectResult<Vec<GraphObservation>> {
    let (clause, binds) = scope_clause(&goal.scope, "f.path");
    let sql = format!(
        "SELECT f.path FROM files f
         WHERE {clause}
           AND NOT EXISTS (SELECT 1 FROM note_relations r WHERE r.source_path = f.path)
           AND NOT EXISTS (SELECT 1 FROM note_relations r WHERE r.target_path = f.path)
         ORDER BY f.path
         LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_dyn: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let paths: Vec<String> = stmt
        .query_map(params_dyn.as_slice(), |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(paths
        .into_iter()
        .map(|path| {
            let title = title_of(conn, &path);
            GraphObservation {
                id: new_object_id(),
                kind: "orphan".to_string(),
                title: format!("《{title}》还没有任何关系"),
                summary: "这篇笔记与图谱其它部分没有连接，检索时很难被顺着关系找到。"
                    .to_string(),
                evidence: vec![opening_evidence(conn, &path, "chunk_text")],
                paths: vec![path],
                confidence: Some(1.0),
                warnings: Vec::new(),
            }
        })
        .collect())
}

/// 枢纽过载 / nodes carrying too many edges.
fn hub_overload(conn: &Connection, goal: &GraphGoal) -> ObjectResult<Vec<GraphObservation>> {
    let (clause, binds) = scope_clause(&goal.scope, "path");
    let sql = format!(
        "SELECT path, degree FROM (
             SELECT source_path AS path, COUNT(*) AS degree FROM note_relations GROUP BY source_path
             UNION ALL
             SELECT target_path AS path, COUNT(*) AS degree FROM note_relations GROUP BY target_path
         )
         WHERE {clause}
         GROUP BY path
         HAVING SUM(degree) > {HUB_DEGREE_CEILING}
         ORDER BY SUM(degree) DESC
         LIMIT 5"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_dyn: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let rows: Vec<(String, i64)> = stmt
        .query_map(params_dyn.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows
        .into_iter()
        .map(|(path, degree)| {
            let title = title_of(conn, &path);
            GraphObservation {
                id: new_object_id(),
                kind: "hub_overload".to_string(),
                title: format!("《{title}》承担了 {degree} 条关系"),
                summary:
                    "关系过度集中在一个节点上时，它会变成什么都沾一点的目录页，\
                     顺着它检索反而更难命中。可以考虑拆成几篇更具体的笔记。"
                        .to_string(),
                evidence: vec![GraphEvidence {
                    path: path.clone(),
                    chunk_id: None,
                    excerpt: Some(format!("note_relations 中与该路径相关的行数：{degree}")),
                    kind: "relation_table".to_string(),
                }],
                paths: vec![path],
                confidence: Some(1.0),
                warnings: Vec::new(),
            }
        })
        .collect())
}

/// 桥梁候选 / pairs the store says are close but that nobody has linked.
///
/// 观察来自 `semantic_edges`（真实向量相似度），提议的置信度就是那个相似度本身，
/// 不做任何放大。已经被用户拒过的一对直接跳过——那正是"拒绝后不该反复骚扰"。
fn bridge_candidates(
    conn: &Connection,
    goal: &GraphGoal,
    limit: usize,
) -> ObjectResult<(Vec<GraphObservation>, Vec<GraphProposal>)> {
    let (clause, mut binds) = scope_clause(&goal.scope, "s.source_path");
    // 锚点给了就只看锚点相关的对；这让「围绕这两个主题找桥梁」真的只看那两块。
    let anchor_clause = if goal.anchor_paths.is_empty() {
        "1=1".to_string()
    } else {
        let marks = goal
            .anchor_paths
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        format!("(s.source_path IN ({marks}) OR s.target_path IN ({marks}))")
    };
    if !goal.anchor_paths.is_empty() {
        // IN 子句出现两次，绑定也要给两遍。
        binds.extend(goal.anchor_paths.iter().cloned());
        binds.extend(goal.anchor_paths.iter().cloned());
    }

    let sql = format!(
        "SELECT s.source_path, s.target_path, s.similarity
         FROM semantic_edges s
         WHERE {clause} AND {anchor_clause}
           AND s.similarity >= {BRIDGE_SIMILARITY_FLOOR}
           AND NOT EXISTS (
                SELECT 1 FROM note_relations r
                WHERE (r.source_path = s.source_path AND r.target_path = s.target_path)
                   OR (r.source_path = s.target_path AND r.target_path = s.source_path)
           )
           AND NOT EXISTS (
                SELECT 1 FROM relation_decisions d
                WHERE d.decision = 'rejected'
                  AND ((d.source_path = s.source_path AND d.target_path = s.target_path)
                    OR (d.source_path = s.target_path AND d.target_path = s.source_path))
           )
         ORDER BY s.similarity DESC
         LIMIT {limit}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let params_dyn: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let rows: Vec<(String, String, f64)> = stmt
        .query_map(params_dyn.as_slice(), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut observations = Vec::new();
    let mut proposals = Vec::new();
    for (source, target, similarity) in rows {
        let (source_title, target_title) = (title_of(conn, &source), title_of(conn, &target));
        let evidence = vec![
            GraphEvidence {
                path: source.clone(),
                chunk_id: None,
                excerpt: Some(format!("语义相似度 {similarity:.2}")),
                kind: "semantic_edge".to_string(),
            },
            opening_evidence(conn, &source, "chunk_text"),
            opening_evidence(conn, &target, "chunk_text"),
        ];
        observations.push(GraphObservation {
            id: new_object_id(),
            kind: "missing_link".to_string(),
            title: format!("《{source_title}》与《{target_title}》内容接近但没有连线"),
            summary: format!(
                "向量检索算出的相似度是 {similarity:.2}，而关系表里两者之间没有任何一条边。"
            ),
            paths: vec![source.clone(), target.clone()],
            evidence: evidence.clone(),
            confidence: Some(similarity),
            warnings: Vec::new(),
        });
        proposals.push(GraphProposal {
            id: new_object_id(),
            operation: "add_relation".to_string(),
            source_path: source.clone(),
            target_path: Some(target.clone()),
            relation_type: Some("related".to_string()),
            reason: format!(
                "两篇笔记的语义相似度为 {similarity:.2}，但图谱里没有连接。建立 related \
                 关系后，检索一篇时另一篇能被顺着关系带出来。"
            ),
            evidence,
            // 置信度就是相似度本身：不加工，用户看到的数与算出来的数是同一个。
            confidence: similarity,
            risk: "low".to_string(),
            affected_paths: vec![source, target],
            already_exists: false,
        });
    }
    Ok((observations, proposals))
}

/// 疑似重复 / near-duplicate pairs.
///
/// 只识别，不提议删除或合并：合并会改写用户正文，那是 note ChangeSet 的活，而且必须
/// 由用户逐篇看过 diff。
fn duplicate_groups(
    conn: &Connection,
    goal: &GraphGoal,
    limit: usize,
) -> ObjectResult<Vec<GraphObservation>> {
    let (clause, binds) = scope_clause(&goal.scope, "s.source_path");
    let sql = format!(
        "SELECT s.source_path, s.target_path, s.similarity
         FROM semantic_edges s
         WHERE {clause} AND s.similarity >= {DUPLICATE_SIMILARITY_FLOOR}
         ORDER BY s.similarity DESC
         LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_dyn: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let rows: Vec<(String, String, f64)> = stmt
        .query_map(params_dyn.as_slice(), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows
        .into_iter()
        .map(|(source, target, similarity)| {
            let (a, b) = (title_of(conn, &source), title_of(conn, &target));
            GraphObservation {
                id: new_object_id(),
                kind: "duplicate".to_string(),
                title: format!("《{a}》与《{b}》高度重叠"),
                summary: format!(
                    "相似度 {similarity:.2}。要不要合并由你决定——自动合并会改写正文，\
                     这里只做提示。"
                ),
                evidence: vec![
                    opening_evidence(conn, &source, "chunk_text"),
                    opening_evidence(conn, &target, "chunk_text"),
                ],
                paths: vec![source, target],
                confidence: Some(similarity),
                warnings: vec!["合并笔记不在图谱计划的执行范围内".to_string()],
            }
        })
        .collect())
}

// ── 存取 / persistence ───────────────────────────────────────────────────────

/// 建表 / the plan table.
///
/// 计划要存下来，否则"预览 → 用户看一会儿 → 批准"中间应用重启就丢了，而重新生成一份
/// 计划里的 proposal id 全变了，用户刚才勾掉的那条会重新出现。
pub fn ensure_table(conn: &Connection) -> ObjectResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS graph_plans (
            id TEXT PRIMARY KEY,
            plan_json TEXT NOT NULL,
            changeset_id TEXT,
            state TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );",
        [],
    )?;
    Ok(())
}

/// 存一份计划 / persist one plan.
pub fn save_plan(conn: &Connection, plan: &GraphPlan) -> ObjectResult<()> {
    ensure_table(conn)?;
    let json = serde_json::to_string(plan).unwrap_or_default();
    conn.execute(
        "INSERT INTO graph_plans (id, plan_json, changeset_id, state, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
            plan_json = ?2, changeset_id = ?3, state = ?4, updated_at_ms = ?5",
        params![plan.id, json, plan.changeset_id, plan.state, now_ms()],
    )?;
    Ok(())
}

/// 读一份计划 / load one plan.
pub fn load_plan(conn: &Connection, plan_id: &str) -> ObjectResult<Option<GraphPlan>> {
    ensure_table(conn)?;
    let json: Option<String> = conn
        .query_row(
            "SELECT plan_json FROM graph_plans WHERE id = ?1",
            params![plan_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

// ── 提交与验证 / staging, committing, verifying ───────────────────────────────

/// 一次提交尝试的真实结果 / what actually happened when the plan was applied.
///
/// 每个数字都来自后端。UI 的成功文案只能引用这里的字段——"调用没报错"不是成功。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOutcome {
    pub plan_id: String,
    pub changeset_id: Option<String>,
    /// `awaiting_approval` / `applying` / `completed` / `partial_success` / `conflict`
    /// / `rejected` / `failed`。与前端状态机一一对应。
    pub state: String,
    pub selected: usize,
    pub applied: usize,
    pub already_existed: usize,
    pub rejected_by_user: usize,
    pub missing: usize,
    pub failed: usize,
    /// 每条冲突的人话。空数组表示没有冲突，不是"不知道"。
    pub conflicts: Vec<String>,
    /// 被门禁拒绝时的原因。有值就意味着**什么都没写**。
    pub refusal: Option<String>,
    pub message: String,
    pub details: Vec<relations::RelationItemResult>,
}

impl PlanOutcome {
    fn refused(plan_id: &str, changeset_id: Option<String>, refusal: String) -> Self {
        Self {
            plan_id: plan_id.to_string(),
            changeset_id,
            state: "rejected".to_string(),
            selected: 0,
            applied: 0,
            already_existed: 0,
            rejected_by_user: 0,
            missing: 0,
            failed: 0,
            conflicts: Vec::new(),
            message: format!("未执行：{refusal}"),
            refusal: Some(refusal),
            details: Vec::new(),
        }
    }
}

/// 把选中的提议开成一个 changeset / stage the selected proposals.
///
/// 只 stage，不写库。返回的 `state` 是 `awaiting_approval` 或 `conflict`，两者都表示
/// **还没有任何东西落库**。
pub fn stage_plan(
    conn: &Connection,
    ctx: &super::write_guard::WriteContext,
    plan: &mut GraphPlan,
    selected_ids: &[String],
) -> ObjectResult<PlanOutcome> {
    use super::write_guard::{self, Guarded};

    let chosen: Vec<&GraphProposal> = plan
        .proposals
        .iter()
        .filter(|p| selected_ids.is_empty() || selected_ids.contains(&p.id))
        .collect();

    if chosen.is_empty() {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "没有选中任何提议".to_string(),
        ));
    }

    let mut intents = Vec::new();
    for p in &chosen {
        let (Some(target), Some(relation_type)) = (&p.target_path, &p.relation_type) else {
            // 关系类提议缺了另一端就整批停下。半批能提交、半批不能的批次没法诚实回滚。
            return Ok(PlanOutcome::refused(
                &plan.id,
                None,
                format!("提议 {} 缺少目标笔记或关系类型", p.id),
            ));
        };
        let kind = match p.operation.as_str() {
            "add_relation" => ChangeOpKind::AddRelation,
            "delete_relation" => ChangeOpKind::DeleteRelation,
            other => {
                return Ok(PlanOutcome::refused(
                    &plan.id,
                    None,
                    format!("`{other}` 不是图谱计划能执行的操作"),
                ))
            }
        };
        intents.push(write_guard::relation_intent(
            kind,
            p.source_path.clone(),
            target.clone(),
            relation_type.clone(),
            p.confidence,
            Some(p.reason.clone()),
        ));
    }

    match write_guard::open_intents(conn, ctx, "knowledge_graph_plan", &intents)? {
        Guarded::Ready(ready) => {
            plan.changeset_id = Some(ready.changeset_id.clone());
            plan.state = "awaiting_approval".to_string();
            save_plan(conn, plan)?;
            Ok(PlanOutcome {
                plan_id: plan.id.clone(),
                changeset_id: Some(ready.changeset_id),
                state: "awaiting_approval".to_string(),
                selected: chosen.len(),
                applied: 0,
                already_existed: 0,
                rejected_by_user: 0,
                missing: 0,
                failed: 0,
                conflicts: Vec::new(),
                refusal: None,
                message: format!("{} 条改动已生成预览，等待你确认，尚未写入。", chosen.len()),
                details: Vec::new(),
            })
        }
        Guarded::Conflicted {
            changeset_id,
            report,
        } => {
            plan.changeset_id = Some(changeset_id.clone());
            plan.state = "conflict".to_string();
            save_plan(conn, plan)?;
            let conflicts: Vec<String> = report
                .ops
                .iter()
                .filter_map(|op| op.conflict_message.clone())
                .collect();
            Ok(PlanOutcome {
                plan_id: plan.id.clone(),
                changeset_id: Some(changeset_id),
                state: "conflict".to_string(),
                selected: chosen.len(),
                applied: 0,
                already_existed: 0,
                rejected_by_user: 0,
                missing: 0,
                failed: 0,
                message: format!(
                    "{} 条改动中有 {} 条需要你先看一眼，没有写入任何内容。",
                    chosen.len(),
                    conflicts.len()
                ),
                conflicts,
                refusal: None,
                details: Vec::new(),
            })
        }
        Guarded::Refused {
            changeset_id,
            refusal,
        } => {
            plan.state = "rejected".to_string();
            save_plan(conn, plan)?;
            Ok(PlanOutcome::refused(
                &plan.id,
                changeset_id,
                refusal.message(),
            ))
        }
        Guarded::Unguarded => Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "图谱写入必须经过写入审查，但守卫没有接管这次调用".to_string(),
        )),
    }
}

/// 提交一份已经 stage 好的计划 / commit a staged plan.
///
/// 成功判定只有一个来源：[`relations::apply_changeset_relations`] 返回的 `applied`。
/// 一条都没落库时状态是 `failed` 或 `conflict`，绝不是 `completed`。
pub fn commit_plan(conn: &Connection, plan: &mut GraphPlan) -> ObjectResult<PlanOutcome> {
    let Some(changeset_id) = plan.changeset_id.clone() else {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "这份计划还没有生成变更批次".to_string(),
        ));
    };

    let report = relations::apply_changeset_relations(conn, &changeset_id)?;
    let settled = if report.applied > 0 {
        changeset::record_commit(conn, &changeset_id).map(|_| ()).is_ok()
    } else {
        // 一条都没写就不该记成 committed：那会让审计里出现一个"提交过但什么都没变"的批次。
        let _ = changeset::mark_failed(conn, &changeset_id, "没有任何关系被写入");
        false
    };

    let state = match (report.applied, report.failed, report.already_existed + report.missing + report.rejected_by_user) {
        (0, 0, skipped) if skipped > 0 => "conflict",
        (0, _, _) => "failed",
        (_, 0, 0) => "completed",
        _ => "partial_success",
    };
    plan.state = state.to_string();
    save_plan(conn, plan)?;

    // 图谱缓存的输入变了。不失效的话用户看到的还是旧图，会以为写入没生效。
    crate::db::search::invalidate_graph_cache(conn);

    Ok(PlanOutcome {
        plan_id: plan.id.clone(),
        changeset_id: Some(changeset_id),
        state: state.to_string(),
        selected: report.details.len(),
        applied: report.applied,
        already_existed: report.already_existed,
        rejected_by_user: report.rejected_by_user,
        missing: report.missing,
        failed: report.failed,
        conflicts: Vec::new(),
        refusal: None,
        message: format!(
            "已写入 {} 条；{} 条已存在；{} 条你之前拒绝过；{} 条找不到目标；{} 条失败。{}",
            report.applied,
            report.already_existed,
            report.rejected_by_user,
            report.missing,
            report.failed,
            if settled {
                "变更已记账，可以撤销。"
            } else {
                "没有任何内容落库。"
            }
        ),
        details: report.details,
    })
}

/// 撤销一份已提交的计划 / undo a committed plan.
pub fn rollback_plan(conn: &Connection, plan: &mut GraphPlan) -> ObjectResult<PlanOutcome> {
    let Some(changeset_id) = plan.changeset_id.clone() else {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "这份计划没有可撤销的批次".to_string(),
        ));
    };
    let report = relations::rollback_changeset_relations(conn, &changeset_id)?;
    let _ = changeset::set_state(
        conn,
        &changeset_id,
        super::types::ChangeSetState::RolledBack,
        None,
    );
    plan.state = "rolled_back".to_string();
    save_plan(conn, plan)?;
    crate::db::search::invalidate_graph_cache(conn);

    Ok(PlanOutcome {
        plan_id: plan.id.clone(),
        changeset_id: Some(changeset_id),
        state: "rolled_back".to_string(),
        selected: report.details.len(),
        applied: report.applied,
        already_existed: report.already_existed,
        rejected_by_user: report.rejected_by_user,
        missing: report.missing,
        failed: report.failed,
        conflicts: Vec::new(),
        refusal: None,
        message: format!("已撤销 {} 条改动。", report.applied),
        details: report.details,
    })
}

/// 验证结果 / what the store looks like after the write.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanVerification {
    pub plan_id: String,
    pub relation_total: i64,
    /// 计划里的每条提议现在到底在不在库里。
    pub proposals_present: usize,
    pub proposals_absent: usize,
    /// 两端都还存在吗。
    pub dangling_endpoints: Vec<String>,
    pub steps: Vec<String>,
    pub message: String,
}

/// 提交后真查一遍 / verify by querying, not by trusting the write path.
pub fn verify_plan(conn: &Connection, plan: &GraphPlan) -> ObjectResult<PlanVerification> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM note_relations", [], |r| r.get(0))?;
    let mut present = 0usize;
    let mut absent = 0usize;
    let mut dangling = Vec::new();

    for p in &plan.proposals {
        let (Some(target), Some(kind)) = (&p.target_path, &p.relation_type) else {
            continue;
        };
        if changeset::relation_exists(conn, &p.source_path, target, kind)? {
            present += 1;
        } else {
            absent += 1;
        }
        for end in [&p.source_path, target] {
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM files WHERE path = ?1 COLLATE NOCASE",
                    params![end],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() && !dangling.contains(end) {
                dangling.push(end.clone());
            }
        }
    }

    Ok(PlanVerification {
        plan_id: plan.id.clone(),
        relation_total: total,
        proposals_present: present,
        proposals_absent: absent,
        dangling_endpoints: dangling,
        steps: plan.validation_steps.clone(),
        message: format!(
            "关系总数 {total}；计划中的 {present} 条已在库里，{absent} 条不在。"
        ),
    })
}

/// MOC 草稿 / a table-of-contents draft, not a written note.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MocDraft {
    pub suggested_path: String,
    pub title: String,
    /// Markdown 正文。**还没写盘**：用户看过之后才走笔记写入路径。
    pub content: String,
    pub member_paths: Vec<String>,
    pub evidence: Vec<GraphEvidence>,
    pub warnings: Vec<String>,
}

/// 从一组笔记生成 MOC 草稿 / draft a MOC from a set of notes.
///
/// 只生成文本与成员清单，不创建文件。"创建 MOC"必须先有预览——直接落一篇用户看不到
/// 来源的自动文章，是这份需求里点名要避免的事。
pub fn create_moc_draft(
    conn: &Connection,
    title: &str,
    member_paths: &[String],
) -> ObjectResult<MocDraft> {
    let mut lines = vec![
        format!("# {title}"),
        String::new(),
        "> 由图谱计划生成的目录草稿。每一项都来自你库里已有的笔记，还没有写入任何文件。"
            .to_string(),
        String::new(),
    ];
    let mut evidence = Vec::new();
    for path in member_paths {
        let note_title = title_of(conn, path);
        lines.push(format!("- [[{note_title}]]"));
        evidence.push(opening_evidence(conn, path, "chunk_text"));
    }
    if member_paths.is_empty() {
        lines.push("- （还没有选中任何成员笔记）".to_string());
    }

    Ok(MocDraft {
        suggested_path: format!("{title}.md"),
        title: title.to_string(),
        content: lines.join("\n"),
        member_paths: member_paths.to_vec(),
        evidence,
        warnings: vec![
            "这是草稿：确认后才会通过笔记写入路径创建文件，并显示完整 diff。".to_string(),
        ],
    })
}

/// 关系详情 + 证据 / one edge, with everything needed to judge it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEvidenceView {
    pub detail: Option<relations::RelationDetail>,
    pub semantic_similarity: Option<f64>,
    pub evidence: Vec<GraphEvidence>,
    /// 这条边的语义解释。`supports` / `contradicts` / `depends_on` 必须解释，
    /// 只画一条颜色不同的线等于没说。
    pub semantics: String,
}

/// 读一条边的详情与证据 / assemble the relation drawer payload.
pub fn relation_evidence(
    conn: &Connection,
    source: &str,
    target: &str,
    relation_type: &str,
) -> ObjectResult<RelationEvidenceView> {
    let detail = relations::relation_detail(conn, source, target, relation_type)?;
    let similarity: Option<f64> = conn
        .query_row(
            "SELECT similarity FROM semantic_edges
             WHERE (source_path = ?1 AND target_path = ?2)
                OR (source_path = ?2 AND target_path = ?1)",
            params![source, target],
            |r| r.get(0),
        )
        .optional()?;

    let semantics = match relation_type {
        "supports" => "源笔记的内容为目标笔记的主张提供支持。",
        "contradicts" => "两篇笔记的主张互相矛盾，需要你判断哪一个成立。",
        "depends_on" => "源笔记的结论依赖目标笔记的事实，目标变了源就要复查。",
        "extends" => "源笔记在目标笔记的基础上继续展开。",
        "references" => "源笔记引用了目标笔记。",
        "example_of" => "源笔记是目标笔记所述概念的一个实例。",
        _ => "两篇笔记相关，但没有更具体的语义。",
    };

    Ok(RelationEvidenceView {
        detail,
        semantic_similarity: similarity,
        evidence: vec![
            opening_evidence(conn, source, "chunk_text"),
            opening_evidence(conn, target, "chunk_text"),
        ],
        semantics: semantics.to_string(),
    })
}

/// 审计一次计划动作 / leave an audit trail for one plan action.
pub fn record_plan_audit(
    conn: &Connection,
    actor: &str,
    action: &str,
    outcome: &PlanOutcome,
) -> ObjectResult<()> {
    object_store::record_audit(
        conn,
        actor,
        action,
        &outcome.state,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(
            &serde_json::json!({
                "planId": outcome.plan_id,
                "changesetId": outcome.changeset_id,
                "applied": outcome.applied,
                "alreadyExisted": outcome.already_existed,
                "rejectedByUser": outcome.rejected_by_user,
                "failed": outcome.failed,
                "refusal": outcome.refusal,
            })
            .to_string(),
        ),
    )?;
    Ok(())
}

