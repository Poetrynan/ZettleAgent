import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLang } from '../../../lib/i18n';
const app = vi.hoisted(() => ({
  state: { lang: 'en', view: 'settings', vaultPath: '/vault', vaultPaths: ['/vault'], methodology: 'zettelkasten',
    llmConfig: { providerId: 'openai', apiUrl: 'https://api.openai.com/v1/chat/completions', apiKey: '', model: 'gpt-4o-mini', supportsThinking: false } },
  setAppLang: vi.fn(), setLlmConfig: vi.fn(), setMethodology: vi.fn(), showToast: vi.fn(),
}));
vi.mock('../../../contexts/AppContext', () => ({ useApp: () => app }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '/data') }));
vi.mock('../../../lib/storage', () => ({
  loadDailyNotePath: async () => null, loadNewFolderDefaultPath: async () => null,
  getSecretStatus: async () => ({ backend: 'os-keyring', has_key: true, protected: true, fallback_reason: null }),
}));
vi.mock('../GeneralSettingsTab', () => ({ GeneralSettingsTab: () => null }));
vi.mock('../MemorySettings', () => ({ AiMemorySection: () => null }));
vi.mock('../CoreMemorySettings', () => ({ CoreMemorySection: () => null }));
vi.mock('../McpSettings', () => ({ McpServersSection: () => null }));
vi.mock('../McpServerExposeSection', () => ({ McpServerExposeSection: () => null }));
vi.mock('../SecuritySettings', () => ({ SecuritySettingsSection: () => null }));
vi.mock('../SkillSettings', () => ({ SkillDirectoriesSection: () => null }));
vi.mock('../ReviewSettings', () => ({ ReviewSettingsSection: () => null }));
vi.mock('../RerankSettings', () => ({ RerankSettingsSection: () => null }));
vi.mock('../EmbeddingSettings', () => ({ EmbeddingConfigSection: () => null }));
import { Settings } from '../Settings';

beforeEach(() => { vi.clearAllMocks(); setLang('en'); localStorage.clear(); app.setLlmConfig.mockResolvedValue(undefined); });
async function models() { render(<Settings />); fireEvent.click(screen.getByRole('button', { name: 'Models & connections' })); await screen.findByLabelText('Model name'); }
describe('knowledge Agent settings', () => {
  it('searches by a setting keyword across categories', async () => {
    render(<Settings />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'API Key' } });
    expect(await screen.findByRole('heading', { name: 'Models & connections' })).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
  });
  it('keeps provider selection as a draft until the user saves it', async () => {
    await models();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } });
    expect(app.setLlmConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled();
  });
  it('enables saving when only the custom model name changes and preserves the key', async () => {
    await models();
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'custom-reasoner' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(app.setLlmConfig).toHaveBeenCalledOnce());
    expect(app.setLlmConfig.mock.calls[0][0]).toMatchObject({ model: 'custom-reasoner' });
    expect(app.setLlmConfig.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });
  it('retains the draft and shows the real save error', async () => {
    app.setLlmConfig.mockRejectedValue(new Error('disk unavailable'));
    await models();
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'draft-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk unavailable');
    expect(screen.getByLabelText('Model name')).toHaveValue('draft-model');
    expect(app.showToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
  });
  it('keeps the connection draft when switching settings categories', async () => {
    await models();
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'draft-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    fireEvent.click(screen.getByRole('button', { name: 'Models & connections' }));
    expect(screen.getByLabelText('Model name')).toHaveValue('draft-model');
  });
  it('protects a dirty connection when leaving settings', async () => {
    await models();
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'draft-model' } });
    const navigation = new CustomEvent('zettel:before-navigate', { cancelable: true, detail: { view: 'dashboard' } });
    fireEvent(window, navigation);
    expect(navigation.defaultPrevented).toBe(true);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Unsaved changes will be discarded');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Model name')).toHaveValue('draft-model');
  });
  it('does not send the saved key to a different service origin', async () => {
    await models();
    fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: 'https://other.example/v1/chat/completions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a credential for the new service');
    expect(app.setLlmConfig).not.toHaveBeenCalled();
  });
  it('shows a useful empty search result and can clear it', async () => {
    render(<Settings />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'unmatched-setting-123' } });
    expect(screen.getByRole('heading', { name: 'No matching settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
  });
});
