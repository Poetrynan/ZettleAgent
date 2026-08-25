//! 画布计划 / the canvas plan: goal → observations → proposals → verified canvas.
//!
//! ## 为什么画布 AI 也需要"计划"这层东西
//!
//! Smart Canvas 之前是一条直线：搜一把笔记 → 默认全选 → 一次性铺到画布上 →
//! 弹一个"已添加 N 个笔记"的 toast。三件事因此分不开——**它检索到了什么**、
//! **它为什么认为这几篇该放一起**、**它到底往文件里写了什么**。用户只能整体接受，
//! 而那句"已添加"的依据仅仅是"调用没抛异常"。
//!
//! 本模块把这三件事拆成可逐项审查的结构，与 [`graph_plan`](super::graph_plan) 完全同形：
//!
//! ```text
//! CanvasGoal        用户想要一张什么画布（类型 + 范围 + 锚点 + 约束）
//! CanvasObservation 从库里读到的事实（每条都指得出证据）
//! CanvasProposal    想往画布上加的一个东西（节点/分组/连线/排版）
//! CanvasPlan        以上三者 + 实际布局 + 降级原因 + 验证步骤 + 未解决的问题
//! ```
//!
//! ## 观察是算出来的，不是模型说的
//!
//! 所有观察与提议都来自 `files`、`chunks`、`note_relations`、`semantic_edges` 的真实
//! 查询。提议的置信度**就是** `semantic_edges.similarity` 本身，不放大、不补默认值：
//! 前端"只默认勾选 ≥ 0.8"这条规则要成立，这个数就必须是可比的真数。没有 LLM 时这一层
//! 照样能给出完整计划，`generated_by` 如实写 `deterministic`。
//!
//! ## 布局降级要说出来
//!
//! 请求"依赖层级"却一条依赖边都没有、请求"树"却图里有环——这两种情况以前的表现是
//! 悄悄画一张网格，然后仍然宣称按依赖排好了。[`CanvasPlan::layout`] 记的是**真正用了
//! 哪种**，[`CanvasPlan::layout_fallback_reason`] 记的是原来那种为什么做不到。这两个
//! 字段一起存在的唯一目的，就是让"画布看起来排好了"不能替代"画布真按你要的排好了"。
//!
//! ## 提交走的是同一条门禁
//!
//! [`stage_plan`] 把最终的 JSON Canvas 交给 [`write_guard`](super::write_guard) 的
//! `open_intents` → `dry_run` → `settle` 流程。`create_canvas` / `modify_canvas` 早就
//! 在 `MAPPED_WRITE_TOOLS` 里，所以画布写入与笔记写入共享 scope 校验、冲突检测、审批
//! 记录、审计与撤销。这里**没有**第二条写入路径。

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::changeset;
use super::graph_plan::KnowledgeScope;
use super::object_store::{self, ObjectError, ObjectResult};
use super::types::{new_object_id, now_ms};
use super::write_guard::{self, Guarded, ReadyWrite, WriteContext};

/// 用户的目标 / what the user asked the canvas for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasGoal {
    /// `explain` / `compare` / `trace` / `cluster`。
    pub goal_type: String,
    #[serde(default)]
    pub scope: KnowledgeScope,
    /// 锚点笔记路径。`explain` 用一个，`compare` 用两个以上，`trace` 用一个起点。
    #[serde(default)]
    pub anchor_paths: Vec<String>,
    #[serde(default)]
    pub question: String,
    /// 用户写下的限制，例如"不要动已有节点"。原样带进计划，供审查时对照。
    #[serde(default)]
    pub constraints: Vec<String>,
    /// 最多往画布上加多少个节点。上限是产品规则：一张两百个节点的画布不是知识结构，
    /// 是一次倾倒。
    #[serde(default)]
    pub max_nodes: Option<usize>,
}

/// 一条从库里读出来的事实 / one fact read from the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasObservation {
    pub id: String,
    /// `anchor` / `neighbour` / `similar_pair` / `dependency_chain` / `cluster`。
    pub kind: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// 支持这条观察的证据。文件级证据要在 UI 上标明是文件级。
    #[serde(default)]
    pub evidence: Vec<CanvasEvidence>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 一条证据 / one piece of evidence behind an observation or proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEvidence {
    pub path: String,
    /// 精确到块时给 chunk id；只能给到文件时为 `None`，UI 必须说明这是文件级依据。
    pub chunk_id: Option<i64>,
    pub excerpt: Option<String>,
    /// `relation_table` / `semantic_edge` / `chunk_text` / `file_level`。
    pub kind: String,
}

/// 一次想往画布上加的东西 / one change the plan proposes to the canvas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasProposal {
    pub id: String,
    /// `add_node` / `add_group` / `add_edge` / `arrange`。
    pub operation: String,
    /// `add_node` 一个路径；`add_edge` 两个（源、目标）；`add_group` 一组成员。
    pub node_paths: Vec<String>,
    pub group_title: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub evidence: Vec<CanvasEvidence>,
    /// **就是** `semantic_edges.similarity`（或关系表命中时的 1.0）。不放大。
    pub confidence: f64,
    /// `low` / `medium` / `high`。
    pub risk: String,
    #[serde(default)]
    pub affected_paths: Vec<String>,
}

/// 一份完整计划 / the whole canvas plan, ready to be reviewed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPlan {
    pub id: String,
    pub goal: CanvasGoal,
    pub observations: Vec<CanvasObservation>,
    pub proposals: Vec<CanvasProposal>,
    /// **实际**会用的布局：`radial` / `columns` / `dependency` / `clusters` / `grid`。
    pub layout: String,
    /// 请求的布局做不到时，为什么做不到。`None` = 请求的那种就是用上的那种。
    pub layout_fallback_reason: Option<String>,
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
    /// 要写的画布文件。相对路径按主 vault 解析，解析结果在 stage 时定下来。
    pub canvas_path: String,
}

// ── 阈值 / the thresholds, named ─────────────────────────────────────────────

/// 高于这个语义相似度才值得往画布上多放一个节点 / the floor for pulling in a neighbour.
///
/// 与 `graph_plan::BRIDGE_SIMILARITY_FLOOR` 同一个数，理由也同一个：
/// `compute_and_store_semantic_edges` 已经滤掉了低相似度的对，这里再抬一档，因为
/// "把一篇笔记摆到你正在看的画布上"比"在图上画一条淡线"更需要底气。
const NEIGHBOUR_SIMILARITY_FLOOR: f64 = 0.72;

/// 高于这个相似度才算同一簇 / above this, two notes belong in the same group.
const CLUSTER_SIMILARITY_FLOOR: f64 = 0.78;

/// 前端默认勾选的门槛 / the bar a proposal must clear to be pre-checked.
///
/// 0.8 与前端 `canvasPlan.ts` 的 `DEFAULT_SELECT_CONFIDENCE` 是同一个数，写在两边是
/// 为了让后端也能解释这条规则：低于它的提议**不会**被默认勾选。旧 Smart Canvas 默认
/// 全选，于是"用户批准了"退化成"用户点了确认"。
pub const DEFAULT_SELECT_CONFIDENCE: f64 = 0.8;

/// 一份计划最多往画布上加多少个节点 / how many nodes one plan may add by default.
const DEFAULT_MAX_NODES: usize = 24;

/// 无论用户填多少都不超过这个数 / the hard ceiling, regardless of what was asked.
const HARD_MAX_NODES: usize = 80;

/// `trace` 最多顺着依赖走几层 / how deep one trace may follow the chain.
const TRACE_MAX_DEPTH: usize = 4;

/// 画布节点的尺寸与间距 / node geometry, matching `canvas::ExportOptions::default`.
const NODE_W: i32 = 400;
const NODE_H: i32 = 300;
const NODE_GAP: i32 = 100;

/// `trace` 认哪些关系类型是"链" / the relation types a trace may follow.
const CHAIN_RELATION_TYPES: &[&str] = &["depends_on", "extends", "supports", "references"];

// ── 计划生成 / building the plan ─────────────────────────────────────────────

/// 每种目标本来想用哪种布局 / the layout each goal type asks for.
fn requested_layout_for(goal_type: &str) -> &'static str {
    match goal_type {
        "compare" => "columns",
        "trace" => "dependency",
        "cluster" => "clusters",
        // `explain` 是默认：锚点在中间，邻居围一圈。
        _ => "radial",
    }
}

