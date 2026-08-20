/**
 * The Notes Overview filter DSL.
 *
 * Two jobs, kept together on purpose so the token grammar and the row semantics
 * cannot drift apart:
 *   1. `parseQuery` — text → structured rules (+ leftover keywords).
 *   2. `matchesRule` / `matchesQuery` — apply those rules to a `NoteRow`.
 *
 * `confidence` used to be a field here. It is gone: nothing in the repo ever
 * wrote `card_meta.confidence`, and `get_notes_overview` does not return it, so
 * every `conf>…` query silently matched everything.
 */
import type { NoteRow } from './tauri';
import { HEALTH_PERSPECTIVES } from './notesHealth';

export type QueryField =
  // text
  | 'title'
  | 'noteType'
  | 'tag'
  | 'folder'
  | 'indexStatus'
  | 'reviewState'
  // numeric
  | 'outboundLinks'
  | 'backlinkCount'
  | 'semanticDegree'
  | 'contradictionCount'
  | 'pagerank'
  // boolean
  | 'reviewIsDue'
  | 'isHub'
  // date / nullable timestamp
  | 'reconciledAt'
  | 'createdAt'
  | 'lastSynced'
  /**
   * A named health perspective (`lens:orphan`). Chips in the view are *nothing
   * but* these tokens, which is what makes a saved view round-trip the chips for
   * free — `SavedView` has no separate field for them.
   */
  | 'lens';

export type QueryOperator = 'contains' | 'equals' | 'greater' | 'less' | 'greaterEqual' | 'lessEqual';

export interface QueryRule {
  token: string;
  field: QueryField;
  operator: QueryOperator;
  value: string;
}

/** Aliases are lowercase; the DSL is case-insensitive on field names. */
const FIELD_ALIASES: Record<string, QueryField> = {
  // text
  title: 'title', name: 'title',
  type: 'noteType', notetype: 'noteType',
  tag: 'tag', tags: 'tag',
  folder: 'folder', dir: 'folder', path: 'folder',
  index: 'indexStatus', indexed: 'indexStatus', indexstatus: 'indexStatus',
  review: 'reviewState', reviewstate: 'reviewState',
  // numeric
  links: 'outboundLinks', link: 'outboundLinks', linkcount: 'outboundLinks',
  outbound: 'outboundLinks', outboundlinks: 'outboundLinks',
  backlinks: 'backlinkCount', backlink: 'backlinkCount',
  inlinks: 'backlinkCount', backlinkcount: 'backlinkCount',
  semantic: 'semanticDegree', sem: 'semanticDegree', semanticdegree: 'semanticDegree',
  contradictions: 'contradictionCount', contradiction: 'contradictionCount',
  conflicts: 'contradictionCount', conflict: 'contradictionCount',
  pagerank: 'pagerank', pr: 'pagerank', rank: 'pagerank',
  // boolean
  due: 'reviewIsDue', isdue: 'reviewIsDue',
  hub: 'isHub', ishub: 'isHub',
  // dates
  reconciled: 'reconciledAt', reconciledat: 'reconciledAt', organized: 'reconciledAt',
  created: 'createdAt', createdat: 'createdAt',
  modified: 'lastSynced', updated: 'lastSynced', lastsynced: 'lastSynced',
  // health perspective
  lens: 'lens', persp: 'lens', perspective: 'lens',
};

const NUMERIC_FIELDS = new Set<QueryField>([
  'outboundLinks', 'backlinkCount', 'semanticDegree', 'contradictionCount', 'pagerank',
]);

const BOOLEAN_FIELDS = new Set<QueryField>(['reviewIsDue', 'isHub']);

export function mapField(fieldRaw: string): QueryField | null {
  return FIELD_ALIASES[fieldRaw.toLowerCase()] ?? null;
}

export function mapOperator(opRaw: string): QueryOperator {
  if (opRaw === '>') return 'greater';
  if (opRaw === '<') return 'less';
  if (opRaw === '>=') return 'greaterEqual';
  if (opRaw === '<=') return 'lessEqual';
  return 'equals';
}

export function isNumericField(field: QueryField): boolean {
  return NUMERIC_FIELDS.has(field);
}

export function isBooleanField(field: QueryField): boolean {
  return BOOLEAN_FIELDS.has(field);
}

