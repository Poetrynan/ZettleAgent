import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { openOrCreateDailyNote, getDailyFolderPath } from '../../lib/dailyNote';

import {
  deleteFile,
  createFile,
  createFolder,
  renamePath,
  movePath,
  deleteFolder,
  importFiles,
  importAttachments,
  getEmbeddingStats,
  runSchedulerNow,
  listDirectoryTree,
  DirTreeNode,
  ImportResult
} from '../../lib/tauri';
import { open } from '@tauri-apps/plugin-dialog';
import { t } from '../../lib/i18n';
import {
  IconFolder,
  IconSearch,
  IconFolderPlus,
  IconFilePlus,
  IconTrash,
  IconEdit,
  IconUpload,
} from '../icons';
import { useFileTree } from '../../hooks/useFileTree';
import { ContextMenu } from '../common/ContextMenu';
import SidebarModals from './SidebarModals';
import { SidebarFileTree } from './SidebarFileTree';
import { SidebarBookmarksPanel } from './SidebarBookmarksPanel';

export type TreeSortMode = 'name' | 'modified' | 'created';

export function Sidebar() {
  const {
    state,
    addVaultPath,
    removeVaultPath,
    setPrimaryVaultPath,
    setCurrentFile,
    setSearchQuery,
    setView,
    showToast,
    attachNoteToChat,
    toggleBookmark,
    renameTabs,
    closeTabsUnderPath,
    openInSplit,
  } = useApp();

  const {
    trees,
    loading,
    expandedFolders,
    searchExpandedFolders,
    toggleFolder,
    expandFolder,
    revealFile,
    refresh
  } = useFileTree();

  // ── Tree toolbar state ──
  const [sortMode, setSortMode] = useState<TreeSortMode>(() => {
    try { return (localStorage.getItem('za-tree-sort') as TreeSortMode) || 'name'; } catch { return 'name'; }
  });
  const [sortDesc, setSortDesc] = useState(() => {
    try { return localStorage.getItem('za-tree-sort-desc') === 'true'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('za-tree-sort', sortMode); } catch {}
  }, [sortMode]);
  useEffect(() => {
    try { localStorage.setItem('za-tree-sort-desc', String(sortDesc)); } catch {}
  }, [sortDesc]);

  const handleSortToggle = () => {
    const modes: TreeSortMode[] = ['name', 'modified', 'created'];
    const curIdx = modes.indexOf(sortMode);
    const nextMode = modes[(curIdx + 1) % modes.length];
    setSortMode(nextMode);
  };

  const handleSortDirectionToggle = () => {
    setSortDesc(prev => !prev);
  };

  const handleExpandAll = () => {
    // Expand all folders recursively
    const expandRecursive = (node: DirTreeNode | null) => {
      if (!node || !node.is_dir) return;
      if (!expandedFolders.has(node.path)) expandFolder(node.path);
      if (node.children) {
        for (const child of node.children) {
          if (child.is_dir) expandRecursive(child);
        }
      }
    };
    for (const wt of trees) {
      expandRecursive(wt.tree);
    }
  };

  const handleCollapseAll = () => {
    // Collapse all by clearing — toggleFolder toggles, so we toggle each that's expanded
    for (const path of expandedFolders) {
      toggleFolder(path);
    }
  };

  // ── Auto-reveal the selected file in the sidebar tree ──
  const prevCurrentFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.currentFile && state.currentFile !== prevCurrentFileRef.current) {
      prevCurrentFileRef.current = state.currentFile;
      revealFile(state.currentFile);
      requestAnimationFrame(() => {
        const activeEl = document.querySelector('.tree-item.active');
        if (activeEl) {
          activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    }
  }, [state.currentFile, revealFile]);

  // ── Dialog / Popup states ──
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: DirTreeNode } | null>(null);
  const [createFileDialog, setCreateFileDialog] = useState<DirTreeNode | null>(null);
  const [createFolderDialog, setCreateFolderDialog] = useState<DirTreeNode | null>(null);
  const [renameDialog, setRenameDialog] = useState<DirTreeNode | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DirTreeNode | null>(null);

  const [inputName, setInputName] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // ── Daily notes tree ──
  const [dailyTree, setDailyTree] = useState<DirTreeNode | null>(null);
  const loadDailyTree = useCallback(async () => {
    try {
      const dailyPath = await getDailyFolderPath();
      const tree = await listDirectoryTree(dailyPath);
      setDailyTree(tree);
    } catch {
      setDailyTree(null);
    }
  }, []);

  useEffect(() => {
    loadDailyTree();
  }, [loadDailyTree]);

  useEffect(() => {
    const onDailyNotesChanged = () => {
      void loadDailyTree();
      expandFolder('__daily_notes__');
    };
    window.addEventListener('zettel:daily-notes-changed', onDailyNotesChanged);
    return () => window.removeEventListener('zettel:daily-notes-changed', onDailyNotesChanged);
  }, [loadDailyTree, expandFolder]);

  // ── Embedding index check ──
  const [hasEmbeddingIndex, setHasEmbeddingIndex] = useState(false);
  useEffect(() => {
    getEmbeddingStats()
      .then(stats => setHasEmbeddingIndex(stats.has_index && stats.indexed_chunks > 0))
      .catch(() => {});
  }, []);

  const [importProgress, setImportProgress] = useState<{
    file: string; progress: number; message: string; stage: string;
  } | null>(null);

  // ── Tree Drag & Drop (file/folder move) ──
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const dragOverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTreeDragStart = useCallback((e: React.DragEvent, node: DirTreeNode) => {
    e.stopPropagation();
    e.dataTransfer.setData('application/x-zettel-tree-path', node.path);
    e.dataTransfer.setData('application/x-zettel-tree-isdir', node.is_dir ? '1' : '0');
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleTreeDragOver = useCallback((e: React.DragEvent, folderPath: string) => {
    if (!e.dataTransfer.types.includes('application/x-zettel-tree-path')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverFolder(folderPath);
    if (dragOverTimerRef.current) clearTimeout(dragOverTimerRef.current);
    dragOverTimerRef.current = setTimeout(() => {
      if (!expandedFolders.has(folderPath)) {
        expandFolder(folderPath);
      }
    }, 600);
  }, [expandedFolders, expandFolder]);

  const handleTreeDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    const related = e.relatedTarget as HTMLElement | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    setDragOverFolder(null);
    if (dragOverTimerRef.current) clearTimeout(dragOverTimerRef.current);
  }, []);

  const handleTreeDrop = useCallback(async (e: React.DragEvent, targetFolderPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
    if (dragOverTimerRef.current) clearTimeout(dragOverTimerRef.current);

    const sourcePath = e.dataTransfer.getData('application/x-zettel-tree-path');
    if (!sourcePath || sourcePath === targetFolderPath) return;

    const sourceParent = sourcePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const targetNorm = targetFolderPath.replace(/\\/g, '/');
    if (sourceParent === targetNorm) return;

    const sourceNorm = sourcePath.replace(/\\/g, '/');
    if (targetNorm.startsWith(sourceNorm + '/')) {
      showToast(state.lang === 'zh' ? '不能将文件夹移动到自身内部' : 'Cannot move a folder into itself', 'error');
      return;
    }

    const fileName = sourcePath.replace(/\\/g, '/').split('/').pop() || '';
    try {
      const newPath = await movePath(sourcePath, targetFolderPath);
      showToast(state.lang === 'zh' ? `已移动「${fileName}」` : `Moved "${fileName}"`, 'success');
      if (state.currentFile === sourcePath) {
        setCurrentFile(newPath);
      } else if (state.currentFile && (state.currentFile.startsWith(sourcePath + '\\') || state.currentFile?.startsWith(sourcePath + '/'))) {
        setCurrentFile(state.currentFile.replace(sourcePath, newPath));
      }
      await refresh();
    } catch (err) {
      showToast((state.lang === 'zh' ? '移动失败: ' : 'Move failed: ') + String(err), 'error');
    }
  }, [state.lang, state.currentFile, setCurrentFile, showToast, refresh]);

  // ── Vault selection ──
  const handleSelectVault = async () => {
    try {
      const selected = await open({
        directory: true, multiple: false,
        title: state.lang === 'zh' ? '添加文件夹到工作区' : 'Add folder to workspace',
      });
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : (selected as string);
        if (state.vaultPaths.includes(path)) {
          showToast(state.lang === 'zh' ? '此文件夹已在工作区中' : 'This folder is already in workspace', 'error');
          return;
        }
        await addVaultPath(path);
      }
    } catch (err) {
      console.error('Failed to select vault:', err);
      showToast(String(err), 'error');
    }
  };

  // ── File operations ──
  const handleCreateFile = async () => {
    if (!createFileDialog || !inputName.trim()) return;
    try {
      const name = inputName.trim();
      const newPath = await createFile(createFileDialog.path, name);
      showToast(t('sidebar.createSuccess'), 'success');
      setCreateFileDialog(null);
      setInputName('');
      await refresh();
      setCurrentFile(newPath);
      setView('note');
    } catch (err) {
      console.error('Failed to create file:', err);
      showToast(String(err), 'error');
    }
  };

  const handleCreateFolder = async () => {
    if (!createFolderDialog || !inputName.trim()) return;
    try {
      const name = inputName.trim();
      await createFolder(createFolderDialog.path, name);
      showToast(t('sidebar.createSuccess'), 'success');
      setCreateFolderDialog(null);
      setInputName('');
      await refresh();
      expandFolder(createFolderDialog.path);
    } catch (err) {
      console.error('Failed to create folder:', err);
      showToast(String(err), 'error');
    }
  };

  const handleRename = async () => {
    if (!renameDialog || !inputName.trim()) return;
    try {
      const oldPath = renameDialog.path;
      const newPath = await renamePath(oldPath, inputName.trim());
      showToast(t('sidebar.renameSuccess'), 'success');
      setRenameDialog(null);
      setInputName('');
      await refresh();
      renameTabs(oldPath, newPath);
    } catch (err) {
      console.error('Failed to rename path:', err);
      showToast(String(err), 'error');
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      const path = deleteConfirm.path;
      if (deleteConfirm.is_dir) {
        await deleteFolder(path);
      } else {
        await deleteFile(path);
      }
      showToast(t('sidebar.deleteSuccess'), 'success');
      setDeleteConfirm(null);
      await refresh();
      loadDailyTree();
      closeTabsUnderPath(path);
    } catch (err) {
      console.error('Failed to delete path:', err);
      showToast(String(err), 'error');
    }
  };

  // ── Clear Daily Notes Directory ──
  const handleClearDirectory = async (node: DirTreeNode) => {
    const files = (node.children ?? []).filter(c => !c.is_dir);
    if (files.length === 0) {
      showToast(state.lang === 'zh' ? '目录已经是空的' : 'Directory is already empty', 'info');
      return;
    }
    const ok = window.confirm(
      state.lang === 'zh'
        ? `确定要清空「${node.name}」下的 ${files.length} 篇笔记吗？\n\n这将从文件系统和数据库中删除这些笔记，且不可恢复。`
        : `Clear ${files.length} notes under "${node.name}"?\n\nThis will delete them from filesystem and database, and cannot be undone.`
    );
    if (!ok) return;
    try {
      for (const f of files) {
        await deleteFile(f.path);
      }
      showToast(state.lang === 'zh' ? `已清空 ${files.length} 篇笔记` : `Cleared ${files.length} notes`, 'success');
      await refresh();
      loadDailyTree();
      setContextMenu(null);
    } catch (err) {
      console.error('Failed to clear directory:', err);
      showToast(String(err), 'error');
    }
  };

  // ── Import via Dialog ──
  const handleImportFiles = async () => {
    if (!state.vaultPath) {
      showToast(t('sidebar.tipNoVault'), 'error');
      return;
    }
    try {
      const selected = await open({
        multiple: true,
        title: state.lang === 'zh' ? '选择要导入的文件' : 'Select files to import',
        filters: [{
          name: 'Supported Files',
          extensions: ['md', 'html', 'htm', 'csv', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp']
        }]
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      const standardExts = ['md', 'html', 'htm', 'csv'];
      const attachmentExts = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp'];
      const standardPaths: string[] = [];
      const attachmentPaths: string[] = [];

      for (const p of paths as string[]) {
        const ext = p.split('.').pop()?.toLowerCase() || '';
        if (standardExts.includes(ext)) standardPaths.push(p);
        else if (attachmentExts.includes(ext)) attachmentPaths.push(p);
      }

      const totalCount = standardPaths.length + attachmentPaths.length;
      if (totalCount === 0) return;

      setIsImporting(true);
      setImportProgress(null);
      let results: ImportResult[] = [];
      if (standardPaths.length > 0) {
        results = results.concat(await importFiles(state.vaultPath, standardPaths));
      }
      if (attachmentPaths.length > 0) {
        const cfg = state.llmConfig;
        results = results.concat(await importAttachments(state.vaultPath, attachmentPaths, {
          apiUrl: cfg.apiUrl, apiKey: cfg.apiKey || undefined,
          model: cfg.model, providerId: cfg.providerId || undefined,
        }));
      }
      await refresh();

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      let msg = state.lang === 'zh'
        ? `已导入 ${successCount} 个文件`
        : `Imported ${successCount} file${successCount !== 1 ? 's' : ''}`;
      if (failCount > 0) msg += state.lang === 'zh' ? `，${failCount} 个失败` : `, ${failCount} failed`;
      showToast(msg, failCount > 0 ? 'error' : 'success');

      const firstSuccess = results.find(r => r.success && r.companion_path);
      if (firstSuccess?.companion_path) {
        setCurrentFile(firstSuccess.companion_path);
        setView('note');
      }
    } catch (err) {
      console.error('Import failed:', err);
      showToast(`Import failed: ${err}`, 'error');
    } finally {
      setIsImporting(false);
      setImportProgress(null);
    }
  };

  // ── Drag-and-Drop Import (Tauri native) ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let aborted = false;

    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (aborted) return;
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onDragDropEvent(async (event) => {
          if (aborted) return;
          if (event.payload.type === 'over') {
            if (state.vaultPath) setIsDragOver(true);
          } else if (event.payload.type === 'leave') {
            setIsDragOver(false);
          } else if (event.payload.type === 'drop') {
            setIsDragOver(false);
            if (!state.vaultPath) {
              showToast(state.lang === 'zh' ? '请先选择知识库' : 'Please select a vault first', 'error');
              return;
            }
            const paths = event.payload.paths as string[];
            if (!paths || paths.length === 0) return;

            const standardExts = ['md', 'html', 'htm', 'csv'];
            const attachmentExts = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp'];
            const standardPaths: string[] = [];
            const attachmentPaths: string[] = [];
            for (const p of paths) {
              const ext = p.split('.').pop()?.toLowerCase() || '';
              if (standardExts.includes(ext)) standardPaths.push(p);
              else if (attachmentExts.includes(ext)) attachmentPaths.push(p);
            }
            const totalSupported = standardPaths.length + attachmentPaths.length;
            if (totalSupported === 0) {
              showToast(state.lang === 'zh'
                ? '仅支持导入 .md、.pdf、.docx、.csv 及常用图片文件'
                : 'Only .md, .pdf, .docx, .csv, and image files are supported', 'error');
              return;
            }

            setIsImporting(true);
            setImportProgress(null);
            try {
              let results: ImportResult[] = [];
              if (standardPaths.length > 0) {
                results = results.concat(await importFiles(state.vaultPath, standardPaths));
              }
              if (attachmentPaths.length > 0) {
                results = results.concat(await importAttachments(state.vaultPath, attachmentPaths, state.llmConfig));
              }
              await refresh();
              const successCount = results.filter(r => r.success).length;
              const failCount = results.filter(r => !r.success).length;
              let msg = state.lang === 'zh'
                ? `已导入 ${successCount} 个文件`
                : `Imported ${successCount} file${successCount !== 1 ? 's' : ''}`;
              if (failCount > 0) msg += state.lang === 'zh' ? `，${failCount} 个失败` : `, ${failCount} failed`;
              showToast(msg, failCount > 0 ? 'error' : 'success');
              const firstSuccess = results.find(r => r.success && r.companion_path);
              if (firstSuccess?.companion_path) {
                setCurrentFile(firstSuccess.companion_path);
                setView('note');
              }
            } catch (err) {
              console.error('Import failed:', err);
              showToast(`Import failed: ${err}`, 'error');
            } finally {
              setIsImporting(false);
              setImportProgress(null);
            }
          }
        });
        if (aborted && unlisten) unlisten();
      } catch (e) {
        console.warn('Drag-drop events not available:', e);
      }
    })();

    return () => {
      aborted = true;
      if (unlisten) unlisten();
    };
  }, [state.vaultPath, state.lang, state.llmConfig, refresh, showToast, setCurrentFile, setView]);

  // ── Import Progress Listener ──
  useEffect(() => {
    const listenPromise = import('@tauri-apps/api/event').then(({ listen }) => {
      return listen<{ stage: string; file: string; progress: number; message: string }>('import-progress', (event) => {
        const { stage, file, progress, message } = event.payload;
        if (stage === 'done') {
          setImportProgress(null);
        } else {
          setImportProgress({ stage, file, progress, message });
        }
      });
    });
    return () => {
      listenPromise.then(unlisten => unlisten()).catch(err => console.warn(err));
    };
  }, []);

  // ── Context menu ──
  const handleNodeContextMenu = (e: React.MouseEvent, node: DirTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const node = contextMenu.node;
    const isWorkspaceRoot = state.vaultPaths.includes(node.path);
    const isDailyNotes = node.path === '__daily_notes__';

    if (node.is_dir) {
      const items: any[] = [
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <IconFilePlus size={14} /><span>{t('sidebar.newFile')}</span></div>),
          onClick: () => { setInputName(''); setCreateFileDialog(node); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <IconFolderPlus size={14} /><span>{t('sidebar.newFolder')}</span></div>),
          onClick: () => { setInputName(''); setCreateFolderDialog(node); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            <span>{state.bookmarks.includes(node.path) ? (state.lang === 'zh' ? '取消书签/收藏' : 'Remove Bookmark') : (state.lang === 'zh' ? '添加书签/收藏' : 'Add Bookmark')}</span></div>),
          onClick: () => { toggleBookmark(node.path); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M12.2 11.8L11 13M12.2 6.2L11 5"/><line x1="2" y1="22" x2="22" y2="2"/></svg>
            <span>{state.lang === 'zh' ? '智能整理此文件夹' : 'Smart Organize Folder'}</span></div>),
          onClick: async () => {
            const folderName = node.name;
            showToast(state.lang === 'zh' ? `开始整理「${folderName}」...` : `Organizing "${folderName}"...`, 'info');
            try {
              const orgConfig = (await import('../settings/Settings')).getSmartOrganizeConfig();
              let dailyPath: string | undefined;
              if (!orgConfig.includeJournals) {
                const { getDailyFolderPath } = await import('../../lib/dailyNote');
                dailyPath = await getDailyFolderPath();
              }
              const result = await runSchedulerNow(
                state.llmConfig.apiUrl, state.llmConfig.apiKey || undefined,
                state.llmConfig.model, state.llmConfig.providerId,
                state.methodology, node.path, orgConfig.batchSize,
                orgConfig.searchResultCount, orgConfig.contentTruncationLimit,
                orgConfig.includeJournals, dailyPath,
                false, // force
                orgConfig.minNoteLength,
              );
              showToast(state.lang === 'zh'
                ? `「${folderName}」整理完成：处理 ${result.notes_processed} 篇，整理 ${result.notes_reconciled} 篇`
                : `"${folderName}" organized: ${result.notes_processed} processed, ${result.notes_reconciled} reconciled`, 'success');
            } catch (e) {
              showToast((state.lang === 'zh' ? '整理失败: ' : 'Organize failed: ') + e, 'error');
            }
          }
        },
      ];

      if (isDailyNotes) {
        items.push({
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            <span>{state.lang === 'zh' ? '清空目录' : 'Clear Directory'}</span></div>),
          danger: true,
          onClick: () => handleClearDirectory(node)
        });
      } else if (isWorkspaceRoot) {
        const isPrimary = state.vaultPaths[0] === node.path;
        if (!isPrimary) {
          items.push({
            label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg><span>{state.lang === 'zh' ? '设为主文件夹' : 'Set as Primary'}</span></div>),
            onClick: () => { setPrimaryVaultPath(node.path); }
          });
        }
        items.push({
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg><span>{state.lang === 'zh' ? '从工作区移除' : 'Remove from Workspace'}</span></div>),
          danger: true,
          onClick: () => { removeVaultPath(node.path); }
        });
      } else {
        items.push(
          {
            label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><IconEdit size={14} /><span>{t('sidebar.rename')}</span></div>),
            onClick: () => { setInputName(node.name); setRenameDialog(node); }
          },
          {
            label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><IconTrash size={14} /><span>{t('sidebar.delete')}</span></div>),
            danger: true,
            onClick: () => { setDeleteConfirm(node); }
          }
        );
      }
      return items;
    } else {
      return [
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg><span>{state.lang === 'zh' ? '在分屏中打开' : 'Open in Split'}</span></div>),
          onClick: () => { openInSplit(node.path); setView('note'); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>{state.lang === 'zh' ? '附加到聊天' : 'Attach to chat'}</span></div>),
          onClick: () => { attachNoteToChat(node.name.replace(/\.md$/, ''), node.path); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg><span>{state.bookmarks.includes(node.path) ? (state.lang === 'zh' ? '取消书签/收藏' : 'Remove Bookmark') : (state.lang === 'zh' ? '添加书签/收藏' : 'Add Bookmark')}</span></div>),
          onClick: () => { toggleBookmark(node.path); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><IconEdit size={14} /><span>{t('sidebar.rename')}</span></div>),
          onClick: () => { setInputName(node.name.replace(/\.md$/, '')); setRenameDialog(node); }
        },
        {
          label: (<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><IconTrash size={14} /><span>{t('sidebar.delete')}</span></div>),
          danger: true,
          onClick: () => { setDeleteConfirm(node); }
        }
      ];
    }
  }, [contextMenu, state.bookmarks, state.lang, state.llmConfig, state.methodology, state.vaultPaths, attachNoteToChat, toggleBookmark, setPrimaryVaultPath, removeVaultPath, showToast, openInSplit, setView]);

  // ── Render ──
  const sortLabel = state.lang === 'zh'
    ? { name: '名称', modified: '修改时间', created: '创建时间' }[sortMode]
    : { name: 'Name', modified: 'Modified', created: 'Created' }[sortMode];

  return (
    <aside className={`sidebar ${isDragOver ? 'drag-over' : ''}`}>

      {/* Drop Overlay */}
      {isDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginTop: 'var(--space-2)' }}>
              {state.lang === 'zh' ? '拖放以导入' : 'Drop to Import'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
              .md · .pdf · .docx · .csv · .png/jpg
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="sidebar-header" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span className="logo-wordmark" style={{ fontSize: 'var(--text-xl)' }}>
              <span className="logo-zettel">Zettel</span>
              <span className="logo-lambda-wrap"><span className="logo-agent-lambda">Λ</span></span>
              <span className="logo-agent-rest">agent</span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <button className="btn btn-ghost btn-icon-sm" onClick={handleSelectVault} title={t('sidebar.selectVault')}>
              <IconFolder size={16} />
            </button>
            <button className="btn btn-ghost btn-icon-sm" onClick={handleImportFiles} disabled={!state.vaultPath || isImporting}
              title={!state.vaultPath ? t('sidebar.tipNoVault') : (state.lang === 'zh' ? '导入文件 / 附件 (.md, .pdf, .docx 等)' : 'Import files / attachments (.md, .pdf, .docx etc.)')}>
              <IconUpload size={16} />
            </button>
            <button className="btn btn-ghost btn-icon-sm" onClick={async () => {
              try { const path = await openOrCreateDailyNote(); setCurrentFile(path); setView('note'); await loadDailyTree(); }
              catch (err) { showToast(String(err), 'error'); }
            }} title={t('sidebar.dailyNote')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Filename Search Input — only filters file tree by name */}
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-1)' }}>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 'var(--space-3)', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }}>
            <IconSearch size={14} />
          </div>
          <input
            type="text" className="input"
            placeholder={t('sidebar.search')}
            value={state.searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ paddingLeft: 'var(--space-8)' }}
          />
          {state.searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              title={state.lang === 'zh' ? '清除' : 'Clear'}
              style={{
                position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                border: 'none', background: 'none', cursor: 'pointer', padding: '2px',
                color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          )}
        </div>
        {/* Content search link — opens SearchPanel (Ctrl+Shift+F) */}
        <button
          className="sidebar-content-search-link"
          onClick={() => window.dispatchEvent(new CustomEvent('zettel:open-search-panel'))}
          title={state.lang === 'zh' ? '搜索笔记内容 (Ctrl+Shift+F)' : 'Search note content (Ctrl+Shift+F)'}
        >
          <IconSearch size={11} />
          <span>{state.lang === 'zh' ? '内容搜索' : 'Content Search'}</span>
          <kbd>Ctrl+Shift+F</kbd>
        </button>
      </div>

      {/* Tree Toolbar — sort / expand / collapse */}
      <div className="sidebar-tree-toolbar">
        <button
          className="sidebar-tree-toolbar-btn"
          onClick={handleSortToggle}
          title={state.lang === 'zh'
            ? `切换排序字段（当前：${sortLabel}）`
            : `Change sort field (current: ${sortLabel})`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 18V4" style={{ transform: sortDesc ? 'scaleY(-1)' : 'none', transformOrigin: 'center' }} />
          </svg>
        </button>
        <button
          className="sidebar-tree-toolbar-btn"
          onClick={handleExpandAll}
          title={state.lang === 'zh' ? '展开全部' : 'Expand All'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 13 12 8 17 13"/><polyline points="7 18 12 13 17 18"/><line x1="12" y1="3" x2="12" y2="8"/>
          </svg>
        </button>
        <button
          className="sidebar-tree-toolbar-btn"
          onClick={handleCollapseAll}
          title={state.lang === 'zh' ? '折叠全部' : 'Collapse All'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 8 12 13 17 8"/><polyline points="7 3 12 8 17 3"/><line x1="12" y1="13" x2="12" y2="21"/>
          </svg>
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="sidebar-tree-sort-label"
          onClick={handleSortDirectionToggle}
          title={state.lang === 'zh'
            ? `点击切换${sortDesc ? '升序' : '降序'}`
            : `Click to sort ${sortDesc ? 'ascending' : 'descending'}`}
        >
          {sortLabel}{sortDesc ? ' ↓' : ' ↑'}
        </button>
      </div>

      {/* Sync Status */}
      {state.isSyncing && (
        <div style={{ padding: 'var(--space-1) var(--space-3)' }}>
          <div className="sync-indicator"><span className="sync-dot syncing" /><span>{t('sidebar.syncing')}</span></div>
        </div>
      )}

      {/* Import Progress */}
      {importProgress && (
        <div style={{ padding: 'var(--space-2) var(--space-3)', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
              {state.lang === 'zh' ? `正在导入: ${importProgress.file}` : `Importing: ${importProgress.file}`}
            </span>
            <span>{Math.round(importProgress.progress * 100)}%</span>
          </div>
          <div style={{ width: '100%', height: '4px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
            <div style={{ width: `${importProgress.progress * 100}%`, height: '100%', background: 'var(--accent-primary)', transition: 'width 0.2s ease-out' }} />
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>{importProgress.message}</div>
        </div>
      )}

      {/* Main Content: File Tree */}
      <div className="sidebar-content">
        <SidebarFileTree
          trees={trees}
          loading={loading}
          expandedFolders={expandedFolders}
          searchExpandedFolders={searchExpandedFolders}
          sortMode={sortMode}
          sortDesc={sortDesc}
          toggleFolder={toggleFolder}
          setCurrentFile={setCurrentFile}
          setView={(v: string) => setView(v as any)}
          showToast={(msg: string, type?: string) => showToast(msg, type as any)}
          attachNoteToChat={attachNoteToChat}
          onTreeDragStart={handleTreeDragStart}
          onTreeDragOver={handleTreeDragOver}
          onTreeDragLeave={handleTreeDragLeave}
          onTreeDrop={handleTreeDrop}
          dragOverFolder={dragOverFolder}
          onNodeContextMenu={handleNodeContextMenu}
          bookmarks={state.bookmarks}
          searchQuery={state.searchQuery}
        />

        {/* Bookmarked Notes & Daily Notes */}
        <SidebarBookmarksPanel
          expandFolder={expandFolder}
          toggleFolder={toggleFolder}
          revealFile={revealFile}
          expandedFolders={expandedFolders}
          trees={trees}
          dailyTree={dailyTree}
          searchExpandedFolders={searchExpandedFolders}
          onContextMenu={handleNodeContextMenu}
        />

      </div>

      {/* Context Menu */}
      <ContextMenu
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        isOpen={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        items={contextMenuItems}
      />

      {/* File Operation Modals */}
      <SidebarModals
        createFileDialog={createFileDialog}
        setCreateFileDialog={setCreateFileDialog}
        createFolderDialog={createFolderDialog}
        setCreateFolderDialog={setCreateFolderDialog}
        renameDialog={renameDialog}
        setRenameDialog={setRenameDialog}
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        inputName={inputName}
        setInputName={setInputName}
        onHandleCreateFile={handleCreateFile}
        onHandleCreateFolder={handleCreateFolder}
        onHandleRename={handleRename}
        onHandleDelete={handleDelete}
      />
    </aside>
  );
}