/// 按目标算一份计划 / compute the canvas plan for one goal.
///
/// 全部来自真实查询。没有 LLM 也能跑完——`generated_by` 会如实写 `deterministic`。
pub fn create_plan(
    conn: &Connection,
    goal: CanvasGoal,
    canvas_path: &str,
) -> ObjectResult<CanvasPlan> {
    let limit = goal
        .max_nodes
        .unwrap_or(DEFAULT_MAX_NODES)
        .clamp(1, HARD_MAX_NODES);
    let mut unresolved = Vec::new();

    let (observations, mut proposals) = match goal.goal_type.as_str() {
        "compare" => compare_canvas(conn, &goal, limit)?,
        "trace" => trace_canvas(conn, &goal, limit)?,
        "cluster" => cluster_canvas(conn, &goal, limit)?,
        _ => explain_canvas(conn, &goal, limit)?,
    };

    if proposals.is_empty() {
        unresolved.push(
            "库里没有算得出来的素材：锚点没有关系边、也没有相似度过线的邻居。\
             可以先补写中间概念，或者放宽范围重试。"
                .to_string(),
        );
    }
    if goal.goal_type == "compare" && goal.anchor_paths.len() < 2 {
        unresolved.push(
            "对比至少需要两个锚点。只给了一个时这一轮只能按单锚点展开，不能对比。"
                .to_string(),
        );
    }

    cap_node_count(&mut proposals, limit);
    let (layout, layout_fallback_reason) = settle_layout(requested_layout_for(&goal.goal_type), &proposals);

    Ok(CanvasPlan {
        id: new_object_id(),
        goal,
        observations,
        proposals,
        layout,
        layout_fallback_reason,
        validation_steps: vec![
            "提交后重新读取画布文件，逐条核对提议的节点与分组是否真的在里面".to_string(),
            "检查每个节点指向的笔记是否仍存在于 files 表".to_string(),
            "核对写入前后的节点总数差与本次批准数量一致".to_string(),
        ],
        unresolved_questions: unresolved,
        generated_by: "deterministic".to_string(),
        generated_at_ms: now_ms(),
        changeset_id: None,
        state: "preview_ready".to_string(),
        canvas_path: canvas_path.to_string(),
    })
}

// ── 共用查询 / the shared read helpers ───────────────────────────────────────

/// 范围过滤的 SQL 片段 / the scope filter, as a predicate on one column.
///
/// 空范围 = 整库。与 `changeset::path_in_scope` 的方向刻意不同：那是**写入许可**
/// （空 = 什么都不许写），这是**查询范围**（空 = 全都看）。两个默认值反着来是对的，
/// 混成一个会让"没选范围"要么什么都查不到，要么什么都能写。
///
/// 占位符是编号的 `?N` 而不是裸 `?`：本模块的查询里锚点参数出现在 SQL 文本的**前面**，
/// 而范围参数在后面。SQLite 给裸 `?` 分配的编号是"到此为止用过的最大编号 + 1"，一旦
/// 同一条语句里两种写法混用，范围参数就会被绑到一个空槽上，查询静默返回零行。
fn scope_clause(scope: &KnowledgeScope, column: &str, first_index: usize) -> (String, Vec<String>) {
    if scope.paths.is_empty() {
        return ("1=1".to_string(), Vec::new());
    }
    let mut parts = Vec::new();
    let mut binds = Vec::new();
    for (i, p) in scope.paths.iter().enumerate() {
        parts.push(format!("{column} LIKE ?{}", first_index + i));
        binds.push(format!("{}%", p.replace('\\', "/")));
    }
    (format!("({})", parts.join(" OR ")), binds)
}


/// 一篇笔记的标题 / the title the canvas shows for a path.
fn title_of(conn: &Connection, path: &str) -> String {
    conn.query_row(
        "SELECT COALESCE(title, path) FROM files WHERE path = ?1",
        params![path],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| path.to_string())
}

/// 一篇笔记的第一段，作为证据 / the opening chunk, as evidence.
fn opening_evidence(conn: &Connection, path: &str, kind: &str) -> CanvasEvidence {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, content FROM chunks WHERE file_path = ?1 ORDER BY chunk_index LIMIT 1",
            params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap_or(None);
    match row {
        Some((id, content)) => CanvasEvidence {
            path: path.to_string(),
            chunk_id: Some(id),
            excerpt: Some(content.chars().take(160).collect()),
            kind: kind.to_string(),
        },
        // 拿不到片段就如实标成文件级依据，而不是编一段摘录。
        None => CanvasEvidence {
            path: path.to_string(),
            chunk_id: None,
            excerpt: None,
            kind: "file_level".to_string(),
        },
    }
}

/// 一次带绑定参数的取行 / run one scoped query and collect its rows.
fn query_rows<T, F>(conn: &Connection, sql: &str, binds: &[String], map: F) -> ObjectResult<Vec<T>>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut stmt = conn.prepare(sql)?;
    let params_dyn: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let rows: Vec<T> = stmt
        .query_map(params_dyn.as_slice(), |r| map(r))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 关系表里的邻居 / neighbours the relation table already knows about.
///
/// 置信度给 1.0 而不是猜一个数：这条边已经在库里了，"它存在"是事实，不是推断。
fn relation_neighbours(
    conn: &Connection,
    goal: &CanvasGoal,
    anchor: &str,
    limit: usize,
) -> ObjectResult<Vec<(String, String, f64)>> {
    // 锚点占 ?1，范围参数从 ?2 起。
    let (clause, scope_binds) = scope_clause(&goal.scope, "other", 2);
    let sql = format!(
        "SELECT other, relation_type FROM (
             SELECT target_path AS other, relation_type FROM note_relations WHERE source_path = ?1
             UNION
             SELECT source_path AS other, relation_type FROM note_relations WHERE target_path = ?1
         )
         WHERE {clause} AND other <> ?1
         ORDER BY other
         LIMIT {limit}"
    );
    let mut binds = vec![anchor.to_string()];
    binds.extend(scope_binds);
    let rows = query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows
        .into_iter()
        .map(|(path, kind)| (path, kind, 1.0))
        .collect())
}

/// 语义邻居 / neighbours the vector index says are close.
///
/// 返回的相似度原样带出，后面直接当 `confidence` 用。放大它就等于伪造一个更确定的判断。
fn semantic_neighbours(
    conn: &Connection,
    goal: &CanvasGoal,
    anchor: &str,
    floor: f64,
    limit: usize,
) -> ObjectResult<Vec<(String, f64)>> {
    let (clause, scope_binds) = scope_clause(&goal.scope, "other", 2);
    let sql = format!(
        "SELECT other, MAX(similarity) AS best FROM (
             SELECT target_path AS other, similarity FROM semantic_edges WHERE source_path = ?1
             UNION ALL
             SELECT source_path AS other, similarity FROM semantic_edges WHERE target_path = ?1
         )
         WHERE {clause} AND other <> ?1 AND similarity >= {floor}
         GROUP BY other
         ORDER BY best DESC
         LIMIT {limit}"
    );
    let mut binds = vec![anchor.to_string()];
    binds.extend(scope_binds);
    query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
    })
}


/// 一个"加节点"提议 / one add_node proposal.
fn node_proposal(
    conn: &Connection,
    path: &str,
    confidence: f64,
    reason: String,
    evidence_kind: &str,
) -> CanvasProposal {
    CanvasProposal {
        id: new_object_id(),
        operation: "add_node".to_string(),
        node_paths: vec![path.to_string()],
        group_title: None,
        reason,
        evidence: vec![opening_evidence(conn, path, evidence_kind)],
        confidence,
        // 往画布上多摆一个节点不动笔记正文，风险是低的；改动的只有 .canvas 文件。
        risk: "low".to_string(),
        affected_paths: vec![path.to_string()],
    }
}

/// 一个"加连线"提议 / one add_edge proposal.
fn edge_proposal(
    source: &str,
    target: &str,
    confidence: f64,
    reason: String,
    evidence: Vec<CanvasEvidence>,
) -> CanvasProposal {
    CanvasProposal {
        id: new_object_id(),
        operation: "add_edge".to_string(),
        node_paths: vec![source.to_string(), target.to_string()],
        group_title: None,
        reason,
        evidence,
        confidence,
        risk: "low".to_string(),
        affected_paths: vec![source.to_string(), target.to_string()],
    }
}

/// 锚点自己那条观察 / the observation that states the anchor exists.
fn anchor_observation(conn: &Connection, path: &str) -> CanvasObservation {
    let title = title_of(conn, path);
    CanvasObservation {
        id: new_object_id(),
        kind: "anchor".to_string(),
        title: format!("锚点《{title}》"),
        summary: "这张画布围绕它展开；它本身会作为一个文件节点放上去。".to_string(),
        evidence: vec![opening_evidence(conn, path, "chunk_text")],
        paths: vec![path.to_string()],
        confidence: Some(1.0),
        warnings: Vec::new(),
    }
}

// ── 四种目标 / the four goal types ───────────────────────────────────────────

