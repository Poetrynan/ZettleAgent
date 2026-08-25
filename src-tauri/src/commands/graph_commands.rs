use crate::AppState;
use crate::db::search::{self, GraphData};
use crate::canvas::{self, ExportOptions};
use crate::error::ZettelError;
use tauri::State;

#[tauri::command]
pub fn get_knowledge_graph(
    state: State<'_, AppState>,
    vault_path: String,
) -> Result<GraphData, ZettelError> {
    let conn = state.db.lock()?;
    let data = search::get_graph_data(&conn)?;

    let vault_path_norm = vault_path.replace('\\', "/").to_lowercase();
    let mut filtered_nodes = Vec::new();
    let mut node_paths = std::collections::HashSet::new();

    for node in data.nodes {
        let node_path_norm = node.id.replace('\\', "/").to_lowercase();
        if node_path_norm.starts_with(&vault_path_norm) {
            node_paths.insert(node.id.clone());
            filtered_nodes.push(node);
        }
    }

    let mut filtered_edges = Vec::new();
    for edge in data.edges {
        if node_paths.contains(&edge.source) && node_paths.contains(&edge.target) {
            filtered_edges.push(edge);
        }
    }

    Ok(GraphData {
        nodes: filtered_nodes,
        edges: filtered_edges,
        clusters: data.clusters,
    })
}

/// Get local graph data for a specific note.
#[tauri::command]
pub fn get_local_graph(state: State<'_, AppState>, file_path: String) -> Result<GraphData, ZettelError> {
    let conn = state.db.lock()?;
    let data = search::get_local_graph(&conn, &file_path)?;
    Ok(data)
}

/// Notes related to the one currently being read — the Related Notes panel.
///
/// Lives with the other relation reads (`get_local_graph`, `get_edges_by_relation`)
/// because it answers the same question at a different granularity: this is the local
/// graph, flattened and explained, for one note. All merge/rank/SQL logic is in
/// `db::search::get_related_notes`; this stays a thin lock-and-delegate command.
#[tauri::command]
pub fn get_related_notes(
    state: State<'_, AppState>,
    file_path: String,
    limit: Option<usize>,
) -> Result<search::RelatedNotesResult, ZettelError> {
    let conn = state.db.lock()?;
    // 8 is what fits the in-note panel without turning passive discovery into a wall
    // of links; the frontend can ask for more.
    Ok(search::get_related_notes(&conn, &file_path, limit.unwrap_or(8))?)
}

/// Export knowledge graph to JSON Canvas 1.0 format
#[tauri::command]
pub fn export_canvas(
    state: State<'_, AppState>,
    options: ExportOptions,
) -> Result<String, ZettelError> {
    let conn = state.db.lock()?;
    let canvas = canvas::export_to_canvas(&conn, &options)?;
    let json = serde_json::to_string_pretty(&canvas)?;
    Ok(json)
}

/// Save Canvas JSON to file
#[tauri::command]
pub fn save_canvas_to_file(
    canvas_json: String,
    output_path: String,
) -> Result<(), ZettelError> {
    crate::file_lock::safe_write(std::path::Path::new(&output_path), &canvas_json)?;
    Ok(())
}

/// Add a note relation to the note_relations table from canvas connection.
#[tauri::command]
pub fn add_canvas_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "INSERT OR IGNORE INTO note_relations (source_path, target_path, relation_type, confidence, reason)
         VALUES (?1, ?2, ?3, 1.0, 'Created manually on canvas')",
        rusqlite::params![source_path, target_path, relation_type],
    )?;
    Ok(())
}

/// Remove a note relation from the note_relations table from canvas disconnection.
#[tauri::command]
pub fn delete_canvas_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    conn.execute(
        "DELETE FROM note_relations WHERE source_path = ?1 AND target_path = ?2",
        rusqlite::params![source_path, target_path],
    )?;
    Ok(())
}

/// Get edges filtered by relation type from note_relations table.
#[tauri::command]
pub fn get_edges_by_relation(
    state: State<'_, AppState>,
    relation_type: String,
) -> Result<Vec<search::GraphEdge>, ZettelError> {
    let conn = state.db.lock()?;
    let edges = search::get_edges_by_relation(&conn, &relation_type)?;
    Ok(edges)
}

