/**
 * Notes Overview domain constants — the "health desk" logic, kept pure and
 * framework-free so it can be unit-tested without rendering anything.
 *
 * Two things live here:
 *   1. HEALTH_PERSPECTIVES — the one-click "what should I do" filters. Each is a
 *      predicate over a `NoteRow`; the view turns them into chips with counts.
 *   2. COLUMN_DEFS — the table columns, their i18n keys and default visibility.
 *      `graphOnly` columns only exist once the user computes graph signals.
 */
import type { NoteRow, NotesOverview } from './tauri';
import type { TranslationKey } from './i18n';

export type PerspectiveId =
  | 'orphan'
  | 'neverReconciled'
  | 'hasContradictions'
  | 'notIndexed'
  | 'dueToday'
  | 'semanticIsland';

export interface HealthPerspective {
  id: PerspectiveId;
  /** i18n key for the chip label. */
  labelKey: TranslationKey;
  /** Row predicate. */
  match: (row: NoteRow) => boolean;
  /** When true the chip is meaningless until the semantic index exists. */
  needsSemanticIndex?: boolean;
}

export const HEALTH_PERSPECTIVES: HealthPerspective[] = [
  {
    id: 'orphan',
    labelKey: 'overview.persp.orphan',
    match: r => r.backlinkCount === 0 && r.outboundLinks === 0,
  },
  {
    id: 'neverReconciled',
    labelKey: 'overview.persp.neverReconciled',
    match: r => r.reconciledAt === null,
  },
  {
    id: 'hasContradictions',
    labelKey: 'overview.persp.hasContradictions',
    match: r => r.hasContradictions,
  },
  {
    id: 'notIndexed',
    labelKey: 'overview.persp.notIndexed',
    match: r => r.indexStatus === 'notIndexed' || r.indexStatus === 'partial',
  },
  {
    id: 'dueToday',
    labelKey: 'overview.persp.dueToday',
    match: r => r.reviewIsDue,
  },
  {
    id: 'semanticIsland',
    labelKey: 'overview.persp.semanticIsland',
    match: r => r.semanticDegree === 0,
    needsSemanticIndex: true,
  },
];

export function getPerspective(id: PerspectiveId): HealthPerspective {
  const p = HEALTH_PERSPECTIVES.find(x => x.id === id);
  if (!p) throw new Error(`Unknown perspective: ${id}`);
  return p;
}

/**
 * How many rows each perspective matches. Perspectives that need the semantic
 * index report 0 when it is not ready — the view disables the chip in that case,
 * so a misleading count is never shown as actionable.
 */
export function perspectiveCounts(
  rows: NoteRow[],
  semanticIndexReady: boolean,
): Record<PerspectiveId, number> {
  const counts = {} as Record<PerspectiveId, number>;
  for (const p of HEALTH_PERSPECTIVES) {
    if (p.needsSemanticIndex && !semanticIndexReady) {
      counts[p.id] = 0;
      continue;
    }
    let n = 0;
    for (const r of rows) if (p.match(r)) n++;
    counts[p.id] = n;
  }
  return counts;
}

/** A perspective is usable only if its data prerequisite is met. */
export function isPerspectiveEnabled(
  p: HealthPerspective,
  overview: Pick<NotesOverview, 'semanticIndexReady'> | null,
): boolean {
  if (!p.needsSemanticIndex) return true;
  return !!overview?.semanticIndexReady;
}

// ── Columns ──────────────────────────────────────────────────────────────

export type ColumnId =
  | 'title'
  | 'noteType'
  | 'tags'
  | 'outboundLinks'
  | 'backlinkCount'
  | 'semanticDegree'
  | 'indexStatus'
  | 'reviewState'
  | 'createdAt'
  | 'lastSynced'
  | 'pagerank'
  | 'isHub';

