import { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  getNotesOverview,
  listSavedViews,
  saveView,
  deleteSavedView,
  addCardsToReview,
  chatWithLlm,
  type NotesOverview,
  type NoteRow,
  type SavedView,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import {
  parseQuery,
  matchesQuery,
  ruleLabel,
  hasToken,
  toggleToken,
  removeToken,
} from '../../lib/basesQuery';
import {
  HEALTH_PERSPECTIVES,
  perspectiveCounts,
  isPerspectiveEnabled,
  COLUMN_DEFS,
  defaultVisibleColumns,
  compareRows,
  type ColumnId,
} from '../../lib/notesHealth';
import { OverviewTable, type FlatItem } from './OverviewTable';
import { NotePeekPanel } from './NotePeekPanel';
import { BatchAgentDialog } from './BatchAgentDialog';
import { ResizablePanel } from '../layout/ResizablePanel';

type GroupBy = 'folder' | 'noteType' | 'reviewState' | null;

/** The DSL cheat-sheet rows. `conf>80` is gone — the backend never returned it. */
const DSL_EXAMPLES: Array<[string, string]> = [
  ['type:permanent', 'overview.col.noteType'],
  ['#ai', 'overview.col.tags'],
  ['backlinks=0', 'overview.col.backlinks'],
  ['links>=3', 'overview.col.outbound'],
  ['semantic=0', 'overview.col.semantic'],
  ['index:notIndexed', 'overview.col.index'],
  ['review:none', 'overview.col.review'],
  ['reconciled:never', 'overview.persp.neverReconciled'],
  ['due:true', 'overview.persp.dueToday'],
  ['created>2026-01-01', 'overview.col.created'],
];

/**
 * 知识库总览 / Notes Overview — the vault's health desk.
 *
 * This view exists for the three things an AI conversation cannot give you:
 * **scanability** (hundreds of statuses in one glance), **completeness** (every
 * note matching a condition, not the model's top 5) and **batch action** (pick a
 * set, act on all of it). Everything here serves one of those three.
 *
 * Filter state is a single DSL string. Health-lens chips are literally `lens:*`
 * tokens in that string, which is why a `SavedView` — whose contract has no
 * field for chips — still round-trips them.
 */
export function Bases() {
  const { state, setCurrentFile, setView, showToast } = useApp();

  const [data, setData] = useState<NotesOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [graphLoading, setGraphLoading] = useState(false);

  // Filters. There is exactly one filter model: the DSL string. The three
  // `All folders / types / tags` dropdowns used to keep their own state beside
  // it, duplicating `folder:` / `type:` / `#tag` and hiding their value in a
  // `<select>` label instead of showing it as a pill.
  const [query, setQuery] = useState('');

  // Sort / columns / grouping
  const [sortField, setSortField] = useState<ColumnId>('lastSynced');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(() => defaultVisibleColumns());
  const [groupBy, setGroupBy] = useState<GroupBy>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Selection / peek / batch
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [peekPath, setPeekPath] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  // Saved views
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [namingView, setNamingView] = useState(false);
  const [newViewName, setNewViewName] = useState('');

  // Panels
  const [showHelp, setShowHelp] = useState(false);
  /** The one disclosure that holds every occasional control (see the toolbar). */
  const [showSettings, setShowSettings] = useState(false);
  const [nlLoading, setNlLoading] = useState(false);

  // ── Data ──────────────────────────────────────────────────────────
  const loadData = useCallback(async (includeGraph: boolean) => {
    if (includeGraph) setGraphLoading(true); else setLoading(true);
    try {
      const overview = await getNotesOverview(state.vaultPath || '', includeGraph);
      setData(overview);
    } catch (err) {
      console.error('Failed to load notes overview:', err);
      showToast(String(err), 'error');
    } finally {
      setLoading(false);
      setGraphLoading(false);
    }
  }, [state.vaultPath, showToast]);

  useEffect(() => { void loadData(false); }, [loadData]);
  useEffect(() => { void listSavedViews().then(setViews).catch(() => {}); }, []);

  const rows = data?.rows ?? [];
  const semanticReady = data?.semanticIndexReady ?? false;
  const graphIncluded = data?.graphSignalsIncluded ?? false;

  const parsed = useMemo(() => parseQuery(query), [query]);

  // The columns actually offered: graph-only ones appear once signals are loaded.
  const availableColumns = useMemo(
    () => COLUMN_DEFS.filter(c => !c.graphOnly || graphIncluded),
    [graphIncluded],
  );

  // DSL + keywords, then sort. This is the "completeness" contract: every
  // matching row, deterministically ordered — never a model's sample.
  const filtered = useMemo(() => {
    let result = rows.filter(r => matchesQuery(r, parsed));
    result = [...result].sort((a, b) => {
      const cmp = compareRows(a, b, sortField);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [rows, parsed, sortField, sortDir]);

  const counts = useMemo(() => perspectiveCounts(rows, semanticReady), [rows, semanticReady]);

  // Flatten (optionally grouped) rows into the uniform list the table windows over.
  const flatItems = useMemo<FlatItem[]>(() => {
    if (!groupBy) return filtered.map(row => ({ kind: 'row', row }));
    const groups = new Map<string, NoteRow[]>();
    for (const row of filtered) {
      const raw = groupBy === 'reviewState' ? (row.reviewState ?? '') : (row[groupBy] as string);
      const key = raw || t('overview.ungrouped');
      const arr = groups.get(key);
      if (arr) arr.push(row); else groups.set(key, [row]);
    }
    const items: FlatItem[] = [];
    for (const [key, groupRows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const isCollapsed = collapsed.has(key);
      items.push({ kind: 'group', key, label: key, count: groupRows.length, collapsed: isCollapsed });
      if (!isCollapsed) for (const row of groupRows) items.push({ kind: 'row', row });
    }
    return items;
  }, [filtered, groupBy, collapsed]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleSort = useCallback((field: ColumnId) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }, [sortField]);

  const toggleRow = useCallback((path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const filteredPaths = useMemo(() => filtered.map(r => r.path), [filtered]);
  const allSelected = filteredPaths.length > 0 && filteredPaths.every(p => selected.has(p));

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      const everySelected = filteredPaths.length > 0 && filteredPaths.every(p => prev.has(p));
      if (everySelected) {
        const next = new Set(prev);
        for (const p of filteredPaths) next.delete(p);
        return next;
      }
      return new Set([...prev, ...filteredPaths]);
    });
  }, [filteredPaths]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Row click opens the peek pane. It must NOT navigate away — leaving the list
  // on a single click is exactly what kills the scan flow this view is built for.
  const handleRowClick = useCallback((row: NoteRow) => {
    setPeekPath(row.path);
  }, []);

  const openFull = useCallback((path: string) => {
    setCurrentFile(path);
    setView('note');
  }, [setCurrentFile, setView]);

  const toggleColumn = useCallback((id: ColumnId) => {
    setVisibleColumns(prev => (prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]));
  }, []);

  const toggleLens = useCallback((token: string) => {
    setQuery(prev => toggleToken(prev, token));
  }, []);

  const removePill = useCallback((token: string) => {
    setQuery(prev => removeToken(prev, token));
  }, []);

  // ── Batch actions & saved views ───────────────────────────────────
  /** Immediate, no AI, no approval: FSRS just starts scheduling these notes. */
  const handleAddToReview = useCallback(async () => {
    const paths = [...selected];
    if (paths.length === 0) return;
    try {
      const added = await addCardsToReview(paths);
      showToast(
        added > 0 ? tf('overview.batchReviewDone', added) : t('overview.batchReviewNone'),
        added > 0 ? 'success' : 'info',
      );
      await loadData(graphIncluded);
    } catch (err) {
      showToast(String(err), 'error');
    }
  }, [selected, showToast, loadData, graphIncluded]);

  /**
   * Re-apply a stored view.
   *
   * Older views carry `folder` / `noteType` / `tag` from the three dropdowns the
   * toolbar used to have. Those dropdowns are gone — the DSL already expresses
   * all three (`folder:` / `type:` / `#tag`) — so their values are folded into
   * the query string here. The filter then shows up as removable pills like
   * everything else instead of as invisible state, and old views keep working.
   */
  const applyView = useCallback((view: SavedView) => {
    let q = view.query;
    if (view.folder) q = toggleToken(q, `folder:${view.folder}`);
    if (view.noteType) q = toggleToken(q, `type:${view.noteType}`);
    if (view.tag) q = toggleToken(q, `#${view.tag}`);
    setQuery(q);
    setSortField((view.sortField || 'lastSynced') as ColumnId);
    setSortDir(view.sortDir === 'asc' ? 'asc' : 'desc');
    if (view.visibleColumns.length > 0) setVisibleColumns(view.visibleColumns as ColumnId[]);
    setGroupBy((view.groupBy as GroupBy) ?? null);
    setActiveViewId(view.id);
  }, []);

  const handleSaveView = useCallback(async () => {
    const name = newViewName.trim();
    if (!name) {
      showToast(t('overview.viewNameEmpty'), 'error');
      return;
    }
    const view: SavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      query,
      // The `SavedView` contract keeps these three fields; the view no longer
      // has separate state for them, so everything lives in `query` and old
      // views are still read back correctly by `applyView`.
      folder: '',
      noteType: '',
      tag: '',
      sortField,
      sortDir,
      visibleColumns,
      groupBy,
      createdAtMs: Date.now(),
    };
    try {
      await saveView(view);
      const list = await listSavedViews();
      setViews(list);
      setActiveViewId(view.id);
      setNamingView(false);
      setNewViewName('');
      showToast(t('overview.viewSaved'), 'success');
    } catch (err) {
      showToast(String(err), 'error');
    }
  }, [newViewName, query, sortField, sortDir, visibleColumns, groupBy, showToast]);

  const handleDeleteView = useCallback(async () => {
    const view = views.find(v => v.id === activeViewId);
    if (!view) return;
    try {
      await deleteSavedView(view.id);
      setViews(await listSavedViews());
      setActiveViewId('');
      showToast(t('overview.viewDeleted'), 'success');
    } catch (err) {
      showToast(String(err), 'error');
    }
  }, [views, activeViewId, showToast]);

  // ── Natural-language → filter ─────────────────────────────────────
  /**
   * Natural language → filter, via the *existing* DSL rather than a bespoke
   * structured-output protocol.
   *
   * The model's only job is to emit one line of the same syntax the user could
   * have typed. That line goes through `parseQuery`, so whatever the AI
   * misunderstood shows up as removable pills — the user always sees, and can
   * correct, the machine's reading. It also means a bad model response degrades
   * to "no rules parsed" instead of a silently wrong table.
   *
   * It reads the *one* search field. There used to be a second box next to it for
   * this, which is what made the toolbar unanswerable: two inputs side by side
   * and no way to know which one your sentence belonged in. Now the same field
   * takes either, and the AI rewrites the sentence into DSL in place.
   */
  const handleNlTranslate = useCallback(async () => {
    const text = query.trim();
    if (!text) {
      showToast(t('overview.nlEmpty'), 'error');
      return;
    }
    if (!state.llmConfig?.model || !state.llmConfig?.apiUrl) {
      showToast(t('overview.nlNoConfig'), 'error');
      return;
    }
    setNlLoading(true);
    try {
      const vocabulary = [
        'type:<noteType>', 'folder:<name>', '#<tag>', 'title:<text>',
        'links<N|>N|=N (outbound)', 'backlinks<N|>N|=N', 'semantic=N',
        'index:indexed|partial|notIndexed|noChunks',
        'review:new|learning|review|relearning|none', 'due:true|false',
        'reconciled:never|yes', 'contradictions>0', 'created>YYYY-MM-DD',
        'modified>YYYY-MM-DD', 'pagerank>0.01', 'hub:true',
        'lens:orphan|neverReconciled|hasContradictions|notIndexed|dueToday|semanticIsland',
      ].join('\n');
      const prompt = [
        'Translate the user request into ONE line of this note-filter DSL.',
        'Terms are space separated and combined with AND. Output the line only —',
        'no prose, no code fence, no explanation. If nothing maps, output nothing.',
        '',
        'Fields:',
        vocabulary,
        '',
        `Request: ${text}`,
      ].join('\n');

      const res = await chatWithLlm({
        messages: [{ role: 'user', content: prompt }],
        apiUrl: state.llmConfig.apiUrl,
        model: state.llmConfig.model,
        apiKey: state.llmConfig.apiKey || undefined,
        providerId: state.llmConfig.providerId,
      });

      // Defensive: models like fences and preambles. Take the first non-empty,
      // non-fence line and cap it — this string goes straight into the parser.
      const line = (res.content || '')
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('```')) ?? '';
      const candidate = [...line].slice(0, 300).join('');

      if (!candidate || parseQuery(candidate).rules.length === 0) {
        showToast(t('overview.nlFailed'), 'error');
        return;
      }
      setQuery(candidate);
      showToast(t('overview.nlApplied'), 'success');
    } catch (err) {
      console.error('[Overview] NL translate failed:', err);
      showToast(t('overview.nlFailed'), 'error');
    } finally {
      setNlLoading(false);
    }
  }, [query, state.llmConfig, showToast]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setActiveViewId('');
  }, []);

  const hasFilter = query.trim() !== '';

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="overview-container">
      <div className="overview-main">
        <div className="overview-head">
          <div className="overview-head-text">
            <h2 className="overview-head-title">{t('overview.title')}</h2>
            <span className="overview-head-sub">{t('overview.subtitle')}</span>
          </div>
          <div className="overview-head-right">
            <span className="overview-head-count" data-testid="overview-count">
              {hasFilter
                ? tf('overview.countFiltered', filtered.length, rows.length)
                : tf('overview.count', rows.length)}
            </span>
            <button
              className="overview-refresh-btn"
              onClick={() => void loadData(graphIncluded)}
              title={t('overview.refresh')}
              aria-label={t('overview.refresh')}
              aria-busy={loading || graphLoading}
              disabled={loading || graphLoading}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Health lenses: the product's core move — put "what you should do" on
            the surface instead of handing the user a query language. This is the
            protagonist of the view, so it leads and is styled up, not buried in
            the toolbar. */}
        <div className="overview-lenses" role="group" aria-label={t('overview.perspectives')}>
          <span className="overview-lenses-label">{t('overview.perspectives')}</span>
          {HEALTH_PERSPECTIVES.map(p => {
            const token = `lens:${p.id}`;
            const on = hasToken(query, token);
            const enabled = isPerspectiveEnabled(p, data);
            const count = enabled ? counts[p.id] : 0;
            const btn = (
              <button
                key={p.id}
                type="button"
                className={`overview-lens ${on ? 'is-on' : ''} ${enabled ? '' : 'is-disabled'} ${enabled && count === 0 ? 'is-empty' : ''}`}
                onClick={() => enabled && toggleLens(token)}
                disabled={!enabled}
                aria-pressed={on}
                data-testid={`lens-${p.id}`}
              >
                <span className="overview-lens-label">{t(p.labelKey as Parameters<typeof t>[0])}</span>
                <span className="overview-lens-badge">{enabled ? counts[p.id] : '—'}</span>
              </button>
            );
            // A disabled button eats pointer events, so its `title` never shows.
            // Wrap it so the "why is this greyed out" hint is actually reachable.
            return enabled ? btn : (
              <span key={p.id} className="overview-lens-lock" title={t('overview.persp.semanticDisabled')}>
                {btn}
              </span>
            );
          })}
        </div>

        <div className="overview-toolbar">
          {/* ONE primary input. It filters live as DSL while you type; if what
              you typed is plain prose (no DSL rule parsed), the AI button turns
              it into DSL in place. Two side-by-side boxes used to force the user
              to guess which one their sentence belonged in — this removes the
              guess. */}
          <div className="overview-search-wrap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="overview-search"
              placeholder={t('overview.searchPlaceholder')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label={t('overview.searchPlaceholder')}
            />
            {query.trim() !== '' && (
              <span className={`overview-mode ${parsed.rules.length > 0 ? 'is-dsl' : ''}`} data-testid="search-mode">
                {parsed.rules.length > 0 ? t('overview.modeDsl') : t('overview.modeText')}
              </span>
            )}
            <button
              type="button"
              className="overview-ai-btn"
              onClick={() => void handleNlTranslate()}
              disabled={nlLoading || query.trim() === ''}
              title={t('overview.aiTranslateHint')}
              data-testid="nl-translate"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
              </svg>
              {nlLoading ? t('overview.nlRunning') : t('overview.nlRun')}
            </button>
          </div>

          <button
            type="button"
            className={`overview-chip-btn ${showHelp ? 'is-on' : ''}`}
            onClick={() => setShowHelp(v => !v)}
            aria-expanded={showHelp}
          >
            {t('overview.dslHelp')}
          </button>

          {hasFilter && (
            <button type="button" className="overview-chip-btn" onClick={clearFilters}>
              {t('overview.clearFilters')}
            </button>
          )}

          <select
            className="overview-select"
            value={activeViewId}
            onChange={e => {
              const v = views.find(x => x.id === e.target.value);
              if (v) applyView(v); else setActiveViewId('');
            }}
            aria-label={t('overview.views')}
            data-testid="view-select"
          >
            <option value="">{t('overview.viewCurrent')}</option>
            {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>

          {/* Every occasional control lives here: grouping, columns, saving a
              view, and the expensive graph-signals recompute. None of them earn
              permanent toolbar space, and folding them together is what lets the
              search field and the lenses dominate. */}
          <div className="overview-columns-wrap">
            <button
              type="button"
              className={`overview-chip-btn ${showSettings ? 'is-on' : ''}`}
              onClick={() => setShowSettings(v => !v)}
              aria-expanded={showSettings}
              data-testid="view-settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              {t('overview.viewSettings')}
            </button>
            {showSettings && (
              <div className="overview-columns-menu" data-testid="view-settings-menu">
                <div className="overview-settings-group">
                  <span className="overview-settings-title">{t('overview.groupBy')}</span>
                  <select
                    className="overview-select"
                    value={groupBy ?? ''}
                    onChange={e => setGroupBy((e.target.value || null) as GroupBy)}
                    aria-label={t('overview.groupBy')}
                    data-testid="group-select"
                  >
                    <option value="">{t('overview.groupNone')}</option>
                    <option value="folder">{t('overview.groupFolder')}</option>
                    <option value="noteType">{t('overview.groupType')}</option>
                    <option value="reviewState">{t('overview.groupReview')}</option>
                  </select>
                </div>

                <div className="overview-settings-group">
                  <span className="overview-settings-title">{t('overview.columns')}</span>
                  <div className="overview-columns-list" data-testid="columns-menu">
                    {availableColumns.map(col => (
                      <label key={col.id} className={`overview-columns-item ${col.locked ? 'is-locked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={visibleColumns.includes(col.id)}
                          disabled={col.locked}
                          onChange={() => toggleColumn(col.id)}
                        />
                        <span>{t(col.labelKey as Parameters<typeof t>[0])}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="overview-settings-group">
                  <span className="overview-settings-title">{t('overview.views')}</span>
                  <div className="overview-settings-row">
                    <button
                      type="button"
                      className="overview-chip-btn overview-chip-btn-sm"
                      onClick={() => { setNamingView(true); setShowSettings(false); }}
                      data-testid="save-view"
                    >
                      {t('overview.saveAsView')}
                    </button>
                    {activeViewId && (
                      <button type="button" className="overview-chip-btn overview-chip-btn-sm is-danger" onClick={() => void handleDeleteView()}>
                        {t('overview.deleteView')}
                      </button>
                    )}
                  </div>
                </div>

                <div className="overview-settings-group">
                  <span className="overview-settings-title">{t('overview.graphSignals')}</span>
                  <button
                    type="button"
                    className={`overview-chip-btn overview-chip-btn-sm ${graphIncluded ? 'is-on' : ''}`}
                    onClick={() => void loadData(true)}
                    disabled={graphLoading}
                    data-testid="compute-graph"
                  >
                    {graphLoading ? t('overview.computingGraph') : graphIncluded ? t('overview.graphReady') : t('overview.computeGraph')}
                  </button>
                  <span className="overview-settings-desc">{t('overview.graphHint')}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {showHelp && (
          <div className="overview-help-card">
            <div className="overview-help-title">{t('overview.dslHelpTitle')}</div>
            <div className="overview-help-grid">
              {DSL_EXAMPLES.map(([example, labelKey]) => (
                <button
                  key={example}
                  type="button"
                  className="overview-help-item"
                  onClick={() => setQuery(prev => (prev.trim() ? `${prev.trim()} ${example}` : example))}
                >
                  <code>{example}</code>
                  <span>{t(labelKey as Parameters<typeof t>[0])}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {parsed.rules.length > 0 && (
          <div className="overview-pills" data-testid="query-pills">
            {parsed.rules.map(rule => {
              const lens = rule.field === 'lens'
                ? HEALTH_PERSPECTIVES.find(p => p.id.toLowerCase() === rule.value.toLowerCase())
                : undefined;
              return (
                <span key={rule.token} className={`overview-pill ${lens ? 'is-lens' : ''}`}>
                  <span>{lens ? t(lens.labelKey as Parameters<typeof t>[0]) : ruleLabel(rule)}</span>
                  <button
                    type="button"
                    className="overview-pill-x"
                    onClick={() => removePill(rule.token)}
                    aria-label={`remove ${rule.token}`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {namingView && (
          <div className="overview-inline-form" data-testid="name-view-form">
            <input
              type="text"
              className="overview-nl-input"
              placeholder={t('overview.saveViewPrompt')}
              value={newViewName}
              onChange={e => setNewViewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSaveView(); }}
              aria-label={t('overview.saveViewPrompt')}
              autoFocus
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveView()} data-testid="confirm-save-view">
              {t('overview.saveAsView')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setNamingView(false); setNewViewName(''); }}>
              {t('overview.ai.cancel')}
            </button>
          </div>
        )}

        {data?.truncated && (
          <div className="overview-banner" data-testid="truncated-banner">
            {tf('overview.truncated', data.total)}
          </div>
        )}

        {selected.size > 0 && (
          <div className="overview-batchbar" data-testid="batch-bar">
            <span className="overview-batchbar-count">{tf('overview.selected', selected.size)}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void handleAddToReview()} data-testid="batch-review">
              {t('overview.batchReview')}
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setBatchOpen(true)} data-testid="batch-ai">
              {t('overview.batchAi')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearSelection}>
              {t('overview.clearSelection')}
            </button>
          </div>
        )}

        {/* The body area always occupies the same box, so swapping spinner →
            table → empty state never shifts the toolbar above it. */}
        <div className="overview-body">
          {loading && (
            <div className="overview-state" data-testid="overview-loading">
              <span className="overview-spinner" />
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div className="overview-state overview-empty" data-testid="overview-empty">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" />
              </svg>
              <h3>{t('overview.empty')}</h3>
              <p>{t('overview.emptyDesc')}</p>
            </div>
          )}
          {!loading && rows.length > 0 && filtered.length === 0 && (
            <div className="overview-state overview-empty" data-testid="overview-empty-filtered">
              <h3>{t('overview.emptyFiltered')}</h3>
              <p>{t('overview.emptyFilteredDesc')}</p>
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
                {t('overview.clearFilters')}
              </button>
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <OverviewTable
              items={flatItems}
              visibleColumns={visibleColumns}
              sortField={sortField}
              sortDir={sortDir}
              onSort={handleSort}
              selected={selected}
              onToggleRow={toggleRow}
              allSelected={allSelected}
              onToggleAll={toggleAll}
              onRowClick={handleRowClick}
              peekPath={peekPath}
              semanticIndexReady={semanticReady}
              onToggleGroup={toggleGroup}
              lang={state.lang}
            />
          )}
        </div>

      </div>

      {peekPath !== null && (
        <ResizablePanel side="right" defaultWidth={420} minWidth={280} maxWidth={720} storageKey="za-overview-peek-width">
          <NotePeekPanel
            path={peekPath}
            title={rows.find(r => r.path === peekPath)?.title ?? null}
            onClose={() => setPeekPath(null)}
            onOpenFull={openFull}
          />
        </ResizablePanel>
      )}

      {batchOpen && (
        <BatchAgentDialog
          filePaths={[...selected]}
          onClose={() => setBatchOpen(false)}
          onFinished={() => void loadData(graphIncluded)}
        />
      )}
    </div>
  );
}

