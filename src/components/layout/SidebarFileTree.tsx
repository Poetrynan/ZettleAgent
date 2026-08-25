import React, { useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import { DirTreeNode, openFileExternal } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { IconFolder, IconFolderOpen, IconFile, IconChevronRight, IconFilePlus, IconFolderPlus } from '../icons';
import type { TreeSortMode } from './Sidebar';
import { TreeSectionHeader } from './tree/TreeSectionHeader';
import { TreeChevron, TreeIndentSpacer, TreeCountBadge, TreeBookmarkPin } from './tree/TreeRowParts';

interface FileTreeProps {
  trees: Array<{ rootPath: string; rootName: string; tree: DirTreeNode | null }>;
  loading: boolean;
  expandedFolders: Set<string>;
  searchExpandedFolders: Set<string>;
  sortMode: TreeSortMode;
  sortDesc: boolean;
  toggleFolder: (path: string) => void;
  setCurrentFile: (path: string) => void;
  setView: (view: string) => void;
  showToast: (msg: string, type?: string) => void;
  attachNoteToChat: (name: string, path: string) => void;
  onTreeDragStart: (e: React.DragEvent, node: DirTreeNode) => void;
  onTreeDragOver: (e: React.DragEvent, folderPath: string) => void;
  onTreeDragLeave: (e: React.DragEvent) => void;
  onTreeDrop: (e: React.DragEvent, targetFolderPath: string) => void;
  dragOverFolder: string | null;
  onNodeContextMenu: (e: React.MouseEvent, node: DirTreeNode) => void;
  bookmarks: string[];
  searchQuery: string;
  inlineCreateFolderParentPath?: string | null;
  inlineFolderName?: string;
  setInlineFolderName?: (v: string) => void;
  onExecuteCreateFolder?: () => void;
  onCancelCreateFolder?: () => void;
  selectedPath?: string | null;
  setSelectedPath?: (p: string | null) => void;
  onHoverCreateFile?: (folderPath: string) => void;
  onHoverCreateFolder?: (folderPath: string) => void;
}




function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-secondary)' }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>;
  }
  if (ext === 'canvas') {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--canvas-accent, #a855f7)' }}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
  }
  if (['pdf'].includes(ext)) {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#ef4444' }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#10b981' }}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>;
  }
  if (['docx'].includes(ext)) {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#3b82f6' }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
  }
  return <IconFile size={13} />;
}

function sortChildren(children: DirTreeNode[], mode: TreeSortMode, desc: boolean): DirTreeNode[] {
  const sorted = [...children];
  if (mode === 'name') {
    sorted.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  } else if (mode === 'modified') {
    sorted.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  } else if (mode === 'created') {
    sorted.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }
  if (desc) sorted.reverse();
  return sorted;
}

