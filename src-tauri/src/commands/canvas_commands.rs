// ── 画布计划 / the canvas plan surface ────────────────────────────────────────
//
// 目标 → 观察 → 提议 → 预览 → 部分批准 → 提交 → 验证 → 撤销。每一步都是一个命令，
// 返回值都带真实数字，前端不需要（也不允许）自己判断"是不是成功了"。
//
// 命令名与形状刻意与 `graph_commands.rs` 的 `knowledge_graph_*` 一一对应：两条计划路径
// 的前端状态机是同一套，命名一旦分叉，"图谱能撤销、画布不能"这类差异就会藏在名字里。

use crate::error::ZettelError;
use crate::AppState;
use tauri::State;

use crate::knowledge::canvas_plan::{
    self, CanvasGoal, CanvasPlan, PlanOutcome, PlanVerification,
};

/// 算一份画布计划 / compute a plan. Reads only, writes nothing to disk.
#[tauri::command]
pub fn knowledge_canvas_create_plan(
    state: State<'_, AppState>,
    goal: CanvasGoal,
    canvas_path: String,
) -> Result<CanvasPlan, ZettelError> {
    let conn = state.db.lock()?;
    let plan = canvas_plan::create_plan(&conn, goal, &canvas_path)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    canvas_plan::save_plan(&conn, &plan).map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(plan)
}

/// 取回一份计划 / load a plan the user is still reviewing.
#[tauri::command]
pub fn knowledge_canvas_get_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<Option<CanvasPlan>, ZettelError> {
    let conn = state.db.lock()?;
    canvas_plan::load_plan(&conn, &plan_id).map_err(|e| ZettelError::System(e.to_string()))
}

/// 生成预览批次 / stage the selected proposals. Writes nothing to disk.
///
/// `selected_ids` 为空表示**没选**（而不是"全选"）——画布这条路上的"默认全选"正是这次要
/// 消掉的行为。返回的 `state` 只会是 `awaiting_approval`、`conflict` 或 `rejected`，
/// 三者都意味着磁盘上还没有任何变化。
#[tauri::command]
pub fn knowledge_canvas_stage_plan(
    state: State<'_, AppState>,
    plan_id: String,
    selected_ids: Vec<String>,
    vault_path: String,
    vault_paths: Option<Vec<String>>,
) -> Result<PlanOutcome, ZettelError> {
    use crate::knowledge::write_guard::WriteContext;

    let conn = state.db.lock()?;
    let Some(mut plan) =
        canvas_plan::load_plan(&conn, &plan_id).map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };

    let vaults = vault_paths.unwrap_or_else(|| vec![vault_path.clone()]);
    let ctx = WriteContext {
        // 计划是用户在画布页发起的，但执行者仍是 Agent 的提议——审计里要能分清。
        actor: "agent".to_string(),
        session_id: None,
        run_id: Some(plan_id.clone()),
        primary_vault: vault_path,
        vaults,
    };

    let outcome = canvas_plan::stage_plan(&conn, &ctx, &mut plan, &selected_ids)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let _ = canvas_plan::record_plan_audit(&conn, "agent", "canvas_plan_staged", &outcome);
    Ok(outcome)
}

/// 提交 / commit. Success comes from re-reading the file, not from the write call.
#[tauri::command]
pub fn knowledge_canvas_commit_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlanOutcome, ZettelError> {
    let conn = state.db.lock()?;
    let Some(mut plan) =
        canvas_plan::load_plan(&conn, &plan_id).map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };
    let outcome = canvas_plan::commit_plan(&conn, &mut plan)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let _ = canvas_plan::record_plan_audit(&conn, "agent", "canvas_plan_committed", &outcome);
    Ok(outcome)
}

/// 撤销 / restore the canvas to the snapshot taken at commit time.
#[tauri::command]
pub fn knowledge_canvas_rollback_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlanOutcome, ZettelError> {
    let conn = state.db.lock()?;
    let Some(mut plan) =
        canvas_plan::load_plan(&conn, &plan_id).map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };
    let outcome = canvas_plan::rollback_plan(&conn, &mut plan)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let _ = canvas_plan::record_plan_audit(&conn, "user", "canvas_plan_rolled_back", &outcome);
    Ok(outcome)
}

/// 验证 / re-read the canvas file and report what is actually in it.
#[tauri::command]
pub fn knowledge_canvas_verify_plan(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlanVerification, ZettelError> {
    let conn = state.db.lock()?;
    let Some(plan) =
        canvas_plan::load_plan(&conn, &plan_id).map_err(|e| ZettelError::System(e.to_string()))?
    else {
        return Err(ZettelError::System(format!("找不到计划 {plan_id}")));
    };
    canvas_plan::verify_plan(&conn, &plan).map_err(|e| ZettelError::System(e.to_string()))
}
