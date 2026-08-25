import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getEmbedding } from './embeddings';
import { getLang } from './i18n';

// ── Types ──────────────────────────────────────────────────────────

export interface AppInfo {
  name: string;
  version: string;
  description: string;
}

export interface SyncResult {
  files_updated: number;
  files_removed: number;
  total_files: number;
}

export interface ChunkInfo {
  content: string;
  heading_hierarchy: string;
  marker_type: string;
  chunk_index: number;
}

export interface ChunkResult {
  chunks: ChunkInfo[];
  total: number;
}

export interface SearchResult {
  file_path: string;
  chunk_id: number;
  content: string;
  heading_hierarchy: string | null;
  score: number;
}

export type SearchMode = 'fts' | 'hybrid' | 'vector';

export interface EmbeddingStats {
  total_chunks: number;
  indexed_chunks: number;
  has_index: boolean;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  mode?: SearchMode;
  queryEmbedding?: number[];
}

export interface DirTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: DirTreeNode[];
  file_count: number;
}

// ── API Calls ──────────────────────────────────────────────────────

export async function getAppInfo(): Promise<AppInfo> {
  return invoke('get_app_info');
}

export async function setVaultPath(path: string): Promise<string> {
  return invoke('set_vault_path', { path });
}

export async function syncVault(vaultPath: string): Promise<SyncResult> {
  return invoke('sync_vault', { vaultPath });
}

export async function chunkDocument(
  content: string,
  maxChunkSize?: number
): Promise<ChunkResult> {
  return invoke('chunk_document', { content, maxChunkSize });
}

async function withPromiseTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const EMBEDDING_QUERY_TIMEOUT_MS = 20_000;
const EMBEDDING_STATS_TTL_MS = 5000;

/**
 * Call a custom (self-hosted / OpenAI-compatible) embedding endpoint through
 * Rust so the API key never enters the WebView.
 *
 * The key was moved into the OS credential store (`lib/secrets.ts`), which by
 * design has no getter — so the header can only be attached backend-side. This
 * is the custom-endpoint path only; the built-in model embeds locally in a
 * worker and does not come through here. A rejected credential surfaces as an
 * actionable bilingual 401 message from the backend rather than a bare code.
 */
export async function fetchCustomEmbeddings(
  apiUrl: string,
  model: string,
  inputs: string[],
): Promise<number[][]> {
  return invoke('fetch_custom_embeddings', { apiUrl, model, inputs, zh: getLang() === 'zh' });
}

let embeddingStatsCache: { stats: EmbeddingStats; at: number } | null = null;

async function getEmbeddingStatsCached(): Promise<EmbeddingStats | null> {
  const now = Date.now();
  if (embeddingStatsCache && now - embeddingStatsCache.at < EMBEDDING_STATS_TTL_MS) {
    return embeddingStatsCache.stats;
  }
  try {
    const stats = await getEmbeddingStats();
    embeddingStatsCache = { stats, at: now };
    return stats;
  } catch {
    return null;
  }
}

/** True when the RAG pipeline needs a query embedding (hybrid/vector with a built index). */
export function ragNeedsQueryEmbedding(mode?: SearchMode | string): boolean {
  return mode === 'hybrid' || mode === 'vector';
}

/** Downgrade hybrid/vector → fts when the vault has no vector index yet. */
export async function resolveRagSearchMode(searchMode?: SearchMode | string): Promise<SearchMode> {
  const mode = (searchMode as SearchMode) || 'fts';
  if (!ragNeedsQueryEmbedding(mode)) return mode;
  const stats = await getEmbeddingStatsCached();
  if (!stats?.has_index || stats.indexed_chunks === 0) {
    console.info('[RAG] Vector index empty — using FTS instead of', mode);
    return 'fts';
  }
  return mode;
}

async function getEmbeddingForSearch(queryText: string, searchMode?: SearchMode | string): Promise<number[] | undefined> {
  if (searchMode !== 'vector' && searchMode !== 'hybrid') {
    return undefined;
  }
  // No point loading the embedding model when nothing is indexed.
  const stats = await getEmbeddingStatsCached();
  if (!stats?.has_index || stats.indexed_chunks === 0) {
    return undefined;
  }
  try {
    const raw = localStorage.getItem('zettelagent:embedding_config');
    if (!raw) return undefined;
    const config = JSON.parse(raw);
    if (config.mode === 'local') {
      return await withPromiseTimeout(
        getEmbedding(queryText, 'query'),
        EMBEDDING_QUERY_TIMEOUT_MS,
        'Query embedding',
      );
    } else if (config.mode === 'custom') {
      if (!config.apiUrl || !config.model) return undefined;

      // Routed through Rust on purpose. The API key lives in the OS credential
      // store and `lib/secrets.ts` exposes no getter, so the WebView cannot
      // build an `Authorization` header any more — it used to read the plaintext
      // `zettelagent-llm.apiKey`, which migration deletes, and the request then
      // 401'd with nothing the user could act on. `fetchCustomEmbeddings` reads
      // the key inside Rust and attaches the header there.
      const vectors = await withPromiseTimeout(
        fetchCustomEmbeddings(config.apiUrl, config.model, [queryText]),
        EMBEDDING_QUERY_TIMEOUT_MS,
        'Custom embedding API',
      );
      return vectors[0];
    }
  } catch (e) {
    console.error('Failed to generate search embedding:', e);
  }
  return undefined;
}

async function prepareRagSearchRequest(request: RagChatRequest): Promise<RagChatRequest> {
  const effectiveMode = await resolveRagSearchMode(request.searchMode);
  if (!ragNeedsQueryEmbedding(effectiveMode)) {
    return { ...request, searchMode: effectiveMode, queryEmbedding: undefined };
  }
  const queryEmbedding = await getEmbeddingForSearch(request.query, effectiveMode)
    || request.queryEmbedding;
  if (!queryEmbedding) {
    console.warn('[RAG] Query embedding unavailable — falling back to FTS');
    return { ...request, searchMode: 'fts', queryEmbedding: undefined };
  }
  return { ...request, searchMode: effectiveMode, queryEmbedding };
}

export async function searchChunks(query: SearchQuery): Promise<SearchResult[]> {
  const enrichedQuery = await enrichSearchQuery(query);
  return invoke('search_chunks', { query: enrichedQuery });
}

/**
 * Resolve the effective search mode and attach a query embedding when the mode
 * needs one, downgrading to `fts` if no embedding can be produced. Shared by
 * `searchChunks` and `rerankSearchWindow` so the Tier-2 window is retrieved over
 * the exact same recall the plain search would have used.
 */
async function enrichSearchQuery(query: SearchQuery): Promise<SearchQuery> {
  const effectiveMode = await resolveRagSearchMode(query.mode);
  const queryEmbedding = ragNeedsQueryEmbedding(effectiveMode)
    ? await getEmbeddingForSearch(query.query, effectiveMode)
    : undefined;
  const finalMode: SearchMode =
    ragNeedsQueryEmbedding(effectiveMode) && !queryEmbedding && !query.queryEmbedding
      ? 'fts'
      : effectiveMode;
  return {
    ...query,
    mode: finalMode,
    queryEmbedding: queryEmbedding || query.queryEmbedding,
  };
}

/**
 * One candidate in a Tier-2 rerank window. Mirrors `rerank::RerankCandidate` in
 * `src-tauri/src/db/search/rerank.rs`. `index` — not `chunkId` — is the identity
 * used to express the reordered order (the regex branch of `search_notes` emits
 * `chunkId: 0` for every row, so chunk ids are not unique inside a result set).
 */
export interface RerankWindowCandidate {
  index: number;
  chunkId: number;
  filePath: string;
  heading: string;
  snippet: string;
}

/**
 * The recall window plus its scoring payload, as returned by `rerank_search_window`.
 * `results` is already Tier-1 reranked (fts/hybrid) or in raw vector order
 * (vector), and `candidates[i].index === i`, so a cross-encoder that declines is
 * a structural no-op: the caller keeps `results`.
 */
export interface RerankWindow {
  results: SearchResult[];
  candidates: RerankWindowCandidate[];
  limit: number;
}

/**
 * Tier-2 transport. Fetch a recall window wide enough to rerank, together with
 * the candidate snippets a webview cross-encoder needs to score it. Enrichment
 * is identical to `searchChunks`, so the window is drawn from the same recall.
 *
 * This never runs the model and never downloads anything: it only hands out
 * candidates. Scoring, ordering and truncation happen in `lib/rerankSearch.ts`.
 */
export async function rerankSearchWindow(query: SearchQuery): Promise<RerankWindow> {
  const enrichedQuery = await enrichSearchQuery(query);
  return invoke('rerank_search_window', { query: enrichedQuery });
}

export async function readMarkdownFile(path: string): Promise<string> {
  return invoke('read_markdown_file', { path });
}

export async function readBinaryFile(path: string): Promise<string> {
  return invoke('read_binary_file', { path });
}

export async function writeMarkdownFile(
  path: string,
  content: string
): Promise<void> {
  return invoke('write_markdown_file', { path, content });
}

/** Generic text file writer — used for .canvas and other non-markdown files */
export async function writeTextFile(
  path: string,
  content: string
): Promise<void> {
  return invoke('write_markdown_file', { path, content });
}

// ── Note Snapshots (persistent SQLite-backed version history) ──

export interface NoteSnapshot {
  id: number;
  file_path: string;
  content: string;
  content_length: number;
  created_at: string;
  created_at_ms: number;
}

export async function saveNoteSnapshot(filePath: string, content: string): Promise<boolean> {
  return invoke('save_note_snapshot', { filePath, content });
}

export async function getNoteSnapshots(filePath: string): Promise<NoteSnapshot[]> {
  return invoke('get_note_snapshots', { filePath });
}

export async function deleteNoteSnapshot(snapshotId: number): Promise<void> {
  return invoke('delete_note_snapshot', { snapshotId });
}

export async function deleteFile(path: string): Promise<void> {
  return invoke('delete_file', { path });
}

export async function listMarkdownFiles(dirPath: string): Promise<string[]> {
  return invoke('list_markdown_files', { dirPath });
}

export async function resolveWikilink(title: string): Promise<string | null> {
  return invoke('resolve_wikilink', { title });
}

export interface BacklinkEntry {
  file_path: string;
  title: string;
  context: string;
}

export async function getBacklinks(filePath: string): Promise<BacklinkEntry[]> {
  return invoke('get_backlinks', { filePath });
}

// ── Related Notes (passive discovery while reading) ────────────────

/** Which signal surfaced a related note. `explicit` > `link` > `semantic` in specificity. */
export type RelationSignal = 'explicit' | 'link' | 'semantic';

export interface RelatedNote {
  file_path: string;
  title: string;
  /** Char-truncated first-chunk preview (backend cuts on char boundaries, never bytes). */
  preview: string;
  /** The strongest signal — what the panel groups this note under. */
  relation: RelationSignal;
  /** `note_relations.relation_type` when `relation === 'explicit'`. */
  relation_type: string | null;
  /** Cosine similarity when a semantic signal is present, else 1.0. */
  score: number;
  /** Every signal that matched. Length > 1 means two independent methods agreed. */
  signals: RelationSignal[];
}

export interface RelatedNotesResult {
  notes: RelatedNote[];
  /**
   * False ⇒ the vault has no semantic signal available at all (no `semantic_edges`
   * rows and no embedding for this note), so an empty list means "index not built
   * yet" rather than "nothing is related". The panel renders a different state.
   */
  semantic_index_ready: boolean;
}

