import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteRow } from '../../lib/tauri';
import {
  COLUMN_DEFS,
  CHECK_COLUMN_WIDTH,
  tableMinWidth,
  fitTags,
  tagsCellWidth,
  type ColumnId,
} from '../../lib/notesHealth';
import { t, tf, type TranslationKey } from '../../lib/i18n';


/** One visual line of the table: either a group header or a note row. */
export type FlatItem =
  | { kind: 'group'; key: string; label: string; count: number; collapsed: boolean }
  | { kind: 'row'; row: NoteRow };

/** Uniform item height keeps the windowing math — and the spacer rows — trivial. */
export const ITEM_HEIGHT = 40;
/** Items kept rendered above and below the viewport so fast scrolls stay filled. */
export const OVERSCAN = 8;
/**
 * jsdom, and the first paint before layout, both report `clientHeight === 0`.
 * Falling back to a realistic viewport keeps the window *bounded* instead of
 * rendering the whole vault, which is the entire point of this component.
 */
export const FALLBACK_VIEWPORT = 640;

export interface OverviewTableProps {
  items: FlatItem[];
  visibleColumns: ColumnId[];
  sortField: ColumnId;
  sortDir: 'asc' | 'desc';
  onSort: (field: ColumnId) => void;
  selected: Set<string>;
  onToggleRow: (path: string) => void;
  /** Every currently filtered row is selected. */
  allSelected: boolean;
  onToggleAll: () => void;
  onRowClick: (row: NoteRow) => void;
  peekPath: string | null;
  semanticIndexReady: boolean;
  onToggleGroup: (key: string) => void;
  lang: string;
}

const INDEX_STATUS_KEY: Record<NoteRow['indexStatus'], TranslationKey> = {
  indexed: 'overview.index.indexed',
  partial: 'overview.index.partial',
  notIndexed: 'overview.index.notIndexed',
  noChunks: 'overview.index.noChunks',
};

function noteTypeColor(type: string): string {
  const colors: Record<string, string> = {
    permanent: '#10B981', literature: '#3B82F6', fleeting: '#F59E0B',
    index: '#8B5CF6', hub: '#EC4899', journal: '#06B6D4',
    reference: '#6366F1', project: '#F97316',
  };
  return colors[type.toLowerCase()] || '#64748B';
}

function formatDate(dateStr: string, lang: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return dateStr.substring(0, 10);
    return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr.substring(0, 10);
  }
}