export interface ColumnDef {
  id: ColumnId;
  labelKey: TranslationKey;
  /**
   * Compact header label. `BACKLINKS` / `OUTBOUND` / `SEMANTIC` are long headers
   * over 1–2 digit values, so they get `IN` / `OUT` / `SEM` in the header with the
   * full name in a tooltip. The full label is still what the Columns panel shows.
   */
  shortLabelKey?: TranslationKey;
  /**
   * Column width in px. **The only place a column width is declared** — CSS used
   * to keep its own copy (and mixed `%` with `px`, which is what made
   * `table-layout: fixed` squeeze every column instead of overflowing). The table
   * renders a `<colgroup>` from these and sets its own `min-width` to their sum,
   * so a narrow container produces real horizontal scroll.
   *
   * Widths are sized for the **Chinese** labels and values, which are wider than
   * the English ones.
   */
  width: number;
  /** Shown by default in a fresh view. */
  defaultVisible: boolean;
  /** Column can be a sort key. */
  sortable: boolean;
  /** Only meaningful once graph signals are computed. */
  graphOnly?: boolean;
  /** `title` can never be hidden — it is the row's identity. */
  locked?: boolean;
}

/**
 * `title` is the one column with "take the remaining space" semantics: the table
 * gives it no explicit `<col>` width, so `table-layout: fixed` hands it whatever
 * is left over. This is its floor, and its contribution to the table min-width.
 */
export const TITLE_COLUMN_MIN_WIDTH = 240;

/** The selection checkbox column. Wide enough for the box *plus* its padding. */
export const CHECK_COLUMN_WIDTH = 40;

export const COLUMN_DEFS: ColumnDef[] = [
  { id: 'title', labelKey: 'overview.col.title', width: TITLE_COLUMN_MIN_WIDTH, defaultVisible: true, sortable: true, locked: true },
  { id: 'noteType', labelKey: 'overview.col.noteType', width: 112, defaultVisible: true, sortable: true },

  { id: 'tags', labelKey: 'overview.col.tags', width: 220, defaultVisible: true, sortable: false },
  { id: 'backlinkCount', labelKey: 'overview.col.backlinks', shortLabelKey: 'overview.col.backlinks.short', width: 64, defaultVisible: true, sortable: true },
  { id: 'outboundLinks', labelKey: 'overview.col.outbound', shortLabelKey: 'overview.col.outbound.short', width: 64, defaultVisible: true, sortable: true },
  { id: 'semanticDegree', labelKey: 'overview.col.semantic', shortLabelKey: 'overview.col.semantic.short', width: 64, defaultVisible: true, sortable: true },
  { id: 'indexStatus', labelKey: 'overview.col.index', width: 112, defaultVisible: true, sortable: true },
  { id: 'reviewState', labelKey: 'overview.col.review', width: 100, defaultVisible: true, sortable: true },
  { id: 'lastSynced', labelKey: 'overview.col.modified', width: 120, defaultVisible: true, sortable: true },
  { id: 'createdAt', labelKey: 'overview.col.created', width: 120, defaultVisible: false, sortable: true },

  { id: 'pagerank', labelKey: 'overview.col.pagerank', width: 96, defaultVisible: true, sortable: true, graphOnly: true },
  { id: 'isHub', labelKey: 'overview.col.isHub', width: 72, defaultVisible: true, sortable: true, graphOnly: true },
];

export function defaultVisibleColumns(): ColumnId[] {
  return COLUMN_DEFS.filter(c => c.defaultVisible && !c.graphOnly).map(c => c.id);
}

export function getColumn(id: ColumnId): ColumnDef | undefined {
  return COLUMN_DEFS.find(c => c.id === id);
}

/**
 * Total width the table needs for a given set of visible columns.
 *
 * The table uses this as its `min-width`, which is the whole fix for "horizontal
 * scrolling does not exist": `width: 100%` alone can never overflow its
 * container, so `overflow: auto` had nothing to scroll and Shift+wheel did
 * nothing. It has to be recomputed whenever the user toggles a column, which is
 * exactly why it cannot live in CSS.
 */
