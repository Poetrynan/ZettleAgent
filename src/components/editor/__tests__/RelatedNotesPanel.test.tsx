import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { RelatedNotesPanel } from '../RelatedNotesPanel';
import { getRelatedNotes, RelatedNotesResult } from '../../../lib/tauri';
import { setLang } from '../../../lib/i18n';

// ── Backend + navigation surface ────────────────────────────────────
vi.mock('../../../lib/tauri', () => ({
  getRelatedNotes: vi.fn(),
}));

const setCurrentFile = vi.fn();
const setView = vi.fn();
vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({ setCurrentFile, setView }),
}));

const mockGet = vi.mocked(getRelatedNotes);

/** A `RelatedNotesResult` with sensible defaults; override per test. */
function result(over: Partial<RelatedNotesResult> = {}): RelatedNotesResult {
  return { notes: [], semantic_index_ready: true, ...over };
}

describe('RelatedNotesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLang('en'); // assert against English copy
  });

  it('renders all three relation kinds under their own group with a reason', async () => {
    mockGet.mockResolvedValue(
      result({
        notes: [
          { file_path: 'x/explicit.md', title: 'Explicit One', preview: 'p', relation: 'explicit', relation_type: 'supports', score: 1.0, signals: ['explicit'] },
          { file_path: 'x/link.md', title: 'Link One', preview: 'p', relation: 'link', relation_type: null, score: 1.0, signals: ['link'] },
          { file_path: 'x/sem.md', title: 'Semantic One', preview: 'p', relation: 'semantic', relation_type: null, score: 0.82, signals: ['semantic'] },
        ],
      }),
    );

    render(<RelatedNotesPanel filePath="x/me.md" />);

    await waitFor(() => expect(screen.getByText('Explicit One')).toBeInTheDocument());
    // Group headers
    expect(screen.getByText('AI relations')).toBeInTheDocument();
    expect(screen.getByText('Links here')).toBeInTheDocument();
    expect(screen.getByText('Semantically similar')).toBeInTheDocument();
    // Reasons — the explicit relation type is translated, the cosine keeps its magnitude
    expect(screen.getByText('AI relation: supports')).toBeInTheDocument();
    expect(screen.getByText('Links to this note')).toBeInTheDocument();
    expect(screen.getByText('Semantic similarity 0.82')).toBeInTheDocument();
  });

  it('flags a note matched by more than one signal', async () => {
    mockGet.mockResolvedValue(
      result({
        notes: [
          { file_path: 'x/both.md', title: 'Both', preview: 'p', relation: 'link', relation_type: null, score: 0.8, signals: ['link', 'semantic'] },
        ],
      }),
    );

    render(<RelatedNotesPanel filePath="x/me.md" />);

    await waitFor(() => expect(screen.getByText('Both')).toBeInTheDocument());
    expect(screen.getByText('Multi-signal')).toBeInTheDocument();
    // Both reasons are shown, joined.
    expect(screen.getByText(/Links to this note/)).toBeInTheDocument();
    expect(screen.getByText(/Semantic similarity 0\.80/)).toBeInTheDocument();
  });

  it('navigates on click', async () => {
    mockGet.mockResolvedValue(
      result({
        notes: [
          { file_path: 'x/target.md', title: 'Target', preview: 'p', relation: 'semantic', relation_type: null, score: 0.9, signals: ['semantic'] },
        ],
      }),
    );

    render(<RelatedNotesPanel filePath="x/me.md" />);

    const item = await screen.findByText('Target');
    fireEvent.click(item);
    expect(setCurrentFile).toHaveBeenCalledWith('x/target.md');
    expect(setView).toHaveBeenCalledWith('note');
  });

  it('distinguishes "no semantic index" from an ordinary empty result', async () => {
    // No index built yet.
    mockGet.mockResolvedValueOnce(result({ notes: [], semantic_index_ready: false }));
    const { unmount } = render(<RelatedNotesPanel filePath="x/me.md" />);
    expect(await screen.findByText('Semantic index not built yet')).toBeInTheDocument();
    unmount();

    // Index exists, this note simply has no neighbours.
    mockGet.mockResolvedValueOnce(result({ notes: [], semantic_index_ready: true }));
    render(<RelatedNotesPanel filePath="x/other.md" />);
    expect(await screen.findByText('No related notes found for this one yet.')).toBeInTheDocument();
    expect(screen.queryByText('Semantic index not built yet')).not.toBeInTheDocument();
  });

  it('refetches only when the file path changes, not on unrelated re-renders', async () => {
    mockGet.mockResolvedValue(result({ notes: [] }));

    const { rerender } = render(<RelatedNotesPanel filePath="x/me.md" limit={8} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    // Re-render with identical props (what a keystroke elsewhere in the tree causes).
    rerender(<RelatedNotesPanel filePath="x/me.md" limit={8} />);
    await Promise.resolve();
    expect(mockGet).toHaveBeenCalledTimes(1);

    // A genuine file switch must refetch.
    rerender(<RelatedNotesPanel filePath="x/other.md" limit={8} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockGet).toHaveBeenLastCalledWith('x/other.md', 8);
  });

  it('refreshes on demand via the refresh control', async () => {
    mockGet.mockResolvedValue(result({ notes: [] }));

    render(<RelatedNotesPanel filePath="x/me.md" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    const refresh = screen.getByLabelText('Refresh');
    await act(async () => { fireEvent.click(refresh); });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });
});
