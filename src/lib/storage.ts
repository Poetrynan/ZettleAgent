/**
 * Persistent storage using Tauri Store plugin
 * Data is stored in local filesystem, not affected by WebView cache clearing
 *
 * ## API key handling
 *
 * `llmConfig.apiKey` is deliberately NOT part of what gets written here. It is
 * routed to the OS credential store through `./secrets` instead, and stripped
 * from both `localStorage` and `settings.json`. `saveLlmConfig` /
 * `loadLlmConfig` are the only choke points the rest of the app uses for this
 * config, which is why the hardening lives here rather than in every caller.
 */

import { Store } from '@tauri-apps/plugin-store';
import { setApiKey, migrateApiKey, getApiKeyStatus, type SecretStatus } from './secrets';
import { t } from './i18n';

let store: Store | null = null;

/** Legacy plaintext location. Kept as a constant because several functions
 *  below exist purely to make sure nothing is left in it. */
const LLM_LOCAL_KEY = 'zettelagent-llm';

/**
 * Last known protection status, cached so the settings UI can render a warning
 * without a round-trip on every keystroke. `null` means "not probed yet".
 */
let lastSecretStatus: SecretStatus | null = null;

/**
 * True once a keyring hand-off has thrown outright and the key had to be kept
 * in plaintext WebView storage. That copy is invisible to the Rust status
 * probe (it only knows about the keyring and its own fallback file), so the
 * frontend must remember it — otherwise the next probe would report
 * `has_key: false` and the warning banner would silently vanish.
 */
let plaintextFallbackActive = false;

/**
 * The "unprotected, key kept in plaintext" status the backend cannot report
 * because the only copy lives in WebView storage, not anywhere Rust can see.
 */
function plaintextFallbackStatus(): SecretStatus {
  return {
    backend: 'unprotected-file',
    protected: false,
    has_key: true,
    fallback_reason: t('settings.apiKeyKeyringWriteFailed'),
  };
}

/** Status of the stored key, from cache when available. */
export async function getSecretStatus(force = false): Promise<SecretStatus | null> {
  if (lastSecretStatus && !force) return lastSecretStatus;
  try {
    const probed = await getApiKeyStatus();
    // A frontend-only plaintext fallback is invisible to the backend probe, so
    // it would answer `has_key: false` and drop the warning. Keep warning.
    lastSecretStatus = plaintextFallbackActive && !probed.has_key
      ? plaintextFallbackStatus()
      : probed;
  } catch {
    // The command may not be registered (older build). If we degraded to a
    // plaintext fallback, keep saying so; otherwise report `null` rather than
    // claim a protection level we can't verify.
    lastSecretStatus = plaintextFallbackActive ? plaintextFallbackStatus() : null;
  }
  return lastSecretStatus;
}

/** Strip `apiKey` so it never reaches a persistence call. */
function withoutApiKey(config: Record<string, unknown>): Record<string, unknown> {
  const { apiKey: _dropped, ...rest } = config;
  return rest;
}

/** Write the non-secret part of the config to both stores. */
async function persistLlmConfig(config: Record<string, unknown>): Promise<void> {
  localStorage.setItem(LLM_LOCAL_KEY, JSON.stringify(config));
  try {
    const st = await getStore();
    await st.set('llmConfig', config);
    await st.save();
  } catch (error) {
    console.error('Failed to save LLM config to Tauri Store:', error);
  }
}

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
 * Save LLM configuration.
 *
 * The API key is handed to the OS credential store and removed from the
 * persisted config. If that hand-off throws — e.g. a build where the backend
 * command isn't available, or one where even the backend's own fallback file
 * could not be written — we fall back to the historical behaviour of persisting
 * the key, because losing the user's key is a worse outcome than storing it the
 * way we always have.
 *
 * What must NOT happen is that fallback being silent: it would revert the
 * hardening with no visible trace. So the degradation is recorded and
 * `getSecretStatus()` reports an explicitly *unprotected* status from that point
 * on, which is what puts the warning banner in front of the user on the very
 * next status read (the settings tab re-probes on save) rather than never.
 */
