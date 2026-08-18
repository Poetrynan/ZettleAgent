import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  searchChunksReranked,
  createRerankedSearcher,
  markCrossEncoderInstalled,
  forgetCrossEncoderInstalled,
  isCrossEncoderInstalled,
} from '../rerankSearch';
import { searchChunks, rerankSearchWindow, getRerankConfig, DEFAULT_RERANK_CONFIG } from '../tauri';
import { rerank as crossEncoderRerank } from '../reranker';
import type { SearchResult } from '../tauri';

// Partial mocks: `RerankBackendUnavailable` is compared with `instanceof` and
// `applyIndexOrder` is the very reordering under test, so both must stay real. A
// faked `applyIndexOrder` would make the reorder test pass for the wrong reason.
vi.mock('../tauri', async () => {
  const actual = await vi.importActual<typeof import('../tauri')>('../tauri');
  return {
    ...actual,
    searchChunks: vi.fn(),
    rerankSearchWindow: vi.fn(),
    getRerankConfig: vi.fn(),
  };
});

vi.mock('../reranker', async () => {
  const actual = await vi.importActual<typeof import('../reranker')>('../reranker');
  return { ...actual, rerank: vi.fn() };
});

const searchMock = vi.mocked(searchChunks);
const windowMock = vi.mocked(rerankSearchWindow);
const configMock = vi.mocked(getRerankConfig);
const rerankMock = vi.mocked(crossEncoderRerank);

/** A row shaped like what `search_chunks` returns. `score` descends with `i` so a
 *  test can tell the Tier-1 order from a reordered one. */
function row(id: number, content: string): SearchResult {
  return {
    file_path: `note${id}.md`,
    chunk_id: id,
    content,
    heading_hierarchy: null,
    score: 1 / (id + 1),
  };
}

function windowOf(rows: SearchResult[], limit = rows.length) {
  return {
    results: rows,
    candidates: rows.map((r, index) => ({
      index,
      chunkId: r.chunk_id,
      filePath: r.file_path,
      heading: r.heading_hierarchy ?? '',
      snippet: r.content,
    })),
    limit,
  };
}

const CJK_ROWS = [
  row(0, '图谱是一种数据结构。'),
  row(1, '知识图谱把实体和关系连起来。'),
  row(2, '今天天气不错。'),
];

beforeEach(() => {
  searchMock.mockReset();
  windowMock.mockReset();
  configMock.mockReset();
  rerankMock.mockReset();
  forgetCrossEncoderInstalled();
  configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG });
});

afterEach(() => {
  forgetCrossEncoderInstalled();
});

describe('opt-in gate: the 288 MB model is never fetched behind the user', () => {
  it('does not go near the window or the model when the model was never downloaded', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'crossEncoder' });
    searchMock.mockResolvedValue(CJK_ROWS);

    const out = await searchChunksReranked({ query: '知识图谱' });

    // The two calls that could start a 288 MB download must not happen at all.
    expect(windowMock).not.toHaveBeenCalled();
    expect(rerankMock).not.toHaveBeenCalled();
    // Behaviour degrades silently, reporting does not.
    expect(out.results).toEqual(CJK_ROWS);
    expect(out.tier).toBe('lexical');
    expect(out.degradedFrom).toBe('crossEncoder');
    expect(out.reason).toBe('modelMissing');
  });

  it('only treats the model as present after the explicit download recorded it', () => {
    expect(isCrossEncoderInstalled()).toBe(false);
    markCrossEncoderInstalled();
    expect(isCrossEncoderInstalled()).toBe(true);
  });
});

