/**
 * SearchPanel — 独立的全局内容搜索面板 (Ctrl+Shift+F)
 *
 * 设计参考: VS Code Search + Obsidian Search
 * 特性:
 * 1. 搜索结果按文件分组，每组可折叠
 * 2. 每个结果显示匹配上下文片段 + 高亮关键词
 * 3. 显示统计: "N results in M files"
 * 4. 大小写敏感切换
 * 5. 点击结果跳转到文件
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getEmbeddingStats, type SearchResult } from '../../lib/tauri';
import {
  createRerankedSearcher,
  type RerankTier,
  type RerankDegradeReason,
} from '../../lib/rerankSearch';
import { t } from '../../lib/i18n';
import { IconSearch, IconFile, IconChevronRight, IconClose } from '../icons';

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface GroupedResult {
  filePath: string;
  fileName: string;
  matches: Array<SearchResult & { snippetHtml: string }>;
}

/** Tier → label key. Keyed maps rather than inline ternaries so adding a tier is a
 *  compile error here instead of a silently missing badge. */
const TIER_KEYS: Record<RerankTier, Parameters<typeof t>[0]> = {
  off: 'search.rerank.tier.off',
  lexical: 'search.rerank.tier.lexical',
  crossEncoder: 'search.rerank.tier.crossEncoder',
};

const TIER_REASON_KEYS: Record<RerankDegradeReason, Parameters<typeof t>[0]> = {
  modelMissing: 'search.rerank.degraded.modelMissing',
  modelUnavailable: 'search.rerank.degraded.modelUnavailable',
  tierNotBridged: 'search.rerank.degraded.tierNotBridged',
};

