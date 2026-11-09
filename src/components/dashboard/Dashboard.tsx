import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useApp } from '../../contexts/AppContext';
import { listMarkdownFiles, syncVault, getSchedulerStatus, stopScheduler, runSchedulerNow, getEmbeddingStats, getKnowledgeGraph, retryFailedEmbeddings, resetEmbeddingIndex, type EmbeddingStats, type SchedulerStatus } from '../../lib/tauri';
import { runEmbeddingBuild as buildIndex, buildStageText, describeBuild, type EmbedConfig } from '../../lib/embeddingIndexer';
import { getSmartOrganizeConfig, setBackgroundOrganizeEnabled } from '../settings/Settings';
import { isLlmConfigured, startBackgroundOrganize } from '../../lib/backgroundOrganize';
import { IconNote, IconSync, IconDatabase, IconDownload, IconLink, IconFolder } from '../icons';
import { CanvasExport } from '../canvas/CanvasExport';
import { LintModal } from './LintModal';
import { QuickActionsHelp } from './QuickActionsHelp';
import { ProgressPanel } from './ProgressPanel';
import { ConfirmModal } from './ConfirmModal';
import { KnowledgeGapAnalysis } from './KnowledgeGapAnalysis';
import { GlobalTimeline } from '../temporal/GlobalTimeline';
import { AgentAutoOrganizeCard } from './AgentAutoOrganizeCard';
import '../../styles/dashboard-home.css';

