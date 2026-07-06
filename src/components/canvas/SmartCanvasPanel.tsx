/**
 * SmartCanvasPanel — AI 驱动的画布填充面板
 *
 * 功能：
 * 1. 搜索笔记并预览结果
 * 2. 用户勾选要添加的笔记
 * 3. 自动连接到现有画布节点
 * 4. 快速建议（基于当前画布内容）
 *
 * 进度由 InteractiveCanvas 的悬浮进度条统一管理
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { searchChunks, type SearchResult } from '../../lib/tauri';

interface SmartCanvasPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onAddNotes: (results: SearchResult[]) => void;
  canvasNodePaths: string[];
  lang: string;
}

export function SmartCanvasPanel({
  isOpen,
  onClose,
  onAddNotes,
  canvasNodePaths,
  lang,
}: SmartCanvasPanelProps) {
  const isZh = lang === 'zh';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // 搜索
  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(false);
    try {
      const chunks = await searchChunks({ query: query.trim(), limit: 15, mode: 'hybrid' });

      // 去重：过滤掉已在画布上的笔记
      const seenPaths = new Set<string>();
      const canvasPaths = new Set(canvasNodePaths.map(p => p.replace(/\\/g, '/')));

      const filtered = chunks.filter(r => {
        const norm = r.file_path.replace(/\\/g, '/');
        if (seenPaths.has(norm) || canvasPaths.has(norm)) return false;
        seenPaths.add(norm);
        return true;
      }).slice(0, 10);

      setResults(filtered);
      setSelected(new Set(filtered.map((_, i) => i))); // 默认全选
      setSearched(true);
    } catch (err) {
      console.error('Smart Canvas search failed:', err);
    }
    setLoading(false);
  }, [query, canvasNodePaths]);

  // 切换选择
  const toggleSelect = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // 全选/取消全选
  const toggleAll = () => {
    if (selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((_, i) => i)));
    }
  };

  // 添加选中的笔记
  const handleAdd = () => {
    const selectedResults = results.filter((_, i) => selected.has(i));
    if (selectedResults.length === 0) return;
    onAddNotes(selectedResults);
  };

  // 获取文件名
  const getFileName = (path: string) => {
    return path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || path;
  };

  // 截断内容
  const truncate = (text: string, maxLen: number) => {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  };

  if (!isOpen) return null;

  return (
    <div className="smart-canvas-panel" onMouseDown={e => e.stopPropagation()}>
      {/* 头部 */}
      <div className="smart-canvas-header">
        <div className="smart-canvas-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z" />
          </svg>
          <span>{isZh ? 'Smart Canvas' : 'Smart Canvas'}</span>
        </div>
        <button className="smart-canvas-close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 搜索框 V2 */}
      <div className="smart-canvas-search">
        <div className="smart-canvas-search-inner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="smart-canvas-input"
            placeholder={isZh ? '搜索主题，自动填充画布...' : 'Search topic to populate canvas...'}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(); if (e.key === 'Escape') onClose(); }}
            disabled={loading}
          />
        </div>
        <button
          className="smart-canvas-search-btn"
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? (
            <span className="smart-canvas-spinner" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
      </div>

      {/* 结果列表 */}
      {searched && results.length > 0 && (
        <div className="smart-canvas-results">
          <div className="smart-canvas-results-header">
            <span className="smart-canvas-results-count">
              {isZh ? `找到 ${results.length} 个相关笔记` : `Found ${results.length} related notes`}
            </span>
            <button className="smart-canvas-select-all" onClick={toggleAll}>
              {selected.size === results.length
                ? (isZh ? '取消全选' : 'Deselect All')
                : (isZh ? '全选' : 'Select All')
              }
            </button>
          </div>

          <div className="smart-canvas-results-list">
            {results.map((result, index) => {
              const isSelected = selected.has(index);
              const fileName = getFileName(result.file_path);
              const score = result.score != null ? Math.min(99, Math.round(Math.abs(result.score) * 100)) : null;

              return (
                <div
                  key={index}
                  className={`smart-canvas-result-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleSelect(index)}
                >
                  <div className="smart-canvas-result-checkbox">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      {isSelected ? (
                        <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m9 12 2 2 4-4" /></>
                      ) : (
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      )}
                    </svg>
                  </div>

                  <div className="smart-canvas-result-content">
                    <div className="smart-canvas-result-title">
                      <span className="smart-canvas-result-name">{fileName}</span>
                      {score !== null && (
                        <span className="smart-canvas-result-score">{score}%</span>
                      )}
                    </div>
                    {result.content && (
                      <div className="smart-canvas-result-snippet">
                        {truncate(result.content, 120)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 添加按钮 */}
          <div className="smart-canvas-footer">
            <button
              className="smart-canvas-add-btn"
              onClick={handleAdd}
              disabled={selected.size === 0}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {isZh
                ? `添加 ${selected.size} 个笔记到画布`
                : `Add ${selected.size} notes to canvas`
              }
            </button>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {searched && results.length === 0 && (
        <div className="smart-canvas-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <span>{isZh ? '未找到相关笔记' : 'No related notes found'}</span>
          <span className="smart-canvas-empty-hint">
            {isZh ? '尝试不同的关键词' : 'Try different keywords'}
          </span>
        </div>
      )}

      {/* 初始状态提示 */}
      {!searched && !loading && (
        <div className="smart-canvas-hint">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z" />
          </svg>
          <span>{isZh ? '输入主题搜索相关笔记' : 'Search for related notes by topic'}</span>
          <span className="smart-canvas-hint-detail">
            {isZh ? 'AI 会自动连接到现有笔记' : 'AI will auto-connect to existing notes'}
          </span>
        </div>
      )}
    </div>
  );
}