export function SearchPanel({ isOpen, onClose }: SearchPanelProps) {
  const { state, setCurrentFile, setView } = useApp();
  const isZh = state.lang === 'zh';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [hasEmbeddingIndex, setHasEmbeddingIndex] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  // Which rerank tier ordered what is currently on screen, and — when it is not
  // the tier the user picked — why. Never derived from the setting: derived from
  // the answer, so the panel cannot claim a tier that did not run.
  const [tier, setTier] = useState<RerankTier | null>(null);
  const [tierReason, setTierReason] = useState<RerankDegradeReason | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One searcher for this panel. It carries the request token that lets a slow
  // cross-encoder answer be dropped instead of overwriting a newer result set —
  // the `streamSessionIdRef` idiom, kept per-surface so other panels' searches
  // cannot invalidate ours.
  const searcherRef = useRef(createRerankedSearcher());

  // Check embedding index
  useEffect(() => {
    getEmbeddingStats()
      .then(stats => setHasEmbeddingIndex(stats.has_index && stats.indexed_chunks > 0))
      .catch(() => {});
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setResults([]);
      setSearched(false);
      setTier(null);
      setTierReason(null);
      setCollapsedFiles(new Set());
    }
  }, [isOpen]);

  // Esc to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const highlightSnippet = useCallback((text: string, q: string, caseSensitive: boolean): string => {
    let snippet = text.length > 200 ? text.substring(0, 200) + '...' : text;
    snippet = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const words = q.trim().split(/\s+/).filter(w => w.length >= 1);
    for (const word of words) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(`(${escaped})`, flags);
      snippet = snippet.replace(regex, '<mark class="search-highlight">$1</mark>');
    }
    return snippet;
  }, []);

  // Debounced search
  const doSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearched(false);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searcherRef.current({
          query: trimmed,
          limit: 50,
          mode: hasEmbeddingIndex ? 'hybrid' : 'fts',
        });
        // A cross-encoder pass over 32 candidates easily outlives two more
        // keystrokes. Dropping a superseded answer here is the whole point of the
        // token: without it the panel would flicker back to an older query's hits.
        if (res.stale) return;
        setResults(res.results);
        setTier(res.tier);
        setTierReason(res.reason ?? null);
        setSearched(true);
        setCollapsedFiles(new Set());
      } catch (err) {
        console.error('Search panel failed:', err);
        setResults([]);
        setTier(null);
        setTierReason(null);
        setSearched(true);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, [hasEmbeddingIndex]);

  // Group results by file
  const groupedResults: GroupedResult[] = useMemo(() => {
    const map = new Map<string, GroupedResult>();
    for (const r of results) {
      const normPath = r.file_path.replace(/\\/g, '/');
      if (!map.has(normPath)) {
        const fileName = normPath.split('/').pop()?.replace(/\.md$/, '') || normPath;
        map.set(normPath, {
          filePath: r.file_path,
          fileName,
          matches: [],
        });
      }
      map.get(normPath)!.matches.push({
        ...r,
        snippetHtml: highlightSnippet(r.content, query, matchCase),
      });
    }
    return Array.from(map.values());
  }, [results, query, matchCase, highlightSnippet]);

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const handleOpenFile = (filePath: string) => {
    setCurrentFile(filePath);
    setView('note');
  };

  if (!isOpen) return null;

  const totalMatches = results.length;
  const totalFiles = groupedResults.length;

  return (
    <div className="search-panel-overlay" onClick={onClose}>
      <div className="search-panel-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="search-panel-header">
          <div className="search-panel-title">
            <IconSearch size={16} />
            <span>{isZh ? '搜索' : 'Search'}</span>
          </div>
          <button className="search-panel-close" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>

        {/* Search Input */}
        <div className="search-panel-input-row">
          <div className="search-panel-input-wrapper">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="search-panel-input-icon"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              ref={inputRef}
              type="text"
              className="search-panel-input"
              placeholder={isZh ? '搜索笔记内容...' : 'Search note content...'}
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                doSearch(e.target.value);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && groupedResults.length > 0) {
                  handleOpenFile(groupedResults[0].filePath);
                  onClose();
                }
              }}
            />
            {query && (
              <button
                className="search-panel-clear-btn"
                onClick={() => { setQuery(''); setResults([]); setSearched(false); inputRef.current?.focus(); }}
                title={isZh ? '清除' : 'Clear'}
              >
                <IconClose size={12} />
              </button>
            )}
          </div>
          <button
            className={`search-panel-option-btn ${matchCase ? 'active' : ''}`}
            onClick={() => {
              setMatchCase(prev => !prev);
              if (query.trim().length >= 2) doSearch(query);
            }}
            title={isZh ? '区分大小写' : 'Match Case'}
          >
            <span style={{ fontWeight: 700, fontSize: '11px' }}>Aa</span>
          </button>
        </div>

        {/* Results */}
        <div className="search-panel-results">
          {isSearching ? (
            <div className="search-panel-loading">
              <span className="spinner" />
              <span>{isZh ? '搜索中...' : 'Searching...'}</span>
            </div>
          ) : !searched ? (
            <div className="search-panel-hint">
              <IconSearch size={32} />
              <span>{isZh ? '输入至少 2 个字符开始搜索' : 'Type at least 2 characters to search'}</span>
              <span className="search-panel-hint-sub">
                {hasEmbeddingIndex
                  ? (isZh ? '使用混合搜索（语义 + 关键词）' : 'Using hybrid search (semantic + keyword)')
                  : (isZh ? '使用关键词搜索' : 'Using keyword search')
                }
              </span>
            </div>
          ) : totalMatches === 0 ? (
            <div className="search-panel-empty">
              <IconSearch size={32} />
              <span>{isZh ? `未找到 "${query}" 的匹配` : `No matches for "${query}"`}</span>
            </div>
          ) : (
            <>
              {/* Stats bar */}
              <div className="search-panel-stats">
                {isZh
                  ? `${totalMatches} 个结果 · ${totalFiles} 个文件`
                  : `${totalMatches} results in ${totalFiles} files`}
                {tier && (
                  <span
                    data-testid="search-rerank-tier"
                    data-tier={tier}
                    title={tierReason ? t(TIER_REASON_KEYS[tierReason]) : undefined}
                    style={{
                      marginLeft: 8,
                      opacity: 0.75,
                      fontSize: 'var(--text-xs)',
                    }}
                  >
                    · {t('search.rerank.tierLabel')}: {t(TIER_KEYS[tier])}
                    {tierReason ? ' ⚠' : ''}
                  </span>
                )}
              </div>
              {/* The degrade notice is spelled out, not just hinted by the badge:
                  a mode that silently reports itself as active while a lower tier
                  does the work is the bug this whole path exists to fix. */}
              {tierReason && (
                <div
                  role="status"
                  data-testid="search-rerank-degraded"
                  className="search-panel-stats"
                  style={{ opacity: 0.7 }}
                >
                  {t(TIER_REASON_KEYS[tierReason])}
                </div>
              )}

              {/* Grouped results */}
              <div className="search-panel-groups">
                {groupedResults.map(group => {
                  const isCollapsed = collapsedFiles.has(group.filePath);
                  return (
                    <div key={group.filePath} className="search-group">
                      {/* File header — click to collapse/expand */}
                      <div
                        className="search-group-header"
                        onClick={() => toggleFileCollapse(group.filePath)}
                      >
                        <span
                          className="search-group-chevron"
                          style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                        >
                          <IconChevronRight size={12} />
                        </span>
                        <IconFile size={13} />
                        <span
                          className="search-group-name"
                          title={group.filePath}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenFile(group.filePath);
                          }}
                        >
                          {group.fileName}
                        </span>
                        <span className="search-group-count">{group.matches.length}</span>
                      </div>

                      {/* Match items */}
                      {!isCollapsed && (
                        <div className="search-group-matches">
                          {group.matches.map((match, idx) => (
                            <button
                              key={`${match.file_path}-${match.chunk_id}-${idx}`}
                              className="search-match-item"
                              onClick={() => {
                                handleOpenFile(match.file_path);
                                onClose();
                              }}
                            >
                              <div
                                className="search-match-snippet"
                                dangerouslySetInnerHTML={{ __html: match.snippetHtml }}
                              />
                              {match.score > 0 && (
                                <span className="search-match-score">
                                  {match.score.toFixed(1)}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="search-panel-footer">
          <span><kbd>↵</kbd> {isZh ? '打开第一个结果' : 'Open first result'}</span>
          <span><kbd>esc</kbd> {isZh ? '关闭' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}