const pathKey = (path: string) => {
  const normalized = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export function Dashboard() {
  const { state, setView, addVaultPath, setIsSyncing, setSchedulerLoading, showToast, setSchedulerProgress } = useApp();
  const zh = state.lang === 'zh';
  const copy = (cn: string, en: string) => zh ? cn : en;
  const pathsKey = JSON.stringify(state.vaultPaths?.length ? state.vaultPaths : state.vaultPath ? [state.vaultPath] : []);
  const paths = useMemo<string[]>(() => [...new Set<string>(JSON.parse(pathsKey))], [pathsKey]);
  const ready = paths.length > 0;
  const configured = isLlmConfigured(state.llmConfig);
  const [notes, setNotes] = useState<number | null>(null);
  const [links, setLinks] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [embedding, setEmbedding] = useState<EmbeddingStats | null>(null);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [schedulerStarting, setSchedulerStarting] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [buildStage, setBuildStage] = useState('');
  const [buildResult, setBuildResult] = useState<string | null>(null);
  const [showRebuild, setShowRebuild] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showLint, setShowLint] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [maintenanceOpen, setMaintenanceOpen] = useState(() => {
    try { return localStorage.getItem('zettel:dashboard-maintenance') === 'true'; } catch { return false; }
  });
  const generation = useRef(0);
  const cancel = useRef(false);
  const operation = useRef(false);
  const indexSection = useRef<HTMLDivElement>(null);
  const busy = building || organizing || state.isSyncing || state.schedulerLoading || schedulerStarting;

  const loadStatus = useCallback(async () => {
    try { setStatus(await getSchedulerStatus()); setStatusError(false); }
    catch { setStatusError(true); }
  }, []);

  const loadData = useCallback(async () => {
    const request = ++generation.current;
    if (!paths.length) { setNotes(null); setLinks(null); setEmbedding(null); setLoading(false); return; }
    setLoading(true);
    const [files, graphs, index] = await Promise.allSettled([
      Promise.all(paths.map(listMarkdownFiles)), Promise.all(paths.map(getKnowledgeGraph)), getEmbeddingStats(),
    ]);
    if (request !== generation.current) return;
    setNotes(files.status === 'fulfilled' ? new Set(files.value.flat().map(pathKey)).size : null);
    setLinks(graphs.status === 'fulfilled' ? new Set(graphs.value.flatMap(graph => graph.edges.map(edge =>
      JSON.stringify([pathKey(edge.source), pathKey(edge.target), edge.edge_type]),
    ))).size : null);
    setEmbedding(index.status === 'fulfilled' ? index.value : null);
    setLoading(false);
  }, [paths]);

  const refresh = useCallback(() => { void loadData(); setRefreshKey(key => key + 1); }, [loadData]);
  useEffect(() => {
    if (state.view !== 'dashboard') return;
    setNotes(null); setLinks(null); setEmbedding(null);
    void loadData(); void loadStatus();
    return () => { generation.current += 1; };
  }, [state.view, loadData, loadStatus]);
  useEffect(() => {
    if (state.view !== 'dashboard' || !ready) return;
    const timer = setInterval(loadStatus, status?.running ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [state.view, ready, status?.running, loadStatus]);
  const previousRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!status) return;
    if (previousRun.current !== undefined && status.last_run !== previousRun.current) refresh();
    previousRun.current = status.last_run;
  }, [status, refresh]);
  const hadProgress = useRef(false);
  useEffect(() => {
    if (state.schedulerProgressInfo) hadProgress.current = true;
    else if (hadProgress.current) { hadProgress.current = false; refresh(); void loadStatus(); }
  }, [state.schedulerProgressInfo, refresh, loadStatus]);
  useEffect(() => {
    if (state.view !== 'dashboard' || !ready) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
    const subscriptions = ['file-watcher-synced', 'file-watcher-deleted'].map(event => listen(event, schedule));
    return () => { clearTimeout(timer); subscriptions.forEach(p => { void p.then(unlisten => unlisten()).catch(() => {}); }); };
  }, [state.view, ready, refresh]);

  const openVault = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: copy('打开知识库', 'Open vault') });
      if (typeof selected === 'string') await addVaultPath(selected);
    } catch (error) { showToast(String(error), 'error'); }
  };
  const sync = async () => {
    if (operation.current || !ready) return;
    operation.current = true; setIsSyncing(true);
    try {
      const results = await Promise.all(paths.map(syncVault));
      const updated = results.reduce((sum, item) => sum + item.files_updated, 0);
      showToast(copy(`同步完成，更新 ${updated} 个文件`, `Synced ${updated} changed files`), 'success'); refresh();
    } catch (error) { showToast(copy('同步失败：', 'Sync failed: ') + String(error), 'error'); }
    finally { operation.current = false; setIsSyncing(false); }
  };
  const runIndex = async (rebuild = false, retry = false) => {
    if (operation.current || !ready) return;
    operation.current = true; cancel.current = false; setBuilding(true); setCancelling(false); setBuildResult(null);
    setBuildStage(copy('正在准备索引…', 'Preparing index…'));
    try {
      if (rebuild) await resetEmbeddingIndex();
      if (retry) await retryFailedEmbeddings();
      setEmbedding(await getEmbeddingStats());
      let config: EmbedConfig = { mode: 'local' };
      try { config = JSON.parse(localStorage.getItem('zettelagent:embedding_config') || '{"mode":"local"}'); } catch { /* default */ }
      const report = await buildIndex({ config, isCancelled: () => cancel.current,
        onStage: stage => setBuildStage(buildStageText(stage, zh)),
        onProgress: async () => setEmbedding(await getEmbeddingStats()),
      });
      const message = describeBuild(report, zh);
      setBuildResult(message); showToast(message, report.failed > 0 || report.cancelled ? 'info' : 'success');
    } catch (error) {
      const message = copy('索引未完成：', 'Index incomplete: ') + String(error);
      setBuildResult(message); showToast(message, 'error');
    } finally { setBuilding(false); operation.current = false; refresh(); }
  };
  const runOnce = async () => {
    if (operation.current || !ready || !configured) return;
    operation.current = true; setOrganizing(true); setSchedulerLoading(true);
    try {
      const config = getSmartOrganizeConfig();
      await Promise.all(paths.map(syncVault));
      const dailyPath = config.includeJournals ? undefined : await (await import('../../lib/dailyNote')).getDailyFolderPath();
      const result = await runSchedulerNow(state.llmConfig.apiUrl, state.llmConfig.apiKey || undefined,
        state.llmConfig.model, state.llmConfig.providerId, state.methodology, undefined, config.batchSize,
        config.searchResultCount, config.contentTruncationLimit, config.includeJournals, dailyPath, false, config.minNoteLength);
      setStatus(result);
      showToast(copy(`本次整理完成：检查 ${result.notes_processed} 篇，整理 ${result.notes_reconciled} 篇`, `Finished: ${result.notes_processed} checked, ${result.notes_reconciled} organized`), 'success');
    } catch (error) { showToast(String(error), 'error'); }
    finally { operation.current = false; setOrganizing(false); setSchedulerLoading(false); refresh(); }
  };
  const toggleBackground = async (start: boolean) => {
    if (operation.current) return;
    operation.current = true; setSchedulerStarting(true);
    try {
      if (start) await startBackgroundOrganize({ vaultPaths: paths, llmConfig: state.llmConfig, methodology: state.methodology });
      else { await stopScheduler(); setBackgroundOrganizeEnabled(false); }
      await loadStatus(); refresh();
    } catch (error) { showToast(String(error), 'error'); }
    finally { operation.current = false; setSchedulerStarting(false); }
  };

  const pending = embedding ? Math.max(0, embedding.total_chunks - embedding.indexed_chunks) : null;
  const metric = (value: number | null) => loading ? '…' : value === null ? copy('暂不可用', 'Unavailable') : value.toLocaleString();
  const percent = embedding && embedding.total_chunks > 0 ? Math.min(100, Math.round(embedding.indexed_chunks / embedding.total_chunks * 100)) : null;

  return (
    <div className="panel"><div className="panel-content" style={{ padding: 0 }}><div className="dash-page dash-home">
      <header className="dash-home-header"><div>
        <h1 className="dash-page-title">{copy('知识库总览', 'Workspace overview')}</h1>
        <p className="dash-home-scope">{ready ? copy(`全部 ${paths.length} 个已打开的知识库`, `All ${paths.length} open vaults`) : copy('从一个本地文件夹开始', 'Start with a local folder')}</p>
      </div><button className="btn btn-ghost" onClick={() => setShowHelp(true)}>{copy('使用帮助', 'Help')}</button></header>
      {!ready ? (
        <section className="dash-onboarding" aria-labelledby="dash-onboarding-title"><IconFolder size={28} />
          <h2 id="dash-onboarding-title">{copy('把笔记放回你的工作台', 'Bring your notes into one workspace')}</h2>
          <p>{copy('打开存放 Markdown 笔记的文件夹，即可浏览笔记、检查关联和查看最近变化。', 'Open a folder of Markdown notes to browse, review connections, and follow recent changes.')}</p>
          <button className="btn btn-primary" onClick={() => void openVault()}>{copy('打开知识库', 'Open vault')}</button>
          <button className="btn btn-ghost" onClick={() => setView('settings')}>{copy('配置模型', 'Configure model')}</button>
        </section>
      ) : (<>
        <div className="dash-summary" role="group" aria-label={copy('知识库状态', 'Vault summary')} aria-busy={loading}>
          <button className="dash-summary-item dash-metric" aria-label={`${copy('笔记', 'Notes')}: ${metric(notes)}`} disabled={loading || notes === null} onClick={() => setView('bases')}>
            <span className="dash-summary-label"><IconNote size={14} />{copy('笔记', 'Notes')}</span><span className="dash-summary-value">{metric(notes)}</span><span className="dash-summary-caption">{copy('浏览全部笔记', 'Browse all notes')} <span aria-hidden="true">↗</span></span>
          </button>
          <button className="dash-summary-item dash-metric" aria-label={`${copy('图谱关联', 'Graph links')}: ${metric(links)}`} disabled={loading || links === null} onClick={() => setView('graph')}>
            <span className="dash-summary-label"><IconLink size={14} />{copy('图谱关联', 'Graph links')}</span><span className="dash-summary-value">{metric(links)}</span><span className="dash-summary-caption">{copy('查看关系图谱', 'Explore connections')} <span aria-hidden="true">↗</span></span>
          </button>
          <button className="dash-summary-item dash-metric" onClick={() => indexSection.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            <span className="dash-summary-label"><IconDatabase size={14} />{copy('本地搜索索引', 'Local search index')}</span><span className="dash-summary-value dash-index-value">{loading ? '…' : percent === null ? (embedding ? copy('待建立', 'Not built') : copy('暂不可用', 'Unavailable')) : `${percent}%`}</span><span className="dash-summary-caption">{copy('全部已入库笔记 · 查看详情', 'All indexed vaults · View details')}</span>
          </button>
        </div>
        {!loading && (notes === null || links === null || embedding === null) && <div className="dash-inline-notice" role="status"><span>{copy('部分状态暂时无法读取。', 'Some workspace data could not be loaded.')}</span><button className="btn btn-ghost btn-sm" onClick={refresh}>{copy('重试总览', 'Retry overview')}</button></div>}
        <div className="dash-home-quick-links"><button className="btn" onClick={() => setView(state.currentFile ? 'note' : 'bases')}>{copy(state.currentFile ? '继续写作' : '浏览笔记', state.currentFile ? 'Continue writing' : 'Browse notes')}</button><button className="btn btn-ghost" onClick={() => setView('knowledge')}>{copy('查看待审建议', 'Review suggestions')}</button></div>
        <section className="dash-home-section" aria-labelledby="dash-next-title">
          <div className="dash-home-section-heading"><h2 id="dash-next-title">{copy('接下来', 'Next steps')}</h2><span>{copy('按需要处理，不必重复执行', 'Only do what needs attention')}</span></div>
          {!configured && <div className="dash-inline-notice"><span>{copy('整理与深度诊断需要先配置模型。笔记浏览和本地检查已可使用。', 'Configure a model for organization and deep diagnosis. Browsing and local checks are ready.')}</span><button className="btn btn-sm" onClick={() => setView('settings')}>{copy('配置模型', 'Configure model')}</button></div>}
          <div ref={indexSection} className="dash-index-task">
            <div className="dash-task-heading"><IconDatabase size={17} /><h3>{copy('搜索索引', 'Search index')}</h3><span className="dash-task-state">{pending === null ? copy('状态未知', 'Status unavailable') : pending > 0 ? copy(`${pending.toLocaleString()} 个片段待索引`, `${pending.toLocaleString()} passages pending`) : embedding?.total_chunks ? copy('已就绪', 'Ready') : copy('尚无内容', 'No content yet')}</span></div>
            <p>{copy('更新索引只处理新增和变化的内容，让语义搜索找到相关笔记。', 'Update new and changed content so semantic search can find related notes.')}</p>
            <div className="dash-task-actions"><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void runIndex()}>{building ? copy('正在更新…', 'Updating…') : copy('更新索引', 'Update index')}</button>{(embedding?.failed_chunks || embedding?.retrying_chunks) ? <button className="btn btn-sm" disabled={busy} onClick={() => void runIndex(false, true)}>{copy('重试失败项', 'Retry failed passages')}</button> : null}</div>
            {embedding && <div className="dash-index-details"><span>{copy('已索引', 'Indexed')} {embedding.indexed_chunks.toLocaleString()} / {embedding.total_chunks.toLocaleString()}</span><span>{copy('待重试', 'Retrying')} {embedding.retrying_chunks ?? 0}</span><span>{copy('失败', 'Failed')} {embedding.failed_chunks ?? 0}</span><span>{copy('已忽略', 'Ignored')} {embedding.ignored_chunks ?? 0}</span></div>}
            {embedding?.last_error && <details className="dash-task-error"><summary>{copy('查看最近错误', 'Last index error')}</summary><p>{embedding.last_error}</p></details>}
            {buildResult && <p className="dash-task-result" role="status">{buildResult}</p>}
            {building && <ProgressPanel title={copy('更新搜索索引', 'Updating search index')} current={embedding?.indexed_chunks ?? 0} total={embedding?.total_chunks ?? 0} stage={buildStage} indeterminate={!embedding || pending === 0} cancelLabel={cancelling ? copy('正在停止…', 'Stopping…') : copy('停止', 'Stop')} onCancel={() => { cancel.current = true; setCancelling(true); }} />}
          </div>
          <AgentAutoOrganizeCard status={status} starting={schedulerStarting} vaultReady={ready && configured && !building && !organizing} intervalSecs={getSmartOrganizeConfig().intervalSecs} isZh={zh} onStart={() => toggleBackground(true)} onStop={() => toggleBackground(false)} onRunOnce={runOnce} runOnceDisabled={busy || !configured || !!status?.running || statusError} organizing={organizing || state.schedulerLoading} unavailable={statusError} onRetry={loadStatus} />
          {state.schedulerProgressInfo && <ProgressPanel title={copy('正在整理笔记', 'Organizing notes')} current={state.schedulerProgressInfo.current} total={state.schedulerProgressInfo.total} stage={state.schedulerProgressInfo.message || state.schedulerProgressInfo.filename || ''} indeterminate={state.schedulerProgressInfo.total === 0} cancelLabel={copy('停止本次任务', 'Stop this run')} onCancel={async () => { try { setSchedulerProgress(copy('正在停止…', 'Stopping…')); await stopScheduler(); await loadStatus(); } catch (error) { showToast(String(error), 'error'); } }} />}
          <div className="dash-review-row"><div><h3>{copy('检查笔记关联', 'Review note connections')}</h3><p>{copy('检查失效链接、孤立笔记和缺失的笔记信息。', 'Inspect broken links, orphan notes, and missing metadata.')}</p></div><button className="btn btn-sm" onClick={() => setShowLint(true)}>{copy('运行检查', 'Run check')}</button></div>
        </section>
        <section className="dash-home-section" aria-label={copy('最近变化', 'Recent changes')}><GlobalTimeline refreshKey={refreshKey} /></section>
        <section className="dash-home-section" aria-label={copy('知识结构', 'Knowledge structure')}><KnowledgeGapAnalysis key={state.vaultPath} /></section>
        <details className="dash-maintenance" open={maintenanceOpen} onToggle={event => { const value = event.currentTarget.open; setMaintenanceOpen(value); try { localStorage.setItem('zettel:dashboard-maintenance', String(value)); } catch { /* preference */ } }}>
          <summary>{copy('维护工具', 'Maintenance')}<span>{copy('文件同步、导出和索引重建', 'Sync, export, and rebuild')}</span></summary>
          <div className="dash-maintenance-tools">
            <div><h3>{copy('同步本地文件', 'Sync local files')}</h3><p>{copy('读取磁盘上的最新笔记，更新本地搜索数据。', 'Read the latest files from disk and update local search data.')}</p><button className="btn btn-sm" disabled={busy} onClick={() => void sync()}><IconSync size={14} />{state.isSyncing ? copy('正在同步…', 'Syncing…') : copy('同步文件', 'Sync files')}</button></div>
            <div><h3>{copy('导出知识图谱', 'Export graph')}</h3><p>{copy('导出为 Obsidian Canvas，便于分享与归档。', 'Export an Obsidian Canvas for sharing or archiving.')}</p><button className="btn btn-sm" disabled={!notes || busy} onClick={() => setShowExport(true)}><IconDownload size={14} />{copy('导出 Canvas', 'Export Canvas')}</button></div>
            <div><h3>{copy('全部重建索引', 'Rebuild the index')}</h3><p>{copy('仅在排查索引问题时使用；保留笔记与关键词搜索。', 'For index troubleshooting. Notes and keyword search are preserved.')}</p><button className="btn btn-sm" disabled={busy || !!status?.running || statusError} onClick={() => setShowRebuild(true)}>{copy('重建全部向量', 'Rebuild all vectors')}</button>{status?.running && <small>{copy('请先暂停后台整理。', 'Pause background organization first.')}</small>}</div>
          </div>
        </details>
      </>)}
    </div></div>
      <CanvasExport isOpen={showExport} onClose={() => setShowExport(false)} />
      <LintModal isOpen={showLint} onClose={() => { setShowLint(false); refresh(); }} />
      <QuickActionsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
      <ConfirmModal isOpen={showRebuild} title={copy('重建全部向量', 'Rebuild all vectors')} message={copy('这会清除已有的语义向量和向量缓存，然后重新生成。笔记原文、全文搜索和手动关联将保留。如果使用远程模型，会重新产生请求费用。', 'This clears existing vectors and their cache, then generates them again. Note text, keyword search, and manual relations are preserved. A remote embedding model will incur new requests.')} confirmLabel={copy('确认重建', 'Confirm rebuild')} cancelLabel={copy('取消', 'Cancel')} variant="warning" onConfirm={() => { setShowRebuild(false); void runIndex(true); }} onCancel={() => setShowRebuild(false)} />
    </div>
  );
}
