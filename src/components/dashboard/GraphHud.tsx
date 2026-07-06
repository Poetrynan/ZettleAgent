import { RefObject, useState, useRef, useEffect, useCallback } from 'react';
import { GraphData, chatWithLlm } from '../../lib/tauri';
import { t } from '../../lib/i18n';

import {
  METHODOLOGY_TYPES,
  RelationFilter,
} from './graphHelpers';
import { getNoteColorMap, getRelationFilterConfig, getRelationTypes } from '../../lib/vizPalette';
import { useVizTheme } from '../../lib/useVizTheme';
import { type ForceParams, DEFAULT_FORCE_PARAMS } from './PixiGraph';

interface GraphHudProps {
  rawGraphData: GraphData;
  linkCount: number;
  semanticCount: number;
  semanticThreshold: number;
  setSemanticThreshold: (val: number) => void;
  hudCollapsed: boolean;
  setHudCollapsed: (collapsed: boolean | ((p: boolean) => boolean)) => void;
  isZh: boolean;
  state: any;
  selectedCluster: number | null;
  setSelectedCluster: (cluster: number | null) => void;
  relationFilter: RelationFilter;
  setRelationFilter: (rf: RelationFilter) => void;
  isLocalMode: boolean;
  setIsLocalMode: (mode: boolean) => void;
  focusNodeId: string | null;
  setFocusNodeId: (id: string | null) => void;
  localDepth: number;
  setLocalDepth: (depth: number) => void;
  hideOrphans: boolean;
  setHideOrphans: (hide: boolean) => void;
  folderFilter: Set<string>;
  setFolderFilter: (filter: Set<string> | ((p: Set<string>) => Set<string>)) => void;
  showFolderPicker: boolean;
  setShowFolderPicker: (show: boolean | ((p: boolean) => boolean)) => void;
  folderPickerRef: RefObject<HTMLDivElement | null>;
  folderBtnRef: RefObject<HTMLDivElement | null>;
  handleFilterSwitch: (cb: () => void) => void;
  forceParams: ForceParams;
  setForceParams: (p: ForceParams | ((prev: ForceParams) => ForceParams)) => void;
}

