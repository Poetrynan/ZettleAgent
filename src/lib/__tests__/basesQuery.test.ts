import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  matchesQuery,
  matchesRule,
  toggleToken,
  removeToken,
  hasToken,
  type QueryRule,
} from '../basesQuery';
import type { NoteRow } from '../tauri';

/** A fully-populated row; individual tests override just the fields they probe. */
function row(over: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'Alpha',
    folder: 'notes',
    noteType: 'permanent',
    tags: ['ai'],
    outboundLinks: 2,
    backlinkCount: 1,
    semanticDegree: 3,
    indexStatus: 'indexed',
    chunkTotal: 4,
    chunkEmbedded: 4,
    reconciledAt: '2026-01-01 00:00:00',
    hasContradictions: false,
    contradictionCount: 0,
    reviewState: 'review',
    reviewDueAtMs: null,
    reviewIsDue: false,
    reviewSuspended: false,
    reviewLapses: 0,
    pagerank: null,
    isHub: null,
    createdAt: '2026-01-01 00:00:00',
    lastSynced: '2026-02-01 00:00:00',
    ...over,
  };
}

describe('basesQuery — parsing', () => {
  it('returns nothing for an empty query', () => {
    const { rules, keywords } = parseQuery('');
    expect(rules).toHaveLength(0);
    expect(keywords).toHaveLength(0);
  });

  it('parses tag shorthand', () => {
    const { rules } = parseQuery('#ideas');
    expect(rules[0]).toEqual({ token: '#ideas', field: 'tag', operator: 'equals', value: 'ideas' });
  });

  it('parses colon and relational rules for the NEW fields', () => {
    const { rules } = parseQuery('type:permanent backlinks=0 semantic>2 index:notIndexed');
    expect(rules).toEqual<QueryRule[]>([
      { token: 'type:permanent', field: 'noteType', operator: 'contains', value: 'permanent' },
      { token: 'backlinks=0', field: 'backlinkCount', operator: 'equals', value: '0' },
      { token: 'semantic>2', field: 'semanticDegree', operator: 'greater', value: '2' },
      { token: 'index:notIndexed', field: 'indexStatus', operator: 'contains', value: 'notIndexed' },
    ]);
  });

  it('maps review / reconciled / due / lens aliases', () => {
    const { rules } = parseQuery('review:none reconciled:never due:true lens:orphan');
    expect(rules.map(r => r.field)).toEqual(['reviewState', 'reconciledAt', 'reviewIsDue', 'lens']);
  });

  it('no longer knows the confidence field — it becomes a keyword', () => {
    // Regression guard: the backend dropped confidence, so `conf>80` must not
    // parse into a rule any more (it used to silently match everything).
    const { rules, keywords } = parseQuery('conf>80');
    expect(rules).toHaveLength(0);
    expect(keywords).toEqual(['conf>80']);
  });
});

describe('basesQuery — matching', () => {
  it('matches numeric relational rules', () => {
    const [rule] = parseQuery('backlinks=0').rules;
    expect(matchesRule(row({ backlinkCount: 0 }), rule)).toBe(true);
    expect(matchesRule(row({ backlinkCount: 3 }), rule)).toBe(false);
  });

  it('treats an unloaded graph signal as "does not match"', () => {
    const [rule] = parseQuery('hub:true').rules;
    expect(matchesRule(row({ isHub: null }), rule)).toBe(false);
    expect(matchesRule(row({ isHub: true }), rule)).toBe(true);
  });

  it('handles reconciled:never as "never organized"', () => {
    const [rule] = parseQuery('reconciled:never').rules;
    expect(matchesRule(row({ reconciledAt: null }), rule)).toBe(true);
    expect(matchesRule(row({ reconciledAt: '2026-01-01' }), rule)).toBe(false);
  });

  it('resolves a health lens token to its perspective predicate', () => {
    const [rule] = parseQuery('lens:orphan').rules;
    expect(matchesRule(row({ backlinkCount: 0, outboundLinks: 0 }), rule)).toBe(true);
    expect(matchesRule(row({ backlinkCount: 1, outboundLinks: 0 }), rule)).toBe(false);
  });

  it('ANDs multiple rules and free-text keywords', () => {
    const parsed = parseQuery('type:permanent backlinks=0 alpha');
    expect(matchesQuery(row({ noteType: 'permanent', backlinkCount: 0, title: 'Alpha' }), parsed)).toBe(true);
    expect(matchesQuery(row({ noteType: 'permanent', backlinkCount: 2, title: 'Alpha' }), parsed)).toBe(false);
  });
});

describe('basesQuery — token helpers', () => {
  it('toggles a token on and off', () => {
    expect(toggleToken('', 'lens:orphan')).toBe('lens:orphan');
    expect(toggleToken('type:permanent lens:orphan', 'lens:orphan')).toBe('type:permanent');
  });

  it('removes exactly one token and reports presence', () => {
    expect(hasToken('a lens:orphan', 'lens:orphan')).toBe(true);
    expect(removeToken('a lens:orphan b', 'lens:orphan')).toBe('a b');
  });
});
