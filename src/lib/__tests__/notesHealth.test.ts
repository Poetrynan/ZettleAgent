import { describe, it, expect } from 'vitest';
import {
  HEALTH_PERSPECTIVES,
  getPerspective,
  perspectiveCounts,
  isPerspectiveEnabled,
  defaultVisibleColumns,
  compareRows,
  COLUMN_DEFS,
  CHECK_COLUMN_WIDTH,
  tableMinWidth,
  fitTags,
  estimateTagTextWidth,
  tagsCellWidth,
} from '../notesHealth';
import type { NoteRow } from '../tauri';


function row(over: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md', title: 'A', folder: 'notes', noteType: 'permanent', tags: [],
    outboundLinks: 1, backlinkCount: 1, semanticDegree: 1,
    indexStatus: 'indexed', chunkTotal: 2, chunkEmbedded: 2,
    reconciledAt: '2026-01-01', hasContradictions: false, contradictionCount: 0,
    reviewState: 'review', reviewDueAtMs: null, reviewIsDue: false,
    reviewSuspended: false, reviewLapses: 0,
    pagerank: null, isHub: null,
    createdAt: '2026-01-01', lastSynced: '2026-01-02',
    ...over,
  };
}

describe('health perspectives', () => {
  it('exposes exactly the six product lenses', () => {
    expect(HEALTH_PERSPECTIVES.map(p => p.id)).toEqual([
      'orphan', 'neverReconciled', 'hasContradictions', 'notIndexed', 'dueToday', 'semanticIsland',
    ]);
  });

  it('orphan means no backlinks AND no outbound links', () => {
    const p = getPerspective('orphan');
    expect(p.match(row({ backlinkCount: 0, outboundLinks: 0 }))).toBe(true);
    expect(p.match(row({ backlinkCount: 0, outboundLinks: 1 }))).toBe(false);
    expect(p.match(row({ backlinkCount: 1, outboundLinks: 0 }))).toBe(false);
  });

  it('notIndexed covers both notIndexed and partial, but not noChunks', () => {
    const p = getPerspective('notIndexed');
    expect(p.match(row({ indexStatus: 'notIndexed' }))).toBe(true);
    expect(p.match(row({ indexStatus: 'partial' }))).toBe(true);
    expect(p.match(row({ indexStatus: 'noChunks' }))).toBe(false);
    expect(p.match(row({ indexStatus: 'indexed' }))).toBe(false);
  });

  it('never organized keys off a null reconciledAt', () => {
    const p = getPerspective('neverReconciled');
    expect(p.match(row({ reconciledAt: null }))).toBe(true);
    expect(p.match(row({ reconciledAt: '2026-01-01' }))).toBe(false);
  });

  it('counts each lens over the whole row set', () => {
    const rows = [
      row({ path: '1', backlinkCount: 0, outboundLinks: 0 }),
      row({ path: '2', reconciledAt: null }),
      row({ path: '3', hasContradictions: true, contradictionCount: 2 }),
      row({ path: '4', indexStatus: 'partial' }),
      row({ path: '5', reviewIsDue: true }),
      row({ path: '6', semanticDegree: 0 }),
    ];
    const counts = perspectiveCounts(rows, true);
    expect(counts.orphan).toBe(1);
    expect(counts.neverReconciled).toBe(1);
    expect(counts.hasContradictions).toBe(1);
    expect(counts.notIndexed).toBe(1);
    expect(counts.dueToday).toBe(1);
    expect(counts.semanticIsland).toBe(1);
  });

  it('reports 0 semantic islands — and disables the lens — when the index is cold', () => {
    // A cold semantic index must never be read as "the whole vault is isolated".
    const rows = [row({ semanticDegree: 0 }), row({ path: 'b', semanticDegree: 0 })];
    expect(perspectiveCounts(rows, false).semanticIsland).toBe(0);
    const p = getPerspective('semanticIsland');
    expect(isPerspectiveEnabled(p, { semanticIndexReady: false })).toBe(false);
    expect(isPerspectiveEnabled(p, { semanticIndexReady: true })).toBe(true);
    expect(isPerspectiveEnabled(getPerspective('orphan'), { semanticIndexReady: false })).toBe(true);
  });
});