/// Add a note relation directly from the knowledge graph view.
/// Reuses the same note_relations table as canvas connections.
///
/// 这是**用户亲手连的**边，所以 `origin = user_link`、`confirmed = 1`、置信度 1.0：
/// 它不需要走 ChangeSet（用户就是决策者），但必须与 Agent 推断的边可区分，否则图谱
/// 无从回答"这条线是谁连的"。
#[tauri::command]
pub fn add_note_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
    reason: Option<String>,
) -> Result<String, ZettelError> {
    use crate::knowledge::{changeset::RelationOp, relations};

    let conn = state.db.lock()?;
    let op = RelationOp {
        source_path,
        target_path,
        relation_type,
        confidence: 1.0,
        reason: Some(reason.unwrap_or_else(|| "Created manually on the graph".to_string())),
        origin: relations::ORIGIN_USER_LINK.to_string(),
        old_confidence: None,
        old_reason: None,
        expected_source_version: None,
        expected_target_version: None,
    };
    // 用户手连的边不受"之前拒绝过"的约束——那条规则约束的是自动重建，不是用户自己。
    let _ = crate::knowledge::changeset::record_relation_decision(
        &conn,
        &op.source_path,
        &op.target_path,
        &op.relation_type,
        "accepted",
        None,
    );
    let outcome = relations::add_relation(&conn, &op, None, None)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    if outcome == relations::RelationOutcome::Added {
        let _ = relations::confirm_relation(&conn, &op.source_path, &op.target_path, &op.relation_type);
    }
    Ok(outcome.as_str().to_string())
}

/// Remove a note relation directly from the knowledge graph view.
///
/// `relation_type` 是必填的：不带类型的删除会把两篇笔记之间所有类型的边一起删掉。
/// 同时记下"用户拒绝过"，这样下一次语义刷新不会把它重新建起来。
#[tauri::command]
pub fn delete_note_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
) -> Result<bool, ZettelError> {
    use crate::knowledge::relations;

    let conn = state.db.lock()?;
    let outcome = relations::reject_relation(
        &conn,
        &source_path,
        &target_path,
        &relation_type,
        Some("Removed by the user on the graph"),
    )
    .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(outcome.changed_graph())
}