/// `explain`：锚点 + 它的邻居 / one anchor, surrounded by what it connects to.
fn explain_canvas(
    conn: &Connection,
    goal: &CanvasGoal,
    limit: usize,
) -> ObjectResult<(Vec<CanvasObservation>, Vec<CanvasProposal>)> {
    let Some(anchor) = goal.anchor_paths.first() else {
        // 没有锚点就没有"解释谁"。返回空计划，让 `create_plan` 把这句话写进
        // unresolvedQuestions，而不是随便挑一篇笔记当锚点。
        return Ok((Vec::new(), Vec::new()));
    };

    let mut observations = vec![anchor_observation(conn, anchor)];
    let mut proposals = vec![node_proposal(
        conn,
        anchor,
        1.0,
        "锚点笔记本身。".to_string(),
        "chunk_text",
    )];

    let mut seen: HashSet<String> = HashSet::from([anchor.clone()]);

    for (path, relation_type, confidence) in relation_neighbours(conn, goal, anchor, limit)? {
        if !seen.insert(path.clone()) {
            continue;
        }
        let title = title_of(conn, &path);
        let evidence = vec![
            CanvasEvidence {
                path: path.clone(),
                chunk_id: None,
                excerpt: Some(format!("note_relations 里的关系类型：{relation_type}")),
                kind: "relation_table".to_string(),
            },
            opening_evidence(conn, &path, "chunk_text"),
        ];
        observations.push(CanvasObservation {
            id: new_object_id(),
            kind: "neighbour".to_string(),
            title: format!("《{title}》已经与锚点有 {relation_type} 关系"),
            summary: "这条边已经在关系表里，画布上把它画出来只是让它可见。".to_string(),
            evidence: evidence.clone(),
            paths: vec![anchor.clone(), path.clone()],
            confidence: Some(confidence),
            warnings: Vec::new(),
        });
        proposals.push(node_proposal(
            conn,
            &path,
            confidence,
            format!("与锚点存在 {relation_type} 关系。"),
            "chunk_text",
        ));
        proposals.push(edge_proposal(
            anchor,
            &path,
            confidence,
            format!("关系表里已有的 {relation_type} 边。"),
            evidence,
        ));
    }

    for (path, similarity) in
        semantic_neighbours(conn, goal, anchor, NEIGHBOUR_SIMILARITY_FLOOR, limit)?
    {
        if !seen.insert(path.clone()) {
            continue;
        }
        let title = title_of(conn, &path);
        let evidence = vec![
            CanvasEvidence {
                path: path.clone(),
                chunk_id: None,
                excerpt: Some(format!("语义相似度 {similarity:.2}")),
                kind: "semantic_edge".to_string(),
            },
            opening_evidence(conn, &path, "chunk_text"),
        ];
        observations.push(CanvasObservation {
            id: new_object_id(),
            kind: "similar_pair".to_string(),
            title: format!("《{title}》与锚点内容接近（{similarity:.2}）"),
            summary: "向量检索算出的相似度过线，但关系表里没有这条边。".to_string(),
            evidence: evidence.clone(),
            paths: vec![anchor.clone(), path.clone()],
            confidence: Some(similarity),
            warnings: Vec::new(),
        });
        // 置信度就是相似度本身：用户看到的数与算出来的数是同一个。
        proposals.push(node_proposal(
            conn,
            &path,
            similarity,
            format!("与锚点的语义相似度为 {similarity:.2}。"),
            "chunk_text",
        ));
    }

    Ok((observations, proposals))
}

/// `compare`：一个锚点一列 / one column per anchor, so two ideas can be read side by side.
fn compare_canvas(
    conn: &Connection,
    goal: &CanvasGoal,
    limit: usize,
) -> ObjectResult<(Vec<CanvasObservation>, Vec<CanvasProposal>)> {
    let mut observations = Vec::new();
    let mut proposals = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // 每个锚点分到的额度。除法向下取整后至少给 1，否则锚点多时每列都空。
    let per_anchor = (limit / goal.anchor_paths.len().max(1)).max(1);

    for anchor in &goal.anchor_paths {
        observations.push(anchor_observation(conn, anchor));
        let anchor_title = title_of(conn, anchor);
        let mut members = Vec::new();

        if seen.insert(anchor.clone()) {
            proposals.push(node_proposal(
                conn,
                anchor,
                1.0,
                format!("《{anchor_title}》是这一列的锚点。"),
                "chunk_text",
            ));
        }
        members.push(anchor.clone());

        for (path, similarity) in
            semantic_neighbours(conn, goal, anchor, NEIGHBOUR_SIMILARITY_FLOOR, per_anchor)?
        {
            // 一篇笔记只归一列。同时贴近两个锚点时归先出现的那个，并在观察里说明——
            // 悄悄放两份会让"这两组各有多少篇"这个最基本的对比读数失真。
            if !seen.insert(path.clone()) {
                observations.push(CanvasObservation {
                    id: new_object_id(),
                    kind: "similar_pair".to_string(),
                    title: format!("《{}》同时贴近多个锚点", title_of(conn, &path)),
                    summary: "它已经归到前面的一列里了，这里不再重复放一份。".to_string(),
                    evidence: vec![opening_evidence(conn, &path, "chunk_text")],
                    paths: vec![anchor.clone(), path.clone()],
                    confidence: Some(similarity),
                    warnings: vec!["同一篇笔记只在一列中出现".to_string()],
                });
                continue;
            }
            members.push(path.clone());
            proposals.push(node_proposal(
                conn,
                &path,
                similarity,
                format!("与《{anchor_title}》的语义相似度为 {similarity:.2}。"),
                "chunk_text",
            ));
        }

        proposals.push(CanvasProposal {
            id: new_object_id(),
            operation: "add_group".to_string(),
            node_paths: members.clone(),
            group_title: Some(anchor_title.clone()),
            reason: format!("把围绕《{anchor_title}》的 {} 篇笔记框成一列。", members.len()),
            evidence: members
                .iter()
                .map(|p| opening_evidence(conn, p, "chunk_text"))
                .collect(),
            confidence: 1.0,
            risk: "low".to_string(),
            affected_paths: members,
        });
    }

    Ok((observations, proposals))
}

/// 链上的下一步 / the outgoing chain edges of one note.
fn chain_step(
    conn: &Connection,
    goal: &CanvasGoal,
    from: &str,
) -> ObjectResult<Vec<(String, String)>> {
    let (clause, scope_binds) = scope_clause(&goal.scope, "target_path", 2);
    let types = CHAIN_RELATION_TYPES
        .iter()
        .map(|t| format!("'{t}'"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT target_path, relation_type FROM note_relations
         WHERE source_path = ?1 AND relation_type IN ({types}) AND {clause}
         ORDER BY relation_type, target_path"
    );
    let mut binds = vec![from.to_string()];
    binds.extend(scope_binds);
    query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })
}

/// `trace`：顺着依赖链走 / follow the chain of reasoning, one hop at a time.
fn trace_canvas(
    conn: &Connection,
    goal: &CanvasGoal,
    limit: usize,
) -> ObjectResult<(Vec<CanvasObservation>, Vec<CanvasProposal>)> {
    let Some(anchor) = goal.anchor_paths.first() else {
        return Ok((Vec::new(), Vec::new()));
    };

    let mut observations = vec![anchor_observation(conn, anchor)];
    let mut proposals = vec![node_proposal(
        conn,
        anchor,
        1.0,
        "推理链的起点。".to_string(),
        "chunk_text",
    )];
    let mut visited: HashSet<String> = HashSet::from([anchor.clone()]);
    let mut frontier = vec![(anchor.clone(), 0usize)];
    let mut hops = 0usize;

    while let Some((current, depth)) = frontier.pop() {
        if depth >= TRACE_MAX_DEPTH || visited.len() >= limit {
            continue;
        }
        for (target, relation_type) in chain_step(conn, goal, &current)? {
            let evidence = vec![
                CanvasEvidence {
                    path: current.clone(),
                    chunk_id: None,
                    excerpt: Some(format!("note_relations: {current} —{relation_type}→ {target}")),
                    kind: "relation_table".to_string(),
                },
                opening_evidence(conn, &target, "chunk_text"),
            ];
            // 边照画：链上出现回边时那条边本身是事实，只是不再往下展开。
            proposals.push(edge_proposal(
                &current,
                &target,
                1.0,
                format!("关系表里第 {} 跳的 {relation_type} 边。", depth + 1),
                evidence.clone(),
            ));
            hops += 1;
            if !visited.insert(target.clone()) {
                continue;
            }
            proposals.push(node_proposal(
                conn,
                &target,
                1.0,
                format!("从起点出发第 {} 跳，经 {relation_type} 到达。", depth + 1),
                "chunk_text",
            ));
            frontier.push((target.clone(), depth + 1));
            observations.push(CanvasObservation {
                id: new_object_id(),
                kind: "dependency_chain".to_string(),
                title: format!(
                    "《{}》—{relation_type}→《{}》",
                    title_of(conn, &current),
                    title_of(conn, &target)
                ),
                summary: format!("链上第 {} 跳，来自关系表而不是推断。", depth + 1),
                evidence,
                paths: vec![current.clone(), target.clone()],
                confidence: Some(1.0),
                warnings: Vec::new(),
            });
        }
    }

    if hops == 0 {
        observations.push(CanvasObservation {
            id: new_object_id(),
            kind: "dependency_chain".to_string(),
            title: "起点没有任何可追溯的链".to_string(),
            summary: format!(
                "关系表里这篇笔记没有 {} 之中任何一种出边，因此没有链可画。",
                CHAIN_RELATION_TYPES.join(" / ")
            ),
            evidence: vec![opening_evidence(conn, anchor, "chunk_text")],
            paths: vec![anchor.clone()],
            confidence: Some(1.0),
            warnings: vec!["布局会因此降级".to_string()],
        });
    }

    Ok((observations, proposals))
}