export function tableMinWidth(visible: ColumnId[]): number {
  let total = CHECK_COLUMN_WIDTH;
  for (const col of COLUMN_DEFS) if (visible.includes(col.id)) total += col.width;
  return total;
}

/** Comparator for one sort field, ascending. The view flips it for descending. */
export function compareRows(a: NoteRow, b: NoteRow, field: ColumnId): number {
  switch (field) {
    case 'title': return a.title.localeCompare(b.title);
    case 'noteType': return a.noteType.localeCompare(b.noteType);
    case 'outboundLinks': return a.outboundLinks - b.outboundLinks;
    case 'backlinkCount': return a.backlinkCount - b.backlinkCount;
    case 'semanticDegree': return a.semanticDegree - b.semanticDegree;
    case 'indexStatus': return a.indexStatus.localeCompare(b.indexStatus);
    case 'reviewState': return (a.reviewState ?? '').localeCompare(b.reviewState ?? '');
    case 'createdAt': return a.createdAt.localeCompare(b.createdAt);
    case 'lastSynced': return a.lastSynced.localeCompare(b.lastSynced);
    case 'pagerank': return (a.pagerank ?? -1) - (b.pagerank ?? -1);
    case 'isHub': return Number(a.isHub ?? false) - Number(b.isHub ?? false);
    default: return 0;
  }
}

// ── Tag fitting ──────────────────────────────────────────────────────────
//
// The tags cell must never show *half* a tag. CSS cannot promise that: any
// `overflow: hidden` clips mid-glyph, and that is exactly how the cell ended up
// reading `transformer  e…` / `knowledge-managem`. So the count is decided in JS
// from the column's known width, and whatever does not fit whole becomes `+N`.

/** Horizontal padding + border of one `.overview-tag` pill, in px. */
const TAG_PILL_CHROME = 14;
/** `gap` between pills, in px. */
const TAG_PILL_GAP = 4;
/** Width reserved for the `+N` pill. Fits `+99`. */
const TAG_MORE_WIDTH = 30;
/** `.overview-td` left+right padding, in px. */
export const CELL_PADDING_X = 20;

/**
 * Deliberately *pessimistic* text width at the 11px tag font: over-estimating
 * costs at most one tag moving into `+N`, under-estimating would clip a glyph —
 * which is the bug being fixed. Iterates code points, so surrogate pairs and
 * emoji count once instead of twice.
 */
export function estimateTagTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK, Kana, Hangul and full-width punctuation are ~1em wide at 11px.
    width += cp >= 0x1100 ? 12 : 7;
  }
  return width;
}

/**
 * How many tags fit whole in `availableWidth`, and how many are left over.
 *
 * `shown` is always a prefix of `tags`, and `shown.length + hidden === tags.length`,
 * so nothing is ever silently dropped.
 */
export function fitTags(tags: string[], availableWidth: number): { shown: string[]; hidden: number } {
  if (tags.length === 0) return { shown: [], hidden: 0 };
  const pill = tags.map(tg => estimateTagTextWidth(tg) + TAG_PILL_CHROME);

  // Try the longest prefix first; n is small, so the quadratic scan is free.
  for (let k = tags.length; k > 0; k--) {
    let width = 0;
    for (let i = 0; i < k; i++) width += pill[i] + (i > 0 ? TAG_PILL_GAP : 0);
    if (k < tags.length) width += TAG_PILL_GAP + TAG_MORE_WIDTH;
    if (width <= availableWidth) return { shown: tags.slice(0, k), hidden: tags.length - k };
  }
  // Not even the first tag fits whole — every tag goes into `+N` rather than
  // being sliced in half. The `+N` pill carries the full list in its tooltip.
  return { shown: [], hidden: tags.length };
}

/** Usable text width of the tags cell, i.e. the column minus its padding. */
export function tagsCellWidth(): number {
  return (getColumn('tags')?.width ?? 0) - CELL_PADDING_X;
}