/** `true` / `1` / `yes` / `y` / `是` → true; `false` / `0` / `no` / `n` / `否` → false. */
function parseBoolWord(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === '是') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === '否') return false;
  return null;
}

/** `never` / `none` / `null` / `从未` — "this signal was never written". */
function isNeverWord(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'never' || v === 'none' || v === 'null' || v === '从未' || v === '无';
}

export function parseQuery(searchQuery: string): { rules: QueryRule[]; keywords: string[] } {
  const rules: QueryRule[] = [];
  const keywords: string[] = [];

  if (!searchQuery.trim()) {
    return { rules, keywords };
  }

  // 1. Relational rules (links>=5)
  // 2. Colon rules (type:permanent, folder:"My Folder")
  // 3. Shorthand tags (#daily)
  // 4. Fallback keywords (biology, "some phrase")
  const tokenRegex = /([a-zA-Z]+(?:>=|<=|>|<|=)(?:"[^"]*"|'[^']*'|[^\s]+))|([a-zA-Z]+:(?:"[^"]*"|'[^']*'|[^\s]+))|(#[^\s]+)|("[^"]*"|'[^']*'|[^\s]+)/g;

  let match;
  const tokens: string[] = [];
  while ((match = tokenRegex.exec(searchQuery)) !== null) {
    const token = match[0].trim();
    if (token) {
      tokens.push(token);
    }
  }

  for (const token of tokens) {
    // 1. Shorthand tag: #daily
    if (token.startsWith('#') && token.length > 1) {
      rules.push({ token, field: 'tag', operator: 'equals', value: token.slice(1) });
      continue;
    }

    // 2. Relational filters: links>=3, backlinks=0
    const relMatch = token.match(/^([a-zA-Z]+)(>=|<=|>|<|=)(.+)$/);
    if (relMatch) {
      const [, fieldRaw, opRaw, valRaw] = relMatch;
      const field = mapField(fieldRaw);
      if (field) {
        rules.push({
          token,
          field,
          operator: mapOperator(opRaw),
          value: valRaw.replace(/^["']|["']$/g, ''),
        });
        continue;
      }
    }

    // 3. Key-value colon filters: type:permanent, index:notIndexed, due:true
    const colonMatch = token.match(/^([a-zA-Z]+):(.+)$/);
    if (colonMatch) {
      const [, fieldRaw, valRaw] = colonMatch;
      const field = mapField(fieldRaw);
      if (field) {
        rules.push({
          token,
          field,
          // Numeric and boolean fields have no useful "contains", so `:` means `=`
          // for them. Text fields keep substring matching.
          operator: isNumericField(field) || isBooleanField(field) ? 'equals' : 'contains',
          value: valRaw.replace(/^["']|["']$/g, ''),
        });
        continue;
      }
    }

    // 4. Fallback: free-text keyword
    keywords.push(token.replace(/^["']|["']$/g, '').toLowerCase());
  }

  return { rules, keywords };
}

function compareNumber(actual: number, rule: QueryRule): boolean {
  const num = parseFloat(rule.value);
  if (Number.isNaN(num)) {
    // `contradictions:true` reads naturally; treat bool words as "> 0" / "=== 0".
    const bool = parseBoolWord(rule.value);
    if (bool === null) return true; // unparseable → no-op rather than empty table
    return bool ? actual > 0 : actual === 0;
  }
  switch (rule.operator) {
    case 'greater': return actual > num;
    case 'less': return actual < num;
    case 'greaterEqual': return actual >= num;
    case 'lessEqual': return actual <= num;
    default: return actual === num;
  }
}

function compareString(actual: string, rule: QueryRule): boolean {
  const a = actual.toLowerCase();
  const v = rule.value.toLowerCase();
  switch (rule.operator) {
    case 'contains': return a.includes(v);
    case 'greater': return a > v;
    case 'less': return a < v;
    case 'greaterEqual': return a >= v;
    case 'lessEqual': return a <= v;
    default: return a === v;
  }
}

/**
 * Does one row satisfy one rule?
 *
 * Unknown graph signals (`pagerank` / `isHub` are `null` until the user asks for
 * them) never satisfy a rule — an unloaded signal is not evidence.
 */
export function matchesRule(row: NoteRow, rule: QueryRule): boolean {
  switch (rule.field) {
    case 'title': return compareString(row.title, rule);
    case 'noteType': return compareString(row.noteType, rule);
    case 'folder': return compareString(row.folder, rule);
    case 'indexStatus': return compareString(row.indexStatus, rule);

    case 'tag':
      return row.tags.some(tg => compareString(tg, rule));

    case 'reviewState': {
      if (isNeverWord(rule.value)) return row.reviewState === null;
      return row.reviewState !== null && compareString(row.reviewState, rule);
    }

    case 'outboundLinks': return compareNumber(row.outboundLinks, rule);
    case 'backlinkCount': return compareNumber(row.backlinkCount, rule);
    case 'semanticDegree': return compareNumber(row.semanticDegree, rule);
    case 'contradictionCount': return compareNumber(row.contradictionCount, rule);

    case 'pagerank':
      return row.pagerank !== null && compareNumber(row.pagerank, rule);

    case 'reviewIsDue': {
      const want = parseBoolWord(rule.value);
      return want === null ? true : row.reviewIsDue === want;
    }

    case 'isHub': {
      const want = parseBoolWord(rule.value);
      if (want === null) return true;
      return row.isHub !== null && row.isHub === want;
    }

    case 'reconciledAt': {
      if (isNeverWord(rule.value)) return row.reconciledAt === null;
      const bool = parseBoolWord(rule.value);
      if (bool !== null) return bool ? row.reconciledAt !== null : row.reconciledAt === null;
      if (row.reconciledAt === null) return false;
      return compareString(row.reconciledAt, rule);
    }

    case 'createdAt': return compareString(row.createdAt, rule);
    case 'lastSynced': return compareString(row.lastSynced, rule);

    case 'lens': {
      const id = rule.value.toLowerCase();
      const p = HEALTH_PERSPECTIVES.find(x => x.id.toLowerCase() === id);
      // Unknown lens name is a no-op rather than an empty table: the chips only
      // ever emit real ids, so this can only come from hand-typed input.
      return p ? p.match(row) : true;
    }

    default: return true;
  }
}

/** Free-text keywords match title / type / tags / folder, all of them (AND). */
export function matchesKeywords(row: NoteRow, keywords: string[]): boolean {
  return keywords.every(kw =>
    row.title.toLowerCase().includes(kw) ||
    row.noteType.toLowerCase().includes(kw) ||
    row.tags.some(tg => tg.toLowerCase().includes(kw)) ||
    row.folder.toLowerCase().includes(kw),
  );
}

export function matchesQuery(row: NoteRow, parsed: { rules: QueryRule[]; keywords: string[] }): boolean {
  return parsed.rules.every(rule => matchesRule(row, rule)) && matchesKeywords(row, parsed.keywords);
}

/** Human-readable pill label, e.g. `backlinks = 0`. Localisation lives in the view. */
export function ruleLabel(rule: QueryRule): string {
  const op = rule.operator === 'greater' ? '>'
    : rule.operator === 'less' ? '<'
    : rule.operator === 'greaterEqual' ? '≥'
    : rule.operator === 'lessEqual' ? '≤'
    : rule.operator === 'contains' ? ':'
    : '=';
  return rule.field === 'tag' ? `#${rule.value}` : `${rule.field} ${op} ${rule.value}`;
}

/** Split a query string into whitespace-separated tokens, quotes respected. */
function splitTokens(query: string): string[] {
  return query.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
}

/** Is `token` already one of the query's terms? Case-insensitive. */
export function hasToken(query: string, token: string): boolean {
  const want = token.toLowerCase();
  return splitTokens(query).some(x => x.toLowerCase() === want);
}

/** Add `token` if absent, drop it if present. Used by the health-lens chips. */
export function toggleToken(query: string, token: string): string {
  const want = token.toLowerCase();
  const tokens = splitTokens(query);
  const kept = tokens.filter(x => x.toLowerCase() !== want);
  if (kept.length !== tokens.length) return kept.join(' ');
  return [...tokens, token].join(' ');
}

/** Remove exactly one term from a query string, for the pill close buttons. */
export function removeToken(query: string, token: string): string {
  const want = token.toLowerCase();
  return splitTokens(query).filter(x => x.toLowerCase() !== want).join(' ');
}