/// `cluster`：把相似的笔记分堆 / group notes the vector index puts near each other.
///
/// 只按真实相似度分堆，不合并、不改写任何笔记正文——分组是画布上的一个框，不是一次
/// 内容操作。
fn cluster_canvas(
    conn: &Connection,
    goal: &CanvasGoal,
    limit: usize,
) -> ObjectResult<(Vec<CanvasObservation>, Vec<CanvasProposal>)> {
    let (src_clause, src_binds) = scope_clause(&goal.scope, "source_path", 1);
    let (dst_clause, dst_binds) = scope_clause(&goal.scope, "target_path", 1 + src_binds.len());
    let sql = format!(
        "SELECT source_path, target_path, similarity FROM semantic_edges
         WHERE {src_clause} AND {dst_clause} AND similarity >= {CLUSTER_SIMILARITY_FLOOR}
         ORDER BY similarity DESC
         LIMIT {}",
        limit * 4
    );
    let mut binds = src_binds;
    binds.extend(dst_binds);
    let pairs: Vec<(String, String, f64)> = query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?))
    })?;

    // 连通分量即一堆。用最朴素的"合并到同一个 key"做法：数据量被上面的 LIMIT 卡住了，
    // 引入并查集只会让这段更难读。
    let mut cluster_of: HashMap<String, usize> = HashMap::new();
    let mut members: Vec<Vec<String>> = Vec::new();
    let mut best: HashMap<String, f64> = HashMap::new();
    let mut weakest: Vec<f64> = Vec::new();

    for (a, b, similarity) in &pairs {
        for p in [a, b] {
            let entry = best.entry(p.clone()).or_insert(*similarity);
            if *similarity > *entry {
                *entry = *similarity;
            }
        }
        match (cluster_of.get(a).copied(), cluster_of.get(b).copied()) {
            (Some(ia), Some(ib)) if ia != ib => {
                let moved = std::mem::take(&mut members[ib]);
                for p in &moved {
                    cluster_of.insert(p.clone(), ia);
                }
                members[ia].extend(moved);
                weakest[ia] = weakest[ia].min(weakest[ib]).min(*similarity);
            }
            (Some(ia), None) => {
                cluster_of.insert(b.clone(), ia);
                members[ia].push(b.clone());
                weakest[ia] = weakest[ia].min(*similarity);
            }
            (None, Some(ib)) => {
                cluster_of.insert(a.clone(), ib);
                members[ib].push(a.clone());
                weakest[ib] = weakest[ib].min(*similarity);
            }
            (None, None) => {
                let idx = members.len();
                members.push(vec![a.clone(), b.clone()]);
                weakest.push(*similarity);
                cluster_of.insert(a.clone(), idx);
                cluster_of.insert(b.clone(), idx);
            }
            _ => {}
        }
    }

    let mut observations = Vec::new();
    let mut proposals = Vec::new();
    let mut placed = 0usize;

    for (idx, group) in members.iter().enumerate() {
        if group.len() < 2 || placed >= limit {
            continue;
        }
        let label = format!("与《{}》相近的一组", title_of(conn, &group[0]));
        let evidence: Vec<CanvasEvidence> = group
            .iter()
            .map(|p| opening_evidence(conn, p, "chunk_text"))
            .collect();
        observations.push(CanvasObservation {
            id: new_object_id(),
            kind: "cluster".to_string(),
            title: format!("{} 篇笔记构成一堆（最弱一对 {:.2}）", group.len(), weakest[idx]),
            summary: "只是分堆，不合并、不改写任何一篇的正文。".to_string(),
            evidence: evidence.clone(),
            paths: group.clone(),
            confidence: Some(weakest[idx]),
            warnings: vec!["合并笔记不在画布计划的执行范围内".to_string()],
        });
        for path in group {
            if placed >= limit {
                break;
            }
            let confidence = best.get(path).copied().unwrap_or(weakest[idx]);
            proposals.push(node_proposal(
                conn,
                path,
                confidence,
                format!("同堆内最高相似度为 {confidence:.2}。"),
                "chunk_text",
            ));
            placed += 1;
        }
        proposals.push(CanvasProposal {
            id: new_object_id(),
            operation: "add_group".to_string(),
            node_paths: group.clone(),
            group_title: Some(label.clone()),
            // 分组的置信度取堆内**最弱**的一对，而不是最强的：一个框的可信度只能由把它
            // 撑得最勉强的那条边决定，取最大值会让一个勉强成立的分组看起来铁证如山。
            confidence: weakest[idx],
            reason: format!("这一堆里最弱的一对相似度是 {:.2}。", weakest[idx]),
            evidence,
            risk: "low".to_string(),
            affected_paths: group.clone(),
        });
    }

    Ok((observations, proposals))
}

// ── 上限与布局 / the cap, and telling the truth about the layout ─────────────

/// 砍到节点上限 / trim the plan down to the node budget.
///
/// 数的是**不重复的笔记路径**，不是提议条数：连线和分组不占节点预算，而同一篇笔记被两
/// 个提议提到也只占一个。按提议条数砍会让"最多 24 个节点"在有分组时变成七八个。
///
/// 被砍掉的节点，其相关的连线和分组成员也要一起清掉，否则画布里会出现指向不存在节点的
/// 边——Obsidian 打开时那条边直接消失，用户只会以为写入丢了东西。
fn cap_node_count(proposals: &mut Vec<CanvasProposal>, limit: usize) {
    let mut kept: HashSet<String> = HashSet::new();
    for p in proposals.iter() {
        if p.operation != "add_node" {
            continue;
        }
        if kept.len() >= limit {
            break;
        }
        if let Some(path) = p.node_paths.first() {
            kept.insert(path.clone());
        }
    }

    proposals.retain(|p| match p.operation.as_str() {
        "add_node" => p.node_paths.first().is_some_and(|p| kept.contains(p)),
        "add_edge" => p.node_paths.iter().all(|p| kept.contains(p)),
        _ => true,
    });

    for p in proposals.iter_mut() {
        if p.operation == "add_group" {
            p.node_paths.retain(|path| kept.contains(path));
            p.affected_paths.retain(|path| kept.contains(path));
        }
    }
    // 成员被砍空的分组不留：一个空框不是知识结构。
    proposals.retain(|p| p.operation != "add_group" || p.node_paths.len() >= 2);
}

/// 实际用哪种布局，以及请求的那种为什么不行 / the layout actually used, and why.
///
/// 这个函数存在的唯一理由是**不许悄悄降级**。以前请求依赖层级而库里没有依赖边时，代码
/// 直接走网格分支，返回值里没有任何痕迹，UI 于是照旧显示"已按依赖关系排列"。
fn settle_layout(requested: &str, proposals: &[CanvasProposal]) -> (String, Option<String>) {
    let edges: Vec<(&String, &String)> = proposals
        .iter()
        .filter(|p| p.operation == "add_edge" && p.node_paths.len() == 2)
        .map(|p| (&p.node_paths[0], &p.node_paths[1]))
        .collect();
    let groups = proposals.iter().filter(|p| p.operation == "add_group").count();

    match requested {
        "dependency" => {
            if edges.is_empty() {
                (
                    "grid".to_string(),
                    Some(
                        "请求的是依赖层级布局，但计划里一条依赖边都没有：没有边就没有层级，\
                         实际用的是网格。"
                            .to_string(),
                    ),
                )
            } else if let Some(cycle) = first_cycle(&edges) {
                (
                    "grid".to_string(),
                    Some(format!(
                        "依赖关系里存在环（{cycle}），环上没有唯一的层级顺序。\
                         强行分层会画出一张假的树，实际用的是网格。"
                    )),
                )
            } else {
                ("dependency".to_string(), None)
            }
        }
        "columns" => {
            if groups >= 2 {
                ("columns".to_string(), None)
            } else {
                (
                    "grid".to_string(),
                    Some(format!(
                        "对比布局需要至少两组可并排的笔记，这一轮只算出 {groups} 组，\
                         实际用的是网格。"
                    )),
                )
            }
        }
        "clusters" => {
            if groups >= 1 {
                ("clusters".to_string(), None)
            } else {
                (
                    "grid".to_string(),
                    Some(
                        "没有任何一堆达到成组的相似度门槛，没有堆可分，实际用的是网格。"
                            .to_string(),
                    ),
                )
            }
        }
        "radial" => {
            if edges.is_empty() {
                (
                    "grid".to_string(),
                    Some(
                        "放射布局需要锚点至少有一个邻居可以围在外圈，这一轮一条边都没有，\
                         实际用的是网格。"
                            .to_string(),
                    ),
                )
            } else {
                ("radial".to_string(), None)
            }
        }
        other => (other.to_string(), None),
    }
}

/// 找出第一个环 / the first cycle, spelled out so the fallback reason can name it.
fn first_cycle(edges: &[(&String, &String)]) -> Option<String> {
    let mut out: HashMap<&str, Vec<&str>> = HashMap::new();
    for (a, b) in edges {
        out.entry(a.as_str()).or_default().push(b.as_str());
    }
    let mut done: HashSet<&str> = HashSet::new();

    for start in out.keys().copied() {
        // 迭代式 DFS：路径本身就是环的证据，所以要留着，不能只回一个 bool。
        let mut path: Vec<&str> = Vec::new();
        let mut stack: Vec<(&str, usize)> = vec![(start, 0)];
        while let Some((node, next)) = stack.pop() {
            if next == 0 {
                if done.contains(node) {
                    continue;
                }
                if path.contains(&node) {
                    let at = path.iter().position(|p| *p == node).unwrap_or(0);
                    let mut ring: Vec<&str> = path[at..].to_vec();
                    ring.push(node);
                    return Some(
                        ring.iter()
                            .map(|p| leaf_name(p))
                            .collect::<Vec<_>>()
                            .join(" → "),
                    );
                }
                path.push(node);
            }
            let children = out.get(node).map(|v| v.as_slice()).unwrap_or(&[]);
            if next < children.len() {
                stack.push((node, next + 1));
                stack.push((children[next], 0));
            } else {
                done.insert(node);
                path.pop();
            }
        }
    }
    None
}