export async function getRelatedNotes(filePath: string, limit?: number): Promise<RelatedNotesResult> {
  return invoke('get_related_notes', { filePath, limit });
}

export async function listDirectoryTree(vaultPath: string): Promise<DirTreeNode> {
  return invoke('list_directory_tree', { vaultPath });
}

export async function createFile(parentPath: string, name: string): Promise<string> {
  return invoke('create_file', { parentPath, name });
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  return invoke('create_folder', { parentPath, name });
}

export async function renamePath(oldPath: string, newName: string): Promise<string> {
  return invoke('rename_path', { oldPath, newName });
}

export async function movePath(sourcePath: string, targetDir: string): Promise<string> {
  return invoke('move_path', { sourcePath, targetDir });
}

export async function deleteFolder(path: string): Promise<void> {
  return invoke('delete_folder', { path });
}

export async function saveImageToVault(
  vaultPath: string,
  relativePath: string,
  base64Data: string
): Promise<string> {
  return invoke('save_image_to_vault', { vaultPath, relativePath, base64Data });
}

// ── Import ─────────────────────────────────────────────────────────

export interface ImportResult {
  source_name: string;
  import_type: string;
  companion_path: string | null;
  success: boolean;
  error: string | null;
}

export async function importFiles(
  vaultPath: string,
  filePaths: string[],
): Promise<ImportResult[]> {
  return invoke('import_files', { vaultPath, filePaths });
}

export async function openFileExternal(filePath: string): Promise<void> {
  return invoke('open_file_external', { filePath });
}

export interface LlmConfig {
  apiUrl: string;
  apiKey?: string;
  model: string;
  providerId?: string;
  temperature?: number;
  maxTokens?: number;
  /** Optional context window (in tokens) from the provider preset.
   *  Forwarded to the backend so it can manage context accurately. */
  contextWindow?: number;
}

export async function importAttachments(
  vaultPath: string,
  filePaths: string[],
  llmConfig: LlmConfig | null,
): Promise<ImportResult[]> {
  return invoke('import_attachments', { vaultPath, filePaths, llmConfig });
}

// ── LLM Types ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  apiUrl?: string;
  model?: string;
  apiKey?: string;
  providerId?: string;
}

export interface ChatResponse {
  content: string;
  model: string;
}

export interface RagChatRequest {
  query: string;
  apiUrl?: string;
  model?: string;
  apiKey?: string;
  providerId?: string;
  searchLimit?: number;
  searchMode?: SearchMode;
  chatHistory?: ChatMessage[];
  queryEmbedding?: number[];
  methodology?: string;
  currentFile?: string;
  attachedContext?: string;
  /** R-6: File paths to exclude from search (already returned in previous turns) */
  excludePaths?: string[];
}

// ── LLM API Calls ──────────────────────────────────────────────────

export async function chatWithLlm(request: ChatRequest): Promise<ChatResponse> {
  return invoke('chat_with_llm', { request });
}

export async function chatWithLlmStream(request: ChatRequest): Promise<void> {
  return invoke('chat_with_llm_stream', { request });
}

export async function ragSearchAndChat(request: RagChatRequest): Promise<ChatResponse> {
  const enrichedRequest = await prepareRagSearchRequest(request);
  return invoke('rag_search_and_chat', { request: enrichedRequest });
}

export async function ragSearchAndStream(request: RagChatRequest): Promise<void> {
  const enrichedRequest = await prepareRagSearchRequest(request);
  return invoke('rag_search_and_stream', { request: enrichedRequest });
}

export async function generateCardMetadata(noteContent: string): Promise<string> {
  return invoke('generate_card_metadata', { request: { noteContent } });
}

// ── Knowledge Graph ────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  note_type: string;
  chunk_count: number;
  is_hub: boolean;
  is_orphan: boolean;
  cluster: number;
  created_at: string;
  pagerank: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  edge_type: string;
  weight: number;
  label?: string;
}

export interface ClusterInfo {
  id: number;
  label: string;
  node_count: number;
  color: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ClusterInfo[];
}

export async function getKnowledgeGraph(vaultPath: string): Promise<GraphData> {
  return invoke('get_knowledge_graph', { vaultPath });
}

export async function getLocalGraph(filePath: string): Promise<GraphData> {
  return invoke('get_local_graph', { filePath });
}

// ── Graph Relation Operations ─────────────────────────────────────

/**
 * 一次关系写入真正做了什么 / what one edge write actually did.
 *
 * `already_exists` 与 `rejected_by_user` 都**不是**成功：前者没有新增，后者是用户
 * 以前明确否决过的边。调用方必须分开报告，不能一律当成「已添加」。
 */
export type AddRelationOutcome = 'added' | 'already_exists' | 'rejected_by_user';

/** Add a note relation from the knowledge graph view */
export async function addNoteRelation(
  sourcePath: string,
  targetPath: string,
  relationType: string,
  reason?: string,
): Promise<AddRelationOutcome> {
  return invoke('add_note_relation', { sourcePath, targetPath, relationType, reason });
}

/**
 * Remove a note relation from the knowledge graph view.
 *
 * `relationType` 必填：两篇笔记之间可以同时存在 supports 与 depends_on，不指定类型
 * 等于让后端猜该删哪一条。返回 false 表示这条边本来就不存在。
 */
export async function deleteNoteRelation(
  sourcePath: string,
  targetPath: string,
  relationType: string,
): Promise<boolean> {
  return invoke('delete_note_relation', { sourcePath, targetPath, relationType });
}

/** AI-powered explanation of the conceptual relationship between two notes */
export async function explainRelationship(
  noteA: string,
  noteB: string,
  apiUrl: string,
  apiKey: string | null,
  model: string,
  providerId: string | null,
): Promise<string> {
  return invoke('explain_relationship', {
    noteA, noteB, apiUrl, apiKey, model, providerId,
  });
}


// ── Graph Plan: 目标 → 观察 → 提议 → 已验证的结果 ────────────────────
//
// 后端把「它看到了什么」「它推断了什么」「它想改什么」拆成三层，前端必须照着报，
// 不能把三者压成一句「修复完成」。这里的类型直接对应
// `src-tauri/src/knowledge/graph_plan.rs`（serde camelCase）。

/** 计划要解决哪一类问题。 */
export type GraphGoalType = 'diagnose' | 'bridge' | 'consolidate';

/** 计划的作用范围。`cluster` 为 null 表示不限簇。 */
export interface KnowledgeScope {
  paths: string[];
  cluster: number | null;
}

export interface GraphGoal {
  goalType: GraphGoalType;
  scope: KnowledgeScope;
  anchorPaths: string[];
  question: string;
  constraints: string[];
  maxProposals: number | null;
}

/**
 * 一条证据。
 *
 * `kind === 'file_level'` 或 `chunkId === null` 表示这条依据只到文件级，指不回具体
 * 段落——界面必须写明，否则用户会以为有原文出处。
 */
export interface GraphEvidence {
  path: string;
  chunkId: number | null;
  excerpt: string | null;
  kind: string;
}

/** 观察的种类，全部来自真实查询而非模型自述。 */
export type GraphObservationKind = 'orphan' | 'hub_overload' | 'duplicate' | 'missing_link';

export interface GraphObservation {
  id: string;
  kind: GraphObservationKind | string;
  title: string;
  summary: string;
  paths: string[];
  evidence: GraphEvidence[];
  confidence: number | null;
  warnings: string[];
}

export interface GraphProposal {
  id: string;
  operation: string;
  sourcePath: string;
  targetPath: string | null;
  relationType: string | null;
  reason: string;
  evidence: GraphEvidence[];
  confidence: number;
  risk: string;
  affectedPaths: string[];
  alreadyExists: boolean;
}

export interface GraphPlan {
  id: string;
  goal: GraphGoal;
  observations: GraphObservation[];
  proposals: GraphProposal[];
  validationSteps: string[];
  unresolvedQuestions: string[];
  generatedBy: string;
  generatedAtMs: number;
  changesetId: string | null;
  state: string;
}

/**
 * 计划的后端状态。
 *
 * 前三个（`awaiting_approval` / `conflict` / `rejected`）都意味着**还没有任何东西
 * 落库**；`partial_success` 意味着一部分落库了、一部分没有，不能当成完成。
 */
export type PlanState =
  | 'awaiting_approval'
  | 'conflict'
  | 'rejected'
  | 'completed'
  | 'partial_success'
  | 'failed'
  | 'rolled_back';

export type RelationItemOutcome =
  | 'added'
  | 'already_exists'
  | 'deleted'
  | 'missing'
  | 'rejected_by_user';

export interface RelationItemResult {
  source: string;
  target: string;
  relationType: string;
  outcome: RelationItemOutcome;
  message: string;
}

/** 一次 stage / commit / rollback 的真实结果，全部是计数而不是形容词。 */
export interface PlanOutcome {
  planId: string;
  changesetId: string | null;
  state: PlanState | string;
  selected: number;
  applied: number;
  alreadyExisted: number;
  rejectedByUser: number;
  missing: number;
  failed: number;
  conflicts: string[];
  /** 非 null 表示门禁拒绝执行，界面必须说「未执行」并解释，且不得再提供「提交」。 */
  refusal: string | null;
  message: string;
  details: RelationItemResult[];
}

/** 提交之后回查库里到底有没有这些边。 */
export interface PlanVerification {
  planId: string;
  relationTotal: number;
  proposalsPresent: number;
  proposalsAbsent: number;
  danglingEndpoints: string[];
  steps: string[];
  message: string;
}

export interface MocDraft {
  suggestedPath: string;
  title: string;
  content: string;
  memberPaths: string[];
  evidence: GraphEvidence[];
  warnings: string[];
}

/** 一条边的来历。`origin` 为 `user_link` 或 `agent_proposed`。 */
export interface RelationDetail {
  sourcePath: string;
  targetPath: string;
  relationType: string;
  confidence: number;
  reason: string | null;
  origin: string;
  confirmed: boolean;
  changesetId: string | null;
  createdAt: string | null;
  /** 用户下过的判断：`accepted` / `rejected`，没判断过就是 null。 */
  decision: string | null;
}

export interface RelationEvidenceView {
  detail: RelationDetail | null;
  semanticSimilarity: number | null;
  evidence: GraphEvidence[];
  semantics: string;
}

/** 只读：算出一份计划，什么都不写。 */
export async function knowledgeGraphCreatePlan(goal: GraphGoal): Promise<GraphPlan> {
  return invoke('knowledge_graph_create_plan', { goal });
}

/** 取回用户还在审的那份计划。 */
export async function knowledgeGraphGetPlan(planId: string): Promise<GraphPlan | null> {
  return invoke('knowledge_graph_get_plan', { planId });
}

/**
 * 只生成预览批次，不写图谱。
 *
 * `selectedIds` 为空数组表示「整份计划」，所以调用方必须显式传用户勾选的那些 id。
 */
export async function knowledgeGraphStagePlan(
  planId: string,
  selectedIds: string[],
  vaultPath: string,
  vaultPaths?: string[],
): Promise<PlanOutcome> {
  return invoke('knowledge_graph_stage_plan', { planId, selectedIds, vaultPath, vaultPaths });
}

/** 唯一真正写入的一步。 */
export async function knowledgeGraphCommitPlan(planId: string): Promise<PlanOutcome> {
  return invoke('knowledge_graph_commit_plan', { planId });
}

/** 撤销一次已提交的计划。 */
export async function knowledgeGraphRollbackPlan(planId: string): Promise<PlanOutcome> {
  return invoke('knowledge_graph_rollback_plan', { planId });
}