/** Windowing: which slice of `items` to actually render, plus the spacer heights. */
export function useWindowedRange(itemCount: number, scrollTop: number, viewportH: number) {
  const vh = viewportH > 0 ? viewportH : FALLBACK_VIEWPORT;
  const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(vh / ITEM_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(itemCount, start + visible);
  return { start, end, topPad: start * ITEM_HEIGHT, bottomPad: Math.max(0, (itemCount - end) * ITEM_HEIGHT) };
}

/**
 * Index health, four states, one colour language.
 *
 * `indexed` is the *normal* state, so it renders as a dot only: repeating
 * "Indexed" on every healthy row is the same word fourteen times and pushes the
 * states that need action out of view. Everything abnormal keeps its label, so
 * hue is never the only carrier of a problem.
 */
function IndexCell({ row }: { row: NoteRow }) {
  const label = t(INDEX_STATUS_KEY[row.indexStatus]);
  const detail = row.chunkTotal > 0 ? tf('overview.index.detail', row.chunkEmbedded, row.chunkTotal) : label;
  const healthy = row.indexStatus === 'indexed';
  return (
    <span
      className={`overview-index overview-index-${row.indexStatus} ${healthy ? 'is-healthy' : ''}`}
      title={`${label} · ${detail}`}
      aria-label={label}
    >
      <span className="overview-index-dot" aria-hidden="true" />
      {!healthy && <span className="overview-index-label">{label}</span>}
    </span>
  );
}

/**
 * Review state. "Not in review" is the absence of a fact, so it renders as a
 * dash instead of a grey `Not added` on every row — the column then only carries
 * ink where something is actually scheduled or due.
 */
function ReviewCell({ row }: { row: NoteRow }) {
  if (row.reviewState === null) {
    return (
      <span className="overview-review overview-review-none" title={t('overview.review.none')} aria-label={t('overview.review.none')}>
        —
      </span>
    );
  }
  if (row.reviewSuspended) {
    return <span className="overview-review overview-review-suspended">{t('overview.review.suspended')}</span>;
  }
  if (row.reviewIsDue) {
    return <span className="overview-review overview-review-due" data-testid="review-due">{t('overview.review.due')}</span>;
  }
  return <span className="overview-review overview-review-ok">{row.reviewState}</span>;
}

/**
 * Tags, never half of one.
 *
 * How many fit is decided from the column's declared width (see `fitTags`), not
 * by letting CSS clip: a clipped pill reads as a different tag, which is a
 * correctness bug, not a cosmetic one. The overflow is always reachable — `+N`
 * carries the full list in its tooltip.
 */
function TagsCell({ row }: { row: NoteRow }) {
  const { shown, hidden } = useMemo(() => fitTags(row.tags, tagsCellWidth()), [row.tags]);
  if (row.tags.length === 0) return <span className="overview-tags-empty">—</span>;
  return (
    <span className="overview-tags" title={row.tags.join('  ')}>
      {shown.map(tag => <span key={tag} className="overview-tag">{tag}</span>)}
      {hidden > 0 && (
        <span
          className="overview-tag overview-tag-more"
          title={tf('overview.tagsMore', hidden, row.tags.slice(shown.length).join('  '))}
          data-testid="tag-more"
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}

/** Render one data cell for a given column. */
function Cell({ row, col, lang }: { row: NoteRow; col: ColumnId; lang: string }) {
  switch (col) {
    case 'title':
      return (
        <span className="overview-title" title={row.title}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="overview-title-text">{row.title}</span>
        </span>
      );
    case 'noteType':
      return (
        <span className="overview-type-badge" style={{ '--badge-color': noteTypeColor(row.noteType) } as React.CSSProperties}>
          {row.noteType}
        </span>
      );
    case 'tags': return <TagsCell row={row} />;
    case 'outboundLinks': return <span className="overview-num">{row.outboundLinks}</span>;
    case 'backlinkCount': return <span className="overview-num">{row.backlinkCount}</span>;
    case 'semanticDegree': return <span className="overview-num">{row.semanticDegree}</span>;
    case 'indexStatus': return <IndexCell row={row} />;
    case 'reviewState': return <ReviewCell row={row} />;
    case 'createdAt': return <span className="overview-date">{formatDate(row.createdAt, lang)}</span>;
    case 'lastSynced': return <span className="overview-date">{formatDate(row.lastSynced, lang)}</span>;
    case 'pagerank': return <span className="overview-num">{row.pagerank !== null ? row.pagerank.toFixed(3) : '—'}</span>;
    case 'isHub': return <span className="overview-num">{row.isHub === null ? '—' : row.isHub ? '★' : '·'}</span>;
    default: return null;
  }
}


const SortGlyph = ({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: active ? 1 : 0.25 }}>
    {active ? (dir === 'asc' ? <path d="M7 14l5-5 5 5" /> : <path d="M7 10l5 5 5-5" />) : <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />}
  </svg>
);

export function OverviewTable(props: OverviewTableProps) {
  const {
    items, visibleColumns, sortField, sortDir, onSort, selected, onToggleRow,
    allSelected, onToggleAll, onRowClick, peekPath, onToggleGroup, lang,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const cols = COLUMN_DEFS.filter(c => visibleColumns.includes(c.id));
  const { start, end, topPad, bottomPad } = useWindowedRange(items.length, scrollTop, viewportH);
  const windowed = items.slice(start, end);
  // header checkbox col + data cols
  const totalCols = cols.length + 1;
  /**
   * The table is *at least* as wide as its columns need. Without this the old
   * `width: 100%` + `table-layout: fixed` pair could never overflow, so
   * `overflow: auto` had nothing to scroll and Shift+wheel was a no-op. It is
   * derived from the visible columns, so toggling a column changes it.
   */
  const minWidth = tableMinWidth(cols.map(c => c.id));

  return (
    <div
      className="overview-table-wrap"
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="overview-scroll"
      // A scroll container that only a mouse wheel can reach is a keyboard trap
      // in reverse: focusable + labelled makes the horizontal axis operable.
      role="region"
      aria-label={t('overview.tableRegion')}
      tabIndex={0}
    >
      <table className="overview-table" style={{ minWidth }} data-testid="overview-table">
        {/*
          Widths live in `COLUMN_DEFS` and reach the DOM only here. Mixing `%` and
          `px` across CSS rules is what made `table-layout: fixed` proportionally
          squeeze every column — including the tags and the headers — instead of
          overflowing. `title` deliberately gets no width: it absorbs the slack.
        */}
        <colgroup>
          <col style={{ width: CHECK_COLUMN_WIDTH }} />
          {cols.map(col => (
            col.id === 'title'
              ? <col key={col.id} data-testid="col-title" />
              : <col key={col.id} style={{ width: col.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="overview-th overview-th-check">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label={t('overview.selectAll')}
                data-testid="select-all"
              />
            </th>
            {cols.map(col => {
              const full = t(col.labelKey as Parameters<typeof t>[0]);
              // `IN` / `OUT` / `SEM` in the header, full name in the tooltip and
              // for assistive tech: three long words over one-digit values was
              // most of the wasted width.
              const shown = col.shortLabelKey ? t(col.shortLabelKey as Parameters<typeof t>[0]) : full;
              return (
                <th
                  key={col.id}
                  className={`overview-th overview-th-${col.id} ${col.sortable ? 'is-sortable' : ''}`}
                  onClick={col.sortable ? () => onSort(col.id) : undefined}
                  aria-sort={sortField === col.id ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  title={shown === full ? undefined : full}
                >
                  <span>
                    <span className="overview-th-label" aria-label={shown === full ? undefined : full}>{shown}</span>
                    {col.sortable && <SortGlyph active={sortField === col.id} dir={sortDir} />}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {topPad > 0 && (
            <tr aria-hidden="true" data-testid="spacer-top" style={{ height: topPad }}>
              <td colSpan={totalCols} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
          {/* Only the windowed slice is in the DOM; the spacers above and below
              stand in for everything else so the scrollbar stays truthful. */}
          {windowed.map((item, i) => {
            const absIndex = start + i;
            if (item.kind === 'group') {
              return (
                <tr
                  key={`g:${item.key}`}
                  className="overview-group-row"
                  data-testid="group-row"
                  style={{ height: ITEM_HEIGHT }}
                  onClick={() => onToggleGroup(item.key)}
                >
                  <td colSpan={totalCols} className="overview-group-cell">
                    <span className={`overview-group-caret ${item.collapsed ? 'collapsed' : ''}`} aria-hidden="true">▸</span>
                    <span className="overview-group-label">{item.label}</span>
                    <span className="overview-group-count">{tf('overview.groupCount', item.count)}</span>
                  </td>
                </tr>
              );
            }
            const { row } = item;
            const isChecked = selected.has(row.path);
            const isPeeked = peekPath === row.path;
            return (
              <tr
                key={row.path}
                className={`overview-row ${isPeeked ? 'is-peeked' : ''} ${isChecked ? 'is-checked' : ''}`}
                style={{ height: ITEM_HEIGHT }}
                data-testid="note-row"
                data-index={absIndex}
                onClick={() => onRowClick(row)}
              >
                <td className="overview-td overview-td-check" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggleRow(row.path)}
                    aria-label={row.title}
                    data-testid="row-check"
                  />
                </td>
                {cols.map(col => (
                  <td key={col.id} className={`overview-td overview-td-${col.id}`}>
                    <Cell row={row} col={col.id} lang={lang} />
                  </td>
                ))}
              </tr>
            );
          })}

          {bottomPad > 0 && (
            <tr aria-hidden="true" data-testid="spacer-bottom" style={{ height: bottomPad }}>
              <td colSpan={totalCols} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


