import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { SearchPanel } from '../SearchPanel';
import { createRerankedSearcher, type SupersedableSearch } from '../../../lib/rerankSearch';
import { setLang } from '../../../lib/i18n';
import type { SearchResult } from '../../../lib/tauri';

// The panel only needs three things from the app context; a real provider would
// drag in the vault, the watcher and the whole settings surface.
vi.mock('../../../contexts/AppContext', () => ({
  useApp: () => ({
    state: { lang: 'en' },
    setCurrentFile: vi.fn(),
    setView: vi.fn(),
  }),
}));

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    getEmbeddingStats: vi.fn().mockResolvedValue({
      total_chunks: 0,
      indexed_chunks: 0,
      has_index: false,
    }),
  };
});

vi.mock('../../../lib/rerankSearch', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/rerankSearch')>(
    '../../../lib/rerankSearch',
  );
  return { ...actual, createRerankedSearcher: vi.fn() };
});

const searcherFactory = vi.mocked(createRerankedSearcher);

function row(id: number, content: string): SearchResult {
  return {
    file_path: `note${id}.md`,
    chunk_id: id,
    content,
    heading_hierarchy: null,
    score: 1 / (id + 1),
  };
}

/** Install a searcher that answers with `answers` in order, one per call. */
function stubSearcher(...answers: Array<Promise<SupersedableSearch> | SupersedableSearch>) {
  const search = vi.fn();
  for (const a of answers) search.mockReturnValueOnce(Promise.resolve(a));
  searcherFactory.mockReturnValue(search as never);
  return search;
}

/** Type a query and let the panel's 300 ms debounce fire. */
async function typeQuery(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Search note content/i), {
    target: { value: text },
  });
  await act(async () => {
    await new Promise(res => setTimeout(res, 350));
  });
}

beforeEach(() => {
  setLang('en');
  searcherFactory.mockReset();
});

describe('SearchPanel reports the rerank tier that really ran', () => {
  it('shows the cross-encoder badge when the cross-encoder actually ordered the results', async () => {
    stubSearcher({
      results: [row(1, '知识图谱把实体和关系连起来。'), row(0, '图谱是一种数据结构。')],
      tier: 'crossEncoder',
      stale: false,
    });

    render(<SearchPanel isOpen onClose={() => {}} />);
    await typeQuery('知识图谱');

    const badge = await screen.findByTestId('search-rerank-tier');
    expect(badge).toHaveAttribute('data-tier', 'crossEncoder');
    expect(badge).toHaveTextContent(/cross-encoder rerank/);
    // Nothing was degraded, so there is no notice to explain away.
    expect(screen.queryByTestId('search-rerank-degraded')).not.toBeInTheDocument();
  });

  it('says lexical — and why — when the chosen cross-encoder never ran', async () => {
    stubSearcher({
      results: [row(0, '图谱是一种数据结构。')],
      tier: 'lexical',
      degradedFrom: 'crossEncoder',
      reason: 'modelMissing',
      stale: false,
    });

    render(<SearchPanel isOpen onClose={() => {}} />);
    await typeQuery('知识图谱');

    const badge = await screen.findByTestId('search-rerank-tier');
    // The bug being prevented: claiming crossEncoder while Tier 1 did the work.
    expect(badge).toHaveAttribute('data-tier', 'lexical');
    expect(badge).not.toHaveTextContent(/cross-encoder rerank/);
    expect(screen.getByTestId('search-rerank-degraded')).toHaveTextContent(
      /has not been downloaded/i,
    );
  });

  it('names the timeout as the reason when the model was asked but did not answer', async () => {
    stubSearcher({
      results: [row(0, '图谱是一种数据结构。')],
      tier: 'lexical',
      degradedFrom: 'crossEncoder',
      reason: 'modelUnavailable',
      stale: false,
    });

    render(<SearchPanel isOpen onClose={() => {}} />);
    await typeQuery('知识图谱');

    expect(await screen.findByTestId('search-rerank-degraded')).toHaveTextContent(
      /did not answer in time/i,
    );
    expect(screen.getByTestId('search-rerank-tier')).toHaveAttribute('data-tier', 'lexical');
  });
});

describe('SearchPanel drops superseded rerank answers', () => {
  it('keeps the newer result set when a stale answer arrives afterwards', async () => {
    // Second query answers first (fresh); the first query's slow cross-encoder
    // answer lands later, already flagged stale.
    let releaseStale!: (v: SupersedableSearch) => void;
    const stalePromise = new Promise<SupersedableSearch>(res => { releaseStale = res; });
    const search = vi.fn();
    search.mockReturnValueOnce(stalePromise);
    search.mockReturnValueOnce(
      Promise.resolve({ results: [row(9, 'fresh hit')], tier: 'lexical', stale: false } as SupersedableSearch),
    );
    searcherFactory.mockReturnValue(search as never);

    render(<SearchPanel isOpen onClose={() => {}} />);
    await typeQuery('old query');
    await typeQuery('new query');

    await waitFor(() => expect(screen.getByText(/fresh hit/)).toBeInTheDocument());

    await act(async () => {
      releaseStale({
        results: [row(0, 'stale hit')],
        tier: 'crossEncoder',
        stale: true,
      });
      await Promise.resolve();
    });

    // The stale answer must not repaint the panel — neither its rows nor its tier.
    expect(screen.queryByText(/stale hit/)).not.toBeInTheDocument();
    expect(screen.getByText(/fresh hit/)).toBeInTheDocument();
    expect(screen.getByTestId('search-rerank-tier')).toHaveAttribute('data-tier', 'lexical');
  });
});