/** 提交后回查：库里是不是真的有这些边。 */
export async function knowledgeGraphVerifyPlan(planId: string): Promise<PlanVerification> {
  return invoke('knowledge_graph_verify_plan', { planId });
}

/** 一条边的详情与证据，供关系抽屉使用。 */
export async function knowledgeGraphRelationEvidence(
  sourcePath: string,
  targetPath: string,
  relationType: string,
): Promise<RelationEvidenceView> {
  return invoke('knowledge_graph_relation_evidence', { sourcePath, targetPath, relationType });
}

/** 用户对一条边下判断，并记住这个判断。 */
export async function knowledgeGraphDecideRelation(
  sourcePath: string,
  targetPath: string,
  relationType: string,
  accept: boolean,
  reason?: string,
): Promise<string> {
  return invoke('knowledge_graph_decide_relation', {
    sourcePath, targetPath, relationType, accept, reason,
  });
}

/** 生成一份 MOC 草稿（草稿而已，确认后才走笔记写入路径）。 */
export async function knowledgeGraphCreateMocDraft(
  title: string,
  memberPaths: string[],
): Promise<MocDraft> {
  return invoke('knowledge_graph_create_moc_draft', { title, memberPaths });
}


// ── Canvas Export ──────────────────────────────────────────────────

export interface CanvasExportOptions {
  layout: 'force-directed' | 'circular' | 'grid' | 'hierarchical';
  nodeWidth: number;
  nodeHeight: number;
  spacing: number;
  includeOrphans: boolean;
  maxNodes: number;
  colorByType: boolean;
}

export async function exportCanvas(options: CanvasExportOptions): Promise<string> {
  return invoke('export_canvas', { options });
}

export async function saveCanvasToFile(
  canvasJson: string,
  outputPath: string
): Promise<void> {
  return invoke('save_canvas_to_file', { canvasJson, outputPath });
}

export async function addCanvasRelation(
  sourcePath: string,
  targetPath: string,
  relationType: string
): Promise<string> {
  return invoke('add_canvas_relation', { sourcePath, targetPath, relationType });
}

export async function deleteCanvasRelation(
  sourcePath: string,
  targetPath: string,
  relationType: string
): Promise<boolean> {
  return invoke('delete_canvas_relation', { sourcePath, targetPath, relationType });
}


// ── Scheduler ──────────────────────────────────────────────────────

export interface SchedulerStatus {
  running: boolean;
  last_run: string | null;
  notes_processed: number;
  notes_reconciled: number;
  api_calls_used: number;
  errors: string[];
}

export interface StartSchedulerRequest {
  intervalSecs: number;
  batchSize: number;
  maxApiCalls: number;
  apiUrl: string;
  apiKey?: string;
  model: string;
  providerId: string;
  methodology: string;
  searchResultCount?: number;
  contentTruncationLimit?: number;
  includeJournals?: boolean;
  dailyNotePath?: string;
  vaultPaths?: string[];
  minNoteLength?: number;
}

export async function startScheduler(request: StartSchedulerRequest): Promise<string> {
  return invoke('start_scheduler', { request });
}

export async function stopScheduler(): Promise<string> {
  return invoke('stop_scheduler');
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  return invoke('get_scheduler_status');
}

export async function runSchedulerNow(
  apiUrl?: string,
  apiKey?: string,
  model?: string,
  providerId?: string,
  methodology?: string,
  pathPrefix?: string,
  batchSize?: number,
  searchResultCount?: number,
  contentTruncationLimit?: number,
  includeJournals?: boolean,
  dailyNotePath?: string,
  force?: boolean,
  minNoteLength?: number,
): Promise<SchedulerStatus> {
  return invoke('run_scheduler_now', { request: { apiUrl, apiKey, model, providerId, methodology, pathPrefix, batchSize, searchResultCount, contentTruncationLimit, includeJournals, dailyNotePath, force, minNoteLength } });
}

// ── Embedding ──────────────────────────────────────────────────

export async function getUnindexedChunks(limit: number): Promise<[number, string][]> {
  return invoke('get_unindexed_chunks', { limit });
}

export async function saveChunkEmbeddings(embeddings: [number, number[]][]): Promise<void> {
  return invoke('save_chunk_embeddings', { embeddings });
}

export async function finalizeEmbeddingIndex(): Promise<void> {
  return invoke('finalize_embedding_index');
}

export async function getEmbeddingStats(): Promise<EmbeddingStats> {
  return invoke('get_embedding_stats');
}

// ── Data Management ───────────────────────────────────────────────

export async function clearData(): Promise<void> {
  return invoke('clear_data');
}

export async function clearDataSelective(categories: string[]): Promise<void> {
  return invoke('clear_data_selective', { categories });
}

// ── Demo Vault ───────────────────────────────────────────────

export async function initDemoVault(): Promise<string> {
  return invoke('init_demo_vault');
}

export async function getDbPath(): Promise<string> {
  return invoke('get_db_path');
}

export async function getDataPath(): Promise<string> {
  return invoke('get_data_path');
}

export async function getCustomDbPath(): Promise<string | null> {
  return invoke('get_custom_db_path');
}

export async function setCustomDbPath(newPath: string, migrate: boolean): Promise<string> {
  return invoke('set_custom_db_path', { newPath, migrate });
}

// ── Health Lint Check ─────────────────────────────────────────────

export interface OrphanInfo {
  file_path: string;
  title: string;
}

export interface BrokenLinkInfo {
  file_path: string;
  target_title: string;
  line_number: number;
  context: string;
  suggested_fix?: string;
}

export interface MissingMetadataInfo {
  file_path: string;
  title: string;
}

export interface HubOverloadInfo {
  file_path: string;
  title: string;
  degree: number;
}

export interface UnidirectionalInfo {
  source: string;
  target: string;
  relation_type: string;
}

export interface GraphHealthInfo {
  connected_components: number;
  largest_component_size: number;
  total_nodes: number;
  total_edges: number;
  hub_overload: HubOverloadInfo[];
  unidirectional_relations: UnidirectionalInfo[];
  missing_embeddings: number;
}

export interface LintReport {
  orphans: OrphanInfo[];
  broken_links: BrokenLinkInfo[];
  missing_metadata: MissingMetadataInfo[];
  graph_health: GraphHealthInfo;
  semantic_duplicates: SemanticDuplicateInfo[];
  hidden_connections: HiddenConnectionInfo[];
}

export interface SemanticDuplicateInfo {
  file_path_a: string;
  title_a: string;
  file_path_b: string;
  title_b: string;
  similarity: number;
}

export interface HiddenConnectionInfo {
  file_path_a: string;
  title_a: string;
  file_path_b: string;
  title_b: string;
  similarity: number;
}

export async function runVaultLint(): Promise<LintReport> {
  return invoke('run_vault_lint');
}

export async function fixBrokenLink(
  filePath: string,
  targetTitle: string,
  lineNumber: number,
  action: 'remove_brackets' | 'replace',
  replacement?: string
): Promise<void> {
  return invoke('fix_broken_link', { filePath, targetTitle, lineNumber, action, replacement });
}

export async function createNoteForLink(title: string): Promise<string> {
  return invoke('create_note_for_link', { title });
}

// ── Agent Chat (Tool Calling) ─────────────────────────────────────

export interface AgentChatRequest {
  messages: ChatMessage[];
  apiUrl?: string;
  model?: string;
  apiKey?: string;
  providerId?: string;
  /** Selected model's context window (tokens). Backed by LlmConfig.contextWindow. */
  contextWindow?: number;
  /** 模型是否支持原生思考（native reasoning tokens） */
  supportsThinking?: boolean;
  vaultPath?: string;
  vaultPaths?: string[];
  methodology?: string;
  /** Whether web search mode is enabled */
  webSearch?: boolean;
  /** Currently open file path hint */
  currentFile?: string;
  /** Attached note context (pre-resolved content) */
  attachedContext?: string;
  /**
   * 本轮查询的 embedding，由前端 worker 算好。
   *
   * 有它后端才能走 hybrid + rerank；没有就是 FTS-only，而且 ContextPackage 的
   * warnings 里会明说是 FTS-only——界面显示的检索路径必须是真实跑过的那一条。
   */
  queryEmbedding?: number[];
}

/** Structured diff data from the backend for the approval card */
export interface ApprovalDiffData {
  tool_name: string;
  file_path: string;
  file_path_alt?: string;
  diff_type: string;
  tool_args_json: string;
  title: string;
  /** Effective risk of this call — always present. Backend: `RiskLevel::as_str()`. */
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  /** Why the risk was raised, multiple reasons joined with ` · `. Omitted when none. */
  risk_reason?: string;
}

export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface AgentEvent {
  type: 'thinking' | 'tool_start' | 'tool_progress' | 'tool_result' | 'tool_call_detected' | 'text_delta' | 'done' | 'role_selected' | 'pipeline_progress' | 'approval_required' | 'approval_resolved' | 'stage' | 'clear_text' | 'plan_update' | 'intent_classified' | 'tool_blocked' | 'tool_risk_notice' | 'tool_redacted' | 'memory_flushed' | 'run_started' | 'phase' | 'token_usage' | 'batch_progress' | 'context_package_ready';
message?: string;
tool_call_id?: string;
name?: string;
arguments?: string;
content?: string;
total_tool_calls?: number;
answer_source?: string;
answer_preview?: string;
  // Plan update (todo_write tool)
  steps?: PlanStep[];
  // Multi-Agent events
  agent_id?: string;
  agent_name?: string;
  agent_icon?: string;
  current_step?: number;
  total_steps?: number;
  action_description?: string;
  approval_id?: string;
  // ApprovalResolved 事件专用
  approved?: boolean;
  reason?: string;
  // Stage feedback (routing / loading_tools / planning / executing)
  // Also used by tool_progress events for the human-readable stage label.
  stage?: string;
  /** tool_progress: optional partial content preview */
  preview?: string;
  /** Structured diff data JSON from backend (approval_required events) */
  diff_json?: string;
  /** clear_text: true = next text_delta goes to Answer block (synthesis), not trace */
  answer_stream?: boolean;
  // Intent classification result (intent_classified events)
  /** Classified intent (snake_case: chitchat, vault_stats, search, analyze, write, curate, diagnose, composite, unknown) */
  intent?: string;
  /** Classification confidence (0.0 - 1.0) */
  confidence?: number;
  /** Which layer produced the classification: L0 (rules), L1 (scoring), L2 (LLM) */
  layer?: 'L0' | 'L1' | 'L2';
  /** Localized human-readable intent name for display */
  intent_name?: string;
  // Tool hook events (tool_blocked / tool_risk_notice / tool_redacted / memory_flushed)
  // `reason` (declared above) carries the PRE-hook risk/veto explanation.
  /** Number of secrets redacted by POST hook */
  redactions?: number;
  /** Number of memory items flushed before context fold */
  count?: number;
  // Lifecycle generation — stamped on EVERY event by `emit_agent_event`.
  /** Run id of the turn that produced this event. Events from a superseded run are dropped. */
  run_id?: string;
  // Phase labels (phase events)
  /** snake_case phase id: routing, calling_model, executing_tools, retrying, … */
  phase?: string;
  /** Pre-localized phase label for display */
  label?: string;
  /** Optional extra phase context */
  detail?: string;
  // Four-way token accounting (token_usage event, emitted once per turn)
  /** Uncached prompt tokens */
  input?: number;
  /** Generated tokens */
  output?: number;
  /** Prompt tokens served from cache */
  cache_read?: number;
  /** Tokens written into the cache */
  cache_write?: number;
  /** Sum of the four disjoint buckets */
  total?: number;
  /** cache_read / (cache_read + input), 0..1 */
  cache_hit_rate?: number;
  // Batch agent progress (batch_progress event, one per item of a `run_batch_agent` run).
  // `run_id` (declared above) is the *whole batch's* id — the same id `undoAgentRun`
  // takes to roll the entire batch back. `total` (declared above) is the item count.
  /** 0-based index of the item that just finished */
  index?: number;
  /** Vault-relative path of the note this item processed */
  file_path?: string;
  /** Per-item outcome: ok | error | skipped */
  status?: 'ok' | 'error' | 'skipped';
  // Context assembly (context_package_ready, emitted once per turn before the model call).
  // Carries the *summary* only — never chunk bodies, so the event stays safe to log.
  /** What the retrieval layer actually decided to put in front of the model */
  package?: ContextPackageSummary;
}

