import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import { listMarkdownFiles } from '../../lib/tauri';
import { IconFile } from '../icons';

/**
 * Quick Switcher — Ctrl+P modal for rapidly opening notes by name.
 * Fuzzy-matches against file names, sorted by relevance.
 */
export function QuickSwitcher() {
  const { state, setCurrentFile, setView } = useApp();
  const isZh = state.lang === 'zh';
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load files when vault changes
  useEffect(() => {
    if (!state.vaultPath) return;
    listMarkdownFiles(state.vaultPath).then(setFiles).catch(console.error);
  }, [state.vaultPath]);

  // Listen for Ctrl+P / Cmd+P
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setIsOpen(prev => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Filter files by query
  useEffect(() => {
    if (!query.trim()) {
      setFilteredFiles(files.slice(0, 20));
      setSelectedIndex(0);
      return;
    }
    const q = query.toLowerCase();
    const matches = files
      .map(f => {
        const name = f.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || f;
        const nameLower = name.toLowerCase();
        // Score: exact start > includes > fuzzy
        let score = 0;
        if (nameLower.startsWith(q)) score = 3;
        else if (nameLower.includes(q)) score = 2;
        else {
          // Fuzzy: check if all chars appear in order
          let qi = 0;
          for (const c of nameLower) {
            if (qi < q.length && c === q[qi]) qi++;
          }
          if (qi === q.length) score = 1;
        }
        return { file: f, name, score };
      })
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 20)
      .map(m => m.file);
    setFilteredFiles(matches);
    setSelectedIndex(0);
  }, [query, files]);

  // Scroll selected item into view when index changes
  useEffect(() => {
    if (!listRef.current || filteredFiles.length === 0) return;
    const container = listRef.current;
    const selectedItem = container.children[selectedIndex] as HTMLElement;
    if (!selectedItem) return;

    const containerHeight = container.clientHeight;
    const containerTop = container.scrollTop;
    const containerBottom = containerTop + containerHeight;

    const itemTop = selectedItem.offsetTop;
    const itemHeight = selectedItem.clientHeight;
    const itemBottom = itemTop + itemHeight;

    if (itemTop < containerTop) {
      container.scrollTop = itemTop;
    } else if (itemBottom > containerBottom) {
      container.scrollTop = itemBottom - containerHeight;
    }
  }, [selectedIndex, filteredFiles.length]);

  const handleSelect = useCallback((file: string) => {
    setCurrentFile(file);
    setView('note');
    setIsOpen(false);
  }, [setCurrentFile, setView]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filteredFiles.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filteredFiles[selectedIndex]) {
      handleSelect(filteredFiles[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
    }
  };

  const getFileName = (path: string) =>
    path.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || path;

  const getRelDir = (path: string) => {
    if (!state.vaultPath) return '';
    const rel = path.replace(/\\/g, '/').replace(state.vaultPath.replace(/\\/g, '/'), '').replace(/^\//, '');
    const parts = rel.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  };

  if (!isOpen) return null;

  return (
    <div className="quick-switcher-overlay" onClick={() => setIsOpen(false)}>
      <div className="quick-switcher-modal" onClick={e => e.stopPropagation()}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <svg 
            width="15" 
            height="15" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2.5" 
            style={{ position: 'absolute', left: '18px', color: 'var(--text-tertiary)' }}
          >
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className="quick-switcher-input"
            type="text"
            placeholder={isZh ? "输入关键词搜索笔记..." : "Type to search notes…"}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{ paddingLeft: '44px' }}
          />
        </div>
        <div ref={listRef} className="quick-switcher-list">
          {filteredFiles.length === 0 ? (
            <div className="quick-switcher-empty">{isZh ? "未找到匹配笔记" : "No matching notes"}</div>
          ) : (
            filteredFiles.map((file, i) => (
              <button
                key={file}
                className={`quick-switcher-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleSelect(file)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <IconFile size={14} />
                <span className="quick-switcher-item-name">{getFileName(file)}</span>
                {getRelDir(file) && (
                  <span className="quick-switcher-item-path">{getRelDir(file)}</span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="quick-switcher-hint">
          <span><kbd>↑↓</kbd> {isZh ? '选择' : 'navigate'}</span>
          <span><kbd>↵</kbd> {isZh ? '打开' : 'open'}</span>
          <span><kbd>esc</kbd> {isZh ? '关闭' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}
