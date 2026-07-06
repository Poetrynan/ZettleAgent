import { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { syncVault } from '../lib/tauri';
import { saveVaultPaths as saveVaultPathsToStore, saveMethodology as saveMethodologyToStore } from '../lib/storage';

export type Methodology = 'zettelkasten' | 'para' | 'generic' | 'code' | 'evergreen' | 'gtd' | 'cornell' | 'moc';

export interface VaultState {
  /** Primary vault path (first in vaultPaths). Backward-compatible alias. */
  vaultPath: string | null;
  /** All workspace vault paths */
  vaultPaths: string[];
  isSyncing: boolean;
  methodology: Methodology;
}

export interface VaultContextType {
  state: VaultState;
  setState: React.Dispatch<React.SetStateAction<VaultState>>;
  /** @deprecated Use addVaultPath instead. Sets a single vault (replaces all). */
  setVaultPath: (path: string | null) => void | Promise<void>;
  /** Add a folder to the workspace */
  addVaultPath: (path: string) => Promise<void>;
  /** Remove a folder from the workspace */
  removeVaultPath: (path: string) => Promise<void>;
  /** Set a specific folder as the primary vault (moves it to index 0) */
  setPrimaryVaultPath: (path: string) => Promise<void>;
  setIsSyncing: (syncing: boolean) => void;
  setMethodology: (m: Methodology) => void;
}

const noop = () => {};
const noopAsync = async () => {};

/** Safe default so components don't crash during the brief mount window before VaultProvider commits. */
const defaultVaultContext: VaultContextType = {
  state: { vaultPath: null, vaultPaths: [], isSyncing: false, methodology: 'zettelkasten' },
  setState: noop as any,
  setVaultPath: noopAsync,
  addVaultPath: noopAsync,
  removeVaultPath: noopAsync,
  setPrimaryVaultPath: noopAsync,
  setIsSyncing: noop,
  setMethodology: noop,
};

export const VaultContext = createContext<VaultContextType>(defaultVaultContext);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<VaultState>({
    vaultPath: null,
    vaultPaths: [],
    isSyncing: false,
    methodology: 'zettelkasten',
  });

  /** Helper: persist and sync a list of vault paths */
  const persistAndSync = useCallback(async (paths: string[]) => {
    const primary = paths[0] ?? null;
    setState((s) => ({ ...s, vaultPaths: paths, vaultPath: primary }));

    try {
      await saveVaultPathsToStore(paths);
      // Sync all paths
      if (paths.length > 0) {
        setState((s) => ({ ...s, isSyncing: true }));
        try {
          for (const p of paths) {
            await syncVault(p);
          }
        } catch (syncErr) {
          console.error('Failed to auto-sync vault after selection:', syncErr);
        } finally {
          setState((s) => ({ ...s, isSyncing: false }));
        }
      }
    } catch (err) {
      console.error('Failed to persist vault paths:', err);
    }
  }, []);

  /** Legacy: set a single vault path (replaces all). */
  const setVaultPath = useCallback(async (path: string | null) => {
    if (path) {
      // If path already exists, just make it primary
      setState((s) => {
        if (s.vaultPaths.includes(path)) {
          const reordered = [path, ...s.vaultPaths.filter(p => p !== path)];
          persistAndSync(reordered);
          return s; // persistAndSync will update state
        }
        return s;
      });
      // If not already in paths, replace all
      const current = state.vaultPaths;
      if (!current.includes(path)) {
        await persistAndSync([path, ...current]);
      } else {
        const reordered = [path, ...current.filter(p => p !== path)];
        await persistAndSync(reordered);
      }
    } else {
      await persistAndSync([]);
    }
  }, [state.vaultPaths, persistAndSync]);

  /** Add a new folder to the workspace */
  const addVaultPath = useCallback(async (path: string) => {
    const current = state.vaultPaths;
    if (current.includes(path)) return; // Already exists
    const updated = [...current, path];
    await persistAndSync(updated);
  }, [state.vaultPaths, persistAndSync]);

  /** Remove a folder from the workspace */
  const removeVaultPath = useCallback(async (path: string) => {
    const updated = state.vaultPaths.filter(p => p !== path);
    await persistAndSync(updated);
  }, [state.vaultPaths, persistAndSync]);

  /** Set a specific folder as primary (index 0) */
  const setPrimaryVaultPath = useCallback(async (path: string) => {
    const current = state.vaultPaths;
    if (!current.includes(path)) return;
    const reordered = [path, ...current.filter(p => p !== path)];
    setState(s => ({ ...s, vaultPaths: reordered, vaultPath: path }));
    await saveVaultPathsToStore(reordered);
  }, [state.vaultPaths]);

  const setIsSyncing = useCallback((syncing: boolean) => {
    setState((s) => ({ ...s, isSyncing: syncing }));
  }, []);

  const setMethodology = useCallback((methodology: Methodology) => {
    setState((s) => ({ ...s, methodology }));
    saveMethodologyToStore(methodology).catch(err => 
      console.error('Failed to persist methodology:', err)
    );
  }, []);

  return (
    <VaultContext.Provider
      value={{
        state,
        setState,
        setVaultPath,
        addVaultPath,
        removeVaultPath,
        setPrimaryVaultPath,
        setIsSyncing,
        setMethodology,
      }}
    >
      {children}
    </VaultContext.Provider>
  );
}

export function useVault() {
  return useContext(VaultContext);
}
