import { beforeEach, describe, expect, it, vi } from 'vitest';

const secret = vi.hoisted(() => ({
  set: vi.fn(), save: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({
  get: async () => null, set: async () => {}, save: secret.save,
}) } }));
vi.mock('../secrets', () => ({ setApiKey: secret.set, getApiKeyStatus: vi.fn(), migrateApiKey: vi.fn() }));
import { saveLlmConfig } from '../storage';

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  secret.save.mockResolvedValue(undefined);
  secret.set.mockResolvedValue({ backend: 'os-keyring', has_key: true, protected: true, fallback_reason: null });
});
describe('connection persistence', () => {
  it('preserves the stored credential when only endpoint or model settings are saved', async () => {
    await saveLlmConfig({ providerId: 'custom', model: 'new-model', apiUrl: 'http://localhost/v1' });
    expect(secret.set).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('zettelagent-llm')!)).not.toHaveProperty('apiKey');
  });
  it('still clears a credential when the user explicitly submits an empty key', async () => {
    await saveLlmConfig({ model: 'm', apiKey: '' });
    expect(secret.set).toHaveBeenCalledWith('');
  });
  it('reports a settings-file failure without putting a protected key into browser storage', async () => {
    secret.save.mockRejectedValue(new Error('disk unavailable'));
    await expect(saveLlmConfig({ model: 'm', apiKey: 'test-only-key' })).rejects.toThrow('disk unavailable');
    expect(localStorage.getItem('zettelagent-llm')).not.toContain('test-only-key');
  });
});