export function GraphHud({
  rawGraphData,
  linkCount,
  semanticCount,
  semanticThreshold,
  setSemanticThreshold,
  hudCollapsed,
  setHudCollapsed,
  isZh,
  state,
  selectedCluster,
  setSelectedCluster,
  relationFilter,
  setRelationFilter,
  isLocalMode,
  setIsLocalMode,
  focusNodeId,
  setFocusNodeId,
  localDepth,
  setLocalDepth,
  hideOrphans,
  setHideOrphans,
  folderFilter,
  setFolderFilter,
  showFolderPicker,
  setShowFolderPicker,
  folderPickerRef,
  folderBtnRef,
  handleFilterSwitch,
  forceParams,
  setForceParams,
}: GraphHudProps) {
  useVizTheme();
  const noteColors = getNoteColorMap();
  const relationFilterConfig = getRelationFilterConfig();
  const relationTypes = getRelationTypes();
  const methodologyKey = state.methodology || 'generic';
  const noteTypeLegend = METHODOLOGY_TYPES[methodologyKey] ?? METHODOLOGY_TYPES.generic;
  const relColor = (type: string) =>
    relationTypes.find((r) => r.type === type)?.color ?? 'var(--text-secondary)';

  // Local slider states for lag-free dragging
  const [localCenterStrength, setLocalCenterStrength] = useState(forceParams.centerStrength);
  const [localChargeStrength, setLocalChargeStrength] = useState(forceParams.chargeStrength);
  const [localLinkStrength, setLocalLinkStrength] = useState(forceParams.linkStrength);
  const [localLinkDistance, setLocalLinkDistance] = useState(forceParams.linkDistance);

  useEffect(() => {
    setLocalCenterStrength(forceParams.centerStrength);
    setLocalChargeStrength(forceParams.chargeStrength);
    setLocalLinkStrength(forceParams.linkStrength);
    setLocalLinkDistance(forceParams.linkDistance);
  }, [forceParams]);

  const debounceTimerRef = useRef<any>(null);
  const clusterWrapperRef = useRef<HTMLDivElement>(null);
  const clusterContainerRef = useRef<HTMLDivElement>(null);
  const hudBodyRef = useRef<HTMLDivElement>(null);
  const [clustersOverflowing, setClustersOverflowing] = useState(false);

  // Check if clusters overflow to show fade indicator
  useEffect(() => {
    const checkOverflow = () => {
      const el = clusterContainerRef.current;
      if (el) {
        setClustersOverflowing(el.scrollWidth > el.clientWidth + 1);
      }
    };
    checkOverflow();
    window.addEventListener('resize', checkOverflow);
    return () => window.removeEventListener('resize', checkOverflow);
  }, [rawGraphData.clusters]);

  // Convert vertical wheel to horizontal scroll for cluster container when HUD panel is hovered
  useEffect(() => {
    const hudBody = hudBodyRef.current;
    const clusterContainer = clusterContainerRef.current;
    if (!hudBody || !clusterContainer) return;
    const handleWheel = (e: WheelEvent) => {
      // Only intercept if cluster container is overflowing
      if (clusterContainer.scrollWidth <= clusterContainer.clientWidth) return;
      // Don't interfere with settings popover scrolling
      const target = e.target as Node;
      if (settingsPopoverRef.current && settingsPopoverRef.current.contains(target)) return;
      if (e.deltaY !== 0) {
        e.preventDefault();
        clusterContainer.scrollLeft += e.deltaY;
      }
    };
    hudBody.addEventListener('wheel', handleWheel, { passive: false });
    return () => hudBody.removeEventListener('wheel', handleWheel);
  }, []);
  const updateParentParams = useCallback((newParams: Partial<ForceParams>) => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setForceParams(prev => ({ ...prev, ...newParams }));
    }, 120);
  }, [setForceParams]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);
  // Folder calculation
  const organizedFolders = new Set<string>();
  if (rawGraphData) {
    for (const node of rawGraphData.nodes) {
      if (node.note_type && node.note_type !== 'unknown' && node.note_type !== '') {
        const normId = node.id.replace(/\\/g, '/');
        for (const vp of state.vaultPaths || []) {
          const normVp = vp.replace(/\\/g, '/');
          if (normId.startsWith(normVp)) {
            organizedFolders.add(vp);
            break;
          }
        }
      }
    }
  }

  const folderColors = ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];
  const MAX_INLINE = 10;
  const hasMore = (state.vaultPaths || []).length > MAX_INLINE;
  const inlinePaths = hasMore ? state.vaultPaths.slice(0, MAX_INLINE) : (state.vaultPaths || []);

  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);

  const settingsBtnRef = useRef<HTMLDivElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);

  // Close popovers on click outside
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (showSettings &&
          settingsPopoverRef.current &&
          settingsBtnRef.current &&
          !settingsPopoverRef.current.contains(e.target as Node) &&
          !settingsBtnRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
      if (showHelp) {
        const helpEl = document.querySelector('.kg-help-popover');
        const target = e.target as Node;
        if (helpEl && !helpEl.contains(target)) {
          setShowHelp(false);
        }
      }
    };
    document.addEventListener('mousedown', handleGlobalClick);
    return () => document.removeEventListener('mousedown', handleGlobalClick);
  }, [showSettings, showHelp]);

  const toggleFolder = (vp: string) => {
    handleFilterSwitch(() => {
      if (folderFilter.size === 0) {
        const next = new Set<string>((state.vaultPaths || []) as string[]);
        next.delete(vp);
        setFolderFilter(next);
        return;
      }
      const next = new Set<string>(folderFilter);
      if (next.has(vp)) next.delete(vp); else next.add(vp);
      if (next.size === state.vaultPaths.length) setFolderFilter(new Set());
      else setFolderFilter(next);
    });
  };

  const renderFolderRow = (vp: string, idx: number) => {
    const color = folderColors[idx % folderColors.length];
    const name = vp.replace(/\\/g, '/').split('/').filter(Boolean).pop() || vp;
    const isOrganized = organizedFolders.has(vp);
    const isChecked = folderFilter.size === 0 || folderFilter.has(vp);
    return (
      <label
        key={vp}
        className={`kg-folder-option ${!isOrganized ? 'disabled' : ''}`}
        title={isOrganized ? vp : (isZh ? '未经 AI 整理，请先运行智能整理' : 'Not organized yet')}
      >
        <input
          type="checkbox"
          checked={isChecked}
          disabled={!isOrganized}
          onChange={() => toggleFolder(vp)}
          className="kg-folder-checkbox"
          style={{ accentColor: isOrganized ? color : undefined }}
        />
        <span className="kg-folder-color-badge" style={{ backgroundColor: color }} />
        <span className="kg-folder-text">{name}</span>
      </label>
    );
  };

  const handleExplainCluster = async () => {
    if (selectedCluster === null || isSummarizing) return;
    
    // Find active notes in the cluster
    const clusterNodes = rawGraphData.nodes.filter(
      n => n.cluster === selectedCluster
    );
    
    if (clusterNodes.length === 0) {
      setAiSummary(isZh ? "当前聚类没有活跃笔记。" : "No active notes in this cluster.");
      return;
    }
    
    setIsSummarizing(true);
    setAiSummary(null);
    
    const clusterInfo = clusterNodes.map(n => ({
      title: n.label,
      type: n.note_type || 'unknown',
      importance: Math.round((n.pagerank ?? 0) * 100) / 100,
    })).slice(0, 30);
    const methodology = state.methodology || 'zettelkasten';
    const hubNode = clusterInfo.reduce((max, n) => n.importance > max.importance ? n : max, clusterInfo[0]);
    const typeBreakdown = clusterInfo.reduce((acc, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {} as Record<string, number>);
    const typeSummary = Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}:${c}`).join(', ');

    const prompt = isZh
      ? `你是一个${methodology.toUpperCase()}知识管理体系的专家。以下是知识图谱中一个聚类（第${selectedCluster}簇）的笔记信息：

笔记列表（共${clusterInfo.length}篇）：
${clusterInfo.map(n => `- 《${n.title}》类型:${n.type} 重要度:${n.importance}`).join('\n')}

类型分布：${typeSummary}
核心枢纽：《${hubNode.title}》（重要度最高）

请用简短精炼的语言（不超过60字）概括这个聚类的核心主题，并指出最关键的枢纽笔记和一条拓展建议。格式：核心主题｜枢纽：《标题》｜建议：一句话。不要包含前导词。`
      : `You are an expert in the ${methodology.toUpperCase()} knowledge management system. Below is a cluster (#${selectedCluster}) from the knowledge graph:

Notes (${clusterInfo.length} total):
${clusterInfo.map(n => `- "${n.title}" type:${n.type} importance:${n.importance}`).join('\n')}

Type distribution: ${typeSummary}
Hub node: "${hubNode.title}" (highest importance)

In under 25 words, summarize this cluster's core theme, identify the hub note, and suggest one expansion direction. Format: Theme | Hub: "title" | Suggestion: one sentence. No introductory words.`;

    try {
      const response = await chatWithLlm({
        messages: [{ role: 'user', content: prompt }],
        apiUrl: state.llmConfig?.apiUrl,
        apiKey: state.llmConfig?.apiKey,
        model: state.llmConfig?.model,
        providerId: state.llmConfig?.providerId,
      });
      
      setAiSummary(response.content.trim());
    } catch (err) {
      console.error("AI cluster explanation failed:", err);
      setAiSummary(isZh ? "AI 智能解读失败，请检查模型配置。" : "AI explanation failed. Please check LLM configuration.");
    } finally {
      setIsSummarizing(false);
    }
  };

  return (
    <>
      {/* Standalone Folder Picker (top-right) */}
      {state.vaultPaths && state.vaultPaths.length > 1 && (
        <div className="kg-hud kg-folder-picker-wrap">
          <div
            ref={folderBtnRef}
            className={`kg-folder-picker-btn ${showFolderPicker ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowFolderPicker(p => !p); }}
            title={isZh ? '筛选工作空间目录' : 'Filter Workspaces'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>{isZh ? '工作空间筛选' : 'Workspace Filter'}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="6 9 12 15 18 9"/></svg>
          </div>

          {showFolderPicker && (
            <div
              ref={folderPickerRef}
              className="kg-folder-picker-dropdown"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="kg-folder-picker-header">
                <span>{isZh ? '选择显示的工作空间' : 'Select Workspaces'}</span>
                <button
                  className="btn btn-xs btn-ghost"
                  onClick={() => handleFilterSwitch(() => setFolderFilter(new Set()))}
                  disabled={folderFilter.size === 0}
                >
                  {isZh ? '全部重置' : 'Reset All'}
                </button>
              </div>
              <div className="kg-folder-options-list">
                {inlinePaths.map((vp: string, idx: number) => renderFolderRow(vp, idx))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* AI Summary Bubble Overlay (Glassmorphism, displayed right above the HUD) */}
      {(isSummarizing || aiSummary) && (
        <div className="kg-ai-summary-bubble" onClick={(e) => e.stopPropagation()}>
          <div className="kg-ai-summary-header">
            <span className="kg-ai-summary-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`kg-ai-sparkle ${isSummarizing ? 'spin' : ''}`}>
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
              </svg>
              {isZh ? 'AI 专题解读' : 'AI Cluster Summary'}
            </span>
            <button className="kg-ai-summary-close" onClick={() => setAiSummary(null)}>×</button>
          </div>
          <div className="kg-ai-summary-body">
            {isSummarizing ? (
              <div className="kg-ai-loading">
                <span className="kg-spinner" />
                <span>{isZh ? 'AI 正在阅读卡片并提炼专题...' : 'AI is reading notes and summarizing...'}</span>
              </div>
            ) : (
              <div className="kg-ai-summary-content">
                {(() => {
                  // Parse the summary text into sections
                  const text = aiSummary || '';
                  const sections: { type: 'topic' | 'hub' | 'advice'; text: string }[] = [];
                  
                  // Split by ｜ or | delimiter
                  const parts = text.split(/[｜|]/).map(p => p.trim()).filter(Boolean);
                  
                  parts.forEach(part => {
                    if (part.startsWith('核心主题') || part.startsWith('Topic')) {
                      const label = isZh ? '核心主题' : 'TOPICS';
                      sections.push({ type: 'topic', text: part.replace(/^(核心主题|Topic)[：:]/, '').trim() || part });
                    } else if (part.startsWith('枢纽') || part.startsWith('Hub')) {
                      sections.push({ type: 'hub', text: part.replace(/^(枢纽|Hub)[：:]/, '').trim() || part });
                    } else if (part.startsWith('建议') || part.startsWith('Advice')) {
                      sections.push({ type: 'advice', text: part.replace(/^(建议|Advice)[：:]/, '').trim() || part });
                    } else if (sections.length === 0) {
                      sections.push({ type: 'topic', text: part });
                    } else {
                      // Append to last section
                      sections[sections.length - 1].text += ' ' + part;
                    }
                  });

                  const labels = {
                    topic: isZh ? '核心主题' : 'TOPIC',
                    hub: isZh ? '枢纽' : 'HUB',
                    advice: isZh ? '建议' : 'ADVICE',
                  };

                  const typeClasses = {
                    topic: 'kg-ai-section-label--topic',
                    hub: 'kg-ai-section-label--hub',
                    advice: 'kg-ai-section-label--advice',
                  };

                  return sections.map((section, i) => (
                    <div key={i} className="kg-ai-section">
                      <span className={`kg-ai-section-label ${typeClasses[section.type]}`}>
                        {labels[section.type]}
                      </span>
                      <span className="kg-ai-section-text">{section.text}</span>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main HUD Controls */}
      <div className={`kg-hud kg-bottom-panel ${hudCollapsed ? 'kg-bottom-panel--collapsed' : ''}`}>
        <div
          className="kg-hud-toggle"
          onClick={() => setHudCollapsed(prev => !prev)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg
              width={10} height={10} viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{
                transition: 'transform 0.25s ease',
                transform: hudCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span className="kg-hud-toggle-label">
              {isZh ? '图谱控制面板' : 'Graph Controls'}
            </span>
          </div>
        </div>

        <div ref={hudBodyRef} className={`kg-hud-body ${hudCollapsed ? 'kg-hud-body--collapsed' : ''}`}>
          {/* Row 1: Graph Info & AI Semantic Slider */}
          <div className="kg-panel-row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div className="kg-stat-group">
              <div className="kg-stat-badge kg-stat-badge--notes">
                <span>{rawGraphData.nodes.length}</span>
                <span style={{ opacity: 0.75, fontWeight: 500 }}>{t('graph.notes')}</span>
              </div>
              <div className="kg-stat-badge kg-stat-badge--links">
                <span>{linkCount}</span>
                <span style={{ opacity: 0.75, fontWeight: 500 }}>{t('graph.links')}</span>
              </div>
              <div className="kg-stat-badge kg-stat-badge--semantic">
                <span>{semanticCount}</span>
                <span style={{ opacity: 0.75, fontWeight: 500 }}>{t('graph.semantic')}</span>
              </div>
            </div>

            {/* AI Semantic Slider */}
            <div className="kg-slider-container" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="kg-similarity-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 3 }}>
                  <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                  <circle cx="12" cy="12" r="3" />
                  <line x1="12" y1="2" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                </svg>
                <span>{isZh ? '关联度' : 'Similarity'}</span>
                <span>{Math.round(semanticThreshold * 100)}%</span>
              </div>
              {(() => {
                const pct = ((semanticThreshold - 0.50) / 0.45) * 100;
                return (
                  <input
                    type="range"
                    min="0.50"
                    max="0.95"
                    step="0.05"
                    value={semanticThreshold}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      handleFilterSwitch(() => setSemanticThreshold(val));
                    }}
                    className="kg-slider"
                    style={{ ['--kg-slider-pct' as string]: `${pct}%` }}
                  />
                );
              })()}
            </div>
          </div>

          {/* Row 2: Clusters Selection & AI Summary Button */}
          <div className="kg-panel-row kg-panel-row--divider" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className={`kg-cluster-container-wrapper ${clustersOverflowing ? 'has-overflow' : ''}`} ref={clusterWrapperRef}>
                <div className="kg-cluster-container" ref={clusterContainerRef}>
                <div
                  className={`kg-cluster-chip ${selectedCluster === null ? 'active-all' : ''}`}
                  onClick={() => handleFilterSwitch(() => setSelectedCluster(null))}
                >
                  <div className="kg-legend-dot" style={{ background: 'linear-gradient(135deg, #10B981, #3B82F6)', width: 6, height: 6 }} />
                  <span>{isZh ? '全部' : 'All'}</span>
                </div>
                {(rawGraphData.clusters || []).map((cluster, index) => {
                  const isActive = selectedCluster === cluster.id;
                  const isTruncated = cluster.label.length > 15;
                  return (
                    <div
                      key={cluster.id}
                      className={`kg-cluster-chip ${isActive ? 'active-custom' : ''}`}
                      title={isTruncated ? cluster.label : undefined}
                      style={{
                        background: isActive ? `${cluster.color}12` : undefined,
                        borderColor: isActive ? `${cluster.color}35` : undefined,
                        color: isActive ? cluster.color : undefined,
                      }}
                      onClick={() => handleFilterSwitch(() => {
                        setSelectedCluster(isActive ? null : cluster.id);
                        setAiSummary(null); // Clear previous summary when switching
                      })}
                    >
                      <div className="kg-legend-dot" style={{ background: cluster.color, width: 6, height: 6 }} />
                      <span>
                        {isTruncated ? cluster.label.slice(0, 15) + '...' : cluster.label}
                        <span style={{ opacity: 0.6, fontSize: '10px', marginLeft: '3px' }}>({cluster.node_count})</span>
                      </span>
                    </div>
                  );
                })}
                </div>
                {(rawGraphData.clusters || []).length > 3 && (
                  <div className="kg-cluster-hint" style={{ fontSize: 9, color: 'var(--kg-text-faint, var(--text-tertiary))', marginTop: 2, whiteSpace: 'nowrap' }}>
                    {isZh ? '滑轮滚动查看更多' : 'Scroll for more'}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {selectedCluster !== null && (
                  <button
                    className="kg-ai-explain-btn"
                    onClick={handleExplainCluster}
                    disabled={isSummarizing}
                    style={{ margin: 0 }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={isSummarizing ? 'spin' : ''}>
                      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
                    </svg>
                    <span>{isZh ? 'AI 解读' : 'Explain'}</span>
                  </button>
                )}

                {/* Settings Trigger Icon (Compact ⚙️ button at the bottom right) */}
                <div
                  ref={settingsBtnRef}
                  className={`kg-settings-trigger ${showSettings ? 'active' : ''}`}
                  onClick={() => setShowSettings(p => !p)}
                  title={isZh ? '图谱高级配置' : 'Graph Settings'}
                  style={{ margin: 0 }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                </div>
              </div>
            </div>

          {/* Render the floating popover settings */}
          {showSettings && (
            <div ref={settingsPopoverRef} className="kg-settings-popover">
               <div className="kg-settings-popover-title">{isZh ? '图谱高级配置' : 'Advanced Graph Settings'}</div>
               
               {/* 1. Classification Legend (Types) */}
               {selectedCluster === null && (
                 <div className="kg-settings-section">
                   <div className="kg-settings-section-label">{isZh ? '分类图例' : 'Legend'}</div>
                   <div className="kg-panel-items" style={{ gap: 8 }}>
                     {METHODOLOGY_TYPES[state.methodology || 'generic'].map((type) => (
                       <div key={type} className="kg-legend-item">
                         <div className="kg-legend-dot" style={{ background: noteColors[type] }} />
                         <span className="kg-legend-text">{t(`type.${type}` as any)}</span>
                       </div>
                     ))}
                   </div>
                 </div>
               )}

               {/* 2. Relations filter */}
               <div className="kg-settings-section">
                 <div className="kg-settings-section-label">{isZh ? '关系筛选' : 'Relations'}</div>
                 <div className="kg-panel-items" style={{ gap: 5 }}>
                   {relationFilterConfig.map((rf) => (
                     <div
                       key={rf.key}
                       className={`kg-chip kg-settings-chip ${relationFilter === rf.key ? 'active' : ''}`}
                       style={relationFilter === rf.key ? { background: `${rf.color}15`, border: `1px solid ${rf.color}35`, color: rf.color } : {}}
                       onClick={() => handleFilterSwitch(() => setRelationFilter(rf.key))}
                     >
                       {rf.key !== 'all' && <div className="kg-legend-dot" style={{ width: 5, height: 5, background: rf.color }} />}
                       {isZh ? rf.labelZh : rf.labelEn}
                     </div>
                   ))}
                 </div>
               </div>

               {/* 3. Local graph toggle */}
               <div className="kg-settings-section">
                 <div className="kg-panel-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                   <span className="kg-settings-section-label" style={{ margin: 0 }}>{isZh ? '局部图谱' : 'Local Graph'}</span>
                   <button
                     className={`kg-toggle-switch ${isLocalMode ? 'active' : ''}`}
                     onClick={() => {
                       const next = !isLocalMode;
                       setIsLocalMode(next);
                       if (next) {
                         setFocusNodeId(state.currentFile || rawGraphData.nodes[0]?.id || null);
                       }
                       handleFilterSwitch(() => {});
                     }}
                     aria-label="Local Graph Mode"
                     role="switch"
                     aria-checked={isLocalMode}
                   >
                     <span className="kg-toggle-thumb" />
                   </button>
                 </div>
                 {isLocalMode && (
                   <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                     <span className="kg-depth-label-sm">{isZh ? '深度' : 'Depth'}</span>
                     {[1, 2, 3].map(d => (
                       <div
                         key={d}
                         className={`kg-chip kg-depth-chip-sm ${localDepth === d ? 'active kg-chip-active-canvas' : ''}`}
                         style={localDepth !== d ? { minWidth: 22 } : undefined}
                         onClick={() => { setLocalDepth(d); handleFilterSwitch(() => {}); }}
                       >
                         {d}
                       </div>
                     ))}
                     {focusNodeId && (
                       <span className="kg-focus-label-sm" title={focusNodeId} style={{ marginLeft: 4 }}>
                         <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
                         {(focusNodeId.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || focusNodeId)}
                       </span>
                     )}
                   </div>
                 )}
               </div>

               {/* 4. Orphans filter */}
               <div className="kg-settings-section">
                 <div className="kg-settings-section-label">{isZh ? '孤立节点' : 'Orphans'}</div>
                 <div className="kg-panel-items" style={{ gap: 6 }}>
                   <div
                     className={`kg-chip kg-settings-chip ${!hideOrphans ? 'active kg-chip-active-info' : ''}`}
                     onClick={() => handleFilterSwitch(() => setHideOrphans(false))}
                   >
                     {isZh ? '显示' : 'Show'}
                   </div>
                   <div
                     className={`kg-chip kg-settings-chip ${hideOrphans ? 'active kg-chip-active-danger' : ''}`}
                     onClick={() => handleFilterSwitch(() => setHideOrphans(true))}
                   >
                     {isZh ? '隐藏' : 'Hide'}
                   </div>
                 </div>
               </div>

               {/* 5. Force Parameters (Obsidian-style sliders) */}
               <div className="kg-settings-section">
                 <div className="kg-settings-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                   <span>{isZh ? '力学参数' : 'Forces'}</span>
                   <button
                     className="btn btn-xs btn-ghost"
                     style={{ fontSize: 9, padding: '1px 6px' }}
                     onClick={() => {
                       setLocalCenterStrength(DEFAULT_FORCE_PARAMS.centerStrength);
                       setLocalChargeStrength(DEFAULT_FORCE_PARAMS.chargeStrength);
                       setLocalLinkStrength(DEFAULT_FORCE_PARAMS.linkStrength);
                       setLocalLinkDistance(DEFAULT_FORCE_PARAMS.linkDistance);
                       setForceParams(DEFAULT_FORCE_PARAMS);
                     }}
                   >
                     {isZh ? '重置' : 'Reset'}
                   </button>
                 </div>

                 {/* Center force */}
                 <div className="kg-force-slider-row">
                   <span className="kg-force-slider-label">{isZh ? '中心引力' : 'Center'}</span>
                   <input
                     type="range" min="0" max="0.2" step="0.005"
                     value={localCenterStrength}
                     onChange={(e) => {
                       const val = parseFloat(e.target.value);
                       setLocalCenterStrength(val);
                       updateParentParams({ centerStrength: val });
                     }}
                     className="kg-slider"
                     style={{ ['--kg-slider-pct' as string]: `${(localCenterStrength / 0.2) * 100}%` }}
                   />
                   <span className="kg-force-slider-val">{localCenterStrength.toFixed(3)}</span>
                 </div>

                 {/* Repel force (display absolute value) */}
                 <div className="kg-force-slider-row">
                   <span className="kg-force-slider-label">{isZh ? '排斥力' : 'Repel'}</span>
                   <input
                     type="range" min="0" max="2500" step="50"
                     value={Math.abs(localChargeStrength)}
                     onChange={(e) => {
                       const val = parseFloat(e.target.value);
                       setLocalChargeStrength(-val);
                       updateParentParams({ chargeStrength: -val });
                     }}
                     className="kg-slider"
                     style={{ ['--kg-slider-pct' as string]: `${(Math.abs(localChargeStrength) / 2500) * 100}%` }}
                   />
                   <span className="kg-force-slider-val">{Math.abs(localChargeStrength)}</span>
                 </div>

                 {/* Link force */}
                 <div className="kg-force-slider-row">
                    <span className="kg-force-slider-label">{isZh ? '连线拉力' : 'Link'}</span>
                    <input
                      type="range" min="0" max="1.0" step="0.02"
                      value={localLinkStrength}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setLocalLinkStrength(val);
                        updateParentParams({ linkStrength: val });
                      }}
                      className="kg-slider"
                      style={{ ['--kg-slider-pct' as string]: `${localLinkStrength * 100}%` }}
                    />
                    <span className="kg-force-slider-val">{localLinkStrength.toFixed(2)}</span>
                 </div>

                 {/* Link distance */}
                 <div className="kg-force-slider-row">
                   <span className="kg-force-slider-label">{isZh ? '连线距离' : 'Distance'}</span>
                   <input
                     type="range" min="50" max="500" step="10"
                     value={localLinkDistance}
                     onChange={(e) => {
                       const val = parseFloat(e.target.value);
                       setLocalLinkDistance(val);
                       updateParentParams({ linkDistance: val });
                     }}
                     className="kg-slider"
                     style={{ ['--kg-slider-pct' as string]: `${((localLinkDistance - 50) / 450) * 100}%` }}
                   />
                   <span className="kg-force-slider-val">{localLinkDistance}</span>
                 </div>
               </div>
            </div>
          )}
        </div>
      </div>

      {/* Help Button — bottom-right */}
      <div className="kg-help-wrap">
        <button
          type="button"
          className={`kg-help-btn ${showHelp ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); setShowHelp(p => !p); }}
          onMouseDown={(e) => e.stopPropagation()}
          title={isZh ? '图谱说明' : 'Graph Guide'}
          aria-expanded={showHelp}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
        {showHelp && (
          <div
            className="kg-help-popover"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="kg-help-popover-title">
              {isZh ? '知识图谱说明' : 'Knowledge Graph Guide'}
            </div>
            <div className="kg-help-popover-body">
              <div><strong className="kg-help-term-notes">{isZh ? '笔记' : 'Notes'}</strong> — {isZh ? '图谱中显示的笔记卡片总数' : 'Total note cards shown in the graph'}</div>
              <div><strong className="kg-help-term-links">{isZh ? '连接' : 'Links'}</strong> — {isZh ? '笔记间的 Wikilink 连接数' : 'Wikilink connections between notes'}</div>
              <div><strong className="kg-help-term-semantic">{isZh ? '语义' : 'Semantic'}</strong> — {isZh ? 'AI 发现的语义关联数（余弦相似度 ≥ 阈值）' : 'AI-discovered semantic links (cosine similarity ≥ threshold)'}</div>
              <div className="kg-help-popover-section">
                <div><strong className="kg-help-term-size">{isZh ? '节点大小' : 'Node size'}</strong> — {isZh ? '由 PageRank 重要度决定，越大越重要' : 'Determined by PageRank importance — larger = more important'}</div>
              </div>
              <div>
                <strong className="kg-help-term-node">{isZh ? '节点颜色' : 'Node color'}</strong>
                {' — '}
                {isZh ? (
                  <>
                    按笔记类型着色（
                    {noteTypeLegend.map((type, i) => (
                      <span key={type}>
                        {i > 0 && '、'}
                        <span className="kg-help-inline" style={{ color: noteColors[type] }}>
                          {t(`type.${type}` as any)}
                        </span>
                      </span>
                    ))}
                    等），语义色相在深浅主题下保持一致
                  </>
                ) : (
                  <>
                    Colored by note type (
                    {noteTypeLegend.map((type, i) => (
                      <span key={type}>
                        {i > 0 && ', '}
                        <span className="kg-help-inline" style={{ color: noteColors[type] }}>
                          {t(`type.${type}` as any)}
                        </span>
                      </span>
                    ))}
                    , etc.); hues stay consistent across themes
                  </>
                )}
              </div>
              <div>
                <strong className="kg-help-term-edge">{isZh ? '连线颜色' : 'Edge color'}</strong>
                {' — '}
                {isZh ? (
                  <>
                    按关系类型着色（
                    <span className="kg-help-inline" style={{ color: relColor('wikilink') }}>链接</span>、
                    <span className="kg-help-inline" style={{ color: relColor('semantic') }}>语义</span>、
                    <span className="kg-help-inline" style={{ color: relColor('supports') }}>支持</span>、
                    <span className="kg-help-inline" style={{ color: relColor('contradicts') }}>矛盾</span>
                    等）；悬停时高亮
                  </>
                ) : (
                  <>
                    Colored by relation (
                    <span className="kg-help-inline" style={{ color: relColor('wikilink') }}>link</span>,{' '}
                    <span className="kg-help-inline" style={{ color: relColor('semantic') }}>semantic</span>,{' '}
                    <span className="kg-help-inline" style={{ color: relColor('supports') }}>supports</span>,{' '}
                    <span className="kg-help-inline" style={{ color: relColor('contradicts') }}>contradicts</span>
                    , etc.); highlighted on hover
                  </>
                )}
              </div>
              <div><strong className="kg-help-term-canvas">{isZh ? '画布主题' : 'Canvas theme'}</strong> — {t('graph.help.canvasTheme')}</div>
              <div><strong className="kg-help-term-cluster">{isZh ? '聚类标签' : 'Cluster labels'}</strong> — {isZh ? 'AI 自动将相关笔记分组，点击标签可筛选' : 'AI auto-groups related notes — click a label to filter'}</div>
              <div><strong className="kg-help-term-slider">{isZh ? '关联度滑块' : 'Similarity slider'}</strong> — {isZh ? '调整语义边的最低相似度，越高越严格' : 'Adjust minimum similarity for semantic edges — higher = stricter'}</div>
              <div><strong className="kg-help-term-orphan">{isZh ? '孤立节点' : 'Orphan nodes'}</strong> — {isZh ? '没有任何连接的笔记，可在设置中隐藏' : 'Notes with no connections — can be hidden in settings'}</div>
            </div>
            <button
              type="button"
              className="kg-help-popover-close"
              onClick={() => setShowHelp(false)}
            >
              {isZh ? '关闭' : 'Close'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
