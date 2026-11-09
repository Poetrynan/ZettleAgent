import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('../../../lib/tauri', () => ({
  getEmbeddingStats: vi.fn(), resetEmbeddingIndex: vi.fn(), retryFailedEmbeddings: vi.fn(), getSchedulerStatus: vi.fn(),
}));
vi.mock('../../../lib/embeddingIndexer', () => ({ runEmbeddingBuild: vi.fn(), buildStageText: () => 'Indexing', describeBuild: () => 'Index updated' }));
vi.mock('../../../lib/hardwareDetect', () => ({ detectHardware: async () => ({ bestGpu: null, deviceMemoryGB: 0, cpuCores: 0 }), recommendConfig: () => null, getGpuSummary: () => '' }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
import { EmbeddingConfigSection } from '../EmbeddingSettings';
import { getEmbeddingStats, getSchedulerStatus, resetEmbeddingIndex } from '../../../lib/tauri';
import { runEmbeddingBuild } from '../../../lib/embeddingIndexer';
import { ask } from '@tauri-apps/plugin-dialog';
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(getEmbeddingStats).mockResolvedValue({ total_chunks: 10, indexed_chunks: 10, has_index: true });
  vi.mocked(getSchedulerStatus).mockResolvedValue({ running: false, last_run: null, notes_processed: 0, notes_reconciled: 0, api_calls_used: 0, errors: [] });
  vi.mocked(runEmbeddingBuild).mockResolvedValue({ embedded: 0, failed: 0, skipped: 0, cancelled: false, ignore: { ignoredFiles: 0, ignoredChunks: 0, removedVectors: 0 } });
  vi.mocked(ask).mockResolvedValue(true);
});
describe('embedding settings', () => {
  it('updates an already complete index without a rebuild prompt', async () => {
    render(<EmbeddingConfigSection isZh={false} />);
    await waitFor(() => expect(getEmbeddingStats).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Update index' }));
    await waitFor(() => expect(runEmbeddingBuild).toHaveBeenCalledOnce());
    expect(ask).not.toHaveBeenCalled(); expect(resetEmbeddingIndex).not.toHaveBeenCalled();
  });
  it('clears cached vectors only after explicit confirmation and before rebuilding', async () => {
    render(<EmbeddingConfigSection isZh={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild all vectors…' }));
    await waitFor(() => expect(runEmbeddingBuild).toHaveBeenCalledOnce());
    expect(ask).toHaveBeenCalledOnce();
    expect(vi.mocked(resetEmbeddingIndex).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runEmbeddingBuild).mock.invocationCallOrder[0]);
  });
  it('does not clear anything when rebuild confirmation is cancelled', async () => {
    vi.mocked(ask).mockResolvedValue(false);
    render(<EmbeddingConfigSection isZh={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild all vectors…' }));
    await waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(resetEmbeddingIndex).not.toHaveBeenCalled(); expect(runEmbeddingBuild).not.toHaveBeenCalled();
  });
  it('shows the actual fixed index dimension even for old custom configurations', async () => {
    localStorage.setItem('zettelagent:embedding_config', JSON.stringify({ mode: 'custom', apiUrl: 'https://embedding.example/v1', model: 'm', dimensions: 1536 }));
    render(<EmbeddingConfigSection isZh={false} />);
    const dimension = await screen.findByRole('spinbutton', { name: 'Fixed vector dimensions' });
    expect(dimension).toHaveValue(768); expect(dimension).toHaveAttribute('readonly');
  });
  it('keeps an incomplete custom configuration as a draft', async () => {
    render(<EmbeddingConfigSection isZh={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save retrieval configuration' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    expect(localStorage.getItem('zettelagent:embedding_config')).toBeNull();
    expect(screen.getByRole('button', { name: 'Update index' })).toBeDisabled();
  });
});