/// 路径的末段 / just the file name, for messages the user reads.
fn leaf_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .to_string()
}

// ── 存取 / persistence ───────────────────────────────────────────────────────

/// 建表 / the plan table.
///
/// 表在这里懒建而不是写进 `db::schema`：本模块是后加的一层，schema 那个文件同时被别的
/// 改动占着，往里塞一张只有画布计划用的表会把两处改动绑在一起。
///
/// 计划必须存下来，否则"预览 → 用户看一会儿 → 批准"中间应用重启就丢了，而重新生成一份
/// 计划里的 proposal id 全变了，用户刚才勾掉的那条会重新出现。
///
/// `staged_json` 存的是预览时**算好的最终画布**：提交时直接写它，而不是重新算一遍。
/// 重算的风险不是慢，而是这中间库里的边可能已经变了，于是用户批准的预览和真正落盘的
/// 内容会悄悄不是同一份。
pub fn ensure_table(conn: &Connection) -> ObjectResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS canvas_plans (
            id TEXT PRIMARY KEY,
            plan_json TEXT NOT NULL,
            changeset_id TEXT,
            state TEXT NOT NULL,
            abs_path TEXT,
            staged_json TEXT,
            selected_ids TEXT,
            previous_content TEXT,
            previous_existed INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );",
        [],
    )?;
    Ok(())
}