/**
 * Attach a query embedding to an agent turn so recall is hybrid (vector + FTS +
 * RRF + rerank) instead of FTS-only.
 *
 * The embedding is computed here rather than in `SmartChat` because every gate
 * that decides whether an embedding is even possible already lives in this
 * module: `getEmbeddingForSearch` checks the vector index stats, reads the
 * embedding config, picks local vs custom provider, and times the call out. The
 * agent path reusing it means the two retrieval paths can never disagree.
 *
 * Failure is not an error: when no embedding can be produced the field stays
 * absent, retrieval falls back to FTS, and the ContextPackage carries the
 * `fts_only_no_query_embedding` warning — so the Context Inspector shows the
 * path that actually ran instead of the one we hoped for.
 */
async function withAgentQueryEmbedding(request: AgentChatRequest): Promise<AgentChatRequest> {
  if (request.queryEmbedding?.length) return request;
  // The turn's recall is about what the user just asked, so the last user
  // message is the query — not the whole transcript.
  const lastUser = [...(request.messages || [])].reverse().find((m) => m.role === 'user');
  const queryText = lastUser?.content?.trim();
  if (!queryText) return request;
  const queryEmbedding = await getEmbeddingForSearch(queryText, 'hybrid');
  if (!queryEmbedding) return request;
  return { ...request, queryEmbedding };
}

export async function agentChat(request: AgentChatRequest): Promise<string> {
  return invoke('agent_chat', { request: await withAgentQueryEmbedding(request) });
}

export async function cancelAgentTurn(): Promise<boolean> {
  return invoke('cancel_agent_turn');
}

/** Pre-send context estimate: messages + system prompt + default tool schemas. */
export interface AgentContextEstimate {
  total: number;
  messages: number;
  system: number;
  tools: number;
}

export async function estimateAgentContextTokens(request: {
  messages: { role: string; content: string }[];
  methodology?: string;
  vaultPath?: string;
}): Promise<AgentContextEstimate> {
  return invoke('estimate_agent_context_tokens', { request });
}

export async function emitRefreshEvent(filePath?: string): Promise<void> {
  return emit('request-file-tree-refresh', filePath ? { filePath } : undefined);
}

// ── Graph Relations (Phase 4) ─────────────────────────────────────

export async function getEdgesByRelation(relationType: string): Promise<GraphEdge[]> {
  return invoke('get_edges_by_relation', { relationType });
}

// ── MCP Server Management (Phase 3.3) ─────────────────────────────

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return invoke('list_mcp_servers');
}

export async function addMcpServer(
  name: string, command: string, args: string[],
  env?: Record<string, string>
): Promise<void> {
  return invoke('add_mcp_server', { name, command, args, env: env || null });
}

export async function removeMcpServer(name: string): Promise<void> {
  return invoke('remove_mcp_server', { name });
}

export async function testMcpConnection(
  name: string, command: string, args: string[],
  env?: Record<string, string>
): Promise<string[]> {
  return invoke('test_mcp_connection', { name, command, args, env: env || null });
}

// ── Skill Directory Management (Phase 3.3) ────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  tools: string[];
  directory: string;
  enabled: boolean;
  has_skill_md: boolean;
}

export interface SkillDetail {
  info: SkillInfo;
  skill_md_content: string | null;
  mcp_servers: unknown[];
}

export async function listSkillDirectories(): Promise<string[]> {
  return invoke('list_skill_directories');
}

export async function addSkillDirectory(directory: string): Promise<void> {
  return invoke('add_skill_directory', { directory });
}

export async function removeSkillDirectory(directory: string): Promise<void> {
  return invoke('remove_skill_directory', { directory });
}

export async function scanSkills(): Promise<SkillInfo[]> {
  return invoke('scan_skills');
}

export async function getSkillDetail(skillDir: string): Promise<SkillDetail> {
  return invoke('get_skill_detail', { skillDir });
}

// ── Chat History & AI Memory (Phase 6) ────────────────────────────

export interface ChatSession {
  id: string;
  title: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  sources?: string;
  toolCalls?: string;
  /** Separated chain-of-thought (agent narration) */
  thinkingContent?: string;
  /** Full agent timeline (thinking + tool calls + text), JSON array string */
  agentTimeline?: string;
  /** Live plan from todo_write tool, JSON array string of {text, status} */
  planSteps?: string;
  createdAt: string;
}

export interface AiMemoryEntry {
  id: number;
  content: string;
  category: string;
  weight: number;
  sourceSessionId?: string;
  createdAt: string;
  expiresAt?: string;
}

// Session CRUD
export async function listChatSessions(): Promise<ChatSession[]> {
  return invoke('list_chat_sessions');
}

export async function getChatSession(sessionId: string): Promise<ChatMessageRecord[]> {
  return invoke('get_chat_session', { sessionId });
}

export async function createChatSession(id: string, title: string, mode: string): Promise<void> {
  return invoke('create_chat_session', { id, title, mode });
}

export async function saveChatMessage(
  id: string,
  sessionId: string,
  role: string,
  content: string,
  sources?: string,
  toolCalls?: string,
  thinkingContent?: string,
  agentTimeline?: string,
  planSteps?: string,
): Promise<void> {
  return invoke('save_chat_message', { id, sessionId, role, content, sources, toolCalls, thinkingContent, agentTimeline, planSteps });
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  return invoke('delete_chat_session', { sessionId });
}

/**
 * Drop `fromMessageId` and every message saved after it in this session.
 * Backs the regenerate / edit-and-resend / error-retry flows: the discarded
 * turn must leave the sqlite history too, or reloading the session would
 * resurrect the reply the user just asked to redo.
 * Returns the number of rows removed.
 */
export async function deleteChatMessagesFrom(sessionId: string, fromMessageId: string): Promise<number> {
  return invoke('delete_chat_messages_from', { sessionId, fromMessageId });
}

export async function renameChatSession(sessionId: string, newTitle: string): Promise<void> {
  return invoke('rename_chat_session', { sessionId, newTitle });
}

// Export
export async function exportChatSession(sessionId: string, format: string, exportPath: string): Promise<string> {
  return invoke('export_chat_session', { sessionId, format, exportPath });
}

export async function exportAllSessions(format: string, exportPath: string): Promise<string[]> {
  return invoke('export_all_sessions', { format, exportPath });
}

// AI Memory
export async function getAiMemories(): Promise<AiMemoryEntry[]> {
  return invoke('get_ai_memories');
}

export async function addAiMemory(content: string, category?: string, sourceSessionId?: string): Promise<number> {
  return invoke('add_ai_memory', { content, category, sourceSessionId });
}

export async function deleteAiMemory(memoryId: number): Promise<void> {
  return invoke('delete_ai_memory', { memoryId });
}

// ── App Settings ──────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  return invoke('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke('set_setting', { key, value });
}

// ── Internal Tools & Persistent Memory (Tier 2) ──────────────────

export interface ToolSummary {
  name: string;
  description: string;
}

export async function listInternalTools(): Promise<ToolSummary[]> {
  return invoke('list_internal_tools');
}

export async function readMemoryFile(vaultPath: string): Promise<string> {
  return invoke('read_memory_file', { vaultPath });
}

export async function writeMemoryFile(vaultPath: string, content: string): Promise<void> {
  return invoke('write_memory_file', { vaultPath, content });
}

// ── Bases (Database View) ─────────────────────────────────────────

export interface BasesEntry {
  path: string;
  title: string;
  noteType: string;
  tags: string[];
  linkCount: number;
  confidence: number | null;
  createdAt: string;
  lastSynced: string;
  folder: string;
}

export interface BasesData {
  entries: BasesEntry[];
  folders: string[];
  allTags: string[];
  allTypes: string[];
}

export async function getBasesData(vaultPath: string): Promise<BasesData> {
  return invoke('get_bases_data', { vaultPath });
}

// ── Notes Overview / 知识库总览 ────────────────────────────────────
//
// Replaces `get_bases_data` for the table view. The backend struct is
// `#[serde(rename_all = "camelCase")]`, so what arrives here is camelCase.
// `confidence` is deliberately absent: nothing in the repo ever writes
// `card_meta.confidence`, so the old column was always empty.

/** Four-state index health of one note. `noChunks` = the file was never chunked. */
export type NoteIndexStatus = 'indexed' | 'partial' | 'notIndexed' | 'noChunks';

export interface NoteRow {
  path: string;
  title: string;
  folder: string;
  noteType: string;
  tags: string[];
  /** `card_meta.links` length — outbound wikilinks. */
  outboundLinks: number;
  backlinkCount: number;
  semanticDegree: number;
  indexStatus: NoteIndexStatus;
  chunkTotal: number;
  chunkEmbedded: number;
  /** `null` = never reconciled by the AI. */
  reconciledAt: string | null;
  hasContradictions: boolean;
  contradictionCount: number;
  reviewState: string | null;
  reviewDueAtMs: number | null;
  reviewIsDue: boolean;
  reviewSuspended: boolean;
  reviewLapses: number;
  /** Only non-null when the overview was fetched with `includeGraphSignals`. */
  pagerank: number | null;
  isHub: boolean | null;
  createdAt: string;
  lastSynced: string;
}

export interface NotesOverview {
  rows: NoteRow[];
  folders: string[];
  allTags: string[];
  allTypes: string[];
  /** `false` = the semantic index has never been computed. Do **not** paint every
   *  note as a semantic island in that case — say "not computed" instead. */
  semanticIndexReady: boolean;
  graphSignalsIncluded: boolean;
  total: number;
  /** `true` = the 20k row safety cap was hit; warn "showing first N only". */
  truncated: boolean;
}

/**
 * Every note under `vaultPath` with its health signals.
 *
 * `includeGraphSignals` triggers a **full-graph PageRank rebuild** (hundreds of
 * ms to seconds on a few thousand notes) and is the only thing that fills
 * `pagerank` / `isHub`. Pass `false` for the interactive load.
 */
export async function getNotesOverview(
  vaultPath: string,
  includeGraphSignals = false,
): Promise<NotesOverview> {
  return invoke('get_notes_overview', { vaultPath, includeGraphSignals });
}

/** A named filter+sort+columns preset. Persisted as one JSON blob in app_settings. */
export interface SavedView {
  id: string;
  name: string;
  query: string;
  folder: string;
  noteType: string;
  tag: string;
  sortField: string;
  sortDir: string;
  visibleColumns: string[];
  groupBy: string | null;
  createdAtMs: number;
}