/// AI-powered relationship explanation between two notes.
/// Reads both notes' content and uses LLM to explain the conceptual relationship.
#[tauri::command]
pub async fn explain_relationship(
    // Injected by Tauri — needed to resolve the migrated user's key from the OS
    // credential store. This command takes bare args rather than a request
    // struct, but the precedence rule is identical.
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_a: String,
    note_b: String,
    api_url: String,
    // `Option<RequestApiKey>` rather than a bare `RequestApiKey`: the old
    // `Option<String>` arg tolerated the caller omitting `apiKey` entirely, and
    // a Tauri command argument cannot carry `#[serde(default)]` to say so. The
    // outer `Option` preserves that tolerance; the inner newtype still forces the
    // value through the precedence helper.
    api_key: Option<crate::secrets::RequestApiKey>,
    model: String,
    provider_id: Option<String>,
) -> Result<String, ZettelError> {
    // Read both notes' content (first 3000 chars)
    let content_a = std::fs::read_to_string(&note_a)?;
    let content_b = std::fs::read_to_string(&note_b)?;

    let snippet_a: String = content_a.chars().take(3000).collect();
    let snippet_b: String = content_b.chars().take(3000).collect();

    // Query existing relations from DB
    let (direct_relations, shared_tags) = {
        let conn = state.db.lock()?;
        let mut direct = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT relation_type, confidence, reason FROM note_relations
             WHERE (source_path = ?1 AND target_path = ?2)
                OR (source_path = ?2 AND target_path = ?1)"
        )?;
        let rows = stmt.query_map(rusqlite::params![note_a, note_b], |row| {
            Ok(format!(
                "- type: {} (confidence: {:.2}){}",
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1).unwrap_or(0.5),
                row.get::<_, Option<String>>(2)?.map(|r| format!(", reason: {}", r)).unwrap_or_default()
            ))
        })?;
        for r in rows.flatten() {
            direct.push(r);
        }

        // Shared tags
        let mut shared = Vec::new();
        let tags_a: Option<String> = conn.query_row(
            "SELECT tags FROM card_meta WHERE file_path = ?1",
            rusqlite::params![note_a],
            |row| row.get(0),
        ).ok();
        let tags_b: Option<String> = conn.query_row(
            "SELECT tags FROM card_meta WHERE file_path = ?1",
            rusqlite::params![note_b],
            |row| row.get(0),
        ).ok();
        if let (Some(ta), Some(tb)) = (tags_a, tags_b) {
            let list_a: Vec<String> = serde_json::from_str(&ta).unwrap_or_default();
            let list_b: Vec<String> = serde_json::from_str(&tb).unwrap_or_default();
            for t in list_a {
                if list_b.contains(&t) { shared.push(t); }
            }
        }
        (direct, shared)
    };

    let existing_info = if direct_relations.is_empty() {
        "No existing relations found.".to_string()
    } else {
        format!("Existing relations:\n{}", direct_relations.join("\n"))
    };
    let shared_info = if shared_tags.is_empty() {
        "No shared tags.".to_string()
    } else {
        format!("Shared tags: {}", shared_tags.join(", "))
    };

    let prompt = format!(
        "You are a knowledge graph analyst. Analyze the conceptual relationship between these two notes.\n\n\
        Note A ({}) content:\n{}\n\n\
        Note B ({}) content:\n{}\n\n\
        Database context:\n{}\n{}\n\n\
        Provide a concise explanation (3-5 sentences) of how these two notes relate to each other. \
        Identify the main conceptual connection, whether they support/contradict/complement each other, \
        and suggest the most appropriate relation type from: \
        supports, contradicts, refines, supplementary, depends_on, exemplifies, supersedes, or wikilink. \
        Respond in the same language as the note content.",
        note_a, snippet_a, note_b, snippet_b, existing_info, shared_info
    );

    let config = crate::llm::LlmConfig {
        api_url,
        api_key: crate::secrets::resolve_api_key_with_override(&app, api_key.unwrap_or_default()),
        model,
        provider_id,
        ..Default::default()
    };
    let messages = vec![crate::llm::ChatMessage {
        role: "user".to_string(),
        content: prompt,
        ..Default::default()
    }];
    let response = crate::llm::chat_completion(&config, &messages)
        .await
        .map_err(|e| ZettelError::Llm(e.to_string()))?;

    Ok(response)
}

// ── 图谱计划 / the graph plan surface ─────────────────────────────────────────
//
// 目标 → 观察 → 提议 → 预览 → 批准 → 提交 → 验证 → 撤销。每一步都是一个命令，返回值
// 都带真实数字，前端不需要（也不允许）自己判断"是不是成功了"。

use crate::knowledge::graph_plan::{
    self, GraphGoal, GraphPlan, MocDraft, PlanOutcome, PlanVerification, RelationEvidenceView,
};

/// 算一份图谱计划 / compute a plan. Reads only.
#[tauri::command]
pub fn knowledge_graph_create_plan(
    state: State<'_, AppState>,
    goal: GraphGoal,
) -> Result<GraphPlan, ZettelError> {
    let conn = state.db.lock()?;
    let plan = graph_plan::create_plan(&conn, goal).map_err(|e| ZettelError::System(e.to_string()))?;
    graph_plan::save_plan(&conn, &plan).map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(plan)
}

/// 取回一份计划 / load a plan the user is still reviewing.
#[tauri::command]
pub fn knowledge_graph_get_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<Option<GraphPlan>, ZettelError> {
    let conn = state.db.lock()?;
    graph_plan::load_plan(&conn, &plan_id).map_err(|e| ZettelError::System(e.to_string()))
}

