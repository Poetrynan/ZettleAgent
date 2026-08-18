import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { RerankSettingsSection } from '../RerankSettings';
import { getRerankConfig, setRerankConfig, RerankBackendUnavailable, DEFAULT_RERANK_CONFIG } from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

// Partial mock: the two commands are stubbed, but `RerankBackendUnavailable` and
// `DEFAULT_RERANK_CONFIG` must stay real — the component branches on
// `instanceof`, so a fake class would make the test pass for the wrong reason.
vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    getRerankConfig: vi.fn(),
    setRerankConfig: vi.fn(),
  };
});

const getMock = getRerankConfig as unknown as ReturnType<typeof vi.fn>;
const setMock = setRerankConfig as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The app defaults to Chinese; assert against the English strings so the test
  // reads for a non-Chinese maintainer too.
  setLang('en');
  getMock.mockReset();
  setMock.mockReset();
});

describe('RerankSettingsSection', () => {
  it('defaults to lexical and marks it as the selected mode', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG });
    render(<RerankSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true');
    });
    expect(screen.getByTestId('rerank-mode-off')).toHaveAttribute('aria-checked', 'false');
  });

  it('applies a mode change optimistically', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG });
    // Never resolves: the assertion is that the UI moved *before* the backend did.
    setMock.mockReturnValue(new Promise(() => {}));

    render(<RerankSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByTestId('rerank-mode-llm'));

    expect(screen.getByTestId('rerank-mode-llm')).toHaveAttribute('aria-checked', 'true');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'llm' }));
  });

  it('rolls the mode back when the backend rejects the write', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG });
    setMock.mockRejectedValue(new Error('db lock poisoned'));

    render(<RerankSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('rerank-mode-crossEncoder'));
    });

    // Back to the value the backend actually holds, plus the reason.
    expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('rerank-mode-crossEncoder')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/db lock poisoned/)).toBeInTheDocument();
  });

  it('degrades gracefully when the backend commands do not exist yet', async () => {
    getMock.mockRejectedValue(new RerankBackendUnavailable('command get_rerank_config not allowed'));

    render(<RerankSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('rerank-backend-not-ready')).toBeInTheDocument();
    });
    // The card still renders, still shows the default selection: no white screen,
    // no thrown error.
    expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the not-ready notice when saving hits a missing command', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG });
    setMock.mockRejectedValue(new RerankBackendUnavailable('command set_rerank_config not allowed'));

    render(<RerankSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('rerank-mode-off'));
    });

    expect(screen.getByTestId('rerank-backend-not-ready')).toBeInTheDocument();
    // Rolled back, because the write never landed.
    expect(screen.getByTestId('rerank-mode-lexical')).toHaveAttribute('aria-checked', 'true');
  });

  it('states the model size, Chinese support and the silent fallback for tier 2', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'crossEncoder' });
    render(<RerankSettingsSection />);

    await waitFor(() => expect(screen.getByTestId('rerank-model-download')).toBeInTheDocument());

    // The three facts a user needs before committing to a 288 MB download.
    // "288 MB" also appears on the download button, so match the facts line by a
    // substring unique to it rather than the ambiguous size string.
    expect(screen.getByText(/about 288 MB · MIT licence · Chinese supported/)).toBeInTheDocument();
    expect(screen.getByText(/Xenova\/bge-reranker-base/)).toBeInTheDocument();
    expect(screen.getByText(/Downloading is optional.*falls back to the lexical reranker/)).toBeInTheDocument();
  });

  it('keeps the tier-3 cost knobs behind the advanced toggle', async () => {
    getMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG });
    render(<RerankSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('rerank-mode-lexical')).toBeInTheDocument());

    expect(screen.queryByTestId('rerank-knob-llmMaxCandidates')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByTestId('rerank-knob-llmMaxCandidates')).toBeInTheDocument();
    expect(screen.getByTestId('rerank-knob-llmMaxSnippetChars')).toBeInTheDocument();
    expect(screen.getByTestId('rerank-knob-llmTimeoutMs')).toBeInTheDocument();
  });
});