export async function listSavedViews(): Promise<SavedView[]> {
  return invoke('list_saved_views');
}

/** Upsert by `id`. */
export async function saveView(view: SavedView): Promise<void> {
  return invoke('save_view', { view });
}

export async function deleteSavedView(id: string): Promise<void> {
  return invoke('delete_saved_view', { id });
}

// ── Batch AI over a selection ─────────────────────────────────────
//
// One `runId` covers the whole batch, so `undoAgentRun(runId)` rolls every note
// back in one shot. Per-item progress arrives on the `agent-event` channel as
// `batch_progress` events carrying `run_id` / `index` / `total` / `file_path` /
// `status`.

export interface BatchAgentItem {
  filePath: string;
  status: 'ok' | 'error' | 'skipped';
  summary: string | null;
  error: string | null;
}

export interface BatchAgentReport {
  runId: string;
  total: number;
  succeeded: number;
  failed: number;
  items: BatchAgentItem[];
  cancelled: boolean;
}

export interface BatchAgentRequest {
  filePaths: string[];
  instruction: string;
  vaultPath: string;
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  providerId?: string;
  methodology?: string;
  continueOnError?: boolean;
}

/**
 * Run one instruction over a selection of notes, note by note.
 *
 * Every write still goes through the normal approval path, so unless the user
 * has raised their permission tier this will raise one `DiffApprovalCard` per
 * note. Warn before calling.
 */
export async function runBatchAgent(request: BatchAgentRequest): Promise<BatchAgentReport> {
  return invoke('run_batch_agent', { request });
}

// ── Conflict Detection & Resolution ──────────────────────────────

export interface FileConflict {
  file_path: string;
  section_heading: string;
  user_content: string;
  ai_content: string;
  conflict_type: string;
}

export async function detectFileConflicts(filePath: string): Promise<FileConflict[]> {
  return invoke('detect_file_conflicts', { filePath });
}

export async function resolveConflict(
  filePath: string,
  sectionHeading: string,
  resolution: string,
): Promise<boolean> {
  return invoke('resolve_conflict', { filePath, sectionHeading, resolution });
}

// ── Temporal Knowledge Engine ────────────────────────────────────

export interface TemporalFact {
  id: number;
  note_path: string;
  fact_content: string;
  valid_from: string;
  valid_to: string | null;
  superseded_by: number | null;
  created_by: string;
}

export interface TimelineEvent {
  id: number;
  note_path: string;
  event_type: string;
  event_timestamp: string;
  event_details: string | null;
  old_fact_id: number | null;
  new_fact_id: number | null;
}

/** Get facts for a single note. Set includeHistory=true for invalidated facts too. */
export async function getNoteFacts(notePath: string, includeHistory: boolean = false): Promise<TemporalFact[]> {
  return invoke('get_note_facts', { notePath, includeHistory });
}

/** Get timeline events for a single note. */
export async function getNoteTimeline(notePath: string): Promise<TimelineEvent[]> {
  return invoke('get_note_timeline', { notePath });
}

/** Get all timeline events across the vault within a date range. */
export async function getGlobalTimeline(startDate?: string, endDate?: string): Promise<TimelineEvent[]> {
  return invoke('get_global_timeline', { startDate, endDate });
}

// ── Agent Approval Gate ──────────────────────────────────────────

/** Approve a pending Agent write operation. */
export async function approveToolCall(approvalId: string): Promise<boolean> {
  return invoke('approve_tool_call', { approvalId });
}

/** Reject a pending Agent write operation. */
export async function rejectToolCall(approvalId: string): Promise<boolean> {
  return invoke('reject_tool_call', { approvalId });
}

// ── Permission Tiers & Allow Rules ───────────────────────────────

/**
 * Permission tiers. Deliberately three, not ten — a local-first app has no
 * remote blast radius to model, only "can it touch my vault at all".
 *   readOnly — every mutating tool is denied outright
 *   standard — mutating tools ask, unless an allow rule matches
 *   trusted  — low/medium risk auto-allowed; high still asks
 * There is no YOLO tier: deletion (critical) always asks, in every mode.
 */
export type PermissionMode = 'readOnly' | 'standard' | 'trusted';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Rule scope: `session` rules are dropped on app restart, `persistent` ones survive. */
export type ApprovalRuleScope = 'session' | 'persistent';

export interface ApprovalRule {
  id: number;
  tool_name: string;
  /** Vault-relative prefix the rule is limited to; `''` means the whole vault. */
  path_prefix: string;
  /** Never `'critical'` — the backend rejects that. */
  max_risk: RiskLevel;
  scope: ApprovalRuleScope;
  created_at_ms: number;
  note?: string;
}

export async function getPermissionMode(): Promise<PermissionMode> {
  return invoke('get_permission_mode');
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  return invoke('set_permission_mode', { mode });
}

export async function listApprovalRules(): Promise<ApprovalRule[]> {
  return invoke('list_approval_rules');
}

/** Create an allow rule. `maxRisk` must not be `'critical'`. */
export async function addApprovalRule(
  toolName: string,
  pathPrefix: string,
  maxRisk: Exclude<RiskLevel, 'critical'>,
  scope: ApprovalRuleScope,
  note?: string,
): Promise<number> {
  return invoke('add_approval_rule', { toolName, pathPrefix, maxRisk, scope, note });
}

export async function deleteApprovalRule(id: number): Promise<void> {
  return invoke('delete_approval_rule', { id });
}

// ── Whole-Turn Undo (Checkpoint / Rewind) ────────────────────────

export interface AgentRunSummary {
  run_id: string;
  started_at_ms: number;
  change_count: number;
  /** True only when every journal entry of the run is already rolled back. */
  undone: boolean;
  /** Distinct paths touched, capped at 10 by the backend. */
  affected_paths: string[];
}

export interface UndoReport {
  run_id: string;
  restored: number;
  failed: string[];
  /** Files moved into the recycle bin (undo of a `create`). */
  trashed: string[];
  skipped_already_undone: number;
  reindexed: number;
  warnings: string[];
}

/** Agent turns that changed files, newest first. `limit` defaults to 20. */
export async function listAgentRuns(limit?: number): Promise<AgentRunSummary[]> {
  return invoke('list_agent_runs', { limit });
}

/** Roll back every file change of one agent turn. Partial success is reported, not hidden. */
export async function undoAgentRun(runId: string): Promise<UndoReport> {
  return invoke('undo_agent_run', { runId });
}

// ── Recycle Bin ──────────────────────────────────────────────────

export interface TrashEntry {
  /** Location inside `<vault>/.zettelagent/trash/`, forward slashes. */
  trash_path: string;
  original_relative_path: string;
  /** `YYYYMMDD-HHMMSS` batch stamp. */
  deleted_at: string;
  size: number;
}

export async function listTrash(vaultPath: string): Promise<TrashEntry[]> {
  return invoke('list_trash', { vaultPath });
}

/** Move a trashed file back. Refuses to overwrite an existing file at the original path. */
export async function restoreFromTrash(vaultPath: string, trashPath: string): Promise<string> {
  return invoke('restore_from_trash', { vaultPath, trashPath });
}

/** Permanently delete trashed files. `olderThanDays` omitted = clear everything. */
export async function emptyTrash(vaultPath: string, olderThanDays?: number): Promise<number> {
  return invoke('empty_trash', { vaultPath, olderThanDays });
}

/** Backend default, mirrored here so the UI can mark "modified" without a round-trip. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * How long trashed batches survive the automatic sweep, in whole days.
 *
 * `0` means "never sweep", NOT "purge now" — `sweep_expired_trash_impl` returns
 * early on 0 precisely so a mis-set value can't wipe the recycle bin.
 */
export async function getTrashRetentionDays(): Promise<number> {
  return invoke('get_trash_retention_days');
}

export async function setTrashRetentionDays(days: number): Promise<void> {
  await invoke('set_trash_retention_days', { days });
}

// ── MCP Server (expose this vault to external agents) ─────────────
//
// The inbound direction, opposite to `McpServersSection` above: instead of this
// app calling out to other MCP services, these two commands describe the server
// *we* expose over stdio when launched with `--mcp-server`.
//
// Read-only by construction — `EXPOSED_TOOLS` in
// `src-tauri/src/tools/mcp_server/mod.rs` contains no writer, and the SQLite
// connection is opened `SQLITE_OPEN_READ_ONLY`. There is no listener, no port
// and no token to configure, because stdio has none of those things.

/** Shape of `mcp_server_capabilities()`'s JSON payload. */
export interface McpServerCapabilities {
  protocolVersion: string;
  /** Always `true`. Kept as a field rather than assumed so the UI reflects the
   *  backend instead of a hard-coded claim. */
  readOnly: boolean;
  tools: string[];
  resources: { scheme: string; mimeType: string };
  prompts: string[];
}

/**
 * Ready-to-paste `mcpServers` JSON for Claude Desktop / Cursor. The backend
 * fills in the current executable path; we supply the db path the user's vault
 * actually resolves to (`getDbPath()`).
 */
export async function mcpServerClientConfig(dbPath: string): Promise<string> {
  return invoke('mcp_server_client_config', { dbPath });
}

/** Raw JSON string; use `parseMcpServerCapabilities` unless you want the text. */
export async function mcpServerCapabilities(): Promise<string> {
  return invoke('mcp_server_capabilities');
}

/**
 * Parse the capabilities payload, returning `null` on anything unexpected.
 *
 * Both failure modes — command missing on an older build, or JSON we don't
 * recognise — are the same to the UI: show nothing rather than a half-rendered
 * or invented capability list.
 */
export async function parseMcpServerCapabilities(): Promise<McpServerCapabilities | null> {
  try {
    const parsed = JSON.parse(await mcpServerCapabilities());
    if (!parsed || !Array.isArray(parsed.tools)) return null;
    return parsed as McpServerCapabilities;
  } catch (e) {
    console.warn('[mcp-server] capabilities unavailable:', e);
    return null;
  }
}

// ── Retrieval Rerank ─────────────────────────────────────────────
//
// Mirrors `RerankConfig` / `RerankMode` in `src-tauri/src/db/search/rerank.rs`,
// which is `#[serde(default, rename_all = "camelCase")]` — hence camelCase field
// names here rather than the snake_case used by older commands in this file.

/**
 * The four rerank tiers.
 *
 * * `off` — genuine no-op, the fused order is returned untouched.
 * * `lexical` — Tier 1, pure Rust, no download, no network. The default.
 * * `crossEncoder` — Tier 2, the ~288 MB ONNX model in `reranker.ts`.
 * * `llm` — Tier 3, one listwise call to the configured LLM.
 */
export type RerankMode = 'off' | 'lexical' | 'crossEncoder' | 'llm';

export interface RerankConfig {
  mode: RerankMode;
  /** Size of the rerank window. Rust clamps to [2, 200] in `effective_top_k`. */
  topK: number;
  /** Tier 3 cost guard: max candidates handed to the LLM. */
  llmMaxCandidates: number;
  /** Tier 3 cost guard: chars (not bytes) per snippet. */
  llmMaxSnippetChars: number;
  /** Tier 3 cost guard: fall back to Tier 1 after this long. */
  llmTimeoutMs: number;
}

/**
 * Same values as `RerankConfig::default()` in Rust. Duplicated deliberately: the
 * settings UI has to render *something* before the first successful load, and
 * showing the real defaults beats showing zeros.
 */
export const DEFAULT_RERANK_CONFIG: RerankConfig = {
  mode: 'lexical',
  topK: 32,
  llmMaxCandidates: 12,
  llmMaxSnippetChars: 320,
  llmTimeoutMs: 8_000,
};