describe('Tier 2 actually reorders', () => {
  beforeEach(() => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'crossEncoder' });
    markCrossEncoderInstalled();
  });

  it('applies the cross-encoder order to the window instead of keeping Tier 1', async () => {
    windowMock.mockResolvedValue(windowOf(CJK_ROWS));
    // The model promotes the one chunk that is actually about the query.
    rerankMock.mockResolvedValue([1, 0, 2]);

    const out = await searchChunksReranked({ query: '知识图谱' });

    expect(out.tier).toBe('crossEncoder');
    expect(out.degradedFrom).toBeUndefined();
    // The observable claim: the order changed, and changed to the model's order.
    expect(out.results.map(r => r.chunk_id)).toEqual([1, 0, 2]);
    expect(out.results.map(r => r.chunk_id)).not.toEqual(CJK_ROWS.map(r => r.chunk_id));
    // Plain `search_chunks` must not have been used as well — one retrieval only.
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('re-stamps score so a downstream sort cannot undo the rerank', async () => {
    windowMock.mockResolvedValue(windowOf(CJK_ROWS));
    rerankMock.mockResolvedValue([2, 1, 0]);

    const out = await searchChunksReranked({ query: '知识图谱' });

    const scores = out.results.map(r => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // Re-sorting by score — which several consumers do — is now a no-op.
    const resorted = [...out.results].sort((a, b) => b.score - a.score);
    expect(resorted.map(r => r.chunk_id)).toEqual(out.results.map(r => r.chunk_id));
  });

  it('truncates to the requested limit, not to the wider rerank window', async () => {
    windowMock.mockResolvedValue(windowOf(CJK_ROWS, 2));
    rerankMock.mockResolvedValue([2, 1, 0]);

    const out = await searchChunksReranked({ query: '知识图谱' });

    expect(out.results.map(r => r.chunk_id)).toEqual([2, 1]);
  });

  it('survives a model order that is short, duplicated or out of range', async () => {
    windowMock.mockResolvedValue(windowOf(CJK_ROWS));
    rerankMock.mockResolvedValue([2, 2, 99]);

    const out = await searchChunksReranked({ query: '知识图谱' });

    // A sloppy order may reorder but must never lose or duplicate a row.
    expect(out.results.map(r => r.chunk_id).sort()).toEqual([0, 1, 2]);
    expect(out.results[0].chunk_id).toBe(2);
  });
});

describe('degrade silently in behaviour, visibly in reporting', () => {
  beforeEach(() => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'crossEncoder' });
    markCrossEncoderInstalled();
  });

  it('falls back to the Tier-1 window and says so when the model times out', async () => {
    windowMock.mockResolvedValue(windowOf(CJK_ROWS));
    // `null` is the reranker's timeout / unavailable contract — it never throws.
    rerankMock.mockResolvedValue(null);

    const out = await searchChunksReranked({ query: '知识图谱' });

    // The window's own (Tier-1) order is kept, untouched.
    expect(out.results.map(r => r.chunk_id)).toEqual([0, 1, 2]);
    expect(out.tier).toBe('lexical');
    expect(out.degradedFrom).toBe('crossEncoder');
    expect(out.reason).toBe('modelUnavailable');
  });

  it('reports lexical, not llm, for the by-contract Tier-3 fallback', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'llm' });
    searchMock.mockResolvedValue(CJK_ROWS);

    const out = await searchChunksReranked({ query: '知识图谱' });

    expect(out.tier).toBe('lexical');
    expect(out.degradedFrom).toBe('llm');
    expect(out.reason).toBe('tierNotBridged');
    // The webview never touches the model for the LLM tier.
    expect(rerankMock).not.toHaveBeenCalled();
  });

  it('reports off as off, untouched', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'off' });
    searchMock.mockResolvedValue(CJK_ROWS);

    const out = await searchChunksReranked({ query: '知识图谱' });
    expect(out.tier).toBe('off');
    expect(out.degradedFrom).toBeUndefined();
  });

  it('reports plain lexical mode as lexical with no degrade noise', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'lexical' });
    searchMock.mockResolvedValue(CJK_ROWS);

    const out = await searchChunksReranked({ query: '知识图谱' });
    expect(out.tier).toBe('lexical');
    expect(out.reason).toBeUndefined();
  });

  it('claims no failure when there was simply nothing to reorder', async () => {
    windowMock.mockResolvedValue(windowOf([row(0, '唯一命中')]));

    const out = await searchChunksReranked({ query: '知识图谱' });

    // One row has no meaningful tier; inventing `modelUnavailable` would be a
    // false alarm and inventing `crossEncoder` would be a false claim.
    expect(out.reason).toBeUndefined();
    expect(out.degradedFrom).toBeUndefined();
    expect(rerankMock).not.toHaveBeenCalled();
  });

  it('keeps searching when the window command itself fails', async () => {
    windowMock.mockRejectedValue(new Error('command rerank_search_window not allowed'));
    searchMock.mockResolvedValue(CJK_ROWS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await searchChunksReranked({ query: '知识图谱' });

    // A broken rerank must never surface as a broken search.
    expect(out.results).toEqual(CJK_ROWS);
    expect(out.tier).toBe('lexical');
    expect(out.reason).toBe('modelUnavailable');
    warn.mockRestore();
  });
});


describe('CJK survives the whole path', () => {
  it('passes CJK candidates verbatim into the scorer and preserves them in output', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'crossEncoder' });
    markCrossEncoderInstalled();
    windowMock.mockResolvedValue(windowOf(CJK_ROWS));
    rerankMock.mockResolvedValue([1, 0, 2]);

    const out = await searchChunksReranked({ query: '知识图谱' });

    // The query and the CJK snippets reach the model uncorrupted (no mojibake,
    // no truncation to half a codepoint).
    const [scoredQuery, scoredCands] = rerankMock.mock.calls[0];
    expect(scoredQuery).toBe('知识图谱');
    expect(scoredCands.map(c => c.snippet)).toEqual(CJK_ROWS.map(r => r.content));
    // And the promoted row's Chinese content is intact on the way out.
    expect(out.results[0].content).toBe('知识图谱把实体和关系连起来。');
  });
});

describe('cancellation: a stale answer never overwrites a newer one', () => {
  it('marks the earlier-issued, later-resolving search as stale', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'lexical' });

    // Two searches in flight. The first resolves *after* the second — exactly the
    // race the request token exists for.
    let resolveSlow!: (v: SearchResult[]) => void;
    const slow = new Promise<SearchResult[]>(res => { resolveSlow = res; });
    searchMock.mockReturnValueOnce(slow);
    searchMock.mockResolvedValueOnce([row(9, 'fresh')]);

    const searcher = createRerankedSearcher();
    const firstP = searcher({ query: 'old' });
    const secondP = searcher({ query: 'new' });

    const second = await secondP;
    resolveSlow([row(0, 'stale')]);
    const first = await firstP;

    // The newer search is authoritative; the older one is flagged and must be
    // dropped by the caller.
    expect(second.stale).toBe(false);
    expect(first.stale).toBe(true);
  });

  it('does not flag a lone search as stale', async () => {
    configMock.mockResolvedValue({ ...DEFAULT_RERANK_CONFIG, mode: 'lexical' });
    searchMock.mockResolvedValue([row(0, 'only')]);

    const searcher = createRerankedSearcher();
    const out = await searcher({ query: 'solo' });
    expect(out.stale).toBe(false);
  });
});


