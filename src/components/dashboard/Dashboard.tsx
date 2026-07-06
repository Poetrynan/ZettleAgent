import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { listMarkdownFiles, syncVault, getSchedulerStatus, stopScheduler, runSchedulerNow, SchedulerStatus, getEmbeddingStats, EmbeddingStats, getUnindexedChunks, saveChunkEmbeddings, finalizeEmbeddingIndex, getKnowledgeGraph } from '../../lib/tauri';
import { getEmbeddingsBatch } from '../../lib/embeddings';
import { getSmartOrganizeConfig, setBackgroundOrganizeEnabled } from '../settings/Settings';
import { isLlmConfigured, startBackgroundOrganize } from '../../lib/backgroundOrganize';
import { t } from '../../lib/i18n';
import { IconNote, IconSync, IconDatabase, IconBrain, IconDownload, IconWarning, IconLink } from '../icons';
import { CanvasExport } from '../canvas/CanvasExport';
import { LintModal } from './LintModal';
import { QuickActionsHelp } from './QuickActionsHelp';
import { ProgressPanel } from './ProgressPanel';
import { ConfirmModal } from './ConfirmModal';

import { KnowledgeGapAnalysis } from './KnowledgeGapAnalysis';
import { GlobalTimeline } from '../temporal/GlobalTimeline';
import { AgentAutoOrganizeCard } from './AgentAutoOrganizeCard';