/// 存一份计划 / persist one plan.
///
/// 刻意只更新计划本体的四个字段：`staged_json` 等提交材料由 [`save_staged`] 单独写。
/// 一起更新的话，`commit_plan` 里那次状态回写会把刚刚批准的那份预览覆盖成 NULL。
pub fn save_plan(conn: &Connection, plan: &CanvasPlan) -> ObjectResult<()> {
    ensure_table(conn)?;
    let json = serde_json::to_string(plan).unwrap_or_default();
    conn.execute(
        "INSERT INTO canvas_plans
            (id, plan_json, changeset_id, state, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
            plan_json = ?2, changeset_id = ?3, state = ?4, updated_at_ms = ?5",
        params![plan.id, json, plan.changeset_id, plan.state, now_ms()],
    )?;
    Ok(())
}

/// 读一份计划 / load one plan.
pub fn load_plan(conn: &Connection, plan_id: &str) -> ObjectResult<Option<CanvasPlan>> {
    ensure_table(conn)?;
    let json: Option<String> = conn
        .query_row(
            "SELECT plan_json FROM canvas_plans WHERE id = ?1",
            params![plan_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

/// 用户批准的那份预览 / exactly what the user approved, ready to be written.
#[derive(Debug, Clone)]
struct StagedCanvas {
    abs_path: String,
    canvas_json: String,
    /// 用户当时勾了哪几条。存 id 而不是数量：提交后要逐条核对"它真的在文件里吗"，
    /// 只存一个数就只能报"应该有 5 条"，报不出"第 3 条没进去"。
    selected_ids: Vec<String>,
}

/// 记下预览 / remember the staged canvas.
fn save_staged(
    conn: &Connection,
    plan_id: &str,
    abs_path: &str,
    canvas_json: &str,
    selected_ids: &[String],
) -> ObjectResult<()> {
    conn.execute(
        "UPDATE canvas_plans SET abs_path = ?2, staged_json = ?3, selected_ids = ?4,
                                 updated_at_ms = ?5
         WHERE id = ?1",
        params![
            plan_id,
            abs_path,
            canvas_json,
            serde_json::to_string(selected_ids).unwrap_or_else(|_| "[]".to_string()),
            now_ms()
        ],
    )?;
    Ok(())
}

/// 取回预览 / load the staged canvas.
fn load_staged(conn: &Connection, plan_id: &str) -> ObjectResult<Option<StagedCanvas>> {
    ensure_table(conn)?;
    let row: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT abs_path, staged_json, selected_ids FROM canvas_plans WHERE id = ?1",
            params![plan_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        Some((Some(abs_path), Some(canvas_json), selected)) => Some(StagedCanvas {
            abs_path,
            canvas_json,
            selected_ids: selected
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
        }),
        _ => None,
    })
}


/// 记下回滚点 / remember what the file looked like before the write.
fn save_rollback_point(
    conn: &Connection,
    plan_id: &str,
    previous: Option<&str>,
) -> ObjectResult<()> {
    conn.execute(
        "UPDATE canvas_plans SET previous_content = ?2, previous_existed = ?3, updated_at_ms = ?4
         WHERE id = ?1",
        params![
            plan_id,
            previous,
            i64::from(previous.is_some()),
            now_ms()
        ],
    )?;
    Ok(())
}

/// 取回回滚点 / load the pre-image, and whether there ever was one.
fn load_rollback_point(conn: &Connection, plan_id: &str) -> ObjectResult<(Option<String>, bool)> {
    ensure_table(conn)?;
    let row: Option<(Option<String>, i64)> = conn
        .query_row(
            "SELECT previous_content, previous_existed FROM canvas_plans WHERE id = ?1",
            params![plan_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        Some((content, existed)) => (content, existed != 0),
        None => (None, false),
    })
}

// ── 画布组装 / turning proposals into JSON Canvas 1.0 ─────────────────────────

/// 任一种节点的外框 / the bounding box of any node kind.
fn node_box(node: &crate::canvas::Node) -> (i32, i32, i32, i32) {
    use crate::canvas::Node;
    match node {
        Node::File { x, y, width, height, .. }
        | Node::Text { x, y, width, height, .. }
        | Node::Link { x, y, width, height, .. }
        | Node::Group { x, y, width, height, .. } => (*x, *y, *width, *height),
    }
}

/// 路径归一化 / one spelling for one file, so "already on the canvas" is decidable.
fn norm_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// 画布上已有的文件节点 / the file nodes already on the canvas, by normalised path.
fn existing_file_nodes(canvas: &crate::canvas::Canvas) -> HashMap<String, String> {
    use crate::canvas::Node;
    canvas
        .nodes
        .iter()
        .filter_map(|n| match n {
            Node::File { id, file, .. } => Some((norm_path(file), id.clone())),
            _ => None,
        })
        .collect()
}

/// 新内容从哪一行开始 / the y where new content may start.
///
/// 落在已有内容下方而不是从原点铺开：从 (0,0) 开始会把新节点盖在用户自己排好的节点上，
/// 而 JSON Canvas 没有 z 序，重叠之后只能一个个手动拖开。
fn base_offset(canvas: &crate::canvas::Canvas) -> i32 {
    canvas
        .nodes
        .iter()
        .map(|n| {
            let (_, y, _, h) = node_box(n);
            y + h
        })
        .max()
        .map(|bottom| bottom + NODE_GAP * 2)
        .unwrap_or(0)
}

/// 给新节点排位置 / assign coordinates, according to the layout actually chosen.
///
/// 只排**新**节点。已有节点一律不动：用户手摆过的画布被"智能排版"重排一遍，是这次要
/// 消掉的行为之一。
fn place_nodes(
    layout: &str,
    ordered: &[String],
    groups: &[Vec<String>],
    edges: &[(String, String)],
) -> HashMap<String, (i32, i32)> {
    let step_x = NODE_W + NODE_GAP;
    let step_y = NODE_H + NODE_GAP;
    let mut at: HashMap<String, (i32, i32)> = HashMap::new();

    match layout {
        "columns" | "clusters" => {
            let mut column = 0;
            for group in groups {
                for (row, path) in group.iter().enumerate() {
                    if ordered.contains(path) {
                        at.insert(path.clone(), (column * (step_x + NODE_GAP), row as i32 * step_y));
                    }
                }
                column += 1;
            }
            // 没进任何分组的节点单独一列，而不是塞进最后一组里冒充成员。
            let mut row = 0;
            for path in ordered {
                if at.contains_key(path) {
                    continue;
                }
                at.insert(path.clone(), (column * (step_x + NODE_GAP), row * step_y));
                row += 1;
            }
        }
        "radial" => {
            let Some((center, ring)) = ordered.split_first() else {
                return at;
            };
            at.insert(center.clone(), (0, 0));
            let radius = (step_x as f64) * (1.0 + ring.len() as f64 / 12.0);
            for (i, path) in ring.iter().enumerate() {
                let angle = (i as f64 / ring.len().max(1) as f64) * std::f64::consts::TAU;
                at.insert(
                    path.clone(),
                    ((radius * angle.cos()) as i32, (radius * angle.sin()) as i32),
                );
            }
        }
        "dependency" => {
            // 层号 = 从任一无入边节点出发的最长距离。`settle_layout` 已经排除了有环的
            // 情况，所以这里的 BFS 一定会终止。
            let mut level: HashMap<&str, usize> = HashMap::new();
            let targets: HashSet<&str> = edges.iter().map(|(_, b)| b.as_str()).collect();
            for path in ordered {
                if !targets.contains(path.as_str()) {
                    level.insert(path.as_str(), 0);
                }
            }
            for _ in 0..ordered.len() {
                for (a, b) in edges {
                    if let Some(la) = level.get(a.as_str()).copied() {
                        let entry = level.entry(b.as_str()).or_insert(la + 1);
                        if *entry < la + 1 {
                            *entry = la + 1;
                        }
                    }
                }
            }
            let mut used_in_row: HashMap<usize, i32> = HashMap::new();
            for path in ordered {
                let l = level.get(path.as_str()).copied().unwrap_or(0);
                let col = used_in_row.entry(l).or_insert(0);
                at.insert(path.clone(), (*col * step_x, l as i32 * (step_y + NODE_GAP)));
                *col += 1;
            }
        }
        // `grid` 与任何没实现的名字都走网格。这不是悄悄降级：能走到这里的 `layout`
        // 已经由 `settle_layout` 定过，降级原因也已经写进计划了。
        _ => {
            let cols = (ordered.len() as f64).sqrt().ceil().max(1.0) as usize;
            for (i, path) in ordered.iter().enumerate() {
                at.insert(
                    path.clone(),
                    ((i % cols) as i32 * step_x, (i / cols) as i32 * step_y),
                );
            }
        }
    }
    at
}

/// 组装的结果 / what the assembled canvas contains, counted.
#[derive(Debug, Clone)]
struct BuiltCanvas {
    canvas_json: String,
    nodes_added: usize,
    groups_added: usize,
    edges_added: usize,
    /// 已经在画布上、这次跳过的笔记。UI 要说清"跳过"不是"失败"。
    skipped_existing: usize,
}

/// 把选中的提议组装成一份完整的 JSON Canvas / assemble the file that will be written.
///
/// 组装是**增量**的：先读进画布现有内容，再往里加。整份重写会把用户自己加的文本节点、
/// 图片节点和手摆的位置一起抹掉，而那份内容不在任何提议里，也就不会出现在预览里——
/// 用户会在批准一个"新增 5 个节点"的预览之后丢掉三十个自己的节点。
fn build_canvas_json(
    conn: &Connection,
    plan: &CanvasPlan,
    chosen: &[&CanvasProposal],
    existing_raw: Option<&str>,
) -> ObjectResult<BuiltCanvas> {
    use crate::canvas::{Canvas, Edge, Node};

    let mut canvas: Canvas = match existing_raw {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(raw).map_err(|e| {
            // 解析不了就整批停下，绝不"当成空画布"重写：那会一次性删掉用户的整张画布。
            ObjectError::Invalid(format!(
                "画布文件 {} 不是可解析的 JSON Canvas（{e}），不能在它上面追加内容。",
                plan.canvas_path
            ))
        })?,
        _ => Canvas {
            nodes: Vec::new(),
            edges: Vec::new(),
        },
    };

    let existing = existing_file_nodes(&canvas);
    let offset_y = base_offset(&canvas);

    // 新节点，按提议顺序，去掉画布上已有的。
    let mut ordered: Vec<String> = Vec::new();
    let mut skipped_existing = 0usize;
    for p in chosen.iter().filter(|p| p.operation == "add_node") {
        let Some(path) = p.node_paths.first() else { continue };
        if existing.contains_key(&norm_path(path)) {
            skipped_existing += 1;
            continue;
        }
        if !ordered.contains(path) {
            ordered.push(path.clone());
        }
    }

    // 分组只框这次新加的成员：把已有节点圈进去就得移动它们，而那是用户摆的位置。
    let groups: Vec<(String, Vec<String>)> = chosen
        .iter()
        .filter(|p| p.operation == "add_group")
        .map(|p| {
            (
                p.group_title.clone().unwrap_or_else(|| "分组".to_string()),
                p.node_paths
                    .iter()
                    .filter(|m| ordered.contains(m))
                    .cloned()
                    .collect::<Vec<String>>(),
            )
        })
        .filter(|(_, members)| !members.is_empty())
        .collect();

    let edge_pairs: Vec<(String, String)> = chosen
        .iter()
        .filter(|p| p.operation == "add_edge" && p.node_paths.len() == 2)
        .map(|p| (p.node_paths[0].clone(), p.node_paths[1].clone()))
        .collect();

    let member_lists: Vec<Vec<String>> = groups.iter().map(|(_, m)| m.clone()).collect();
    let at = place_nodes(&plan.layout, &ordered, &member_lists, &edge_pairs);

    // id 带上计划 id：同一份计划重新 stage 时 id 稳定，两份不同计划写同一张画布也不撞。
    let tag = plan.id.chars().take(8).collect::<String>();
    let mut id_of: HashMap<String, String> = existing.clone();
    for (i, path) in ordered.iter().enumerate() {
        let (x, y) = at.get(path).copied().unwrap_or((0, 0));
        let id = format!("cp-{tag}-n{i}");
        id_of.insert(norm_path(path), id.clone());
        canvas.nodes.push(Node::File {
            id,
            x,
            y: y + offset_y,
            width: NODE_W,
            height: NODE_H,
            file: path.clone(),
            subpath: None,
            color: None,
        });
    }

    let mut groups_added = 0usize;
    for (gi, (label, members)) in groups.iter().enumerate() {
        let boxes: Vec<(i32, i32)> = members
            .iter()
            .filter_map(|m| at.get(m).copied())
            .collect();
        if boxes.is_empty() {
            continue;
        }
        let pad = 40;
        let min_x = boxes.iter().map(|(x, _)| *x).min().unwrap_or(0) - pad;
        let min_y = boxes.iter().map(|(_, y)| *y).min().unwrap_or(0) - pad + offset_y;
        let max_x = boxes.iter().map(|(x, _)| *x).max().unwrap_or(0) + NODE_W + pad;
        let max_y = boxes.iter().map(|(_, y)| *y).max().unwrap_or(0) + NODE_H + pad + offset_y;
        canvas.nodes.push(Node::Group {
            id: format!("cp-{tag}-g{gi}"),
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
            label: Some(label.clone()),
            background: None,
            background_style: None,
            color: None,
        });
        groups_added += 1;
    }

    let mut edges_added = 0usize;
    for (ei, (source, target)) in edge_pairs.iter().enumerate() {
        // 两端都得真有节点。指向不存在节点的边在 Obsidian 里直接消失，用户只会以为
        // 写入丢了东西。
        let (Some(from), Some(to)) = (
            id_of.get(&norm_path(source)).cloned(),
            id_of.get(&norm_path(target)).cloned(),
        ) else {
            continue;
        };
        if from == to {
            continue;
        }
        canvas.edges.push(Edge {
            id: format!("cp-{tag}-e{ei}"),
            from_node: from,
            from_side: Some("right".to_string()),
            from_end: Some("none".to_string()),
            to_node: to,
            to_side: Some("left".to_string()),
            to_end: Some("arrow".to_string()),
            color: None,
            label: Some(relation_label(conn, source, target)),
        });
        edges_added += 1;
    }

    let canvas_json = serde_json::to_string_pretty(&canvas)
        .map_err(|e| ObjectError::Invalid(format!("画布无法序列化：{e}")))?;

    Ok(BuiltCanvas {
        canvas_json,
        nodes_added: ordered.len(),
        groups_added,
        edges_added,
        skipped_existing,
    })
}

/// 一条边写什么标签 / the label an edge carries, read from the store.
///
/// 关系表里有类型就用那个类型；没有就写 `related`，不编一个更具体的语义出来。
fn relation_label(conn: &Connection, source: &str, target: &str) -> String {
    conn.query_row(
        "SELECT relation_type FROM note_relations
         WHERE (source_path = ?1 AND target_path = ?2)
            OR (source_path = ?2 AND target_path = ?1)
         LIMIT 1",
        params![source, target],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| "related".to_string())
}

// ── 提交与验证 / staging, committing, verifying ───────────────────────────────

/// 一条提议的落地结果 / what happened to one proposal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasItemResult {
    pub proposal_id: String,
    pub operation: String,
    pub paths: Vec<String>,
    /// `applied` / `skipped_existing` / `absent` / `failed`。
    pub status: String,
    pub detail: Option<String>,
}

/// 一次提交尝试的真实结果 / what actually happened when the plan was applied.
///
/// 每个数字都来自后端。UI 的成功文案只能引用这里的字段——"调用没报错"不是成功。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOutcome {
    pub plan_id: String,
    pub changeset_id: Option<String>,
    /// §32 的状态词表：`awaiting_approval` / `applying` / `completed` /
    /// `partial_success` / `conflict` / `rejected` / `failed` / `rolled_back`。
    pub state: String,
    pub selected: usize,
    pub applied: usize,
    /// 已经在画布上、这次没重复添加的。跳过不是失败。
    pub skipped: usize,
    pub failed: usize,
    /// 每条冲突的人话。空数组表示没有冲突，不是"不知道"。
    pub conflicts: Vec<String>,
    /// 被门禁拒绝时的原因。有值就意味着**什么都没写**。
    pub refusal: Option<String>,
    pub message: String,
    pub details: Vec<CanvasItemResult>,
}

impl PlanOutcome {
    fn refused(plan_id: &str, changeset_id: Option<String>, refusal: String) -> Self {
        Self {
            plan_id: plan_id.to_string(),
            changeset_id,
            state: "rejected".to_string(),
            selected: 0,
            applied: 0,
            skipped: 0,
            failed: 0,
            conflicts: Vec::new(),
            message: format!("未执行：{refusal}"),
            refusal: Some(refusal),
            details: Vec::new(),
        }
    }
}

/// 把选中的提议开成一个待审批次 / stage the selected proposals as ONE reviewable op.
///
/// 只 stage，不写盘。返回的 `state` 是 `awaiting_approval`、`conflict` 或 `rejected`，
/// 三者都表示**磁盘上还没有任何变化**。
///
/// 与 `graph_plan::stage_plan` 有一处刻意的不同：`selected_ids` 为空在那边表示"整份
/// 计划"，这里表示**拒绝**。画布这条路上"默认全选"正是要消掉的行为，把空集合解释成
/// 全选会让前端一个疏漏又变回一次性铺满画布。
pub fn stage_plan(
    conn: &Connection,
    ctx: &WriteContext,
    plan: &mut CanvasPlan,
    selected_ids: &[String],
) -> ObjectResult<PlanOutcome> {
    if selected_ids.is_empty() {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "没有选中任何提议".to_string(),
        ));
    }
    let chosen: Vec<&CanvasProposal> = plan
        .proposals
        .iter()
        .filter(|p| selected_ids.contains(&p.id))
        .collect();
    if chosen.is_empty() {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "选中的提议不属于这份计划".to_string(),
        ));
    }
    if plan.canvas_path.trim().is_empty() {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "这份计划没有指定要写哪张画布".to_string(),
        ));
    }

    let abs_path = match crate::tools::internal_tools::helpers::resolve_path_multi_vault(
        &plan.canvas_path,
        &ctx.primary_vault,
        &ctx.vaults,
    ) {
        Ok(p) => p,
        Err(e) => {
            return Ok(PlanOutcome::refused(
                &plan.id,
                None,
                format!("画布路径不在任何已挂载的库里：{e}"),
            ))
        }
    };

    let existed = abs_path.exists();
    let existing_raw = if existed {
        match std::fs::read_to_string(&abs_path) {
            Ok(raw) => Some(raw),
            Err(e) => {
                // 读不到就停下。读不到旧内容却照样写新内容，等于无声覆盖。
                return Ok(PlanOutcome::refused(
                    &plan.id,
                    None,
                    format!("读不到现有画布内容，不能在它上面追加：{e}"),
                ));
            }
        }
    } else {
        None
    };

    let built = match build_canvas_json(conn, plan, &chosen, existing_raw.as_deref()) {
        Ok(built) => built,
        Err(ObjectError::Invalid(msg)) => {
            return Ok(PlanOutcome::refused(&plan.id, None, msg))
        }
        Err(e) => return Err(e),
    };

    // 工具名决定审批卡片上写的是"新建画布"还是"修改画布"，也决定能力校验按哪一条走。
    let intent_label = if existed { "modify_canvas" } else { "create_canvas" };
    let intents = vec![write_guard::rewrite_intent(
        abs_path.to_string_lossy().to_string(),
        built.canvas_json.clone(),
    )];

    match write_guard::open_intents(conn, ctx, intent_label, &intents)? {
        Guarded::Ready(ready) => {
            plan.changeset_id = Some(ready.changeset_id.clone());
            plan.state = "awaiting_approval".to_string();
            save_plan(conn, plan)?;
            save_staged(
                conn,
                &plan.id,
                &abs_path.to_string_lossy(),
                &built.canvas_json,
                selected_ids,
            )?;

            Ok(PlanOutcome {
                plan_id: plan.id.clone(),
                changeset_id: Some(ready.changeset_id),
                state: "awaiting_approval".to_string(),
                selected: chosen.len(),
                applied: 0,
                skipped: built.skipped_existing,
                failed: 0,
                conflicts: Vec::new(),
                refusal: None,
                message: format!(
                    "预览已生成：{} 个节点、{} 个分组、{} 条连线，等待你确认，尚未写入。",
                    built.nodes_added, built.groups_added, built.edges_added
                ),
                details: stage_details(&chosen),
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
                skipped: 0,
                failed: 0,
                message: format!(
                    "画布自生成预览以来已经被改过（{} 处冲突），没有写入任何内容。",
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
            "画布写入必须经过写入审查，但守卫没有接管这次调用".to_string(),
        )),
    }
}

/// 预览阶段的逐条状态 / per-proposal status while nothing has been written yet.
///
/// 全部是 `staged`：这一步磁盘上什么都没变，给不出 `applied`。提交后由 [`tally`] 重算。
fn stage_details(chosen: &[&CanvasProposal]) -> Vec<CanvasItemResult> {
    chosen
        .iter()
        .map(|p| CanvasItemResult {
            proposal_id: p.id.clone(),
            operation: p.operation.clone(),
            paths: p.node_paths.clone(),
            status: "staged".to_string(),
            detail: None,
        })
        .collect()
}

/// 磁盘上那份画布 / the canvas as it exists on disk, or nothing parseable.
fn parse_canvas(raw: &str) -> Option<crate::canvas::Canvas> {
    if raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str(raw).ok()
}

/// 这条提议在这份画布里吗 / is this proposal actually in that canvas?
///
/// `None` = **核对不了**（例如纯排版提议）。这与 `Some(false)` 不是一回事，所以不能合成
/// 一个 bool：把"没法确认"当成"确认不在"会凭空报出失败，反过来当成"确认在"就是伪造成功。
fn proposal_present(canvas: &crate::canvas::Canvas, p: &CanvasProposal) -> Option<bool> {
    use crate::canvas::Node;
    match p.operation.as_str() {
        "add_node" => {
            let want = norm_path(p.node_paths.first()?);
            Some(canvas.nodes.iter().any(|n| match n {
                Node::File { file, .. } => norm_path(file) == want,
                _ => false,
            }))
        }
        "add_group" => {
            let want = p.group_title.clone()?;
            Some(canvas.nodes.iter().any(|n| match n {
                Node::Group { label, .. } => label.as_deref() == Some(want.as_str()),
                _ => false,
            }))
        }
        "add_edge" => {
            if p.node_paths.len() != 2 {
                return Some(false);
            }
            let by_id = existing_file_nodes(canvas);
            let (Some(from), Some(to)) = (
                by_id.get(&norm_path(&p.node_paths[0])),
                by_id.get(&norm_path(&p.node_paths[1])),
            ) else {
                return Some(false);
            };
            Some(
                canvas.edges.iter().any(|e| {
                    (&e.from_node == from && &e.to_node == to)
                        || (&e.from_node == to && &e.to_node == from)
                }),
            )
        }
        _ => None,
    }
}

/// 提交一份已经预览过的计划 / commit the canvas the user approved.
///
/// 成功判定只有一个来源：写盘之后**重新读一遍文件**，逐条数提议在不在里面。
/// `safe_write` 返回 `Ok` 只说明写调用没报错，不说明内容真的落进了那张画布。
pub fn commit_plan(conn: &Connection, plan: &mut CanvasPlan) -> ObjectResult<PlanOutcome> {
    let Some(changeset_id) = plan.changeset_id.clone() else {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "这份计划还没有生成变更批次".to_string(),
        ));
    };
    let Some(staged) = load_staged(conn, &plan.id)? else {
        return Ok(PlanOutcome::refused(
            &plan.id,
            Some(changeset_id),
            "这份计划还没有可提交的预览".to_string(),
        ));
    };

    let path = std::path::PathBuf::from(&staged.abs_path);
    // 回滚点先记下来再写。顺序反过来的话，写成功而记账失败时就没有任何东西可还原了。
    let previous = std::fs::read_to_string(&path).ok();
    save_rollback_point(conn, &plan.id, previous.as_deref())?;
    let before = previous.as_deref().and_then(parse_canvas);

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 与画布工具走同一条写盘路径：`file_lock::safe_write` 负责原子替换与并发锁。
    let write_result = crate::file_lock::safe_write(&path, &staged.canvas_json);

    // `settle` 只用 `changeset_id`（回读落定内容、处理改名、记 commit），`paths` 在这条
    // 路径上不参与判断，所以按实际写的那一个文件填。
    let ready = ReadyWrite {
        changeset_id: changeset_id.clone(),
        paths: vec![staged.abs_path.clone()],
    };

    if let Err(e) = write_result {
        let message = format!("画布写入失败：{e}");
        let _ = write_guard::settle(conn, &ready, Err(&message));
        plan.state = "failed".to_string();
        save_plan(conn, plan)?;
        return Ok(PlanOutcome {
            plan_id: plan.id.clone(),
            changeset_id: Some(changeset_id),
            state: "failed".to_string(),
            selected: staged.selected_ids.len(),
            applied: 0,
            skipped: 0,
            failed: staged.selected_ids.len(),
            conflicts: Vec::new(),
            refusal: None,
            message: format!("{message}。画布内容没有任何改变。"),
            details: Vec::new(),
        });
    }

    write_guard::settle(conn, &ready, Ok(()))?;

    // 落盘后重新读一遍，逐条数。这一步不能省：省掉它 `applied` 就只是"我们打算写几条"。
    let after = std::fs::read_to_string(&path).ok().and_then(|raw| parse_canvas(&raw));
    let (applied, skipped, failed, details) = tally(plan, &staged.selected_ids, before.as_ref(), after.as_ref());

    let state = match (applied, failed) {
        // 状态只由真实计数决定。`completed` 的唯一含义是"选中的每一条都能在文件里找到"。
        (_, 0) => "completed",
        (0, _) => "failed",
        _ => "partial_success",
    };

    plan.state = state.to_string();
    save_plan(conn, plan)?;

    Ok(PlanOutcome {
        plan_id: plan.id.clone(),
        changeset_id: Some(changeset_id),
        state: state.to_string(),
        selected: staged.selected_ids.len(),
        applied,
        skipped,
        failed,
        conflicts: Vec::new(),
        refusal: None,
        message: format!(
            "已写入 {applied} 条；{skipped} 条画布上本来就有；{failed} 条没进去。{}",
            if failed == 0 {
                "变更已记账，可以撤销。"
            } else {
                "没进去的那几条列在下面，撤销会把画布还原成提交前的样子。"
            }
        ),
        details,
    })
}

