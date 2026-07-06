import { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { Lang, setLang as setLangInLib } from '../lib/i18n';

export type View = 'note' | 'dashboard' | 'settings' | 'graph' | 'canvas' | 'bases' | 'calendar';

export interface ToastInfo {
  message: string;
  type: 'success' | 'error' | 'info';
}

export interface SchedulerProgressInfo {
  stage: string;
  message: string;
  current: number;
  total: number;
  filename?: string;
}

export interface LlmConfig {
  providerId: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  /** Optional context window (in tokens) from the provider preset.
   *  Forwarded to the backend to enable accurate context-budget management
   *  instead of model-name heuristics. */
  contextWindow?: number;
  /** 当前模型是否支持原生思考 — 完全由用户在设置中自行勾选，不做模型白名单推断。 */
  supportsThinking?: boolean;
}




export const DEFAULT_LLM_CONFIG: LlmConfig = {
  providerId: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  supportsThinking: false,
};

export interface BaseState {
  currentFile: string | null;
  openFiles: string[];
  bookmarks: string[];
  lang: Lang;
  llmConfig: LlmConfig;
  isLoading: boolean;
  view: View;
  schedulerLoading: boolean;
  schedulerProgress: string | null;
  schedulerProgressInfo: SchedulerProgressInfo | null;
  toast: ToastInfo | null;
  isSidebarOpen: boolean;
  /** Split editor state */
  isSplitView: boolean;
  splitFile: string | null;
}

export interface BaseContextType {
  state: BaseState;
  setState: React.Dispatch<React.SetStateAction<BaseState>>;
  setCurrentFile: (path: string | null) => void;
  setAppLang: (lang: Lang) => void;
  setLlmConfig: (config: Partial<LlmConfig>) => void;
  setView: (view: View) => void;
  setSchedulerLoading: (loading: boolean) => void;
  setSchedulerProgress: (progress: string | null) => void;
  setSchedulerProgressInfo: (info: SchedulerProgressInfo | null) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  hideToast: () => void;
  closeTab: (path: string) => void;
  toggleBookmark: (path: string) => void;
  renameTabs: (oldPath: string, newPath: string) => void;
  closeTabsUnderPath: (path: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  toggleSidebar: () => void;
  /** Split editor actions */
  toggleSplitView: () => void;
  setSplitFile: (path: string | null) => void;
  openInSplit: (path: string) => void;
  closeSplit: () => void;
}

export const BaseContext = createContext<BaseContextType | null>(null);

import { saveLlmConfig as saveLlmConfigToStore } from '../lib/storage';

export function BaseProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BaseState>(() => {
    let savedTabs: string[] = [];
    let savedBookmarks: string[] = [];
    let isSidebarOpen = true;
    try {
      const tabs = localStorage.getItem('zettelagent-tabs');
      if (tabs) savedTabs = JSON.parse(tabs);
    } catch {}
    try {
      const bms = localStorage.getItem('zettelagent-bookmarks');
      if (bms) savedBookmarks = JSON.parse(bms);
    } catch {}
    try {
      const saved = localStorage.getItem('zettelagent-sidebar-open');
      if (saved !== null) isSidebarOpen = saved === 'true';
    } catch {}

    return {
      currentFile: null,
      openFiles: savedTabs,
      bookmarks: savedBookmarks,
      lang: 'zh',
      llmConfig: DEFAULT_LLM_CONFIG,
      isLoading: true,
      view: 'dashboard',
      schedulerLoading: false,
      schedulerProgress: null,
      schedulerProgressInfo: null,
      toast: null,
      isSidebarOpen,
      isSplitView: false,
      splitFile: null,
    };
  });

  const setCurrentFile = useCallback((path: string | null) => {
    setState((s) => {
      if (!path) {
        return { ...s, currentFile: null };
      }
      const newOpenFiles = s.openFiles ? [...s.openFiles] : [];
      if (!newOpenFiles.includes(path)) {
        newOpenFiles.push(path);
        localStorage.setItem('zettelagent-tabs', JSON.stringify(newOpenFiles));
      }
      return { ...s, currentFile: path, openFiles: newOpenFiles };
    });
  }, []);

  const closeTab = useCallback((path: string) => {
    setState((s) => {
      const newOpenFiles = s.openFiles.filter(p => p !== path);
      localStorage.setItem('zettelagent-tabs', JSON.stringify(newOpenFiles));
      let nextActive = s.currentFile;
      if (s.currentFile === path) {
        const idx = s.openFiles.indexOf(path);
        if (newOpenFiles.length > 0) {
          nextActive = newOpenFiles[Math.min(idx, newOpenFiles.length - 1)];
        } else {
          nextActive = null;
        }
      }
      return { ...s, openFiles: newOpenFiles, currentFile: nextActive };
    });
  }, []);

  const toggleBookmark = useCallback((path: string) => {
    setState((s) => {
      const newBookmarks = s.bookmarks.includes(path)
        ? s.bookmarks.filter(p => p !== path)
        : [...s.bookmarks, path];
      localStorage.setItem('zettelagent-bookmarks', JSON.stringify(newBookmarks));
      return { ...s, bookmarks: newBookmarks };
    });
  }, []);

  const renameTabs = useCallback((oldPath: string, newPath: string) => {
    setState((s) => {
      const newOpenFiles = s.openFiles.map(p => {
        if (p === oldPath) return newPath;
        if (p.startsWith(oldPath + '/') || p.startsWith(oldPath + '\\')) {
          return newPath + p.substring(oldPath.length);
        }
        return p;
      });
      localStorage.setItem('zettelagent-tabs', JSON.stringify(newOpenFiles));

      let nextActive = s.currentFile;
      if (s.currentFile === oldPath) {
        nextActive = newPath;
      } else if (s.currentFile && (s.currentFile.startsWith(oldPath + '/') || s.currentFile.startsWith(oldPath + '\\'))) {
        nextActive = newPath + s.currentFile.substring(oldPath.length);
      }

      const newBookmarks = s.bookmarks.map(p => {
        if (p === oldPath) return newPath;
        if (p.startsWith(oldPath + '/') || p.startsWith(oldPath + '\\')) {
          return newPath + p.substring(oldPath.length);
        }
        return p;
      });
      localStorage.setItem('zettelagent-bookmarks', JSON.stringify(newBookmarks));

      return { ...s, openFiles: newOpenFiles, currentFile: nextActive, bookmarks: newBookmarks };
    });
  }, []);

  const closeTabsUnderPath = useCallback((path: string) => {
    setState((s) => {
      const newOpenFiles = s.openFiles.filter(p => p !== path && !p.startsWith(path + '/') && !p.startsWith(path + '\\'));
      localStorage.setItem('zettelagent-tabs', JSON.stringify(newOpenFiles));

      let nextActive = s.currentFile;
      if (s.currentFile === path || (s.currentFile && (s.currentFile.startsWith(path + '/') || s.currentFile.startsWith(path + '\\')))) {
        if (newOpenFiles.length > 0) {
          nextActive = newOpenFiles[newOpenFiles.length - 1];
        } else {
          nextActive = null;
        }
      }

      const newBookmarks = s.bookmarks.filter(p => p !== path && !p.startsWith(path + '/') && !p.startsWith(path + '\\'));
      localStorage.setItem('zettelagent-bookmarks', JSON.stringify(newBookmarks));

      return { ...s, openFiles: newOpenFiles, currentFile: nextActive, bookmarks: newBookmarks };
    });
  }, []);

  const setAppLang = useCallback((lang: Lang) => {
    setLangInLib(lang);
    setState((s) => ({ ...s, lang }));
  }, []);

  const setLlmConfig = useCallback((partial: Partial<LlmConfig>) => {
    setState((s) => {
      const newConfig = { ...s.llmConfig, ...partial };
      saveLlmConfigToStore(newConfig).catch(err => 
        console.error('Failed to persist LLM config:', err)
      );
      return { ...s, llmConfig: newConfig };
    });
  }, []);



  const setView = useCallback((view: View) => {
    setState((s) => ({ ...s, view }));
  }, []);

  const setSchedulerLoading = useCallback((loading: boolean) => {
    setState((s) => ({ ...s, schedulerLoading: loading }));
  }, []);

  const setSchedulerProgress = useCallback((progress: string | null) => {
    setState((s) => ({ ...s, schedulerProgress: progress }));
  }, []);

  const setSchedulerProgressInfo = useCallback((info: SchedulerProgressInfo | null) => {
    setState((s) => ({ ...s, schedulerProgressInfo: info }));
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setState((s) => ({ ...s, toast: { message, type } }));
    setTimeout(() => {
      setState((s) => {
        if (s.toast?.message === message) {
          return { ...s, toast: null };
        }
        return s;
      });
    }, 4000);
  }, []);

  const hideToast = useCallback(() => {
    setState((s) => ({ ...s, toast: null }));
  }, []);

  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setState((s) => {
      const newOpenFiles = [...s.openFiles];
      const [moved] = newOpenFiles.splice(fromIndex, 1);
      newOpenFiles.splice(toIndex, 0, moved);
      localStorage.setItem('zettelagent-tabs', JSON.stringify(newOpenFiles));
      return { ...s, openFiles: newOpenFiles };
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setState((s) => {
      const nextOpen = !s.isSidebarOpen;
      localStorage.setItem('zettelagent-sidebar-open', String(nextOpen));
      return { ...s, isSidebarOpen: nextOpen };
    });
  }, []);

  const toggleSplitView = useCallback(() => {
    setState((s) => {
      if (s.isSplitView) {
        return { ...s, isSplitView: false, splitFile: null };
      }
      return { ...s, isSplitView: true };
    });
  }, []);

  const setSplitFile = useCallback((path: string | null) => {
    setState((s) => ({ ...s, splitFile: path }));
  }, []);

  const openInSplit = useCallback((path: string) => {
    setState((s) => {
      if (s.currentFile === path) {
        return s;
      }
      return { ...s, isSplitView: true, splitFile: path };
    });
  }, []);

  const closeSplit = useCallback(() => {
    setState((s) => ({ ...s, isSplitView: false, splitFile: null }));
  }, []);

  return (
    <BaseContext.Provider
      value={{
        state,
        setState,
        setCurrentFile,
        setAppLang,
        setLlmConfig,
        setView,
        setSchedulerLoading,
        setSchedulerProgress,
        setSchedulerProgressInfo,
        showToast,
        hideToast,
        closeTab,
        toggleBookmark,
        renameTabs,
        closeTabsUnderPath,
        reorderTabs,
        toggleSidebar,
        toggleSplitView,
        setSplitFile,
        openInSplit,
        closeSplit,
      }}
    >
      {children}
    </BaseContext.Provider>
  );
}

export function useBase() {
  const context = useContext(BaseContext);
  if (!context) {
    throw new Error('useBase must be used within a BaseProvider');
  }
  return context;
}
