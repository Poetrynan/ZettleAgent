/**
 * The plaintext fallback in `saveLlmConfig` must never be silent.
 *
 * Keeping the key when the credential-store hand-off throws is deliberate — a
 * lost key is unrecoverable, an exposed one is not. What is NOT acceptable is
 * doing that quietly: the hardening would be reverted with nothing the user
 * could see. These tests pin the visible half of that contract.
 *
 * The WebView-side plaintext copy is invisible to the Rust status probe (Rust
 * only knows the keyring and its own fallback file), so the interesting case is
 * a probe that answers "no key at all" while a plaintext copy actually exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeState = new Map<string, unknown>();

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => storeState.get(k),
      set: async (k: string, v: unknown) => { storeState.set(k, v); },
      save: async () => {},
      delete: async (k: string) => { storeState.delete(k); },
      clear: async () => { storeState.clear(); },
    }),
  },
}));

const setApiKey = vi.fn();
const getApiKeyStatus = vi.fn();
vi.mock('../secrets', () => ({
  setApiKey: (...a: unknown[]) => setApiKey(...a),
  getApiKeyStatus: () => getApiKeyStatus(),
  migrateApiKey: vi.fn(),
}));

const NO_KEY = { backend: 'none', protected: false, has_key: false, fallback_reason: null };

/** Fresh module per test: the protection status is module-level cache. */
async function freshStorage() {
  vi.resetModules();
  return import('../storage');
}

beforeEach(() => {
  storeState.clear();
  localStorage.clear();
  setApiKey.mockReset();
  getApiKeyStatus.mockReset();
});

describe('plaintext fallback visibility', () => {
  it('reports an unprotected status when the keyring hand-off throws', async () => {
    setApiKey.mockRejectedValue(new Error('command set_api_key not allowed'));
    // The backend cannot see the WebView copy, so it honestly reports "no key".
    // Trusting that answer is exactly how the warning used to disappear.
    getApiKeyStatus.mockResolvedValue(NO_KEY);

    const storage = await freshStorage();
    await storage.saveLlmConfig({ apiUrl: 'https://api.example.com', model: 'm', apiKey: 'sk-kept-in-plaintext' });

    const status = await storage.getSecretStatus(true);
    expect(status).not.toBeNull();
    expect(status!.has_key).toBe(true);
    expect(status!.protected).toBe(false);
    expect(status!.backend).toBe('unprotected-file');
    // A reason must travel to the banner, not just a bare "unprotected".
    expect(status!.fallback_reason).toBeTruthy();
  });

  it('keeps warning even when the status command itself is unavailable', async () => {
    setApiKey.mockRejectedValue(new Error('command set_api_key not allowed'));
    getApiKeyStatus.mockRejectedValue(new Error('command get_api_key_status not allowed'));

    const storage = await freshStorage();
    await storage.saveLlmConfig({ apiKey: 'sk-kept-in-plaintext' });

    const status = await storage.getSecretStatus(true);
    expect(status?.protected).toBe(false);
    expect(status?.has_key).toBe(true);
  });

  it('stays silent when there was no key to fall back with', async () => {
    // Clearing the key must not invent a scary "unprotected key" banner.
    setApiKey.mockRejectedValue(new Error('command set_api_key not allowed'));
    getApiKeyStatus.mockResolvedValue(NO_KEY);

    const storage = await freshStorage();
    await storage.saveLlmConfig({ apiKey: '' });

    expect(await storage.getSecretStatus(true)).toEqual(NO_KEY);
  });

  it('does not override the backend status once a hand-off succeeds', async () => {
    const protectedStatus = { backend: 'os-keyring', protected: true, has_key: true, fallback_reason: null };
    setApiKey.mockResolvedValue(protectedStatus);
    getApiKeyStatus.mockResolvedValue(protectedStatus);

    const storage = await freshStorage();
    await storage.saveLlmConfig({ apiKey: 'sk-properly-stored' });

    expect(await storage.getSecretStatus(true)).toEqual(protectedStatus);
    // …and the key is not left behind in WebView storage.
    expect(JSON.parse(localStorage.getItem('zettelagent-llm') ?? '{}')).not.toHaveProperty('apiKey');
  });
});