describe('columns', () => {
  it('never offers a confidence column', () => {
    expect(COLUMN_DEFS.map(c => String(c.id))).not.toContain('confidence');
  });

  it('keeps graph-only columns out of the default set', () => {
    const defaults = defaultVisibleColumns();
    expect(defaults).toContain('backlinkCount');
    expect(defaults).not.toContain('pagerank');
    expect(defaults).not.toContain('isHub');
  });

  it('sorts unloaded pagerank below any loaded value', () => {
    expect(compareRows(row({ pagerank: null }), row({ pagerank: 0.5 }), 'pagerank')).toBeLessThan(0);
    expect(compareRows(row({ backlinkCount: 5 }), row({ backlinkCount: 2 }), 'backlinkCount')).toBeGreaterThan(0);
  });

  it('declares a px width for every column, in one place', () => {
    // CSS used to keep a second copy, mixing `%` with `px` — which is what made
    // `table-layout: fixed` squeeze the columns instead of letting the table
    // overflow and scroll.
    for (const col of COLUMN_DEFS) {
      expect(col.width).toBeGreaterThan(0);
      expect(Number.isInteger(col.width)).toBe(true);
    }
  });

  it('shortens only the three link-count headers', () => {
    const short = COLUMN_DEFS.filter(c => c.shortLabelKey).map(c => c.id);
    expect(short).toEqual(['backlinkCount', 'outboundLinks', 'semanticDegree']);
  });
});

describe('table min-width', () => {
  it('sums the checkbox column and every visible column', () => {
    const visible = defaultVisibleColumns();
    const expected = CHECK_COLUMN_WIDTH
      + COLUMN_DEFS.filter(c => visible.includes(c.id)).reduce((n, c) => n + c.width, 0);
    expect(tableMinWidth(visible)).toBe(expected);
  });

  it('shrinks when a column is hidden and grows when one is shown', () => {
    const all = defaultVisibleColumns();
    const without = all.filter(id => id !== 'tags');
    expect(tableMinWidth(without)).toBe(tableMinWidth(all) - 220);
    expect(tableMinWidth([...all, 'pagerank'])).toBeGreaterThan(tableMinWidth(all));
  });

  it('is wide enough to overflow a realistic pane, which is the point', () => {
    // With the peek panel open there is well under 1100px for the table.
    expect(tableMinWidth(defaultVisibleColumns())).toBeGreaterThan(1000);
  });

  it('ignores ids that are not columns', () => {
    expect(tableMinWidth([])).toBe(CHECK_COLUMN_WIDTH);
  });
});

describe('fitTags', () => {
  it('never returns a partial tag — the prefix shown is always whole tags', () => {
    const tags = ['ai', 'transformer', 'knowledge-management', 'zettelkasten'];
    const { shown, hidden } = fitTags(tags, tagsCellWidth());
    expect(shown.length + hidden).toBe(tags.length);
    expect(shown).toEqual(tags.slice(0, shown.length));
  });

  it('reserves room for the +N pill, so it is never itself clipped', () => {
    const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const wide = fitTags(tags, 1000);
    expect(wide).toEqual({ shown: tags, hidden: 0 });

    // Just enough for two pills alone, but not for two pills plus `+3`.
    const twoPills = estimateTagTextWidth('alpha') + 14 + 4 + estimateTagTextWidth('beta') + 14;
    const { shown, hidden } = fitTags(tags, twoPills);
    expect(shown.length).toBeLessThan(2);
    expect(hidden).toBe(tags.length - shown.length);
  });

  it('drops a single over-long tag into +N rather than slicing it', () => {
    const tags = ['a-really-very-long-tag-name-that-cannot-fit-anywhere'];
    expect(fitTags(tags, 60)).toEqual({ shown: [], hidden: 1 });
  });

  it('handles the empty case without inventing a +0', () => {
    expect(fitTags([], 200)).toEqual({ shown: [], hidden: 0 });
  });

  it('counts CJK as wider than latin, and surrogate pairs only once', () => {
    expect(estimateTagTextWidth('知识管理')).toBeGreaterThan(estimateTagTextWidth('abcd'));
    // Naive `.length` would count this emoji twice and over-reserve.
    expect(estimateTagTextWidth('🙂')).toBe(estimateTagTextWidth('中'));
  });

  it('fits fewer Chinese tags than English ones in the same column', () => {
    // Chinese is the default language, so the width budget has to be checked
    // against it — English fitting is not evidence.
    const zh = fitTags(['知识管理', '深度学习', '费曼技巧', '认知负荷'], tagsCellWidth());
    const en = fitTags(['note', 'link', 'idea', 'work'], tagsCellWidth());
    expect(zh.shown.length).toBeLessThan(en.shown.length);
    expect(zh.shown.length + zh.hidden).toBe(4);
  });
});