/// 生成预览批次 / stage the selected proposals. Writes nothing to the graph.
///
/// `selected_ids` 为空表示"整份计划"。返回的 `state` 只会是 `awaiting_approval`、
/// `conflict` 或 `rejected`——三者都意味着还没有任何东西落库。
#[tauri::command]
pub fn knowledge_graph_stage_plan(
    state: State<'_, AppState>,
    plan_id: String,
    selected_ids: Vec<String>,
    vault_path: String,
    vault_paths: Option<Vec<String>>,
) -> Result<PlanOutcome, ZettelError> {
    use crate::knowledge::write_guard::WriteContext;

    let conn = state.db.lock()?;
    let Some(mut plan) = graph_plan::load_plan(&conn, &plan_id)
        .map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };

    let vaults = vault_paths.unwrap_or_else(|| vec![vault_path.clone()]);
    let ctx = WriteContext {
        // 计划是用户在图谱页发起的，但执行者仍是 Agent 的提议——审计里要能分清。
        actor: "agent".to_string(),
        session_id: None,
        run_id: Some(plan_id.clone()),
        primary_vault: vault_path,
        vaults,
    };

    let outcome = graph_plan::stage_plan(&conn, &ctx, &mut plan, &selected_ids)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let _ = graph_plan::record_plan_audit(&conn, "agent", "graph_plan_staged", &outcome);
    Ok(outcome)
}

/// 提交 / commit. Success comes from the store, not from the model.
#[tauri::command]
pub fn knowledge_graph_commit_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlanOutcome, ZettelError> {
    let conn = state.db.lock()?;
    let Some(mut plan) = graph_plan::load_plan(&conn, &plan_id)
        .map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };
    let outcome = graph_plan::commit_plan(&conn, &mut plan)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let _ = graph_plan::record_plan_audit(&conn, "agent", "graph_plan_committed", &outcome);
    Ok(outcome)
}

/// 撤销 / roll back exactly this plan's batch, nothing else.
#[tauri::command]
pub fn knowledge_graph_rollback_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlanOutcome, ZettelError> {
    let conn = state.db.lock()?;
    let Some(mut plan) = graph_plan::load_plan(&conn, &plan_id)
        .map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };
    let outcome = graph_plan::rollback_plan(&conn, &mut plan)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let _ = graph_plan::record_plan_audit(&conn, "user", "graph_plan_rolled_back", &outcome);
    Ok(outcome)
}

/// 验证 / re-query the store and report what is actually there.
#[tauri::command]
pub fn knowledge_graph_verify_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlanVerification, ZettelError> {
    let conn = state.db.lock()?;
    let Some(plan) = graph_plan::load_plan(&conn, &plan_id)
        .map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };
    graph_plan::verify_plan(&conn, &plan).map_err(|e| ZettelError::System(e.to_string()))
}

/// 一条关系的详情与证据 / the relation drawer payload.
#[tauri::command]
pub fn knowledge_graph_relation_evidence(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
) -> Result<RelationEvidenceView, ZettelError> {
    let conn = state.db.lock()?;
    graph_plan::relation_evidence(&conn, &source_path, &target_path, &relation_type)
        .map_err(|e| ZettelError::System(e.to_string()))
}

/// 用户对一条关系下判断 / accept or reject one edge, and remember it.
#[tauri::command]
pub fn knowledge_graph_decide_relation(
    state: State<'_, AppState>,
    source_path: String,
    target_path: String,
    relation_type: String,
    accept: bool,
    reason: Option<String>,
) -> Result<String, ZettelError> {
    use crate::knowledge::relations;

    let conn = state.db.lock()?;
    let outcome = if accept {
        relations::confirm_relation(&conn, &source_path, &target_path, &relation_type)
            .map(|ok| if ok { "confirmed" } else { "missing" })
            .map_err(|e| ZettelError::System(e.to_string()))?
            .to_string()
    } else {
        relations::reject_relation(
            &conn,
            &source_path,
            &target_path,
            &relation_type,
            reason.as_deref(),
        )
        .map_err(|e| ZettelError::System(e.to_string()))?
        .as_str()
        .to_string()
    };
    crate::db::search::invalidate_graph_cache(&conn);
    Ok(outcome)
}

/// MOC 草稿 / draft a MOC. Creates no file.
#[tauri::command]
pub fn knowledge_graph_create_moc_draft(
    state: State<'_, AppState>,
    title: String,
    member_paths: Vec<String>,
) -> Result<MocDraft, ZettelError> {
    let conn = state.db.lock()?;
    graph_plan::create_moc_draft(&conn, &title, &member_paths)
        .map_err(|e| ZettelError::System(e.to_string()))
}

