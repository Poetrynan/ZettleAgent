import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getEmbedding } from './embeddings';

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
      
      let apiKey = '';
      try {
        const llmRaw = localStorage.getItem('zettelagent-llm');
        if (llmRaw) {
          const llmCfg = JSON.parse(llmRaw);
          if (llmCfg && llmCfg.apiKey) {
            apiKey = llmCfg.apiKey;
          }
        }
      } catch {}

      const response = await withPromiseTimeout(
        fetch(config.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            input: [queryText],
            model: config.model,
          }),
        }),
        EMBEDDING_QUERY_TIMEOUT_MS,
        'Custom embedding API',
      );
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Custom embedding API error (${response.status}): ${errText}`);
      }
      const data = await response.json();
      if (data && data.data && Array.isArray(data.data) && data.data[0]) {
        return data.data[0].embedding;
      }
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
  const effectiveMode = await resolveRagSearchMode(query.mode);
  const queryEmbedding = ragNeedsQueryEmbedding(effectiveMode)
    ? await getEmbeddingForSearch(query.query, effectiveMode)
    : undefined;
  const finalMode: SearchMode =
    ragNeedsQueryEmbedding(effectiveMode) && !queryEmbedding && !query.queryEmbedding
      ? 'fts'
      : effectiveMode;
  const enrichedQuery = {
    ...query,
    mode: finalMode,
    queryEmbedding: queryEmbedding || query.queryEmbedding,
  };
  return invoke('search_chunks', { query: enrichedQuery });
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

/** Add a note relation from the knowledge graph view */
export async function addNoteRelation(
  sourcePath: string,
  targetPath: string,
  relationType: string,
  reason?: string,
): Promise<void> {
  return invoke('add_note_relation', { sourcePath, targetPath, relationType, reason });
}

/** Remove a note relation from the knowledge graph view */
export async function deleteNoteRelation(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  return invoke('delete_note_relation', { sourcePath, targetPath });
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
): Promise<void> {
  return invoke('add_canvas_relation', { sourcePath, targetPath, relationType });
}

export async function deleteCanvasRelation(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  return invoke('delete_canvas_relation', { sourcePath, targetPath });
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
}

/** Structured diff data from the backend for the approval card */
export interface ApprovalDiffData {
  tool_name: string;
  file_path: string;
  file_path_alt?: string;
  diff_type: string;
  tool_args_json: string;
  title: string;
}

export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface AgentEvent {
type: 'thinking' | 'tool_start' | 'tool_progress' | 'tool_result' | 'tool_call_detected' | 'text_delta' | 'done' | 'role_selected' | 'pipeline_progress' | 'approval_required' | 'approval_resolved' | 'stage' | 'clear_text' | 'plan_update' | 'intent_classified';
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
}

export async function agentChat(request: AgentChatRequest): Promise<string> {
  return invoke('agent_chat', { request });
}

export async function cancelAgentTurn(): Promise<boolean> {
  return invoke('cancel_agent_turn');
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