export function Dashboard() {
  const { state, setIsSyncing, setSchedulerLoading, showToast, setSchedulerProgress } = useApp();
  const { schedulerLoading, schedulerProgress, schedulerProgressInfo } = state;
  const [fileCount, setFileCount] = useState(0);
  const [graphLinkCount, setGraphLinkCount] = useState<number | null>(null);
  const [showCanvasExport, setShowCanvasExport] = useState(false);
  const [showLintModal, setShowLintModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [schedulerStarting, setSchedulerStarting] = useState(false);
  const [embeddingStats, setEmbeddingStats] = useState<EmbeddingStats | null>(null);
  const [embeddingBuilding, setEmbeddingBuilding] = useState(false);
  const [buildStage, setBuildStage] = useState('');
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false);
  const cancelRef = useRef(false);

  // Extracted embedding build logic into a reusable callback
  const runEmbeddingBuild = useCallback(async () => {
    setEmbeddingBuilding(true);
    setBuildStage(state.lang === 'zh' ? '正在初始化向量模块...' : 'Initializing embedding module...');
    cancelRef.current = false;
    
    try {
      let totalProcessed = 0;
      let hasMore = true;
      const batchSize = 16;

      // 加载配置
      let embedConfig = { mode: 'local', apiUrl: '', model: '', dimensions: 1536 };
      try {
        const raw = localStorage.getItem('zettelagent:embedding_config');
        if (raw) embedConfig = JSON.parse(raw);
      } catch {}

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

      // Yield to the event loop so the UI stays responsive
      const yieldToUI = () => new Promise<void>(r => setTimeout(r, 50));

      while (hasMore) {
        if (cancelRef.current) {
          showToast(
            state.lang === 'zh' ? '构建任务已被用户中止' : 'Build task was cancelled by user',
            'info'
          );
          break;
        }

        // 1. 获取未索引的分块
        setBuildStage(state.lang === 'zh' ? '正在读取未索引的笔记分块...' : 'Reading unindexed note chunks...');
        const chunks = await getUnindexedChunks(batchSize);
        if (chunks.length === 0) {
          hasMore = false;
          break;
        }

        const contents = chunks.map(([_, content]) => content);
        let embeddings: number[][];

        if (embedConfig.mode === 'local') {
          setBuildStage(state.lang === 'zh' 
            ? `正在通过本地线程计算向量 (本组分块: ${contents.length})...`
            : `Computing vectors in background thread (batch chunks: ${contents.length})...`
          );
          embeddings = await getEmbeddingsBatch(contents, 'document');
        } else {
          setBuildStage(state.lang === 'zh' 
            ? `正在通过 API 请求计算向量 (本组分块: ${contents.length})...`
            : `Requesting vectors via API (batch chunks: ${contents.length})...`
          );
          if (!embedConfig.apiUrl || !embedConfig.model) {
            throw new Error(state.lang === 'zh' ? 'Embedding API 配置不完整' : 'Incomplete Embedding API configuration');
          }
          const response = await fetch(embedConfig.apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              input: contents,
              model: embedConfig.model,
            }),
          });
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error (${response.status}): ${errText}`);
          }
          const data = await response.json();
          if (!data.data || !Array.isArray(data.data)) {
            throw new Error(state.lang === 'zh' ? 'API 返回格式不正确' : 'Invalid API response format');
          }
          const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
          embeddings = sorted.map((item: any) => item.embedding);
        }

        if (cancelRef.current) {
          showToast(
            state.lang === 'zh' ? '构建任务已被用户中止' : 'Build task was cancelled by user',
            'info'
          );
          break;
        }

        // 3. 保存到 Rust SQLite
        setBuildStage(state.lang === 'zh' ? '正在将生成的向量存入本地数据库...' : 'Saving generated vectors to local database...');
        const payload: [number, number[]][] = chunks.map(([id, _], index) => [id, embeddings[index]]);
        await saveChunkEmbeddings(payload);

        totalProcessed += chunks.length;

        // 更新 Dashboard 的 Embedding Stats
        const newStats = await getEmbeddingStats();
        setEmbeddingStats(newStats);

        // Yield to let UI process events (scroll, click, paint)
        await yieldToUI();
      }

      if (!cancelRef.current) {
        setBuildStage(state.lang === 'zh' ? '正在重建语义图关系与索引缓存...' : 'Rebuilding semantic graph relationships and index cache...');
        await finalizeEmbeddingIndex();

        showToast(
          state.lang === 'zh'
            ? `已成功索引 ${totalProcessed} 个分块`
            : `Successfully indexed ${totalProcessed} chunks`,
          'success'
        );
      }

      const finalStats = await getEmbeddingStats();
      setEmbeddingStats(finalStats);
    } catch (e: any) {
      showToast(
        state.lang === 'zh'
          ? `构建失败: ${e.message || e}`
          : `Build failed: ${e.message || e}`,
        'error'
      );
    }
    setEmbeddingBuilding(false);
  }, [state.lang, showToast]);

  const schedulerRef = useRef<string>('');

  const resolveVaultPaths = useCallback((): string[] => {
    if (state.vaultPaths && state.vaultPaths.length > 0) return state.vaultPaths;
    if (state.vaultPath) return [state.vaultPath];
    return [];
  }, [state.vaultPaths, state.vaultPath]);

  const triggerOrganize = useCallback(async (force: boolean) => {
    if (!isLlmConfigured(state.llmConfig)) {
      showToast(
        state.lang === 'zh'
          ? '⚠️ 请先在「设置 → 模型配置」中配置 LLM API 地址和模型名称'
          : '⚠️ Please configure LLM API endpoint and model in Settings → Model Configuration first',
        'error'
      );
      return;
    }
    setSchedulerLoading(true);
    try {
      const orgConfig = getSmartOrganizeConfig();
      const vaultPaths = resolveVaultPaths();
      for (const vp of vaultPaths) {
        await syncVault(vp);
      }
      let dailyPath: string | undefined;
      if (!orgConfig.includeJournals) {
        const { getDailyFolderPath } = await import('../../lib/dailyNote');
        dailyPath = await getDailyFolderPath();
      }
      const result = await runSchedulerNow(
        state.llmConfig.apiUrl,
        state.llmConfig.apiKey || undefined,
        state.llmConfig.model,
        state.llmConfig.providerId,
        state.methodology,
        undefined,
        orgConfig.batchSize,
        orgConfig.searchResultCount,
        orgConfig.contentTruncationLimit,
        orgConfig.includeJournals,
        dailyPath,
        force,
        orgConfig.minNoteLength,
      );
      setSchedulerStatus(result);
      showToast(
        t('dashboard.reconcileSuccess')
          .replace('{p}', String(result.notes_processed))
          .replace('{n}', String(result.notes_reconciled)),
        'success'
      );
    } catch (e) {
      showToast(t('dashboard.reconcileFail') + ': ' + e, 'error');
    } finally {
      setSchedulerLoading(false);
    }
  }, [state.llmConfig, state.lang, state.methodology, resolveVaultPaths, setSchedulerLoading, showToast]);

  const loadSchedulerStatus = useCallback(async () => {
    try {
      const s = await getSchedulerStatus();
      const key = JSON.stringify(s);
      if (key !== schedulerRef.current) {
        schedulerRef.current = key;
        setSchedulerStatus(s);
      }
    } catch (e) {
      console.error('[Dashboard] Failed to load scheduler status:', e);
    }
  }, []);

  const loadData = useCallback(async () => {
    // Sum file counts across all vault paths
    const paths = state.vaultPaths && state.vaultPaths.length > 0 ? state.vaultPaths : (state.vaultPath ? [state.vaultPath] : []);
    if (paths.length > 0) {
      try {
        let total = 0;
        for (const vp of paths) {
          const files = await listMarkdownFiles(vp);
          total += files.length;
        }
        setFileCount(total);
      } catch (e) {
        console.error('[Dashboard] Failed to list markdown files:', e);
      }
    } else {
      setFileCount(0);
    }

    if (state.vaultPath) {
      try {
        const graph = await getKnowledgeGraph(state.vaultPath);
        setGraphLinkCount(graph.edges.length);
      } catch (e) {
        console.error('[Dashboard] Failed to load graph stats:', e);
        setGraphLinkCount(null);
      }
    } else {
      setGraphLinkCount(null);
    }
    loadSchedulerStatus();
    // Load embedding stats
    getEmbeddingStats().then(setEmbeddingStats).catch(() => {});
  }, [state.vaultPaths, state.vaultPath, loadSchedulerStatus]);

  useEffect(() => {
    if (state.view !== 'dashboard') return;
    loadData();
    const pollMs = schedulerStatus?.running ? 5000 : 15000;
    const iv = setInterval(loadSchedulerStatus, pollMs);
    return () => clearInterval(iv);
  }, [state.view, loadData, loadSchedulerStatus, schedulerStatus?.running]);

  // handleSync: reserved for future sync button in Dashboard

  return (
    <div className="panel">
      <div className="panel-content">
        {/* Welcome Banner — gradient background with radial glow */}
        <div className="dashboard-welcome animate-enter">
          <h1>
            {t('dashboard.welcome')}{' '}
            <span className="logo-wordmark" style={{ fontSize: 'inherit' }}>
              <span className="logo-zettel">Zettel</span>
              <span className="logo-lambda-wrap"><span className="logo-agent-lambda">Λ</span></span>
              <span className="logo-agent-rest">gent</span>
            </span>
          </h1>
          <p>{t('app.tagline')}</p>
        </div>

        {/* Stat Tiles — vault overview (detail metrics live in pipeline / agent cards below) */}
        <div className="animate-enter animate-enter-delay-1 dashboard-stat-grid">
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent-primary)' }}>
              <IconNote size={20} />
            </div>
            <div className="stat-card-value">{fileCount}</div>
            <div className="stat-card-label">{t('dashboard.totalNotes')}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-icon" style={{ background: state.vaultPath ? 'rgba(16, 185, 129, 0.1)' : 'rgba(120, 120, 128, 0.08)', color: state.vaultPath ? 'var(--success)' : 'var(--text-tertiary)' }}>
              <IconDatabase size={20} />
            </div>
            <div className="stat-card-value stat-card-value--compact">{state.vaultPath ? t('dashboard.connected') : t('dashboard.none')}</div>
            <div className="stat-card-label">{t('dashboard.vault')}</div>
          </div>
          <div className="stat-card">
            <div
              className="stat-card-icon"
              style={{
                background: graphLinkCount !== null ? 'rgba(59, 130, 246, 0.1)' : 'rgba(120, 120, 128, 0.08)',
                color: graphLinkCount !== null ? 'var(--accent-secondary)' : 'var(--text-tertiary)',
              }}
            >
              <IconLink size={20} />
            </div>
            <div className="stat-card-value">
              {graphLinkCount !== null ? graphLinkCount : '—'}
            </div>
            <div className="stat-card-label">{t('dashboard.graphLinks')}</div>
          </div>
        </div>

        <div className="animate-enter animate-enter-delay-2" style={{ marginBottom: 'var(--space-6)' }}>
          {/* ── Quick Actions ── */}
          <div className="dash-section-header">
            <h2 className="dash-section-title">{t('dashboard.quickActions')}</h2>
            <button
              className="btn btn-ghost btn-icon-sm"
              onClick={() => setShowHelpModal(true)}
              title={t('dashboard.quickActions')}
              style={{
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                border: '1px solid var(--border)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10px',
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                padding: 0,
                lineHeight: 1,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              ?
            </button>
          </div>
          <div style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'stretch',
          }}>
            {/* Tool 1: Export Knowledge Graph */}
            <div className="step-card step-card--export">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="step-badge step-badge--export">①</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {state.lang === 'zh' ? '导出知识图谱' : 'Export Knowledge Graph'}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                {state.lang === 'zh'
                  ? '将知识图谱导出为 Obsidian Canvas 格式，支持力导向、环形、网格、层级 4 种布局算法。'
                  : 'Export knowledge graph to Obsidian Canvas format with 4 layout algorithms: Force-Directed, Circular, Grid, Hierarchical.'}
              </div>
              <button
                className="btn btn-sm"
                style={{
                  alignSelf: 'flex-start',
                  fontSize: 'var(--text-xs)',
                  marginTop: 'var(--space-1)',
                  fontWeight: 600,
                  gap: 6,
                  borderRadius: 'var(--radius-md)',
                  padding: '6px 14px',
                }}
                disabled={!state.vaultPath || fileCount === 0}
                title={!state.vaultPath ? t('dashboard.tipNoVault') : fileCount === 0 ? t('dashboard.tipNoNotes') : undefined}
                onClick={() => setShowCanvasExport(true)}
              >
                <IconDownload size={13} /> {state.lang === 'zh' ? '导出 Canvas' : 'Export Canvas'}
              </button>
            </div>

            {/* Tool 2: Health Check */}
            <div className="step-card step-card--health">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="step-badge step-badge--health">②</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {state.lang === 'zh' ? '健康检查' : 'Health Check'}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                {state.lang === 'zh'
                  ? '扫描知识库：检测失效 Wikilink、孤立笔记、缺失 AI 标记、图谱连通性和 Hub 过载。'
                  : 'Scan vault: detect broken wikilinks, orphan notes, missing AI markers, graph connectivity and hub overload.'}
              </div>
              <button
                className="btn btn-sm"
                style={{
                  alignSelf: 'flex-start',
                  fontSize: 'var(--text-xs)',
                  marginTop: 'var(--space-1)',
                  fontWeight: 600,
                  gap: 6,
                  borderRadius: 'var(--radius-md)',
                  padding: '6px 14px',
                }}
                disabled={!state.vaultPath}
                title={!state.vaultPath ? t('dashboard.tipNoVault') : undefined}
                onClick={() => setShowLintModal(true)}
              >
                <IconWarning size={13} /> {state.lang === 'zh' ? '运行检查' : 'Run Check'}
              </button>
            </div>
          </div>

          {/* ── Pipeline ── */}
          <div className="dash-section-header" style={{ marginTop: 'var(--space-5)' }}>
            <h2 className="dash-section-title">{state.lang === 'zh' ? '数据流水线' : 'Data Pipeline'}</h2>
          </div>
          <div style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'stretch',
          }}>
            {/* Step 1: Sync Knowledge Base */}
            <div className="step-card step-card--sync">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="step-badge step-badge--sync">①</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {state.lang === 'zh' ? '同步知识库' : 'Sync Knowledge Base'}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                {state.lang === 'zh'
                  ? '扫描文件夹中的 Markdown 文件，将内容同步到数据库并清理已删除文件的记录。'
                  : 'Scan folder for Markdown files, sync content to database and clean up records of deleted files.'}
              </div>
              <button
                className="btn btn-sm"
                style={{
                  alignSelf: 'flex-start',
                  fontSize: 'var(--text-xs)',
                  marginTop: 'var(--space-1)',
                  fontWeight: 600,
                  gap: 6,
                  borderRadius: 'var(--radius-md)',
                  padding: '6px 14px',
                }}
                disabled={!state.vaultPath || state.isSyncing}
                title={!state.vaultPath ? t('dashboard.tipNoVault') : undefined}
                onClick={async () => {
                  if (!state.vaultPaths || state.vaultPaths.length === 0) return;
                  setIsSyncing(true);
                  try {
                    let totalUpdated = 0, totalRemoved = 0, totalFiles = 0;
                    for (const vp of state.vaultPaths) {
                      const result = await syncVault(vp);
                      totalUpdated += result.files_updated;
                      totalRemoved += result.files_removed;
                      totalFiles += result.total_files;
                    }
                    showToast(
                      state.lang === 'zh'
                        ? `同步完成：${totalUpdated} 更新，${totalRemoved} 清理，共 ${totalFiles} 文件`
                        : `Synced: ${totalUpdated} updated, ${totalRemoved} removed, ${totalFiles} total`,
                      'success'
                    );
                    loadData();
                  } catch (e) {
                    showToast(
                      (state.lang === 'zh' ? '同步失败: ' : 'Sync failed: ') + e,
                      'error'
                    );
                  } finally {
                    setIsSyncing(false);
                  }
                }}
              >
                {state.isSyncing
                  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> {state.lang === 'zh' ? '同步中...' : 'Syncing...'}</>
                  : <><IconSync size={13} /> {state.lang === 'zh' ? '同步' : 'Sync'}</>}
              </button>
            </div>

            {/* Arrow */}
            <div className="step-arrow">→</div>

            {/* Step 2: Build Index */}
            <div className="step-card step-card--index">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="step-badge step-badge--index">②</span>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {state.lang === 'zh' ? '构建向量索引' : 'Build Vector Index'}
                  </span>
                </div>
                {embeddingStats && (
                  <span style={{
                    fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)',
                  }}>
                    {embeddingStats.indexed_chunks}/{embeddingStats.total_chunks}
                    {embeddingStats.total_chunks > 0 && ` (${Math.round((embeddingStats.indexed_chunks / embeddingStats.total_chunks) * 100)}%)`}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                {state.lang === 'zh'
                  ? '用本地 Embedding 模型为所有笔记生成语义向量。启用语义搜索、RAG 聊天、语义边。'
                  : 'Generate semantic vectors for all notes using local Embedding model. Enables semantic search, RAG chat, semantic edges.'}
              </div>
              {/* Mini progress bar */}
              {embeddingStats && embeddingStats.total_chunks > 0 && (
                <div className="dash-embed-progress-track">
                  <div
                    className={`dash-embed-progress-fill ${embeddingStats.indexed_chunks === embeddingStats.total_chunks ? 'dash-embed-progress-fill--done' : 'dash-embed-progress-fill--active'}`}
                    style={{ width: `${(embeddingStats.indexed_chunks / embeddingStats.total_chunks) * 100}%` }}
                  />
                </div>
              )}
              <button
                className={`btn btn-sm ${embeddingBuilding ? 'btn-secondary' : 'btn-primary'}`}
                disabled={embeddingBuilding || !state.vaultPath}
                style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' }}
                onClick={() => {
                  // Only show confirmation modal when index is 100% complete (rebuild from scratch)
                  if (embeddingStats && embeddingStats.total_chunks > 0 && embeddingStats.indexed_chunks === embeddingStats.total_chunks) {
                    setShowRebuildConfirm(true);
                    return;
                  }
                  // Index not complete → continue incrementally without modal
                  runEmbeddingBuild();
                }}
              >
                {embeddingBuilding
                  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> {state.lang === 'zh' ? '构建中...' : 'Building...'}</>
                  : <><IconDatabase size={13} /> {state.lang === 'zh' ? '构建 / 刷新索引' : 'Build / Refresh Index'}</>}
              </button>
            </div>

            {/* Arrow */}
            <div className="step-arrow">→</div>

            {/* Step 3: Smart Organize */}
            <div className="step-card step-card--organize">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="step-badge step-badge--organize">③</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {state.lang === 'zh' ? '智能整理' : 'Smart Organize'}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                {state.lang === 'zh'
                  ? 'LLM 分析每篇笔记内容，生成分类、标签、关系类型和 confidence。构建知识图谱的关系边。'
                  : 'LLM analyzes each note to generate classification, tags, relation types and confidence. Builds knowledge graph relation edges.'}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-quaternary, var(--text-tertiary))', fontStyle: 'italic' }}>
                {state.lang === 'zh' ? '💡 先构建索引，整理效果更好' : '💡 Build index first for better results'}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-1)' }}>
                <button
                  className="btn btn-sm btn-organize"
                  style={{
                    fontWeight: 600,
                    fontSize: 'var(--text-xs)',
                    gap: 6,
                    borderRadius: 'var(--radius-md)',
                    padding: '6px 14px',
                  }}
                  disabled={!state.vaultPath || schedulerLoading}
                  title={!state.vaultPath ? t('dashboard.tipNoVault') : schedulerLoading ? t('dashboard.tipProcessing') : undefined}
                  aria-label={schedulerLoading ? 'AI organizing notes' : t('dashboard.runNow')}
                  onClick={() => triggerOrganize(true)}
                >
                  {schedulerLoading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <IconBrain size={13} />}
                  {schedulerLoading ? t('dashboard.processing') : t('dashboard.runNow')}
                </button>
              </div>
            </div>
          </div>

        {/* Indexing Progress Panel */}
        {embeddingBuilding && embeddingStats && (
          <ProgressPanel
            title={state.lang === 'zh' ? '构建语义向量索引' : 'Building Vector Index'}
            current={embeddingStats.indexed_chunks}
            total={embeddingStats.total_chunks}
            stage={buildStage}
            stageIcon={<IconDatabase size={11} />}
            cancelLabel={state.lang === 'zh' ? '中止' : 'Cancel'}
            variant="organize"
            hasSpacing
            onCancel={() => {
              cancelRef.current = true;
              setBuildStage(state.lang === 'zh' ? '正在中止任务...' : 'Cancelling task...');
            }}
          />
        )}

          {/* Smart Organize Progress Panel */}
          {schedulerProgressInfo && (
            <ProgressPanel
              title={schedulerProgress || t('dashboard.processing')}
              current={schedulerProgressInfo.current}
              total={schedulerProgressInfo.total}
              stage={schedulerProgressInfo?.message || schedulerProgressInfo?.filename || (state.lang === 'zh' ? '正在准备任务...' : 'Preparing tasks...')}
              stageIcon={<IconNote size={11} />}
              cancelLabel={t('scheduler.stopOrganize')}
              variant="primary"
              indeterminate={!schedulerProgressInfo || schedulerProgressInfo.total === 0}
              hasSpacing
              onCancel={() => {
                setSchedulerProgress(t('scheduler.stopping'));
                stopScheduler()
                  .then(() => showToast(t('scheduler.aborted'), 'info'))
                  .catch((err) => showToast(t('common.error') + ': ' + err, 'error'));
              }}
            />
          )}
        </div>

        <hr className="dash-divider" />

        <AgentAutoOrganizeCard
          status={schedulerStatus}
          starting={schedulerStarting}
          vaultReady={!!state.vaultPath}
          intervalSecs={getSmartOrganizeConfig().intervalSecs}
          isZh={state.lang === 'zh'}
          onStart={async () => {
            if (!isLlmConfigured(state.llmConfig)) {
              showToast(
                state.lang === 'zh'
                  ? '⚠️ 请先在「设置 → 模型配置」中配置 LLM API 地址和模型名称'
                  : '⚠️ Please configure LLM API endpoint and model in Settings → Model Configuration first',
                'error',
              );
              return;
            }
            setSchedulerStarting(true);
            try {
              await startBackgroundOrganize({
                vaultPaths: resolveVaultPaths(),
                llmConfig: state.llmConfig,
                methodology: state.methodology,
              });
              await loadSchedulerStatus();
              showToast(t('dashboard.startedToast'), 'success');
            } catch (e) {
              console.error('[Dashboard] Failed to start scheduler:', e);
              showToast(t('common.error') + ': ' + e, 'error');
            } finally {
              setSchedulerStarting(false);
            }
          }}
          onStop={async () => {
            try {
              await stopScheduler();
              setBackgroundOrganizeEnabled(false);
              await loadSchedulerStatus();
              showToast(t('dashboard.stoppedBgToast'), 'info');
            } catch (e) {
              console.error('[Dashboard] Failed to stop scheduler:', e);
              showToast(t('common.error') + ': ' + e, 'error');
            }
          }}
        />

        {/* Knowledge Evolution Timeline */}
        <GlobalTimeline />

        {/* Knowledge Gap Analysis */}
        <KnowledgeGapAnalysis />
      </div>

      {/* Canvas Export Modal */}
      <CanvasExport 
        isOpen={showCanvasExport} 
        onClose={() => setShowCanvasExport(false)} 
      />

      {/* Lint Check Modal */}
      <LintModal 
        isOpen={showLintModal} 
        onClose={() => setShowLintModal(false)} 
      />
      {/* Quick Actions Help Modal */}
      <QuickActionsHelp
        isOpen={showHelpModal}
        onClose={() => setShowHelpModal(false)}
      />

      {/* Rebuild Index Confirmation Modal */}
      <ConfirmModal
        isOpen={showRebuildConfirm}
        title={state.lang === 'zh' ? '重新构建向量索引' : 'Rebuild Vector Index'}
        message={
          embeddingStats && embeddingStats.indexed_chunks === embeddingStats.total_chunks
            ? (state.lang === 'zh'
              ? `当前所有 ${embeddingStats.total_chunks} 个分块均已建立向量索引（100%）。重新构建将清除已有数据并从头开始，可能需要较长时间。`
              : `All ${embeddingStats.total_chunks} chunks are already indexed (100%). Rebuilding will clear existing data and start over, which may take some time.`)
            : (state.lang === 'zh'
              ? `当前已有 ${embeddingStats?.indexed_chunks ?? 0}/${embeddingStats?.total_chunks ?? 0} 个分块完成索引。重新构建将覆盖已有数据，是否确定继续？`
              : `${embeddingStats?.indexed_chunks ?? 0}/${embeddingStats?.total_chunks ?? 0} chunks already indexed. Rebuilding will overwrite existing data. Continue?`)
        }
        confirmLabel={state.lang === 'zh' ? '确定重建' : 'Rebuild'}
        cancelLabel={state.lang === 'zh' ? '取消' : 'Cancel'}
        variant="info"
        onConfirm={() => {
          setShowRebuildConfirm(false);
          runEmbeddingBuild();
        }}
        onCancel={() => setShowRebuildConfirm(false)}
      />

    </div>
  );
}