export async function saveLlmConfig(config: Record<string, unknown>): Promise<void> {
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  try {
    lastSecretStatus = await setApiKey(apiKey);
    // The backend owns the key now — either in the keyring, or in its own
    // clearly-named unprotected file, which its status probe *can* see. Either
    // way there is no WebView-side plaintext copy left to remember.
    plaintextFallbackActive = false;
    await persistLlmConfig(withoutApiKey(config));
  } catch (error) {
    // Never log `config` itself — it still holds the key at this point.
    console.error('Failed to store API key in the OS credential store:', error);
    plaintextFallbackActive = apiKey.length > 0;
    lastSecretStatus = plaintextFallbackActive ? plaintextFallbackStatus() : null;
    await persistLlmConfig(config);
  }
}

/**
 * Load LLM configuration — tries Tauri Store first, falls back to localStorage.
 *
 * Any plaintext key found on the way is migrated into the credential store and
 * then erased from disk (see `hardenLoadedConfig`). The returned object has no
 * `apiKey`, so request builders pass `undefined` down and the backend resolves
 * the key itself.
 */
export async function loadLlmConfig(): Promise<Record<string, unknown> | null> {
  try {
    const st = await getStore();
    const config = await st.get<Record<string, unknown>>('llmConfig');
    if (config) return await hardenLoadedConfig(config);
  } catch (error) {
    console.error('Failed to load LLM config from Tauri Store:', error);
  }
  // Fallback: localStorage
  try {
    const saved = localStorage.getItem(LLM_LOCAL_KEY);
    if (saved) return await hardenLoadedConfig(JSON.parse(saved));
  } catch { /* ignore */ }
  return null;
}

/**
 * Migrate a plaintext key out of a just-loaded config, then erase it.
 *
 * Ordering matters and is enforced by the backend: it only sets
 * `plaintext_can_be_deleted` after reading the value back out of the credential
 * store. We delete the old copy exclusively on that signal, so an interrupted
 * or failed migration leaves the user's key intact where it was. Re-running on
 * every launch is safe — the backend treats an already-stored key as "nothing
 * to do, the plaintext is redundant".
 */
async function hardenLoadedConfig(
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const plaintext = typeof config.apiKey === 'string' ? config.apiKey : '';
  if (!plaintext) return withoutApiKey(config);

  try {
    const outcome = await migrateApiKey(plaintext);
    if (!outcome.plaintext_can_be_deleted) {
      // Keep the plaintext: it is currently the only copy of the key.
      console.warn('API key migration incomplete; the plaintext copy was kept.');
      return config;
    }
    // Write-new-succeeded ⇒ delete-old. Not doing this would mean no hardening
    // at all: the key would simply exist in two places instead of one.
    await persistLlmConfig(withoutApiKey(config));
    lastSecretStatus = {
      backend: outcome.backend,
      protected: outcome.protected,
      has_key: true,
      fallback_reason: outcome.protected ? null : outcome.detail,
    };
    return withoutApiKey(config);
  } catch (error) {
    console.error('API key migration unavailable; keeping the existing config:', error);
    return config;
  }
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
      const localStorageData = localStorage.getItem(LLM_LOCAL_KEY);
      if (localStorageData) {
        const config = JSON.parse(localStorageData);
        // Route the key to the credential store and persist only the rest, so
        // this migration cannot re-seed plaintext into `settings.json`.
        await saveLlmConfig(config);
        console.log('Successfully migrated LLM config from localStorage to Tauri Store');
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

export async function saveNewFolderDefaultPath(path: string | null): Promise<void> {
  localStorage.setItem('zettelagent-new-folder-default-path', path || '');
  try {
    const st = await getStore();
    await st.set('newFolderDefaultPath', path || '');
    await st.save();
  } catch (error) {
    console.error('Failed to save new folder default path:', error);
  }
}

export async function loadNewFolderDefaultPath(): Promise<string | null> {
  try {
    const st = await getStore();
    const path = await st.get<string>('newFolderDefaultPath');
    if (path && path.length > 0) return path;
  } catch (error) {
    console.error('Failed to load new folder default path:', error);
  }
  const local = localStorage.getItem('zettelagent-new-folder-default-path');
  return (local && local.length > 0) ? local : null;
}

