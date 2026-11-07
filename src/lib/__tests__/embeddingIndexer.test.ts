import { vi, describe, it, expect, beforeEach } from 'vitest';

import {
  runEmbeddingBuild,
  isSetupError,
  EmbeddingSetupError,
  CIRCUIT_BREAKER,
  describeBuild,
} from '../embeddingIndexer';
import {
  getUnindexedChunks,
  saveChunkEmbeddings,
  recordEmbeddingFailures,
  finalizeEmbeddingIndex,
  prepareEmbeddingBuild,
} from '../tauri';
import { EMBEDDING_DIM } from '../embeddingModel';

vi.mock('../tauri', () => ({
  syncEmbeddingModel: vi.fn().mockResolvedValue({}),
  prepareEmbeddingBuild: vi.fn(),
  getUnindexedChunks: vi.fn(),
  saveChunkEmbeddings: vi.fn(),
  recordEmbeddingFailures: vi.fn(),
  finalizeEmbeddingIndex: vi.fn().mockResolvedValue(undefined),
  fetchCustomEmbeddings: vi.fn(),
}));
vi.mock('../embeddings', () => ({ getEmbeddingsBatch: vi.fn() }));

/**
 * A fake backend: `pending` chunks are served in id order, saved ones leave the
 * queue, and failed ones are held back (as the backoff does) for the rest of
 * the build.
 */
function fakeBackend(pending: [number, string][]) {
  const saved = new Set<number>();
  const failed = new Map<number, number>();
  vi.mocked(getUnindexedChunks).mockImplementation(async (limit: number) =>
    pending.filter(([id]) => !saved.has(id) && !failed.has(id)).slice(0, limit),
  );
  vi.mocked(saveChunkEmbeddings).mockImplementation(async (rows) => {
    rows.forEach(([id]) => saved.add(id));
  });
  vi.mocked(recordEmbeddingFailures).mockImplementation(async (ids) =>
    ids.map((id) => {
      const n = (failed.get(id) ?? 0) + 1;
      failed.set(id, n);
      return { chunkId: id, failCount: n, permanent: false };
    }),
  );
  return { saved, failed };
}

const vec = () => new Array(EMBEDDING_DIM).fill(0.1);
const chunks = (n: number, bad: number[] = []): [number, string][] =>
  Array.from({ length: n }, (_, i) => [i + 1, bad.includes(i + 1) ? `BAD ${i + 1}` : `text ${i + 1}`]);

describe('runEmbeddingBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareEmbeddingBuild).mockResolvedValue({ ignoredFiles: 0, ignoredChunks: 0, removedVectors: 0 });
  });

  it('isolates the chunk the API rejects and finishes the rest', async () => {
    const { saved, failed } = fakeBackend(chunks(40, [7]));
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((t) => t.startsWith('BAD'))) throw new Error('400 input too long');
      return texts.map(vec);
    });
    const report = await runEmbeddingBuild({ config: { mode: 'local' }, isCancelled: () => false, embed });

    expect(saved.size).toBe(39);
    expect([...failed.keys()]).toEqual([7]);
    expect(recordEmbeddingFailures).toHaveBeenCalledWith([7], '400 input too long');
    expect(report).toMatchObject({ embedded: 39, failed: 1, skipped: 0, cancelled: false, lastError: '400 input too long' });
    expect(finalizeEmbeddingIndex).toHaveBeenCalledOnce();
    // Bisection, not one call per chunk: a 16-batch with one bad chunk costs ~2·log2(16) extra calls.
    expect(embed.mock.calls.length).toBeLessThan(15);
  });

  it('stops at once on a setup error, recording nothing', async () => {
    fakeBackend(chunks(20));
    const embed = vi.fn(async () => {
      throw new Error('The embedding endpoint rejected the credentials (401) — re-enter your API Key in Settings.');
    });
    await expect(runEmbeddingBuild({ config: { mode: 'custom' }, isCancelled: () => false, embed })).rejects.toBeInstanceOf(
      EmbeddingSetupError,
    );
    expect(embed).toHaveBeenCalledOnce();
    expect(recordEmbeddingFailures).not.toHaveBeenCalled();
    expect(finalizeEmbeddingIndex).not.toHaveBeenCalled();
  });

  it('a wrong vector dimension is a setup error', async () => {
    fakeBackend(chunks(4));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0)));
    await expect(runEmbeddingBuild({ config: { mode: 'custom' }, isCancelled: () => false, embed })).rejects.toThrow(/1536/);
    expect(recordEmbeddingFailures).not.toHaveBeenCalled();
  });

  it('the circuit breaker stops a dead endpoint after a few chunks', async () => {
    const { failed } = fakeBackend(chunks(100));
    const embed = vi.fn(async () => {
      throw new Error('500 internal error');
    });
    await expect(runEmbeddingBuild({ config: { mode: 'custom' }, isCancelled: () => false, embed })).rejects.toThrow('500');
    expect(failed.size).toBe(CIRCUIT_BREAKER);
  });

  it('a success resets the circuit breaker', async () => {
    // Every other chunk is bad: never CIRCUIT_BREAKER failures in a row.
    const bad = Array.from({ length: 30 }, (_, i) => i * 2 + 1);
    const { saved, failed } = fakeBackend(chunks(60, bad));
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((t) => t.startsWith('BAD'))) throw new Error('400');
      return texts.map(vec);
    });
    const report = await runEmbeddingBuild({ config: { mode: 'local' }, isCancelled: () => false, embed });
    expect(failed.size).toBe(30);
    expect(saved.size).toBe(30);
    expect(report.failed).toBe(30);
  });

  it('cancelling stops between batches and skips finalize', async () => {
    fakeBackend(chunks(64));
    let calls = 0;
    const embed = vi.fn(async (texts: string[]) => {
      calls += 1;
      return texts.map(vec);
    });
    const report = await runEmbeddingBuild({ config: { mode: 'local' }, isCancelled: () => calls >= 2, embed });
    expect(report.cancelled).toBe(true);
    expect(report.embedded).toBeLessThan(64);
    expect(finalizeEmbeddingIndex).not.toHaveBeenCalled();
  });
});

describe('isSetupError', () => {
  it.each([
    'Embedding API error (401 Unauthorized): bad key',
    '嵌入端点拒绝了凭据（401）——请在设置中重新填写 API Key',
    'Embedding request failed: error sending request: connection refused',
    'Local WASM model loading timed out after 60000ms',
    'Embedding API 配置不完整 / Incomplete Embedding API configuration',
  ])('treats %s as setup', (m) => expect(isSetupError(m)).toBe(true));

  it.each(['Embedding API error (400 Bad Request): input too long', '500 internal error', 'content filtered'])(
    'treats %s as a chunk problem',
    (m) => expect(isSetupError(m)).toBe(false),
  );
});

describe('describeBuild', () => {
  it('says what happened, in both languages', () => {
    const r = {
      embedded: 10,
      failed: 3,
      skipped: 1,
      cancelled: false,
      ignore: { ignoredFiles: 2, ignoredChunks: 5, removedVectors: 0 },
    };
    expect(describeBuild(r, true)).toBe('已索引 10 个分块；2 个失败，稍后构建会自动重试；1 个多次失败，已跳过；2 篇笔记按 .zettelignore 忽略');
    expect(describeBuild(r, false)).toContain('2 failed and will be retried');
  });
});
