/**
 * 画布计划的前端接线 / the typed edge of the canvas-plan commands.
 *
 * 独立于 `lib/tauri.ts`：这一组命令只有画布面板用，而 `tauri.ts` 已经是全应用共享的那
 * 一份，同时被别的改动占着。类型定义与后端 `knowledge/canvas_plan.rs` 的 serde
 * camelCase 一一对应——字段名对不上时 `invoke` 不会报错，只会静默给出 undefined，
 * 于是"写入了几条"会显示成 NaN。
 *
 * 这里也放两个**纯函数**（`defaultSelection` / `outcomeHeadline`），刻意不放在组件里：
 * "默认勾选哪些"和"这次到底算不算成功"是两条产品规则，要能被单独测到。
 */
import { invoke } from '@tauri-apps/api/core';

// ── 类型 / the wire types ──────────────────────────────────────────────

export interface CanvasScope {
  paths: string[];
  cluster: number | null;
}

export interface CanvasGoal {
  goalType: 'explain' | 'compare' | 'trace' | 'cluster';
  scope: CanvasScope;
  anchorPaths: string[];
  question: string;
  constraints: string[];
  maxNodes: number | null;
}

export interface CanvasEvidence {
  path: string;
  chunkId: number | null;
  excerpt: string | null;
  /** `relation_table` | `semantic_edge` | `chunk_text` | `file_level` */
  kind: string;
}

export interface CanvasObservation {
  id: string;
  kind: string;
  title: string;
  summary: string;
  paths: string[];
  evidence: CanvasEvidence[];
  confidence: number | null;
  warnings: string[];
}

export interface CanvasProposal {
  id: string;
  operation: 'add_node' | 'add_group' | 'add_edge' | 'arrange';
  nodePaths: string[];
  groupTitle: string | null;
  reason: string;
  evidence: CanvasEvidence[];
  /** 后端保证这就是 `semantic_edges.similarity` 本身，没有放大。 */
  confidence: number;
  risk: string;
  affectedPaths: string[];
}

export interface CanvasPlan {
  id: string;
  goal: CanvasGoal;
  observations: CanvasObservation[];
  proposals: CanvasProposal[];
  /** **实际**用的布局，不是请求的那一种。 */
  layout: string;
  /** 请求的布局做不到时的原因。`null` = 请求的那种就是用上的那种。 */
  layoutFallbackReason: string | null;
  validationSteps: string[];
  unresolvedQuestions: string[];
  generatedBy: string;
  generatedAtMs: number;
  changesetId: string | null;
  state: string;
  canvasPath: string;
}

export interface CanvasItemResult {
  proposalId: string;
  operation: string;
  paths: string[];
  /** `staged` | `applied` | `skipped_existing` | `absent` | `failed` | `unverifiable` */
  status: string;
  detail: string | null;
}

export interface CanvasPlanOutcome {
  planId: string;
  changesetId: string | null;
  state: string;
  selected: number;
  applied: number;
  skipped: number;
  failed: number;
  conflicts: string[];
  refusal: string | null;
  message: string;
  details: CanvasItemResult[];
}

export interface CanvasPlanVerification {
  planId: string;
  canvasPath: string;
  canvasReadable: boolean;
  nodeTotal: number;
  groupTotal: number;
  edgeTotal: number;
  proposalsPresent: number;
  proposalsAbsent: number;
  proposalsUnverifiable: number;
  danglingNodePaths: string[];
  steps: string[];
  message: string;
}

// ── 命令 / the six commands ────────────────────────────────────────────

/** 算一份计划。只读，不写盘。 */
export async function createCanvasPlan(
  goal: CanvasGoal,
  canvasPath: string,
): Promise<CanvasPlan> {
  return invoke('knowledge_canvas_create_plan', { goal, canvasPath });
}

/** 取回一份还在审查中的计划。 */
export async function getCanvasPlan(planId: string): Promise<CanvasPlan | null> {
  return invoke('knowledge_canvas_get_plan', { planId });
}

/**
 * 生成预览批次。写不到磁盘上。
 *
 * `selectedIds` 传空数组在后端表示**没选**（而不是"全选"），所以调用方必须真的把
 * 用户勾中的 id 传进来。
 */
export async function stageCanvasPlan(
  planId: string,
  selectedIds: string[],
  vaultPath: string,
  vaultPaths?: string[],
): Promise<CanvasPlanOutcome> {
  return invoke('knowledge_canvas_stage_plan', {
    planId,
    selectedIds,
    vaultPath,
    vaultPaths,
  });
}

