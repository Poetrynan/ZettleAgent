import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLang } from '../../../lib/i18n';

const app = vi.hoisted(() => ({
  state: {
    lang: 'en', view: 'dashboard', vaultPath: '/a', vaultPaths: ['/a', '/b'],
    llmConfig: { apiUrl: 'http://localhost:1234/v1', model: 'test', providerId: 'custom' },
    methodology: 'zettelkasten', schedulerLoading: false, schedulerProgress: null,
    schedulerProgressInfo: null, isSyncing: false, currentFile: null,
  },
  showToast: vi.fn(), setView: vi.fn(), setIsSyncing: vi.fn(),
  setSchedulerLoading: vi.fn(), setSchedulerProgress: vi.fn(), addVaultPath: vi.fn(),
}));
vi.mock('../../../contexts/AppContext', () => ({ useApp: () => app }));
vi.mock('../../settings/Settings', () => ({
  getSmartOrganizeConfig: () => ({ intervalSecs: 3600, includeJournals: true, batchSize: 10 }),
  setBackgroundOrganizeEnabled: vi.fn(),
}));
vi.mock('../../../lib/tauri', () => ({
  listMarkdownFiles: vi.fn(), getKnowledgeGraph: vi.fn(), syncVault: vi.fn(),
  getSchedulerStatus: vi.fn(), stopScheduler: vi.fn(), runSchedulerNow: vi.fn(),
  getEmbeddingStats: vi.fn(), retryFailedEmbeddings: vi.fn(), resetEmbeddingIndex: vi.fn(),
}));
vi.mock('../../../lib/embeddingIndexer', () => ({
  runEmbeddingBuild: vi.fn(), buildStageText: () => 'Building', describeBuild: () => 'Index updated',
}));
// The export and diagnostic flows are tested separately; keep this suite on homepage behavior.
vi.mock('../../canvas/CanvasExport', () => ({ CanvasExport: () => null }));
vi.mock('../LintModal', () => ({ LintModal: () => null }));
vi.mock('../KnowledgeGapAnalysis', () => ({ KnowledgeGapAnalysis: () => null }));
vi.mock('../../temporal/GlobalTimeline', () => ({ GlobalTimeline: () => null }));
import { Dashboard } from '../Dashboard';
import { getEmbeddingStats, getKnowledgeGraph, getSchedulerStatus, listMarkdownFiles, resetEmbeddingIndex, runSchedulerNow, syncVault } from '../../../lib/tauri';
import { runEmbeddingBuild } from '../../../lib/embeddingIndexer';

beforeEach(() => {
  vi.clearAllMocks(); setLang('en'); localStorage.clear();
  app.state.vaultPath = '/a'; app.state.vaultPaths = ['/a', '/b'];
  vi.mocked(listMarkdownFiles).mockImplementation(async path => path === '/a' ? ['/a/one.md', '/a/shared.md'] : ['/a/shared.md', '/b/two.md']);
  vi.mocked(getKnowledgeGraph).mockImplementation(async path => ({
    nodes: [], clusters: [], edges: [{ source: '/a/one.md', target: path === '/a' ? '/a/shared.md' : '/b/two.md', edge_type: 'wikilink', weight: 1 }],
  }));
  const status = { running: false, last_run: null, notes_processed: 0, notes_reconciled: 0, api_calls_used: 0, errors: [] };
  vi.mocked(getSchedulerStatus).mockResolvedValue(status);
  vi.mocked(runSchedulerNow).mockResolvedValue(status);
  vi.mocked(syncVault).mockResolvedValue({ files_updated: 1, files_removed: 0, total_files: 3 });
  vi.mocked(getEmbeddingStats).mockResolvedValue({ total_chunks: 10, indexed_chunks: 10, has_index: true });
  vi.mocked(runEmbeddingBuild).mockResolvedValue({ embedded: 0, failed: 0, skipped: 0, cancelled: false, ignore: { ignoredFiles: 0, ignoredChunks: 0, removedVectors: 0 } });
});

describe('Dashboard', () => {
  it('counts notes and links across the same workspace scope and makes them navigable', async () => {
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notes: 3' }));
    expect(app.setView).toHaveBeenCalledWith('bases');
    fireEvent.click(screen.getByRole('button', { name: 'Graph links: 2' }));
    expect(app.setView).toHaveBeenCalledWith('graph');
  });

  it('shows a failed metric as unavailable instead of zero', async () => {
    vi.mocked(getKnowledgeGraph).mockRejectedValue(new Error('offline'));
    render(<Dashboard />);
    expect(await screen.findByRole('button', { name: 'Graph links: Unavailable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry overview' })).toBeEnabled();
  });

  it('updates a complete index incrementally without a rebuild warning', async () => {
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update index' }));
    await waitFor(() => expect(runEmbeddingBuild).toHaveBeenCalledOnce());
    expect(resetEmbeddingIndex).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resets only after explicit rebuild confirmation and before embedding', async () => {
    render(<Dashboard />);
    await screen.findByRole('button', { name: 'Notes: 3' });
    fireEvent.click(screen.getByText('Maintenance'));
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild all vectors' }));
    expect(resetEmbeddingIndex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rebuild' }));
    await waitFor(() => expect(runEmbeddingBuild).toHaveBeenCalledOnce());
    expect(vi.mocked(resetEmbeddingIndex).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runEmbeddingBuild).mock.invocationCallOrder[0]);
  });

  it('runs once without forcing already-organized notes through again', async () => {
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run once' }));
    await waitFor(() => expect(runSchedulerNow).toHaveBeenCalledOnce());
    expect(vi.mocked(runSchedulerNow).mock.calls[0][11]).toBe(false);
  });

  it('provides an actionable onboarding state when there is no vault', async () => {
    app.state.vaultPath = ''; app.state.vaultPaths = [];
    await act(async () => { render(<Dashboard />); });
    expect(screen.getByRole('button', { name: 'Open vault' })).toBeEnabled();
    expect(screen.queryByText('Local storage ready')).not.toBeInTheDocument();
    expect(listMarkdownFiles).not.toHaveBeenCalled();
  });

  it('opens accessible help and returns focus to its trigger on Escape', async () => {
    render(<Dashboard />);
    await screen.findByRole('button', { name: 'Notes: 3' });
    const help = screen.getByRole('button', { name: 'Help' });
    help.focus(); fireEvent.click(help);
    expect(await screen.findByRole('dialog', { name: 'Using your workspace' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close help' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(help).toHaveFocus();
  });
});
