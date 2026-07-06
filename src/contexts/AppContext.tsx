import { ReactNode, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { t } from '../lib/i18n';
import { syncVault, initDemoVault, listDirectoryTree } from '../lib/tauri';
import {
  migrateFromLocalStorage,
  loadLlmConfig as loadLlmConfigFromStore,
  loadVaultPaths as loadVaultPathsFromStore,
  loadMethodology as loadMethodologyFromStore,
  saveVaultPaths as saveVaultPathsToStore,
} from '../lib/storage';
import { initLang, getLang } from '../lib/i18n';

import { BaseProvider, useBase, DEFAULT_LLM_CONFIG, View, ToastInfo, SchedulerProgressInfo, LlmConfig } from './BaseContext';
import { VaultProvider, useVault } from './VaultContext';
import { ChatProvider, useChat } from './ChatContext';
import type { NoteAttachment } from './ChatContext';
import { SearchMode } from '../lib/tauri';

export type { View, ToastInfo, SchedulerProgressInfo, LlmConfig };

export interface AppState {
  vaultPath: string | null;
  vaultPaths: string[];
  currentFile: string | null;
  openFiles: string[];
  bookmarks: string[];
  isSyncing: boolean;
  isChatOpen: boolean;
  isSidebarOpen: boolean;
  searchQuery: string;
  searchMode: SearchMode;
  lang: any;
  llmConfig: LlmConfig;
  isLoading: boolean;
  view: View;
  schedulerLoading: boolean;
  schedulerProgress: string | null;
  schedulerProgressInfo: SchedulerProgressInfo | null;
  toast: ToastInfo | null;
  methodology: 'zettelkasten' | 'para' | 'generic' | 'code' | 'evergreen' | 'gtd' | 'cornell' | 'moc';
  pendingAttachments: NoteAttachment[];
  pendingChatPrompt: string | null;
  isSplitView: boolean;
  splitFile: string | null;
}

function AppInitializer({ children }: { children: ReactNode }) {
  const { state: baseState, setState: setBaseState } = useBase();
  const { setState: setVaultState } = useVault();

  useEffect(() => {
    async function initializeApp() {
      const emitProgress = (progress: number, stage: string) => {
        window.dispatchEvent(new CustomEvent('splash-progress', { detail: { progress, stage } }));
      };

      try {
        emitProgress(5, 'Initializing...');
        await migrateFromLocalStorage();

        emitProgress(15, 'Loading configuration...');
        const savedConfig = await loadLlmConfigFromStore();
        const llmConfig = savedConfig 
          ? { ...DEFAULT_LLM_CONFIG, ...savedConfig }
          : DEFAULT_LLM_CONFIG;

        emitProgress(25, 'Loading vault...');
        let savedVaultPaths = await loadVaultPathsFromStore();
        const savedMethodology = await loadMethodologyFromStore();
        const methodology = (savedMethodology || 'zettelkasten') as 'zettelkasten' | 'para' | 'generic' | 'code' | 'evergreen' | 'gtd' | 'cornell' | 'moc';

        // If no vault paths are configured, initialize the bundled demo vault
        // Also handles stale paths from previous sessions (e.g. deleted dirs)
        if (savedVaultPaths.length === 0) {
          try {
            const demoPath = await initDemoVault();
            savedVaultPaths = [demoPath];
            await saveVaultPathsToStore(savedVaultPaths);
          } catch (err) {
            console.warn('Failed to init demo vault:', err);
          }
        } else {
          // Filter out paths that no longer exist on disk
          const validPaths: string[] = [];
          for (const vp of savedVaultPaths) {
            try {
              await listDirectoryTree(vp);
              validPaths.push(vp);
            } catch {
              console.warn('Removing stale vault path:', vp);
            }
          }
          if (validPaths.length === 0) {
            // All paths are stale — fall back to demo vault
            try {
              const demoPath = await initDemoVault();
              savedVaultPaths = [demoPath];
              await saveVaultPathsToStore(savedVaultPaths);
            } catch (err) {
              console.warn('Failed to init demo vault:', err);
              savedVaultPaths = [];
            }
          } else if (validPaths.length !== savedVaultPaths.length) {
            savedVaultPaths = validPaths;
            await saveVaultPathsToStore(savedVaultPaths);
          }
        }

        emitProgress(45, 'Preparing interface...');
        initLang();

        setBaseState((s) => ({
          ...s,
          lang: getLang(),
          llmConfig,
          isLoading: false,
        }));

        setVaultState((s) => ({
          ...s,
          vaultPath: savedVaultPaths[0] ?? null,
          vaultPaths: savedVaultPaths,
          methodology,
        }));

        if (savedVaultPaths.length > 0) {
          emitProgress(55, 'Syncing vault...');
          try {
            for (const vp of savedVaultPaths) {
              await syncVault(vp);
            }
          } catch (err) {
            console.warn('Auto-sync on startup failed:', err);
          }

          emitProgress(65, 'Restoring background organize...');
          try {
            const { resumeBackgroundOrganizeIfEnabled } = await import('../lib/backgroundOrganize');
            await resumeBackgroundOrganizeIfEnabled({
              vaultPaths: savedVaultPaths,
              llmConfig,
              methodology,
            });
          } catch (err) {
            console.warn('Failed to resume hourly background organize:', err);
          }
        }

        // Performance preloading
        emitProgress(75, 'Preloading assets...');
        try {
          // Preload UI fonts
          await Promise.race([
            Promise.all([
              document.fonts.load('400 16px "Inter"').catch(() => {}),
              document.fonts.load('600 16px "Inter"').catch(() => {}),
              document.fonts.load('400 13px "SF Mono", "Cascadia Code", "Consolas"').catch(() => {}),
            ]),
            new Promise(r => setTimeout(r, 800)), // Max 800ms for font loading
          ]);
        } catch {
          // Font preloading is best-effort
        }

        emitProgress(90, 'Warming up...');
        // Small delay to let React commit the state updates
        await new Promise(r => setTimeout(r, 50));

        emitProgress(100, 'Ready');
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setBaseState((s) => ({
          ...s,
          lang: getLang(),
          isLoading: false,
        }));
        emitProgress(100, 'Ready');
      }
    }

    initializeApp();
  }, [setBaseState, setVaultState]);

  useEffect(() => {
    const unlisten = listen<{ stage: string; message: string; current?: number; total?: number; filename?: string }>('scheduler-progress', (event) => {
      const stage = event.payload.stage;
      let displayMessage = event.payload.message;
      if (stage === 'starting') {
        displayMessage = t('scheduler.starting');
      } else if (stage === 'done') {
        displayMessage = t('scheduler.done');
      } else if (stage === 'aborted') {
        displayMessage = t('scheduler.aborted');
      } else if (stage === 'aborting') {
        displayMessage = t('scheduler.aborting');
      }
      
      setBaseState((s) => ({
        ...s,
        schedulerProgress: displayMessage,
        schedulerProgressInfo: (stage === 'done' || stage === 'aborted') ? null : {
          stage,
          message: displayMessage,
          current: event.payload.current ?? 0,
          total: event.payload.total ?? 0,
          filename: event.payload.filename,
        }
      }));
      
      if (stage === 'done' || stage === 'aborted') {
        setTimeout(() => {
          setBaseState((s) => ({ ...s, schedulerProgress: null }));
        }, 2000);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [baseState.lang, setBaseState]);

  return <>{children}</>;
}

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <BaseProvider>
      <VaultProvider>
        <ChatProvider>
          <AppInitializer>
            {children}
          </AppInitializer>
        </ChatProvider>
      </VaultProvider>
    </BaseProvider>
  );
}

export function useApp() {
  const { state: baseState, ...baseActions } = useBase();
  const { state: vaultState, ...vaultActions } = useVault();
  const { state: chatState, ...chatActions } = useChat();

  const state: AppState = {
    ...baseState,
    ...vaultState,
    ...chatState,
  };

  return {
    state,
    ...baseActions,
    ...vaultActions,
    ...chatActions,
  };
}