/**
 * Raised when the rerank commands are not registered in this build.
 *
 * A distinct type rather than a string match, so the UI can say "backend not
 * ready yet" instead of dumping a Tauri internal error at the user. The two
 * commands are landing in a parallel change; until then every call ends here.
 */
export class RerankBackendUnavailable extends Error {
  constructor(cause: unknown) {
    super(String(cause));
    this.name = 'RerankBackendUnavailable';
  }
}

/**
 * Tauri answers an unregistered command with a message containing
 * "not allowed"/"not found"/"unknown". Sniffing the text is unlovely but it is
 * the only signal available — and the fallback (treat any failure as
 * "unavailable") is the safe direction: rerank is optional everywhere.
 */
function looksUnregistered(e: unknown): boolean {
  const msg = String(e).toLowerCase();
  return msg.includes('not allowed')
    || msg.includes('not found')
    || msg.includes('unknown')
    || msg.includes('does not exist');
}

/**
 * Load the persisted rerank config.
 *
 * Throws `RerankBackendUnavailable` when the command is missing so the caller
 * can distinguish "no backend yet" (show a notice, keep the defaults on screen)
 * from a real error worth surfacing verbatim.
 */
export async function getRerankConfig(): Promise<RerankConfig> {
  try {
    const raw = await invoke<Partial<RerankConfig>>('get_rerank_config');
    // Spread over the defaults: `#[serde(default)]` on the Rust side means a
    // future added field may simply be absent from an older stored value.
    return { ...DEFAULT_RERANK_CONFIG, ...(raw ?? {}) };
  } catch (e) {
    if (looksUnregistered(e)) throw new RerankBackendUnavailable(e);
    throw e;
  }
}

/**
 * Persist the rerank config. Same unavailability contract as the getter.
 *
 * The command is PATCH-shaped — every knob is an independent `Option<_>` arg
 * (`search_commands.rs:230`), not a single `config` struct — so the fields are
 * spread out here. Tauri maps these camelCase keys onto the snake_case Rust
 * params. Passing a partial patch leaves the other knobs at their stored value.
 *
 * Returns the config the backend actually stored: it clamps out-of-range knobs
 * rather than only rejecting them, so the echo can differ from what was sent
 * and is what the UI should render.
 */
export async function setRerankConfig(patch: Partial<RerankConfig>): Promise<RerankConfig> {
  try {
    const raw = await invoke<Partial<RerankConfig>>('set_rerank_config', {
      mode: patch.mode,
      topK: patch.topK,
      llmMaxCandidates: patch.llmMaxCandidates,
      llmMaxSnippetChars: patch.llmMaxSnippetChars,
      llmTimeoutMs: patch.llmTimeoutMs,
    });
    return { ...DEFAULT_RERANK_CONFIG, ...(raw ?? {}) };
  } catch (e) {
    if (looksUnregistered(e)) throw new RerankBackendUnavailable(e);
    throw e;
  }
}

// ── Spaced repetition (FSRS-4.5) ─────────────────────────────────
//
// Mirrors `src-tauri/src/fsrs.rs` + `src-tauri/src/db/review_store.rs`, both of
// which are `#[serde(rename_all = "camelCase")]`.

/** FSRS grades. The numbers are the storage format — do not renumber. */
export const GRADE_AGAIN = 1;
export const GRADE_HARD = 2;
export const GRADE_GOOD = 3;
export const GRADE_EASY = 4;
export type ReviewGrade = 1 | 2 | 3 | 4;

/** Card lifecycle, matching `fsrs::State`. */
export type ReviewCardState = 'new' | 'learning' | 'review' | 'relearning';

/** What one grade button would do, precomputed by Rust so the two sides cannot
 *  disagree about the interval a click will produce. */
export interface GradePreview {
  grade: ReviewGrade;
  /** Whole days. `0` means the card stays in (re)learning — read `intervalMinutes`. */
  intervalDays: number;
  intervalMinutes: number;
  state: ReviewCardState;
}

export interface ReviewQueueEntry {
  filePath: string;
  title: string;
  /** Char-truncated note preview from the indexed chunks, not the file on disk. */
  preview: string;
  dueAtMs: number;
  state: ReviewCardState;
  overdueDays: number;
  reps: number;
  lapses: number;
  /** In `Again, Hard, Good, Easy` order. */
  gradePreviews: GradePreview[];
}

export interface ReviewQueue {
  due: ReviewQueueEntry[];
  newCards: ReviewQueueEntry[];
  /** Totals ignore the daily caps, so the UI can show "20 of 743 due". */
  dueTotal: number;
  newTotal: number;
  reviewsDoneToday: number;
  newDoneToday: number;
  reviewsRemainingToday: number;
  newRemainingToday: number;
}

export interface ReviewCardView {
  filePath: string;
  state: ReviewCardState;
  dueAtMs: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  suspended: boolean;
  intervalDays: number;
  intervalMinutes: number;
}

export interface ReviewForecastDay {
  /** 0 = today. */
  dayOffset: number;
  count: number;
}

export interface ReviewStats {
  totalCards: number;
  newCount: number;
  learningCount: number;
  reviewCount: number;
  relearningCount: number;
  suspendedCount: number;
  dueToday: number;
  forecast: ReviewForecastDay[];
  /** True retention over mature reviews. `null` until there is one to measure. */
  retentionRate: number | null;
  reviewsToday: number;
  totalReviews: number;
  streakDays: number;
}

export interface FsrsConfig {
  desiredRetention: number;
  maximumIntervalDays: number;
  /** Intra-day delays in minutes for cards that have not graduated. */
  learningSteps: number[];
  enableFuzz: boolean;
  newPerDay: number;
  reviewsPerDay: number;
}

/**
 * Same values as `FsrsConfig::default()` in Rust. Duplicated deliberately: the
 * settings card has to render something honest before the first load resolves.
 */
export const DEFAULT_FSRS_CONFIG: FsrsConfig = {
  desiredRetention: 0.9,
  maximumIntervalDays: 36_500,
  learningSteps: [1, 10],
  enableFuzz: true,
  newPerDay: 20,
  reviewsPerDay: 200,
};

/** Cards to study now. `limit` bounds the due and new lists independently. */
export async function getReviewQueue(limit?: number): Promise<ReviewQueue> {
  return invoke('get_review_queue', { limit });
}

/** Apply a grade and get back the rescheduled card, including its new interval. */
export async function gradeCard(filePath: string, grade: ReviewGrade): Promise<ReviewCardView> {
  return invoke('grade_card', { filePath, grade });
}

/** Returns how many notes were newly added; already-studied notes are untouched. */
export async function addCardsToReview(filePaths: string[]): Promise<number> {
  return invoke('add_cards_to_review', { filePaths });
}

export async function removeCardFromReview(filePath: string): Promise<boolean> {
  return invoke('remove_card_from_review', { filePath });
}

export async function suspendCard(filePath: string, suspended: boolean): Promise<boolean> {
  return invoke('suspend_card', { filePath, suspended });
}

/** `null` when the note is not in the deck. */
export async function getReviewCard(filePath: string): Promise<ReviewCardView | null> {
  return invoke('get_review_card', { filePath });
}

export async function getReviewStats(): Promise<ReviewStats> {
  return invoke('get_review_stats');
}

export async function getFsrsConfig(): Promise<FsrsConfig> {
  const raw = await invoke<Partial<FsrsConfig>>('get_fsrs_config');
  // Spread over the defaults: `#[serde(default)]` on the Rust side means a
  // future added field may simply be absent from an older stored value.
  return { ...DEFAULT_FSRS_CONFIG, ...(raw ?? {}) };
}

/**
 * Persist the scheduling config.
 *
 * The command is PATCH-shaped — every knob is an independent `Option<_>` arg
 * (`review_commands.rs`), not a single `config` struct — so the fields must be
 * spread as individual args here. Nesting them under one object makes every
 * param arrive as `None` and the command then saves nothing at all, silently:
 * exactly the bug `setRerankConfig` above was fixed for.
 *
 * Returns the config the backend actually stored.
 */
export async function setFsrsConfig(patch: Partial<FsrsConfig>): Promise<FsrsConfig> {
  const raw = await invoke<Partial<FsrsConfig>>('set_fsrs_config', {
    desiredRetention: patch.desiredRetention,
    maximumIntervalDays: patch.maximumIntervalDays,
    learningSteps: patch.learningSteps,
    enableFuzz: patch.enableFuzz,
    newPerDay: patch.newPerDay,
    reviewsPerDay: patch.reviewsPerDay,
  });
  return { ...DEFAULT_FSRS_CONFIG, ...(raw ?? {}) };
}

// ── 统一知识对象层 / the knowledge-object layer ──────────────────────────
//
// 稳定身份层：Agent 的写入、证据、关系、审批都挂在 objectId 上，而不是挂在
// 文件路径上（重命名就换身份）。原始 Markdown 仍是内容权威，这些表全部可重建。

export type KnowledgeObjectKind =
  | 'document' | 'block' | 'memory' | 'fact' | 'claim'
  | 'event' | 'task' | 'skill' | 'resource' | 'collection';

export type KnowledgeObjectStatus = 'active' | 'archived' | 'superseded' | 'deleted';

export type RelationProvenance =
  | 'observed' | 'extracted' | 'inferred' | 'proposed' | 'user_authored';

export interface KnowledgeSourceRef {
  source_type: string;
  source_id: string;
}

/**
 * 一个可寻址的知识对象。
 *
 * 字段名是 snake_case：后端这些结构体没有加 `rename_all = "camelCase"`，因为
 * 它们也会出现在 evidence/audit 的 JSON 里，保持与数据库列名一致更好排查。
 * 命令的包装层（`KnowledgeIndexHealth` 等）才是 camelCase。
 */
export interface KnowledgeObject {
  id: string;
  kind: KnowledgeObjectKind;
  scope: string;
  parent_id: string | null;
  source: KnowledgeSourceRef | null;
  title: string | null;
  /** `document`/`block` 为 null——内容在 Markdown 里，这里只有校验和。 */
  canonical_content: string | null;
  content_format: string;
  status: KnowledgeObjectStatus;
  current_version: number;
  created_at_ms: number;
  updated_at_ms: number;
  valid_from_ms: number | null;
  valid_to_ms: number | null;
  supersedes_id: string | null;
  confidence: number;
  user_confirmed: boolean;
  metadata_json: string | null;
}

export interface KnowledgeObjectVersion {
  object_id: string;
  version: number;
  content: string | null;
  checksum: string;
  actor: string;
  run_id: string | null;
  session_id: string | null;
  changeset_id: string | null;
  created_at_ms: number;
  valid_from_ms: number | null;
  valid_to_ms: number | null;
}

export interface KnowledgeRelation {
  id: string;
  source_object_id: string;
  target_object_id: string;
  relation_type: string;
  provenance: RelationProvenance;
  confidence: number;
  status: KnowledgeObjectStatus;
  evidence_ids: string[];
  supersedes_id: string | null;
  conflicts_with_id: string | null;
  created_at_ms: number;
  valid_from_ms: number | null;
  valid_to_ms: number | null;
}

/** 一条证据加上它在某个对象上的角色。 */
export interface KnowledgeEvidence {
  id: string;
  source_type: string;
  source_id: string;
  /** 回到原文的坐标，如 `notes/a.md#L12-L18`。为 null 时 UI 只能标为不可验证。 */
  locator: string | null;
  excerpt: string | null;
  checksum: string | null;
  captured_at_ms: number;
  author: string | null;
  extraction_model: string | null;
  pipeline_version: string | null;
  /** `supports` | `contradicts` | `source` | `completion` */
  role: string;
  confidence: number;
}

