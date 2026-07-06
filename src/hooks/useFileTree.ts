import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useApp } from '../contexts/AppContext';
import { listDirectoryTree, DirTreeNode } from '../lib/tauri';
import { listen } from '@tauri-apps/api/event';


const STORAGE_KEY = 'zettelagent:expanded_folders';

/** Represents one workspace root with its tree */
export interface WorkspaceTree {
  rootPath: string;
  rootName: string;
  tree: DirTreeNode | null;
}

export function useFileTree() {
  const { state } = useApp();
  const { vaultPaths, searchQuery } = state;

  const [trees, setTrees] = useState<WorkspaceTree[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load expanded folders from localStorage
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return new Set<string>(parsed);
        }
      }
    } catch (err) {
      console.error('Failed to load expanded folders:', err);
    }
    return new Set<string>();
  });

  // Extract folder name from path
  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : path;
  };

  // Fetch trees from the backend for all vault paths
  const refresh = useCallback(async () => {
    if (!vaultPaths || vaultPaths.length === 0) {
      setTrees([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const results: WorkspaceTree[] = [];
      for (const vp of vaultPaths) {
        try {
          const result = await listDirectoryTree(vp);
          results.push({
            rootPath: vp,
            rootName: getFolderName(vp),
            tree: result,
          });
        } catch (err) {
          console.error(`Failed to load tree for ${vp}:`, err);
          results.push({
            rootPath: vp,
            rootName: getFolderName(vp),
            tree: null,
          });
        }
      }
      setTrees(results);
    } catch (err) {
      console.error('Failed to load directory trees:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [vaultPaths]);

  // Load tree initially and when vaultPaths change
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep refresh in a stable ref so event listeners don't need to rebuild
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);



  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev: Set<string>) => {
      const next = new Set<string>(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch (err) {
        console.error('Failed to save expanded folders:', err);
      }
      return next;
    });
  }, []);

  const expandFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev: Set<string>) => {
      if (prev.has(folderPath)) return prev;
      const next = new Set<string>(prev);
      next.add(folderPath);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch (err) {
        console.error('Failed to save expanded folders:', err);
      }
      return next;
    });
  }, []);

  const collapseFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev: Set<string>) => {
      if (!prev.has(folderPath)) return prev;
      const next = new Set<string>(prev);
      next.delete(folderPath);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch (err) {
        console.error('Failed to save expanded folders:', err);
      }
      return next;
    });
  }, []);

  /** Expand all ancestor directories of a file so it becomes visible in the tree */
  const revealFile = useCallback((filePath: string) => {
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    // Build ancestor paths (skip the filename itself)
    const ancestors: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      // Reconstruct path in the ORIGINAL format (Windows backslash)
      ancestors.push(parts.slice(0, i).join('\\'));
      ancestors.push(parts.slice(0, i).join('/'));
    }
    setExpandedFolders((prev: Set<string>) => {
      let changed = false;
      const next = new Set<string>(prev);
      for (const a of ancestors) {
        if (!next.has(a)) {
          next.add(a);
          changed = true;
        }
      }
      if (!changed) return prev;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch (err) {
        console.error('Failed to save expanded folders:', err);
      }
      return next;
    });
  }, []);

  // Keep revealFile in a stable ref so event listeners don't need to rebuild
  const revealFileRef = useRef(revealFile);
  useEffect(() => {
    revealFileRef.current = revealFile;
  }, [revealFile]);

  // Listen to file watcher events to trigger tree refresh
  useEffect(() => {
    console.log('[useFileTree] Registering file-watcher listeners');
    const p1 = listen('file-watcher-synced', (event) => {
      console.log('[useFileTree] Received file-watcher-synced event:', event);
      refreshRef.current();
    });
    const p2 = listen('file-watcher-deleted', (event) => {
      console.log('[useFileTree] Received file-watcher-deleted event:', event);
      refreshRef.current();
    });
    const p3 = listen<{ filePath?: string }>('request-file-tree-refresh', (event) => {
      console.log('[useFileTree] Received request-file-tree-refresh event:', event);
      refreshRef.current().then(() => {
        if (event.payload?.filePath) {
          console.log('[useFileTree] Revealing file:', event.payload.filePath);
          revealFileRef.current(event.payload.filePath);
        }
      });
    });

    return () => {
      console.log('[useFileTree] Cleaning up file-watcher listeners');
      p1.then(un => un()).catch(err => console.warn(err));
      p2.then(un => un()).catch(err => console.warn(err));
      p3.then(un => un()).catch(err => console.warn(err));
    };
  }, []);

  // Backward compat: first tree as legacy single tree
  const firstTree = trees.length > 0 ? trees[0].tree : null;

  // Filter helper for a single tree
  const filterNode = (node: DirTreeNode, query: string, tempExpanded: Set<string>): DirTreeNode | null => {
    const isMatch = node.name.toLowerCase().includes(query);

    if (node.is_dir) {
      const filteredChildren: DirTreeNode[] = [];
      let hasMatchingChild = false;

      for (const child of node.children) {
        const filteredChild = filterNode(child, query, tempExpanded);
        if (filteredChild) {
          filteredChildren.push(filteredChild);
          hasMatchingChild = true;
        }
      }

      if (isMatch || hasMatchingChild) {
        if (hasMatchingChild) {
          tempExpanded.add(node.path);
        }
        return {
          ...node,
          children: filteredChildren,
        };
      }
      return null;
    } else {
      return isMatch ? node : null;
    }
  };

  // Compute filtered trees and temporary expanded folders list based on search query
  const { filteredTrees, filteredTree, searchExpandedFolders } = useMemo(() => {
    const tempExpanded = new Set<string>();

    if (trees.length === 0) {
      return { filteredTrees: [], filteredTree: null, searchExpandedFolders: tempExpanded };
    }

    if (!searchQuery.trim()) {
      return {
        filteredTrees: trees,
        filteredTree: firstTree,
        searchExpandedFolders: tempExpanded,
      };
    }

    const query = searchQuery.trim().toLowerCase();
    const filtered: WorkspaceTree[] = [];

    for (const wt of trees) {
      if (!wt.tree) {
        filtered.push(wt);
        continue;
      }
      const result = filterNode(wt.tree, query, tempExpanded);
      filtered.push({ ...wt, tree: result });
    }

    return {
      filteredTrees: filtered,
      filteredTree: filtered.length > 0 ? filtered[0].tree : null,
      searchExpandedFolders: tempExpanded,
    };
  }, [trees, firstTree, searchQuery]);

  return {
    /** @deprecated Use `trees` for multi-workspace support */
    tree: filteredTree,
    /** All workspace trees (filtered by search) */
    trees: filteredTrees,
    loading,
    error,
    expandedFolders,
    searchExpandedFolders,
    toggleFolder,
    expandFolder,
    collapseFolder,
    revealFile,
    refresh,
  };
}
