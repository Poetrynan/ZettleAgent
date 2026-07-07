import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { DirTreeNode } from '../../lib/tauri';
import { IconFolder, IconFolderOpen, IconFile } from '../icons';
import { TreeSectionHeader } from './tree/TreeSectionHeader';
import { TreeChevron, TreeIndentSpacer, TreeCountBadge } from './tree/TreeRowParts';

interface BookmarksPanelProps {
  expandFolder: (path: string) => void;
  toggleFolder: (path: string) => void;
  revealFile: (path: string) => void;
  expandedFolders: Set<string>;
  trees: Array<{ rootPath: string; rootName: string; tree: DirTreeNode | null }>;
  dailyTree: DirTreeNode | null;
  searchExpandedFolders: Set<string>;
  onContextMenu: (e: React.MouseEvent, node: DirTreeNode) => void;
}

const BookmarkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
  </svg>
);

const CalendarIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

export function SidebarBookmarksPanel({
  expandFolder,
  toggleFolder,
  revealFile,
  expandedFolders,
  trees: _trees,
  dailyTree,
  searchExpandedFolders,
  onContextMenu,
}: BookmarksPanelProps) {
  const { state, setCurrentFile, setView } = useApp();

  const [bmCollapsed, setBmCollapsed] = useState(() => {
    try { return localStorage.getItem('zettelagent-bookmarks-collapsed') === 'true'; } catch { return false; }
  });

  void _trees;

  const toggleBmCollapsed = () => {
    setBmCollapsed(v => {
      const next = !v;
      localStorage.setItem('zettelagent-bookmarks-collapsed', String(next));
      return next;
    });
  };

  const countDailyNotes = (tree: DirTreeNode | null): number => {
    if (!tree) return 0;
    if (tree.file_count > 0) return tree.file_count;
    const walk = (node: DirTreeNode): number => {
      if (!node.is_dir) return 1;
      return (node.children ?? []).reduce((sum, child) => sum + walk(child), 0);
    };
    return walk(tree);
  };

  const renderDailyNode = (node: DirTreeNode, depth: number): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path) || searchExpandedFolders.has(node.path);

    if (node.is_dir) {
      return (
        <div key={node.path} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            className="tree-item"
            onClick={() => expandFolder(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, node);
            }}
            style={{ '--depth': depth } as React.CSSProperties}
          >
            {/* Render vertical nesting guides based on depth */}
            {Array.from({ length: depth }).map((_, idx) => (
              <span
                key={idx}
                className="tree-indent-guide"
                style={{
                  left: `calc(var(--tree-base-pad) + ${idx} * var(--tree-indent) + 8px)`
                }}
              />
            ))}
            <TreeChevron expanded={isExpanded} />
            <span className="tree-folder-icon">
              {isExpanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
            </span>
            <span className="tree-item-label" title={node.name}>{node.name}</span>
            <TreeCountBadge count={node.file_count} />
          </div>
          {isExpanded && node.children && (
            <div className="tree-children-enter">
              {node.children.map((child) => renderDailyNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const active = state.currentFile === node.path;
    return (
      <div
        key={node.path}
        className={`tree-item ${active ? 'active' : ''}`}
        onClick={() => {
          setCurrentFile(node.path);
          setView('note');
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node);
        }}
        style={{ '--depth': depth } as React.CSSProperties}
      >
        {/* Render vertical nesting guides based on depth */}
        {Array.from({ length: depth }).map((_, idx) => (
          <span
            key={idx}
            className="tree-indent-guide"
            style={{
              left: `calc(var(--tree-base-pad) + ${idx} * var(--tree-indent) + 8px)`
            }}
          />
        ))}
        <TreeIndentSpacer />
        <span className="tree-file-icon"><IconFile size={14} /></span>
        <span className="tree-item-label" title={node.name}>
          {node.name.replace(/\.md$/, '')}
        </span>
      </div>
    );
  };

  return (
    <>
      {state.bookmarks && state.bookmarks.length > 0 && (
        <div className="tree-section-block">
          <TreeSectionHeader
            label={state.lang === 'zh' ? '书签 / 收藏' : 'Bookmarks'}
            expanded={!bmCollapsed}
            onToggle={toggleBmCollapsed}
            count={state.bookmarks.length}
            icon={<BookmarkIcon />}
          />
          {!bmCollapsed && (
            <div>
              {state.bookmarks.map((bpath) => {
                const parts = bpath.replace(/\\/g, '/').split('/');
                const name = parts[parts.length - 1];
                const isDir = !bpath.endsWith('.md') && !bpath.endsWith('.canvas');
                const cleanName = isDir ? name : name.replace(/\.md$/, '');
                const active = state.currentFile === bpath;
                return (
                  <div
                    key={bpath}
                    className={`tree-item ${active ? 'active' : ''}`}
                    onClick={() => {
                      if (isDir) {
                        expandFolder(bpath);
                        setTimeout(() => revealFile(bpath), 50);
                      } else {
                        setCurrentFile(bpath);
                        setView('note');
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenu(e, { name, path: bpath, is_dir: isDir, children: [], file_count: 0 });
                    }}
                    style={{ '--depth': 0 } as React.CSSProperties}
                  >
                    <TreeIndentSpacer />
                    <span className="tree-file-icon">
                      {isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
                    </span>
                    <span className="tree-item-label" title={bpath}>
                      {cleanName}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {(() => {
        const dailyKey = '__daily_notes__';
        const isDailyExpanded = expandedFolders.has(dailyKey) || searchExpandedFolders.has(dailyKey);
        const dailyChildren = dailyTree?.children ?? [];
        const dailyFileCount = countDailyNotes(dailyTree);

        return (
          <div className="tree-section-block">
            <TreeSectionHeader
              label={state.lang === 'zh' ? '日记 / 每日笔记' : 'Daily Notes'}
              expanded={isDailyExpanded}
              onToggle={() => toggleFolder(dailyKey)}
              count={dailyFileCount}
              icon={<CalendarIcon />}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, {
                  name: state.lang === 'zh' ? '日记 / 每日笔记' : 'Daily Notes',
                  path: dailyKey,
                  is_dir: true,
                  children: dailyChildren,
                  file_count: dailyFileCount,
                });
              }}
            />
            {isDailyExpanded && dailyChildren.length > 0 && (
              <div className="tree-children-enter">
                {dailyChildren.map((child) => renderDailyNode(child, 0))}
              </div>
            )}
            {isDailyExpanded && dailyChildren.length === 0 && (
              <div className="tree-empty-hint" style={{ '--depth': 0 } as React.CSSProperties}>
                {state.lang === 'zh' ? '还没有日记，点击 ' : 'No daily notes yet. Click '}
                <CalendarIcon />
                {state.lang === 'zh' ? ' 创建今天的日记' : ' to create one.'}
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}