/// 逐条数一遍 / count what landed, by comparing the file before and after.
fn tally(
    plan: &CanvasPlan,
    selected_ids: &[String],
    before: Option<&crate::canvas::Canvas>,
    after: Option<&crate::canvas::Canvas>,
) -> (usize, usize, usize, Vec<CanvasItemResult>) {
    let mut applied = 0;
    let mut skipped = 0;
    let mut failed = 0;
    let mut details = Vec::new();

    for p in plan.proposals.iter().filter(|p| selected_ids.contains(&p.id)) {
        let now = after.and_then(|c| proposal_present(c, p));
        let then = before.and_then(|c| proposal_present(c, p));
        let (status, detail) = match (then, now) {
            // 读不回来（文件不见了、或者写进去的不是合法 JSON Canvas）就是失败，
            // 不是"大概成功了"。
            (_, None) if after.is_none() => (
                "failed",
                Some("提交后读不回一份可解析的画布，无法确认这一条是否落地。".to_string()),
            ),
            (_, None) => ("unverifiable", Some("这类提议无法逐条核对。".to_string())),
            (Some(true), Some(true)) => ("skipped_existing", Some("画布上本来就有。".to_string())),
            (_, Some(true)) => ("applied", None),
            (_, Some(false)) => (
                "absent",
                Some("提交后在画布里找不到它。".to_string()),
            ),
        };
        match status {
            "applied" => applied += 1,
            "skipped_existing" => skipped += 1,
            "absent" | "failed" => failed += 1,
            _ => {}
        }
        details.push(CanvasItemResult {
            proposal_id: p.id.clone(),
            operation: p.operation.clone(),
            paths: p.node_paths.clone(),
            status: status.to_string(),
            detail,
        });
    }

    (applied, skipped, failed, details)
}

