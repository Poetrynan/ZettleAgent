/**
 * The migration contract for the LLM API key: the plaintext copy may be erased
 * ONLY when the backend says it has verified the new location.
 *
 * This is the one place where getting it wrong loses the user's key
 * irreversibly, which is why it is tested at the `loadLlmConfig` level (the real
 * entry point) rather than against the private helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeState = new Map<string, unknown>();
const storeSet = vi.fn(async (k: string, v: unknown) => { storeState.set(k, v); });

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => storeState.get(k),
      set: storeSet,
      save: async () => {},
      delete: async (k: string) => { storeState.delete(k); },
      clear: async () => { storeState.clear(); },
    }),
  },
}));

const migrateApiKey = vi.fn();
vi.mock('../secrets', () => ({
  migrateApiKey: (...args: unknown[]) => migrateApiKey(...args),
  setApiKey: vi.fn(async () => ({ backend: 'os-keyring', protected: true, has_key: true, fallback_reason: null })),
  getApiKeyStatus: vi.fn(async () => ({ backend: 'os-keyring', protected: true, has_key: true, fallback_reason: null })),
}));

import { loadLlmConfig } from '../storage';

const LEGACY = { apiUrl: 'https://api.example.com', model: 'gpt-4o-mini', apiKey: 'sk-legacy-plaintext-0001' };

beforeEach(() => {
  storeState.clear();
  storeSet.mockClear();
  migrateApiKey.mockReset();
  localStorage.clear();
  storeState.set('llmConfig', { ...LEGACY });
});

describe('API key migration', () => {
  it('erases the plaintext copy only after plaintext_can_be_deleted comes back true', async () => {
    migrateApiKey.mockResolvedValue({
      migrated: true,
      backend: 'os-keyring',
      plaintext_can_be_deleted: true,
      protected: true,
      detail: null,
    });

    const loaded = await loadLlmConfig();

    expect(migrateApiKey).toHaveBeenCalledWith(LEGACY.apiKey);
    // Nothing hands the key back to the caller any more.
    expect(loaded).not.toHaveProperty('apiKey');
    // …and it is gone from both persisted locations.
    expect(storeSet).toHaveBeenCalledWith('llmConfig', expect.not.objectContaining({ apiKey: expect.anything() }));
    expect(JSON.parse(localStorage.getItem('zettelagent-llm') ?? '{}')).not.toHaveProperty('apiKey');
  });

  it('keeps the plaintext when the backend refuses to greenlight deletion', async () => {
    // The half-failed migration: written somewhere, but not read back
    // identically. Losing the key is worse than leaving it exposed.
    migrateApiKey.mockResolvedValue({
      migrated: false,
      backend: 'unprotected-file',
      plaintext_can_be_deleted: false,
      protected: false,
      detail: 'Stored value did not read back identically.',
    });

    const loaded = await loadLlmConfig();

    expect(loaded).toMatchObject({ apiKey: LEGACY.apiKey });
    // Crucially: no rewrite that would have dropped the key.
    expect(storeSet).not.toHaveBeenCalled();
  });

  it('keeps the plaintext when the migration command is missing entirely', async () => {
    migrateApiKey.mockRejectedValue(new Error('command migrate_api_key not allowed'));

    const loaded = await loadLlmConfig();

    expect(loaded).toMatchObject({ apiKey: LEGACY.apiKey });
    expect(storeSet).not.toHaveBeenCalled();
  });

  it('is idempotent — a config with no key needs no migration call', async () => {
    storeState.set('llmConfig', { apiUrl: LEGACY.apiUrl, model: LEGACY.model });

    const loaded = await loadLlmConfig();

    expect(migrateApiKey).not.toHaveBeenCalled();
    expect(loaded).not.toHaveProperty('apiKey');
  });
});