/** 提交。成功与否由后端重新读文件后给出的计数决定。 */
export async function commitCanvasPlan(planId: string): Promise<CanvasPlanOutcome> {
  return invoke('knowledge_canvas_commit_plan', { planId });
}

/** 撤销：把画布还原成提交那一刻的内容。 */
export async function rollbackCanvasPlan(planId: string): Promise<CanvasPlanOutcome> {
  return invoke('knowledge_canvas_rollback_plan', { planId });
}

/** 验证：重新读画布文件，报告里面真正有什么。 */
export async function verifyCanvasPlan(planId: string): Promise<CanvasPlanVerification> {
  return invoke('knowledge_canvas_verify_plan', { planId });
}

// ── 两条产品规则 / the two rules worth testing on their own ────────────

/**
 * 默认勾选的置信度门槛 / the bar a proposal must clear to start checked.
 *
 * 与后端 `canvas_plan::DEFAULT_SELECT_CONFIDENCE` 同一个数。
 */
export const DEFAULT_SELECT_CONFIDENCE = 0.8;

/**
 * 默认勾哪些 / which proposals start checked.
 *
 * 只勾 `confidence >= 0.8` 的，其余一律不勾。旧 Smart Canvas 默认全选，于是"用户批准
 * 了这几条"退化成"用户点了确认"——用户没有逐条看过的东西不该算他同意过。
 */
export function defaultSelection(proposals: CanvasProposal[]): string[] {
  return proposals
    .filter((p) => p.confidence >= DEFAULT_SELECT_CONFIDENCE)
    .map((p) => p.id);
}

/** UI 该用什么语气呈现这次结果。 */
export type OutcomeTone = 'success' | 'partial' | 'blocked' | 'failed' | 'pending';

/**
 * 结果的语气**只**看后端的 `state` / the tone comes from the backend state alone.
 *
 * 不看"调用有没有抛异常"。`conflict` / `rejected` / `failed` 一律不是成功——这正是
 * 以前那个"调用返回后立刻弹一个成功 toast"的问题所在。
 */
export function outcomeTone(outcome: CanvasPlanOutcome): OutcomeTone {
  switch (outcome.state) {
    case 'completed':
      return 'success';
    case 'partial_success':
      return 'partial';
    case 'conflict':
    case 'rejected':
      return 'blocked';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * 结果文案 / the sentence the user reads, assembled from real counts only.
 *
 * 每个数字都来自 `outcome`。`conflict` / `failed` 时必须说出**没有**写进去什么，
 * 否则用户会以为只是慢了一点。
 */
export function outcomeHeadline(outcome: CanvasPlanOutcome, isZh: boolean): string {
  const { state, selected, applied, skipped, failed } = outcome;
  if (outcome.refusal) {
    return isZh
      ? `未执行：${outcome.refusal}`
      : `Nothing was written: ${outcome.refusal}`;
  }
  switch (state) {
    case 'awaiting_approval':
      return isZh
        ? `${selected} 条改动已生成预览，还没有写入画布。`
        : `${selected} changes previewed. Nothing written to the canvas yet.`;
    case 'completed':
      return isZh
        ? `已写入 ${applied} 条；${skipped} 条画布上本来就有。`
        : `${applied} written; ${skipped} were already on the canvas.`;
    case 'partial_success':
      return isZh
        ? `写入 ${applied} 条，${failed} 条没进去（共选中 ${selected} 条）。`
        : `${applied} written, ${failed} did not land (of ${selected} selected).`;
    case 'conflict':
      return isZh
        ? `画布已被改过，${selected} 条改动一条都没有写入。`
        : `The canvas changed underneath: none of the ${selected} changes were written.`;
    case 'failed':
      return isZh
        ? `写入失败，${selected} 条改动一条都没有生效。`
        : `The write failed: none of the ${selected} changes took effect.`;
    case 'rolled_back':
      return isZh ? '已还原成提交前的画布内容。' : 'The canvas was restored to its pre-commit content.';
    default:
      return outcome.message;
  }
}

/**
 * §32 的进度阶段 / the status vocabulary the panel walks through.
 *
 * 词表原样照抄，不另造词：前端自己发明一个"处理中"会让日志里的 `state` 与用户看到的
 * 阶段对不上。
 */
export const CANVAS_PLAN_STAGES = [
  'scoping',
  'retrieving',
  'analyzing',
  'planning',
  'preview_ready',
  'awaiting_approval',
  'applying',
  'verifying',
  'completed',
] as const;

export type CanvasPlanStage = (typeof CANVAS_PLAN_STAGES)[number] | 'idle';