/// 撤销一次提交 / restore the canvas to what it was before this plan.
///
/// 还原的是**提交那一刻**读到的内容，不是重新算一份"减去这些节点"的画布：后者会把用户
/// 在提交之后手动加的东西一起算没了。
pub fn rollback_plan(conn: &Connection, plan: &mut CanvasPlan) -> ObjectResult<PlanOutcome> {
    let Some(changeset_id) = plan.changeset_id.clone() else {
        return Ok(PlanOutcome::refused(
            &plan.id,
            None,
            "这份计划没有可撤销的批次".to_string(),
        ));
    };
    let Some(staged) = load_staged(conn, &plan.id)? else {
        return Ok(PlanOutcome::refused(
            &plan.id,
            Some(changeset_id),
            "这份计划没有记录过要写哪张画布".to_string(),
        ));
    };
    let (previous, existed) = load_rollback_point(conn, &plan.id)?;

    let Some(previous) = previous.filter(|_| existed) else {
        // 新建的画布：撤销只还原内容，不删文件。悄悄删掉一个用户可能已经编辑过的文件
        // 比留着它更糟，而"我们帮你删了"这句话没人能验证。
        return Ok(PlanOutcome::refused(
            &plan.id,
            Some(changeset_id),
            format!(
                "这份计划新建了 {}，撤销只能还原内容、不会删除文件。需要的话请手动删除它。",
                plan.canvas_path
            ),
        ));
    };

    let path = std::path::PathBuf::from(&staged.abs_path);
    if let Err(e) = crate::file_lock::safe_write(&path, &previous) {
        plan.state = "failed".to_string();
        save_plan(conn, plan)?;
        return Ok(PlanOutcome {
            plan_id: plan.id.clone(),
            changeset_id: Some(changeset_id),
            state: "failed".to_string(),
            selected: staged.selected_ids.len(),
            applied: 0,
            skipped: 0,
            failed: staged.selected_ids.len(),
            conflicts: Vec::new(),
            refusal: None,
            message: format!("还原失败：{e}。画布仍是提交后的样子。"),
            details: Vec::new(),
        });
    }

    let _ = changeset::set_state(
        conn,
        &changeset_id,
        super::types::ChangeSetState::RolledBack,
        None,
    );
    plan.state = "rolled_back".to_string();
    save_plan(conn, plan)?;

    Ok(PlanOutcome {
        plan_id: plan.id.clone(),
        changeset_id: Some(changeset_id),
        state: "rolled_back".to_string(),
        selected: staged.selected_ids.len(),
        applied: 0,
        skipped: 0,
        failed: 0,
        conflicts: Vec::new(),
        refusal: None,
        message: format!("已把 {} 还原成提交前的内容。", plan.canvas_path),
        details: Vec::new(),
    })
}

/// 验证结果 / what the canvas file actually looks like now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanVerification {
    pub plan_id: String,
    pub canvas_path: String,
    /// 文件读得回来、并且是合法 JSON Canvas 吗。
    pub canvas_readable: bool,
    pub node_total: usize,
    pub group_total: usize,
    pub edge_total: usize,
    /// 计划里的每条提议现在到底在不在画布里。
    pub proposals_present: usize,
    pub proposals_absent: usize,
    /// 无法逐条核对的提议数。它既不算成功也不算失败。
    pub proposals_unverifiable: usize,
    /// 画布上指向已经不在 `files` 里的笔记的节点路径。
    pub dangling_node_paths: Vec<String>,
    pub steps: Vec<String>,
    pub message: String,
}

/// 提交后真读一遍磁盘 / verify by reading the file, not by trusting the write path.
pub fn verify_plan(conn: &Connection, plan: &CanvasPlan) -> ObjectResult<PlanVerification> {
    use crate::canvas::Node;

    let staged = load_staged(conn, &plan.id)?;
    let path = staged
        .as_ref()
        .map(|s| s.abs_path.clone())
        .unwrap_or_else(|| plan.canvas_path.clone());
    let canvas = std::fs::read_to_string(&path).ok().and_then(|raw| parse_canvas(&raw));

    let Some(canvas) = canvas else {
        // 读不回来就如实说读不回来，而不是报一串 0 让 UI 显示成"没问题"。
        return Ok(PlanVerification {
            plan_id: plan.id.clone(),
            canvas_path: plan.canvas_path.clone(),
            canvas_readable: false,
            node_total: 0,
            group_total: 0,
            edge_total: 0,
            proposals_present: 0,
            proposals_absent: 0,
            proposals_unverifiable: plan.proposals.len(),
            dangling_node_paths: Vec::new(),
            steps: plan.validation_steps.clone(),
            message: format!("读不回一份可解析的画布（{path}），无法核对任何一条提议。"),
        });
    };

    let mut present = 0usize;
    let mut absent = 0usize;
    let mut unverifiable = 0usize;
    for p in &plan.proposals {
        match proposal_present(&canvas, p) {
            Some(true) => present += 1,
            Some(false) => absent += 1,
            None => unverifiable += 1,
        }
    }

    let mut dangling = Vec::new();
    for node in &canvas.nodes {
        let Node::File { file, .. } = node else { continue };
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM files WHERE path = ?1 COLLATE NOCASE",
                params![file],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() && !dangling.contains(file) {
            dangling.push(file.clone());
        }
    }

    let group_total = canvas
        .nodes
        .iter()
        .filter(|n| matches!(n, Node::Group { .. }))
        .count();

    Ok(PlanVerification {
        plan_id: plan.id.clone(),
        canvas_path: plan.canvas_path.clone(),
        canvas_readable: true,
        node_total: canvas.nodes.len() - group_total,
        group_total,
        edge_total: canvas.edges.len(),
        proposals_present: present,
        proposals_absent: absent,
        proposals_unverifiable: unverifiable,
        dangling_node_paths: dangling.clone(),
        steps: plan.validation_steps.clone(),
        message: format!(
            "画布里有 {} 个节点、{group_total} 个分组、{} 条连线；\
             计划中的 {present} 条已在里面，{absent} 条不在；{} 个节点指向已经不存在的笔记。",
            canvas.nodes.len() - group_total,
            canvas.edges.len(),
            dangling.len()
        ),
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
                "selected": outcome.selected,
                "applied": outcome.applied,
                "skipped": outcome.skipped,
                "failed": outcome.failed,
                "refusal": outcome.refusal,
            })
            .to_string(),
        ),
    )?;
    Ok(())
}
















