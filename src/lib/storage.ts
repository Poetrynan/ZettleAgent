/**
 * Persistent storage using Tauri Store plugin
 * Data is stored in local filesystem, not affected by WebView cache clearing
 */

import { Store } from '@tauri-apps/plugin-store';

let store: Store | null = null;

/**
 * Initialize the store
 */
async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load('settings.json', { 
      autoSave: true,
      defaults: {} 
    });
  }
  return store;
}

/**
 * Save LLM configuration — writes to both Tauri Store and localStorage.
 */
export async function saveLlmConfig(config: Record<string, unknown>): Promise<void> {
  // Always write to localStorage as backup
  localStorage.setItem('zettelagent-llm', JSON.stringify(config));

  try {
    const st = await getStore();
    await st.set('llmConfig', config);
    await st.save();
  } catch (error) {
    console.error('Failed to save LLM config to Tauri Store:', error);
  }
}

/**
 * Load LLM configuration — tries Tauri Store first, falls back to localStorage.
 */
export async function loadLlmConfig(): Promise<Record<string, unknown> | null> {
  try {
    const st = await getStore();
    const config = await st.get<Record<string, unknown>>('llmConfig');
    if (config) return config;
  } catch (error) {
    console.error('Failed to load LLM config from Tauri Store:', error);
  }
  // Fallback: localStorage
  try {
    const saved = localStorage.getItem('zettelagent-llm');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return null;
}

/**
 * Migrate data from localStorage to Tauri Store
 * Should be called once on app initialization
 */
export async function migrateFromLocalStorage(): Promise<void> {
  try {
    const st = await getStore();
    const existingConfig = await st.get('llmConfig');
    
    // Only migrate if Tauri store is empty
    if (!existingConfig) {
      const localStorageData = localStorage.getItem('zettelagent-llm');
      if (localStorageData) {
        const config = JSON.parse(localStorageData);
        await st.set('llmConfig', config);
        await st.save();
        console.log('Successfully migrated LLM config from localStorage to Tauri Store');
        // Optionally clear localStorage after successful migration
        // localStorage.removeItem('zettelagent-llm');
      }
    }
  } catch (error) {
    console.error('Failed to migrate from localStorage:', error);
  }
}

/**
 * Save language preference
 */
export async function saveLang(lang: string): Promise<void> {
  try {
    const st = await getStore();
    await st.set('lang', lang);
    await st.save();
  } catch (error) {
    console.error('Failed to save lang:', error);
    localStorage.setItem('zettelagent-lang', lang);
  }
}

/**
 * Load language preference
 */
export async function loadLang(): Promise<string | null> {
  try {
    const st = await getStore();
    return await st.get<string>('lang') ?? null;
  } catch (error) {
    console.error('Failed to load lang:', error);
    return localStorage.getItem('zettelagent-lang');
  }
}

/**
 * Save vault paths (multi-workspace) — writes to BOTH Tauri Store and localStorage.
 */
export async function saveVaultPaths(paths: string[]): Promise<void> {
  // Always write to localStorage as a fast backup
  localStorage.setItem('zettelagent-vault-paths', JSON.stringify(paths));
  // Also clear old single-path key
  localStorage.removeItem('zettelagent-vault-path');

  try {
    const st = await getStore();
    await st.set('vaultPaths', paths);
    // Clean up old single-path key
    await st.delete('vaultPath');
    await st.save();
  } catch (error) {
    console.error('Failed to save vault paths to Tauri Store:', error);
  }
}

/**
 * Load vault paths (multi-workspace) — tries Tauri Store first, falls back to localStorage.
 * Automatically migrates from old single-path format.
 */
export async function loadVaultPaths(): Promise<string[]> {
  try {
    const st = await getStore();
    // Try new multi-path key first
    const paths = await st.get<string[]>('vaultPaths');
    if (paths && paths.length > 0) return paths;

    // Migrate from old single-path key
    const oldPath = await st.get<string>('vaultPath');
    if (oldPath) {
      const migrated = [oldPath];
      await saveVaultPaths(migrated);
      return migrated;
    }
  } catch (error) {
    console.error('Failed to load vault paths from Tauri Store:', error);
  }

  // Fallback: localStorage multi-path
  try {
    const saved = localStorage.getItem('zettelagent-vault-paths');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }

  // Fallback: localStorage old single-path
  const oldLocal = localStorage.getItem('zettelagent-vault-path');
  if (oldLocal) return [oldLocal];

  return [];
}

/**
 * @deprecated Use saveVaultPaths instead. Kept for backward compatibility.
 */
export async function saveVaultPath(path: string | null): Promise<void> {
  if (path) {
    const current = await loadVaultPaths();
    if (!current.includes(path)) {
      await saveVaultPaths([path, ...current]);
    }
  } else {
    await saveVaultPaths([]);
  }
}

/**
 * @deprecated Use loadVaultPaths instead. Kept for backward compatibility.
 */
export async function loadVaultPath(): Promise<string | null> {
  const paths = await loadVaultPaths();
  return paths[0] ?? null;
}

/**
 * Clear all stored data (useful for reset/logout)
 */
export async function clearAllData(): Promise<void> {
  try {
    const st = await getStore();
    await st.clear();
    await st.save();
  } catch (error) {
    console.error('Failed to clear data:', error);
  }
}

/**
 * Save methodology preference
 */
export async function saveMethodology(methodology: string): Promise<void> {
  localStorage.setItem('zettelagent-methodology', methodology);
  try {
    const st = await getStore();
    await st.set('methodology', methodology);
    await st.save();
  } catch (error) {
    console.error('Failed to save methodology:', error);
  }
}

/**
 * Load methodology preference
 */
export async function loadMethodology(): Promise<string | null> {
  try {
    const st = await getStore();
    const methodology = await st.get<string>('methodology');
    if (methodology) return methodology;
  } catch (error) {
    console.error('Failed to load methodology:', error);
  }
  return localStorage.getItem('zettelagent-methodology');
}

/**
 * Save embedding configuration
 */
export async function saveEmbeddingConfig(config: Record<string, unknown>): Promise<void> {
  localStorage.setItem('zettelagent-embedding', JSON.stringify(config));
  try {
    const st = await getStore();
    await st.set('embeddingConfig', config);
    await st.save();
  } catch (error) {
    console.error('Failed to save embedding config to Tauri Store:', error);
  }
}

/**
 * Load embedding configuration
 */
export async function loadEmbeddingConfig(): Promise<Record<string, unknown> | null> {
  try {
    const st = await getStore();
    const config = await st.get<Record<string, unknown>>('embeddingConfig');
    if (config) return config;
  } catch (error) {
    console.error('Failed to load embedding config from Tauri Store:', error);
  }
  try {
    const saved = localStorage.getItem('zettelagent-embedding');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return null;
}

/**
 * Save onboarding completed flag
 */
export async function saveOnboardingComplete(): Promise<void> {
  localStorage.setItem('zettelagent-onboarding', 'done');
  try {
    const st = await getStore();
    await st.set('onboardingComplete', true);
    await st.save();
  } catch (error) {
    console.error('Failed to save onboarding flag:', error);
  }
}

/**
 * Load onboarding completed flag
 */
export async function loadOnboardingComplete(): Promise<boolean> {
  try {
    const st = await getStore();
    const done = await st.get<boolean>('onboardingComplete');
    if (done) return true;
  } catch (error) {
    console.error('Failed to load onboarding flag:', error);
  }
  return localStorage.getItem('zettelagent-onboarding') === 'done';
}

/**
 * Save custom daily note folder path.
 * If null/empty, the default Desktop/ZettelAgent Daily path will be used.
 */
export async function saveDailyNotePath(path: string | null): Promise<void> {
  localStorage.setItem('zettelagent-daily-path', path || '');
  try {
    const st = await getStore();
    await st.set('dailyNotePath', path || '');
    await st.save();
  } catch (error) {
    console.error('Failed to save daily note path:', error);
  }
}

/**
 * Load custom daily note folder path.
 * Returns null if not set (use default).
 */
export async function loadDailyNotePath(): Promise<string | null> {
  try {
    const st = await getStore();
    const path = await st.get<string>('dailyNotePath');
    if (path && path.length > 0) return path;
  } catch (error) {
    console.error('Failed to load daily note path:', error);
  }
  const local = localStorage.getItem('zettelagent-daily-path');
  return (local && local.length > 0) ? local : null;
}