/**
 * 一条证据本身，不带"在某个对象上扮演什么角色"。
 *
 * 与 `KnowledgeEvidence` 的区别就是少了 `role` / `confidence`——那两个字段属于
 * object↔evidence 绑定，按 id 直接取证据时没有对象上下文，所以不编造。
 */
export interface EvidenceRecord {
  id: string;
  source_type: string;
  source_id: string;
  /** 回到原文的坐标，如 `notes/a.md#L12-L18`。为 null 时只能标为不可定位。 */
  locator: string | null;
  excerpt: string | null;
  checksum: string | null;
  captured_at_ms: number;
  author: string | null;
  extraction_model: string | null;
  pipeline_version: string | null;
}

/**
 * 按 id 批量取证据。返回顺序与传入顺序一致。
 *
 * 取不到的 id 直接不在结果里——不返回占位行，界面才能如实说"这条证据已经不在库里"，
 * 而不是显示一条空白证据让人以为它存在。
 */
export async function getEvidenceByIds(evidenceIds: string[]): Promise<EvidenceRecord[]> {
  if (evidenceIds.length === 0) return [];
  return invoke<EvidenceRecord[]>('knowledge_get_evidence', { evidenceIds });
}

export interface KnowledgeAuditEvent {
  id: string;
  actor: string;
  run_id: string | null;
  session_id: string | null;
  event: string;
  object_id: string | null;
  tool_name: string | null;
  scope: string | null;
  before_version: number | null;
  after_version: number | null;
  result: string;
  metadata_json: string | null;
  created_at_ms: number;
}

export interface KnowledgeIndexHealth {
  schemaVersion: number;
  totalFiles: number;
  indexedDocuments: number;
  blockObjects: number;
  pendingJobs: number;
  failedJobs: number;
  lastError: string | null;
  lastRunAtMs: number | null;
  memoryItems: number;
  memoryInbox: number;
  openChangesets: number;
  openCommitments: number;
}

export interface KnowledgeBackfillProgress {
  processed: number;
  created: number;
  failed: number;
  remaining: number;
  hasMore: boolean;
}

export interface KnowledgeObjectDetail {
  object: KnowledgeObject;
  /** 根在前，含对象自身。 */
  breadcrumb: KnowledgeObject[];
  children: KnowledgeObject[];
  backlinks: KnowledgeRelation[];
  evidence: KnowledgeEvidence[];
}

/** 真实的索引健康计数。每个数字都来自后端的 `COUNT(*)`。 */
export async function getKnowledgeIndexHealth(): Promise<KnowledgeIndexHealth> {
  return invoke<KnowledgeIndexHealth>('knowledge_index_health');
}

/**
 * 推进一批对象化。
 *
 * 有意做成"调一次推一批"：单次调用持锁时间有上界，UI 可以在批与批之间刷新进度，
 * 用户也能中途停下。循环直到 `hasMore` 为 false 即完成。
 */
export async function runKnowledgeBackfill(limit?: number): Promise<KnowledgeBackfillProgress> {
  return invoke<KnowledgeBackfillProgress>('knowledge_run_backfill', { limit });
}

/**
 * 取一个对象的全部可解释信息。
 *
 * 返回 null 表示这篇笔记还没有稳定身份（backfill 未跑到），不是出错。
 */
export async function getKnowledgeObject(
  target: { objectId: string } | { filePath: string },
): Promise<KnowledgeObjectDetail | null> {
  return invoke<KnowledgeObjectDetail | null>('knowledge_get_object', {
    objectId: 'objectId' in target ? target.objectId : undefined,
    filePath: 'filePath' in target ? target.filePath : undefined,
  });
}

export async function getKnowledgeObjectVersions(
  objectId: string,
  limit?: number,
): Promise<KnowledgeObjectVersion[]> {
  return invoke<KnowledgeObjectVersion[]>('knowledge_object_versions', { objectId, limit });
}

/** 某一轮 Agent 或某个对象的审计明细，最新在前。 */
export async function getKnowledgeAuditTrail(
  filter: { runId?: string; objectId?: string; limit?: number },
): Promise<KnowledgeAuditEvent[]> {
  return invoke<KnowledgeAuditEvent[]>('knowledge_audit_trail', {
    runId: filter.runId,
    objectId: filter.objectId,
    limit: filter.limit,
  });
}

// ── 统一收件箱 / the unified inbox ────────────────────────────────────────
//
// 四类"等用户判断的东西"合成一条流。`reason` 和 `actions` 是稳定代码，中英文文案由
// 前端映射——后端返回中文会让英文界面缺一半信息。

export type KnowledgeInboxKind = 'memory' | 'change' | 'task' | 'health';

export interface KnowledgeInboxCounts {
  memory: number;
  changes: number;
  tasks: number;
  health: number;
  total: number;
}

