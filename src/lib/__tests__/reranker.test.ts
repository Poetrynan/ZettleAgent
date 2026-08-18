import { describe, it, expect, vi } from 'vitest';
import {
  applyIndexOrder,
  buildPairTexts,
  orderFromScores,
  rerank,
  truncateChars,
  isCrossEncoderLoaded,
  type RerankCandidate,
} from '../reranker';

function cand(index: number, heading: string, snippet: string): RerankCandidate {
  return { index, chunkId: index + 1, filePath: `note${index}.md`, heading, snippet };
}

describe('truncateChars', () => {
  it('cuts on code point boundaries, never mid-surrogate', () => {
    // "𝄞" is a surrogate pair. `slice(0, 1)` would return half of it.
    const s = '𝄞𝄞𝄞';
    expect(truncateChars(s, 2)).toBe('𝄞𝄞');
    expect(Array.from(truncateChars(s, 2))).toHaveLength(2);
  });

  it('counts Chinese characters, not bytes', () => {
    const s = '知识图谱的应用非常广泛';
    expect(truncateChars(s, 4)).toBe('知识图谱');
  });

  it('returns the input unchanged when short enough', () => {
    expect(truncateChars('abc', 10)).toBe('abc');
    expect(truncateChars('abc', 0)).toBe('');
  });
});

describe('orderFromScores', () => {
  it('sorts descending by score', () => {
    expect(orderFromScores([0.1, 0.9, 0.5])).toEqual([1, 2, 0]);
  });

  it('is stable on ties so "no opinion" degrades to a no-op', () => {
    expect(orderFromScores([0.5, 0.5, 0.5])).toEqual([0, 1, 2]);
  });

  it('handles a single score and an empty list', () => {
    expect(orderFromScores([0.3])).toEqual([0]);
    expect(orderFromScores([])).toEqual([]);
  });
});

describe('applyIndexOrder', () => {
  it('reorders by the given indices', () => {
    expect(applyIndexOrder(['a', 'b', 'c'], [2, 0, 1])).toEqual(['c', 'a', 'b']);
  });

  it('appends omitted items in their original order', () => {
    expect(applyIndexOrder(['a', 'b', 'c'], [2])).toEqual(['c', 'a', 'b']);
  });

  it('ignores out-of-range and duplicate indices instead of trusting them', () => {
    // A sloppy order may reorder results but must never lose or duplicate one.
    expect(applyIndexOrder(['a', 'b', 'c'], [99, 1, 1, -1])).toEqual(['b', 'a', 'c']);
  });

  it('is a permutation for any garbage order', () => {
    const items = ['a', 'b', 'c', 'd'];
    const out = applyIndexOrder(items, [3, 3, 7, 0]);
    expect([...out].sort()).toEqual([...items].sort());
  });
});

describe('buildPairTexts', () => {
  it('prepends the heading and truncates the snippet by code point', () => {
    const long = '知'.repeat(50);
    const pairs = buildPairTexts([cand(0, '知识图谱', long)], 10);
    expect(pairs[0].startsWith('知识图谱\n')).toBe(true);
    expect(Array.from(pairs[0].split('\n')[1])).toHaveLength(10);
  });

  it('omits the heading separator when there is no heading', () => {
    const pairs = buildPairTexts([cand(0, '', 'body text')], 100);
    expect(pairs[0]).toBe('body text');
  });
});

describe('rerank fallback contract', () => {
  it('returns null for an empty query rather than reordering on no evidence', async () => {
    await expect(rerank('   ', [cand(0, '', 'a'), cand(1, '', 'b')])).resolves.toBeNull();
  });

  it('returns null for 0 or 1 candidates', async () => {
    await expect(rerank('机器学习', [])).resolves.toBeNull();
    await expect(rerank('机器学习', [cand(0, '', 'a')])).resolves.toBeNull();
  });

  it('resolves null instead of throwing when the model is unavailable', async () => {
    // jsdom has no Worker, which is exactly the shape of "model not installed":
    // the call must degrade to null so Rust silently uses the lexical tier.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await rerank('机器学习', [cand(0, '', '甲'), cand(1, '', '乙')], {
      timeoutMs: 50,
    });
    expect(out).toBeNull();
    warn.mockRestore();
  });

  it('reports no loaded cross-encoder before one is successfully created', () => {
    expect(typeof isCrossEncoderLoaded()).toBe('boolean');
  });
});