export function SidebarFileTree(props: FileTreeProps) {
  const {
    trees,
    loading,
    expandedFolders,
    searchExpandedFolders,
    sortMode,
    sortDesc,
    toggleFolder,
    setCurrentFile,
    setView,
    showToast,
    attachNoteToChat,
    onTreeDragStart,
    onTreeDragOver,
    onTreeDragLeave,
    onTreeDrop,
    dragOverFolder,
    onNodeContextMenu,
    bookmarks,
    searchQuery,
    inlineCreateFolderParentPath,
    inlineFolderName = '',
    setInlineFolderName,
    onExecuteCreateFolder,
    onCancelCreateFolder,
    selectedPath,
    setSelectedPath,
    onHoverCreateFile,
    onHoverCreateFolder,
  } = props;




  const { state } = useApp();

  const activeExpanded = useMemo(() => {
    if (searchQuery.trim()) {
      return new Set([...Array.from(expandedFolders), ...Array.from(searchExpandedFolders)]);
    }
    return expandedFolders;
  }, [expandedFolders, searchExpandedFolders, searchQuery]);

  const isParentInsideWorkspace = useMemo(() => {
    if (!inlineCreateFolderParentPath) return false;
    const parentNorm = inlineCreateFolderParentPath.replace(/\\/g, '/').toLowerCase();
    return trees.some(wt => {
      const rootNorm = wt.rootPath.replace(/\\/g, '/').toLowerCase();
      return parentNorm.startsWith(rootNorm);
    });
  }, [inlineCreateFolderParentPath, trees]);


  const renderTreeNode = (node: DirTreeNode, depth: number) => {
    const isExpanded = activeExpanded.has(node.path);

    if (node.is_dir) {
      const isDragTarget = dragOverFolder === node.path;
      const isSelected = selectedPath?.replace(/\\/g, '/') === node.path.replace(/\\/g, '/');
      return (
        <div key={node.path} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            className={`tree-item${isSelected ? ' active' : ''}${isDragTarget ? ' tree-drop-target' : ''}`}
            draggable
            onDragStart={(e) => onTreeDragStart(e, node)}
            onClick={() => {
              toggleFolder(node.path);
              if (isExpanded) {
                setSelectedPath?.(null);
              } else {
                setSelectedPath?.(node.path);
              }
            }}
            onContextMenu={(e) => onNodeContextMenu(e, node)}


            onDragOver={(e) => onTreeDragOver(e, node.path)}
            onDragLeave={onTreeDragLeave}
            onDrop={(e) => onTreeDrop(e, node.path)}
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
            <span className="tree-folder-icon">
              {isExpanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
            </span>
            <span className="tree-item-label" title={node.name}>{node.name}</span>
            <TreeChevron expanded={isExpanded} />
            {bookmarks.includes(node.path) && <TreeBookmarkPin />}
            <TreeCountBadge count={node.file_count} />
            {/* Hover actions (VSCode/Cursor style) */}
            <div className="tree-hover-actions">
              {onHoverCreateFile && (
                <button
                  className="tree-hover-btn"
                  onClick={(e) => { e.stopPropagation(); onHoverCreateFile(node.path); }}
                  title={state.lang === 'zh' ? '在此文件夹新建文件' : 'New File in this folder'}
                >
                  <IconFilePlus size={13} />
                </button>
              )}
              {onHoverCreateFolder && (
                <button
                  className="tree-hover-btn"
                  onClick={(e) => { e.stopPropagation(); onHoverCreateFolder(node.path); }}
                  title={state.lang === 'zh' ? '在此文件夹新建子文件夹' : 'New Folder in this folder'}
                >
                  <IconFolderPlus size={13} />
                </button>
              )}
            </div>
          </div>
          {isExpanded && (
            <div className="tree-children-enter">
              {node.children && sortChildren(node.children, sortMode, sortDesc).map((child) => renderTreeNode(child, depth + 1))}
              {inlineCreateFolderParentPath?.replace(/\\/g, '/') === node.path.replace(/\\/g, '/') && (

                <div
                  className="tree-item"
                  style={{ '--depth': depth + 1, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'default' } as React.CSSProperties}
                >
                  {/* Render vertical nesting guides based on depth */}
                  {Array.from({ length: depth + 1 }).map((_, idx) => (
                    <span
                      key={idx}
                      className="tree-indent-guide"
                      style={{
                        left: `calc(var(--tree-base-pad) + ${idx} * var(--tree-indent) + 8px)`
                      }}
                    />
                  ))}
                  <TreeIndentSpacer />
                  <span className="tree-folder-icon" style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center' }}>
                    <IconFolder size={13} />
                  </span>
                  <input
                    type="text"
                    className="input"
                    placeholder={state.lang === 'zh' ? '输入文件夹名称...' : 'Enter folder name...'}
                    autoFocus
                    value={inlineFolderName}
                    onChange={(e) => setInlineFolderName?.(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onExecuteCreateFolder?.();
                      else if (e.key === 'Escape') onCancelCreateFolder?.();
                    }}
                    onBlur={() => {
                      setTimeout(() => {
                        onExecuteCreateFolder?.();
                      }, 150);
                    }}
                    style={{
                      height: '20px',
                      padding: '1px 4px',
                      fontSize: '11px',
                      lineHeight: '1',
                      flex: 1,
                      minWidth: '0',
                      border: '1px solid var(--accent-primary)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                      outline: 'none',
                    }}
                  />
                </div>
              )}
            </div>
          )}

        </div>
      );
    }

    const ext = node.name.split('.').pop()?.toLowerCase() || '';
    const isMd = ext === 'md';
    const isExternal = ['html', 'htm', 'csv', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp'].includes(ext);

    const handleFileClick = () => {
      setSelectedPath?.(node.path);
      if (isMd) {
        setCurrentFile(node.path);
        setView('note');
      } else if (isExternal) {
        openFileExternal(node.path).catch(e => {
          console.error('Failed to open externally:', e);
          showToast(`Failed to open: ${e}`, 'error');
        });
      }
    };

    const isFileActive = (selectedPath?.replace(/\\/g, '/') === node.path.replace(/\\/g, '/')) || (state.currentFile === node.path);

    return (
      <div
        key={node.path}
        className={`tree-item ${isFileActive ? 'active' : ''}`}

        draggable
        onDragStart={(e) => onTreeDragStart(e, node)}
        onClick={handleFileClick}
        onContextMenu={(e) => onNodeContextMenu(e, node)}
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
        <span className="tree-file-icon">{getFileIcon(node.name)}</span>
        <span className="tree-item-label" title={isExternal ? `${node.name} (${state.lang === 'zh' ? '外部打开' : 'open externally'})` : node.name}>
          {isMd ? node.name.replace(/\.md$/, '') : node.name}
        </span>
        {bookmarks.includes(node.path) && !isExternal && <TreeBookmarkPin />}
        {isExternal && <span className="tree-ext-badge">{ext}</span>}
        {isMd && (
          <button
            className="tree-attach-btn"
            onClick={(e) => {
              e.stopPropagation();
              const noteName = node.name.replace(/\.md$/, '');
              attachNoteToChat(noteName, node.path);
            }}
            title={state.lang === 'zh' ? '附加到聊天' : 'Attach to chat'}
            style={{
              border: 'none', background: 'none', cursor: 'pointer', padding: '2px',
              color: 'var(--text-tertiary)', display: 'none', alignItems: 'center',
              marginLeft: 'auto', flexShrink: 0, borderRadius: '4px',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="sidebar-file-tree">
      {loading && trees.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-8)', color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)', gap: 'var(--space-2)' }}>
          <span className="spinner" />
          <span>{t('sidebar.syncing')}</span>
        </div>
      ) : (trees.length === 0 && !inlineCreateFolderParentPath) ? (

        <div className="empty-state" style={{ padding: 'var(--space-8)' }}>
          <IconFolder size={48} />
          <div className="empty-state-title">
            {state.lang === 'zh' ? '当前区域为空' : 'Workspace is Empty'}
          </div>
          <div className="empty-state-description">
            {state.lang === 'zh'
              ? '请创建笔记或日记，或添加文件夹到工作区'
              : 'Create a note or daily journal, or add a folder to workspace'}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  const { openOrCreateDailyNote, notifyDailyNotesChanged } = await import('../../lib/dailyNote');
                  const path = await openOrCreateDailyNote();
                  setCurrentFile(path);
                  setView('note');
                  notifyDailyNotesChanged();
                } catch (err) {
                  console.error('Failed to create daily note:', err);
                  showToast(String(err), 'error');
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              {state.lang === 'zh' ? '创建今日日记' : 'Create Today Note'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {trees.map((wt) => {
            const isRootExpanded = activeExpanded.has(wt.rootPath);
            const dailyChild = wt.tree?.children.find(c => c.is_dir && c.name.toLowerCase() === 'daily');
            const fileCount = (wt.tree?.file_count ?? 0) - (dailyChild?.file_count ?? 0);

            return (
              <div key={wt.rootPath} className="tree-section-block">
                <TreeSectionHeader
                  label={wt.rootName}
                  expanded={isRootExpanded}
                  onToggle={() => {
                    toggleFolder(wt.rootPath);
                    if (isRootExpanded) {
                      setSelectedPath?.(null);
                    } else {
                      setSelectedPath?.(wt.rootPath);
                    }
                  }}

                  className={selectedPath?.replace(/\\/g, '/') === wt.rootPath.replace(/\\/g, '/') ? 'active' : ''}
                  count={fileCount}
                  icon={<IconFolder size={13} />}

                  isDropTarget={dragOverFolder === wt.rootPath}
                  trailing={
                    <>
                      <div className="tree-hover-actions">
                        {onHoverCreateFile && (
                          <button
                            className="tree-hover-btn"
                            onClick={(e) => { e.stopPropagation(); onHoverCreateFile(wt.rootPath); }}
                            title={state.lang === 'zh' ? '在此文件夹新建文件' : 'New File'}
                          >
                            <IconFilePlus size={13} />
                          </button>
                        )}
                        {onHoverCreateFolder && (
                          <button
                            className="tree-hover-btn"
                            onClick={(e) => { e.stopPropagation(); onHoverCreateFolder(wt.rootPath); }}
                            title={state.lang === 'zh' ? '在此文件夹新建子文件夹' : 'New Folder'}
                          >
                            <IconFolderPlus size={13} />
                          </button>
                        )}
                      </div>
                    </>
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onNodeContextMenu(e, { name: wt.rootName, path: wt.rootPath, is_dir: true, children: wt.tree?.children ?? [], file_count: wt.tree?.file_count ?? 0 });
                  }}
                  onDragOver={(e) => onTreeDragOver(e, wt.rootPath)}
                  onDragLeave={onTreeDragLeave}
                  onDrop={(e) => onTreeDrop(e, wt.rootPath)}
                />
                {isRootExpanded && wt.tree && (wt.tree.children.length > 0 || inlineCreateFolderParentPath?.replace(/\\/g, '/') === wt.rootPath.replace(/\\/g, '/')) && (
                  <div className="tree-children-enter">
                    {sortChildren(
                      wt.tree.children.filter((child) => !(child.is_dir && child.name.toLowerCase() === 'daily')),
                      sortMode,
                      sortDesc
                    ).map((child) => renderTreeNode(child, 0))}

                    {inlineCreateFolderParentPath?.replace(/\\/g, '/') === wt.rootPath.replace(/\\/g, '/') && (
                      <div
                        className="tree-item"
                        style={{
                          '--depth': 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          cursor: 'default',
                        } as React.CSSProperties}
                      >
                        <TreeIndentSpacer />
                        <span className="tree-folder-icon" style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center' }}>
                          <IconFolder size={13} />
                        </span>
                        <input
                          type="text"
                          className="input"
                          placeholder={state.lang === 'zh' ? '输入文件夹名称...' : 'Enter folder name...'}
                          autoFocus
                          value={inlineFolderName}
                          onChange={(e) => setInlineFolderName?.(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') onExecuteCreateFolder?.();
                            else if (e.key === 'Escape') onCancelCreateFolder?.();
                          }}
                          onBlur={() => {
                            setTimeout(() => {
                              onExecuteCreateFolder?.();
                            }, 150);
                          }}
                          style={{
                            height: '20px',
                            padding: '1px 4px',
                            fontSize: '11px',
                            lineHeight: '1',
                            flex: 1,
                            minWidth: '0',
                            border: '1px solid var(--accent-primary)',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--bg-primary)',
                            color: 'var(--text-primary)',
                            outline: 'none',
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {isRootExpanded && wt.tree && wt.tree.children.length === 0 && inlineCreateFolderParentPath?.replace(/\\/g, '/') !== wt.rootPath.replace(/\\/g, '/') && (
                  <div className="tree-empty-hint" style={{ '--depth': 0 } as React.CSSProperties}>
                    {state.lang === 'zh' ? '空文件夹' : 'Empty folder'}
                  </div>
                )}
              </div>
            );
          })}

          {/* Render inline create vault input at the end of the vault list if creating outside current vaults (e.g. on Desktop) */}
          {inlineCreateFolderParentPath && !isParentInsideWorkspace && (

            <div className="tree-section-block" style={{ padding: '4px 0' }}>
              <div
                className="tree-section-header"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px var(--tree-base-pad)',
                  cursor: 'default',
                  background: 'none',
                }}
              >
                <span className="tree-section-chevron" style={{ opacity: 0 }}>
                  <IconChevronRight size={12} />
                </span>
                <span className="tree-section-icon" style={{ color: 'var(--text-tertiary)' }}>
                  <IconFolder size={13} />
                </span>
                <input
                  type="text"
                  className="input"
                  placeholder={state.lang === 'zh' ? '在工作区创建新知识库...' : 'Create new vault in workspace...'}

                  autoFocus
                  value={inlineFolderName}
                  onChange={(e) => setInlineFolderName?.(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onExecuteCreateFolder?.();
                    else if (e.key === 'Escape') onCancelCreateFolder?.();
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      onExecuteCreateFolder?.();
                    }, 150);
                  }}
                  style={{
                    height: '22px',
                    padding: '2px 6px',
                    fontSize: '11px',
                    lineHeight: '1',
                    flex: 1,
                    minWidth: '0',
                    border: '1px solid var(--accent-primary)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )

}
    </div>
  );
}