export interface KnowledgeInboxItem {
  /** 原表主键，动作命令用它。 */
  id: string;
  kind: KnowledgeInboxKind;
  title: string;
  /** 一句摘要；变更是操作数，索引故障是失败原因。空串表示没有更多信息。 */
  summary: string;
  /** 原表状态值，给高级详情看的，不作主要文案。 */
  status: string;
  risk: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** 为什么现在需要你处理，稳定代码，见 `inboxReasonText`。 */
  reason: string;
  /** 可用动作的稳定代码。 */
  actions: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * 角标要的那个数。
 *
 * 与 `getKnowledgeIndexHealth` 分开：角标会被轮询，这个命令只有四个 `COUNT(*)`，
 * 不刷新投影健康、不写任何表。
 */
export async function getKnowledgeInboxCounts(): Promise<KnowledgeInboxCounts> {
  return invoke<KnowledgeInboxCounts>('knowledge_inbox_counts');
}

/** 合并后的收件箱，索引故障在最前。 */
export async function getKnowledgeInbox(limit?: number): Promise<KnowledgeInboxItem[]> {
  return invoke<KnowledgeInboxItem[]>('knowledge_inbox', { limit });
}

// ── Memory Inbox ─────────────────────────────────────────────────────────
//
// 候选记忆必须有一个地方让用户看见并裁决。`confirmMemory` 是唯一会写
// `confirmed_by` 的路径——模型不能把自己的推断升级成用户事实。

export type MemoryKind =
  | 'episodic' | 'semantic' | 'profile' | 'procedural' | 'resource' | 'error' | 'task';

export type MemoryLifecycle =
  | 'candidate' | 'verified' | 'active' | 'superseded' | 'expired' | 'archived' | 'forgotten';

export interface MemoryItem {
  id: string;
  /** 背后的 `memory` 对象，证据与关系挂在它上面。 */
  object_id: string | null;
  kind: MemoryKind;
  lifecycle: MemoryLifecycle;
  claim: string;
  scope: string;
  confidence: number;
  importance: number;
  source: KnowledgeSourceRef | null;
  valid_from_ms: number | null;
  valid_to_ms: number | null;
  supersedes_id: string | null;
  conflicts_with_id: string | null;
  /** 只有用户动作会写这一列。 */
  confirmed_by: string | null;
  confirmed_at_ms: number | null;
  requires_user_confirmation: boolean;
  last_accessed_ms: number | null;
  expires_at_ms: number | null;
  /** `memory.md` 的五个 canonical section 之一。 */
  section: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** 一条召回结果，`warnings` 直接可渲染成角标。 */
export interface RecalledMemory {
  item: MemoryItem;
  score: number;
  /** `low_confidence` | `unconfirmed` | `conflicting` | `out_of_scope` */
  warnings: string[];
}

export async function getMemoryInbox(limit?: number): Promise<MemoryItem[]> {
  return invoke<MemoryItem[]>('knowledge_memory_inbox', { limit });
}

export async function confirmMemory(memoryId: string, vaultPath?: string): Promise<MemoryItem> {
  return invoke<MemoryItem>('knowledge_memory_confirm', { memoryId, vaultPath });
}

/** 否掉候选。归档而非删除，所以同一条错误提案不会反复回到 Inbox。 */
export async function rejectMemory(memoryId: string): Promise<MemoryItem> {
  return invoke<MemoryItem>('knowledge_memory_reject', { memoryId });
}

export async function forgetMemory(memoryId: string): Promise<MemoryItem> {
  return invoke<MemoryItem>('knowledge_memory_forget', { memoryId });
}

// ── Memory Center ───────────────────────────────────────────────────────────
//
// Inbox 只回答"有什么等我裁决"。Memory Center 要回答"你到底记住了我什么"——所以它
// 看的是全部生命周期，包括已生效的、被取代的、我否掉过的。

/** 列表筛选。字段全部可省，省略即"不筛"。 */
export interface MemoryListQuery {
  lifecycles?: MemoryLifecycle[];
  kinds?: MemoryKind[];
  scope?: string;
  /** 对 claim 的搜索，与去重同一套归一化（大小写/标点无关）。 */
  search?: string;
  limit?: number;
}

/** 列出记忆（全生命周期）。空数组等于不筛，不是"什么都不要"。 */
export async function listMemories(query?: MemoryListQuery): Promise<MemoryItem[]> {
  return invoke<MemoryItem[]>('knowledge_memory_list', { query });
}

/**
 * 一条记忆的全部来历。
 *
 * `supersededBy` 有值说明这条已经是历史；`evidence` 为空说明它无法对着原文验证，
 * 界面必须如实这么说，而不是留白。
 */
export interface MemoryDetail {
  item: MemoryItem;
  supersedes: MemoryItem | null;
  supersededBy: MemoryItem | null;
  conflictsWith: MemoryItem | null;
  evidence: EvidenceRecord[];
}

export async function getMemoryDetail(memoryId: string): Promise<MemoryDetail | null> {
  return invoke<MemoryDetail | null>('knowledge_memory_detail', { memoryId });
}

/**
 * 改写一条记忆。
 *
 * 后端不原地覆盖，而是新提一条取代旧的——旧说法留在链上可查。所以返回的是**新的**
 * 那一条，id 会变，调用方要刷新列表而不是原地改。
 */
export async function editMemory(memoryId: string, claim: string): Promise<MemoryItem> {
  return invoke<MemoryItem>('knowledge_memory_edit', { memoryId, claim });
}

/**
 * 撤回一次拒绝或遗忘。
 *
 * 回到候选状态，也就是回到收件箱等你裁决——不会替你恢复成"已确认"，因为当初是什么
 * 状态没人存下来。
 */
export async function restoreMemory(memoryId: string): Promise<MemoryItem> {
  return invoke<MemoryItem>('knowledge_memory_restore', { memoryId });
}

/** 一次 `memory.md` 回流的结果。 */
export interface MemoryFileSync {
  /** 文件里新出现、因此被采纳为用户事实的条数。 */
  adopted: number;
  /** 文件里有、库里已经生效的条数。 */
  unchanged: number;
  /** 之前从这个文件采纳过、现在被用户删掉的条数。 */
  forgotten: number;
}

/**
 * 把用户对 `memory.md` 的手工编辑吸收回记忆层。
 *
 * 采纳即已确认——那是用户自己打的字，不该再回收件箱。删除只作用于当初从这个文件
 * 采纳的条目：`memory.md` 是投影，不是记忆的全集。
 */
export async function syncMemoryFile(vaultPath: string): Promise<MemoryFileSync> {
  return invoke<MemoryFileSync>('knowledge_sync_memory_file', { vaultPath });
}

/** 按当前问题召回记忆，用于 Context Inspector 解释"为什么注入了这些"。 */
export async function recallMemories(
  query: string,
  options?: { scope?: string; limit?: number },
): Promise<RecalledMemory[]> {
  return invoke<RecalledMemory[]>('knowledge_memory_recall', {
    query,
    scope: options?.scope,
    limit: options?.limit,
  });
}

// ── ChangeSet ───────────────────────────────────────────────────────────────

/** `proposed` → `previewed`/`conflicted` → `awaiting_approval` → `approved` → `committed`。 */
export type ChangeSetState =
  | 'proposed'
  | 'previewed'
  | 'awaiting_approval'
  | 'approved'
  | 'committed'
  | 'rejected'
  | 'conflicted'
  | 'rolled_back'
  | 'failed';

export interface ChangeSet {
  id: string;
  actor: string;
  session_id: string | null;
  run_id: string | null;
  intent: string | null;
  state: ChangeSetState;
  risk: string;
  requires_approval: boolean;
  dry_run: boolean;
  evidence_ids: string[];
  created_at_ms: number;
  updated_at_ms: number;
  commit_error: string | null;
}

export interface PendingChangeSet {
  id: string;
  actor: string;
  runId: string | null;
  intent: string | null;
  state: ChangeSetState;
  opCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  commitError: string | null;
}

/**
 * 有值就意味着这一步现在不能提交。
 *
 * `version` = 有人先改了（该重新生成），`checksum` = 磁盘内容不是生成这份改动时读到的
 * 那份（该先让用户看），`target_gone` = 目标已被删/改名。三者的处置方式不同，所以
 * UI 不能都渲染成"重试"。
 */
export type ChangeConflict =
  | { kind: 'version'; expected: number; actual: number }
  | { kind: 'stale_read'; readVersion: number; actual: number; readAtMs: number }
  | { kind: 'checksum'; expected: string; actual: string }
  | { kind: 'target_gone'; target: string };

/**
 * 一条边的载荷 / the payload of one relation operation.
 *
 * 关系操作（`add_relation` / `delete_relation`）没有"正文"，所以不能当文本 diff 渲染。
 * 后端把两端、关系类型、置信度和来源结构化地给出来，UI 直接读字段——从 `after` 那行
 * 摘要里反解析"从哪指向哪"迟早解析错。
 */
export interface ChangeRelationOp {
  sourcePath: string;
  targetPath: string;
  relationType: string;
  confidence: number;
  reason: string | null;
  /** `user_link`（用户自己连的）/ `agent_proposed` / `semantic` / `external`。 */
  origin: string;
  /** 改之前的置信度。删除或改置信度时才有值。 */
  oldConfidence: number | null;
  oldReason: string | null;
}

export interface ChangeOpPreview {
  opId: string;
  seq: number;
  opKind:
    | 'create'
    | 'edit'
    | 'patch'
    | 'append'
    | 'rename'
    | 'move'
    | 'delete'
    | 'merge'
    | 'add_relation'
    | 'delete_relation';
  targetObjectId: string | null;
  path: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
  evidenceIds: string[];
  affectedObjects: string[];
  conflict: ChangeConflict | null;
  /** 冲突的人话版本。措辞由后端给，前端不再自己拼一套。 */
  conflictMessage: string | null;
  /** 只有关系操作会有。见 {@link ChangeRelationOp}。 */
  relation: ChangeRelationOp | null;
}

export interface ChangeSetDryRun {
  changesetId: string;
  ops: ChangeOpPreview[];
  hasConflicts: boolean;
  touchedPaths: string[];
}

/** 还没落地的批次（不含 committed / rejected / rolled_back）。 */
export async function getPendingChangeSets(limit?: number): Promise<PendingChangeSet[]> {
  return invoke<PendingChangeSet[]>('knowledge_pending_changesets', { limit });
}

/** 已经落地的批次：committed / rejected / rolled_back / failed。 */
export async function getChangeSetHistory(limit?: number): Promise<PendingChangeSet[]> {
  return invoke<PendingChangeSet[]>('knowledge_changeset_history', { limit });
}

export interface ChangeOpDetail extends ChangeOpPreview {
  /** 改名/移动之后的路径。 */
  newPath: string | null;
  /**
   * `before` 是哪来的：`recorded_version`（提交时记下的上一版）、`current_index`
   * （索引里的当前内容）、`none`（两处都没有）。文案由这个代码查，不在前端另猜一套。
   */
  beforeSource: 'recorded_version' | 'current_index' | 'none';
}

export interface ChangeSetDetail {
  changeset: ChangeSet;
  ops: ChangeOpDetail[];
  /** journal 里属于这一轮、还没撤销的写入条数。0 = 撤销按钮按下去不会有任何效果。 */
  undoableEntries: number;
  /** journal 里属于这一轮的写入总数。0 = 这一轮压根没有可回滚的记录。 */
  journalEntries: number;
}

/**
 * 读一个批次的明细。
 *
 * 与 {@link previewChangeSet} 的区别是**它不改状态**：预演会把批次推到
 * `previewed`/`conflicted`，所以那个只能用在还没落地的批次上。回看历史用这个。
 */
export async function getChangeSetDetail(changesetId: string): Promise<ChangeSetDetail | null> {
  return invoke<ChangeSetDetail | null>('knowledge_changeset_detail', { changesetId });
}

/** 预演一个批次。只读，但会把状态推到 `previewed` 或 `conflicted`。 */
export async function previewChangeSet(changesetId: string): Promise<ChangeSetDryRun> {
  return invoke<ChangeSetDryRun>('knowledge_preview_changeset', { changesetId });
}

/** 记录用户裁决。只改状态，真实写回由 Agent 的工具路径完成。 */
export async function decideChangeSet(
  changesetId: string,
  approved: boolean,
): Promise<ChangeSet> {
  return invoke<ChangeSet>('knowledge_decide_changeset', { changesetId, approved });
}

// ── Context Inspector ───────────────────────────────────────────────────────
//
// `context_package_ready` 事件的载荷。它来自后端 `ContextPackage::inspector_summary()`,
// 与真正进 prompt 的那份是同一个结构体——所以界面上显示的召回结果就是模型看到的，
// 不存在"UI 说召回了 A、实际给模型的是 B"。
//
// 刻意不含正文：摘要只带 title / locator / score / why / warnings。正文要看就点进
// 原文，不通过 IPC 和日志再抄一遍。

export interface ContextInspectorItem {
  objectId: string | null;
  kind: string;
  /**
   * 它是哪个桶召回的：`current` | `fact` | `memory` | `task` | `related` | `conflict`。
   * 分组标题由这个字段决定，前端不按 `kind` 猜。
   */
  section: string;
  title: string;
  locator: string | null;
  score: number;
  /** 为什么它被召回：`lexical`、`vector`、`current_file`、`memory_recall`… */
  why: string[];
  /** `stale`、`low_confidence`、`unconfirmed`、`conflicting`、`out_of_scope`… */
  warnings: string[];
  /** 支撑它的证据 id。只有 id，正文要看得去 `getEvidenceByIds`。 */
  evidenceIds: string[];
}

export interface ContextPackageSummary {
  query: string;
  intent: string;
  scope: string[];
  counts: {
    facts: number;
    memories: number;
    openTasks: number;
    related: number;
    conflicts: number;
  };
  items: ContextInspectorItem[];
  knowledgeGaps: string[];
  warnings: string[];
  budget: {
    maxTokens: number;
    usedTokens: number;
    /** 被裁掉的候选数。为 0 才说明全都装下了。 */
    truncatedCandidates: number;
  };
}

// ── 承诺 / Commitments ──────────────────────────────────────────────────────
export type CommitmentStatus =
  | 'proposed'
  | 'active'
  | 'done'
  | 'snoozed'
  | 'dismissed'
  | 'expired';

/** 一条承诺 / open loop。`source` 指回它是从哪儿被提取出来的。 */
export interface TaskCommitment {
  id: string;
  object_id: string | null;
  commitment_type: string;
  title: string;
  source: { source_type: string; source_id: string } | null;
  evidence_ids: string[];
  owner: string | null;
  status: CommitmentStatus;
  priority: number;
  due_at_ms: number | null;
  remind_at_ms: number | null;
  dedupe_key: string;
  proactive_enabled: boolean;
  last_notified_at_ms: number | null;
  notify_count: number;
  completion_evidence_id: string | null;
  return_target: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** 被闸门挡住的原因。`null` = 这一轮允许露面。 */
export type SilencedReason = 'disabled' | 'quiet_hours' | 'daily_cap' | 'too_soon';

export interface ProactiveDigest {
  items: TaskCommitment[];
  silenced: SilencedReason | null;
  /** 刚刚转成 expired 的条数。 */
  expired: number;
}

export interface CommitmentScan {
  found: number;
  created: number;
}

/** 等用户处理的承诺。 */
export async function getCommitmentInbox(limit?: number): Promise<TaskCommitment[]> {
  return invoke<TaskCommitment[]>('knowledge_commitment_inbox', { limit });
}

/** 任务台的筛选条件。全部留空 = 最近 200 条，按优先级与到期排。 */
export interface CommitmentListQuery {
  statuses?: CommitmentStatus[];
  /** 到期时间早于这个时刻。没有到期日的条目不会被它选中。 */
  dueBeforeMs?: number;
  dueAfterMs?: number;
  /** 只要没写到期日的。与 `dueBeforeMs`/`dueAfterMs` 互斥使用才有意义。 */
  undatedOnly?: boolean;
  /** 标题子串，大小写不敏感，中文可用。 */
  search?: string;
  limit?: number;
}

/**
 * 按条件列任务。
 *
 * 与 {@link getCommitmentInbox} 分开：收件箱回答"现在有什么等我"，这个回答"某一类
 * 任务现在是什么情况"——包括已完成和被推迟的。
 */
export async function getCommitmentList(
  query?: CommitmentListQuery
): Promise<TaskCommitment[]> {
  return invoke<TaskCommitment[]>('knowledge_commitment_list', { query });
}

/**
 * 处理一条承诺。
 *
 * `complete` 必须带 `resultSummary`：后端会把它登记成完成证据并绑回源对象。
 * 没有摘要的"完成"会被拒——只把状态改成 done 不算闭环。
 */
export async function decideCommitment(decision: {
  commitmentId: string;
  action: 'activate' | 'dismiss' | 'snooze' | 'complete';
  untilMs?: number;
  resultSummary?: string;
}): Promise<TaskCommitment> {
  return invoke<TaskCommitment>('knowledge_decide_commitment', { decision });
}

/**
 * 这一轮允许露面的提醒。
 *
 * 拿到 `items` 之后真的展示了，就要调 {@link markCommitmentNotified}，否则日上限
 * 与最小间隔永远不会推进，克制机制形同虚设。
 */
export async function getProactiveDigest(limit?: number): Promise<ProactiveDigest> {
  return invoke<ProactiveDigest>('knowledge_proactive_digest', { limit });
}

/** 记下"这条提醒真的展示过了"。 */
export async function markCommitmentNotified(commitmentId: string): Promise<void> {
  return invoke<void>('knowledge_mark_notified', { commitmentId });
}

/** 扫一遍笔记里的带日期未打勾待办，扫出来一律进 proposed。 */
export async function scanCommitments(limit?: number): Promise<CommitmentScan> {
  return invoke<CommitmentScan>('knowledge_scan_commitments', { limit });
}



