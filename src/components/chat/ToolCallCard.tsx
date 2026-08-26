/**
 * ToolCallCard — knowledge-management tool result renderers.
 *
 * Inspired by Mybuddy's `toolRenderers` dispatch, but purpose-built for a
 * Zettelkasten vault: a note read renders as path + frontmatter + heading
 * skeleton, a search renders as a ranked hit list, a graph query renders as
 * node/edge stats. Generic JSON is the fallback, not the default.
 *
 * Design constraints (matches the rest of the chat UI):
 * - Inline SVG icons only, no emojis
 * - Global CSS classes from `src/styles/chat.css`, no Tailwind / cn()
 * - Keyboard accessible, reduced-motion aware
 */

import { useState, useCallback, useMemo } from 'react';
import type { ToolCallInfo } from './useChatSessions';
import { getLang } from '../../lib/i18n';

function isZh(): boolean {
  return getLang() === 'zh';
}

// ── Tool kind dispatch ─────────────────────────────────────────────

export type ToolKind = 'note' | 'search' | 'graph' | 'relation' | 'canvas' | 'web' | 'generic';

/** Map a tool name to the renderer family that best explains its output. */
export function toolKindOf(name: string): ToolKind {
  if (/^(read_note|create_note|edit_note|patch_note|apply_edit|append_to_note|delete_note|rename_note|move_note|merge_notes|batch_read_notes|revert_note)$/.test(name))
    return 'note';
  if (/^(search_notes|find_similar_notes|search_by_tag|get_backlinks|list_notes|resolve_wikilink)$/.test(name))
    return 'search';
  if (/^(get_graph|get_local_graph|find_shortest_path|get_vault_stats|query_relations|get_relations_by_type)$/.test(name))
    return 'graph';
  if (/^(add_relation|delete_relation|batch_link_notes|fix_broken_link|explain_relationship)$/.test(name))
    return 'relation';
  if (/canvas/.test(name)) return 'canvas';
  if (/^(web_search|fetch_web_content|ocr_image)$/.test(name)) return 'web';
  return 'generic';
}

// ── Copy button ────────────────────────────────────────────────────

export function ToolCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }, [text]);
  return (
    <button
      className="trace-copy-btn"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy'}
      title={copied ? (isZh() ? '已复制' : 'Copied') : (isZh() ? '复制' : 'Copy')}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--success, #16a34a)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      )}
    </button>
  );
}

// ── Parsers ────────────────────────────────────────────────────────

interface SearchHit { title: string; path?: string; score?: string }

function parseSearchResults(raw?: string): { total: number; top: SearchHit[] } {
  if (!raw) return { total: 0, top: [] };
  // The backend may wrap JSON in a ```json fence after compression.
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // A compressed payload starts with a count line — recover it if present.
  const countMatch = raw.match(/(\d+)\s*(?:results total|条结果|results)/i);
  const declaredTotal = countMatch ? parseInt(countMatch[1], 10) : NaN;

  const jsonStart = unfenced.indexOf('[');
  if (jsonStart >= 0) {
    const jsonEnd = unfenced.lastIndexOf(']');
    if (jsonEnd > jsonStart) {
      try {
        const arr = JSON.parse(unfenced.slice(jsonStart, jsonEnd + 1));
        if (Array.isArray(arr)) {
          const top: SearchHit[] = arr.slice(0, 5).map((item: any) => ({
            title: String(item?.title ?? item?.path ?? item?.name ?? '—'),
            path: typeof item?.path === 'string' ? item.path : undefined,
            score: item?.score != null ? String(item.score).slice(0, 6) : undefined,
          }));
          return { total: Number.isNaN(declaredTotal) ? arr.length : declaredTotal, top };
        }
      } catch { /* not JSON — fall through */ }
    }
  }
  return { total: Number.isNaN(declaredTotal) ? 0 : declaredTotal, top: [] };
}

function parseGraphStats(raw?: string): { nodes: number; edges: number; topNodes: string[] } {
  if (!raw) return { nodes: 0, edges: 0, topNodes: [] };
  // Compressed form: "Knowledge graph — N nodes, M edges."
  const compact = raw.match(/(\d+)\s*nodes?,\s*(\d+)\s*edges?/i);
  if (compact) {
    const topLine = raw.match(/Top nodes:\s*(.+)/i);
    return {
      nodes: parseInt(compact[1], 10),
      edges: parseInt(compact[2], 10),
      topNodes: topLine ? topLine[1].split(',').map(s => s.trim()).filter(Boolean).slice(0, 5) : [],
    };
  }
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const val = JSON.parse(unfenced);
    const nodes = Array.isArray(val?.nodes) ? val.nodes.length : 0;
    const edges = Array.isArray(val?.edges) ? val.edges.length : 0;
    const topNodes = Array.isArray(val?.nodes)
      ? val.nodes.slice(0, 5).map((n: any) => String(n?.title ?? n?.id ?? '—'))
      : [];
    return { nodes, edges, topNodes };
  } catch {
    return { nodes: 0, edges: 0, topNodes: [] };
  }
}

/** Split a note payload into frontmatter, headings, and a prose preview. */
function parseNoteContent(raw?: string): { frontmatter: string[]; headings: string[]; preview: string } {
  if (!raw) return { frontmatter: [], headings: [], preview: '' };
  const lines = raw.split('\n');
  const frontmatter: string[] = [];
  const headings: string[] = [];
  const prose: string[] = [];
  let inFm = false;
  let fmClosed = false;

  for (const line of lines) {
    if (line.trim() === '---' && !fmClosed) {
      if (inFm) { fmClosed = true; inFm = false; } else { inFm = true; }
      continue;
    }
    if (inFm) { frontmatter.push(line); continue; }
    if (/^#{1,6}\s/.test(line)) { headings.push(line.trim()); continue; }
    if (line.trim()) prose.push(line.trim());
  }
  return {
    frontmatter: frontmatter.slice(0, 6),
    headings: headings.slice(0, 8),
    preview: prose.join(' ').slice(0, 280),
  };
}

function argOf(args: string, ...keys: string[]): string {
  try {
    const parsed = JSON.parse(args || '{}');
    for (const k of keys) {
      if (typeof parsed[k] === 'string' && parsed[k]) return parsed[k];
    }
  } catch { /* malformed args */ }
  return '';
}

// ── Kind-specific bodies ───────────────────────────────────────────

function NoteToolBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const path = argOf(toolCall.arguments, 'path', 'note_path', 'source_path', 'old_path');
  const { frontmatter, headings, preview } = parseNoteContent(toolCall.result);
  const zh = isZh();

  return (
    <div className="tool-body tool-body-note">
      {path && (
        <div className="tool-body-path">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <code>{path}</code>
          {toolCall.result && <ToolCopyButton text={toolCall.result} />}
        </div>
      )}
      {frontmatter.length > 0 && (
        <div className="tool-body-section">
          <div className="tool-body-label">{zh ? '元数据' : 'Frontmatter'}</div>
          <pre className="trace-detail-code">{frontmatter.join('\n')}</pre>
        </div>
      )}
      {headings.length > 0 && (
        <div className="tool-body-section">
          <div className="tool-body-label">{zh ? '结构' : 'Outline'}</div>
          <ul className="tool-body-outline" role="list">
            {headings.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}
      {preview && (
        <div className="tool-body-section">
          <div className="tool-body-label">{zh ? '正文预览' : 'Body preview'}</div>
          <p className="tool-body-preview">{preview}{preview.length >= 280 ? '…' : ''}</p>
        </div>
      )}
      {!path && !frontmatter.length && !headings.length && !preview && toolCall.result && (
        <pre className="trace-detail-code">{toolCall.result.slice(0, 1000)}</pre>
      )}
    </div>
  );
}

function SearchToolBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const { total, top } = parseSearchResults(toolCall.result);
  const zh = isZh();

  if (total === 0 && top.length === 0) {
    return <pre className="trace-detail-code">{(toolCall.result || '').slice(0, 1000)}</pre>;
  }

  return (
    <div className="tool-body tool-body-search">
      <div className="tool-body-summary">
        {zh ? `找到 ${total} 条结果` : `${total} result${total === 1 ? '' : 's'} found`}
        {toolCall.result && <ToolCopyButton text={toolCall.result} />}
      </div>
      {top.length > 0 && (
        <ol className="tool-body-hits" role="list">
          {top.map((hit, i) => (
            <li key={i} className="tool-body-hit">
              <span className="tool-body-hit-rank">{i + 1}</span>
              <span className="tool-body-hit-title">{hit.title}</span>
              {hit.score && <span className="tool-body-hit-score">{hit.score}</span>}
            </li>
          ))}
        </ol>
      )}
      {total > top.length && top.length > 0 && (
        <div className="tool-body-more">
          {zh ? `… 还有 ${total - top.length} 条` : `… ${total - top.length} more`}
        </div>
      )}
    </div>
  );
}

function GraphToolBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const { nodes, edges, topNodes } = parseGraphStats(toolCall.result);
  const zh = isZh();

  if (nodes === 0 && edges === 0) {
    return <pre className="trace-detail-code">{(toolCall.result || '').slice(0, 1000)}</pre>;
  }

  return (
    <div className="tool-body tool-body-graph">
      <div className="tool-body-stats">
        <span className="tool-body-stat">
          <strong>{nodes}</strong> {zh ? '节点' : nodes === 1 ? 'node' : 'nodes'}
        </span>
        <span className="tool-body-stat">
          <strong>{edges}</strong> {zh ? '条边' : edges === 1 ? 'edge' : 'edges'}
        </span>
        {toolCall.result && <ToolCopyButton text={toolCall.result} />}
      </div>
      {topNodes.length > 0 && (
        <div className="tool-body-section">
          <div className="tool-body-label">{zh ? '主要节点' : 'Top nodes'}</div>
          <div className="tool-body-chips">
            {topNodes.map((n, i) => <span key={i} className="tool-body-chip">{n}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Action Buttons for Structured Tool Results ────────────────────

export interface ToolActionItem {
  type: 'open_canvas' | 'open_knowledge_center' | 'open_note';
  path?: string;
  planId?: string;
  tab?: string;
  label: string;
}

const ALLOWED_ACTION_TYPES = new Set(['open_canvas', 'open_knowledge_center', 'open_note']);
const ALLOWED_KNOWLEDGE_TABS = new Set(['inbox', 'memory', 'changes', 'tasks', 'health', 'activity', 'gap_analysis']);

export function parseToolActions(result?: string): ToolActionItem[] {
  if (!result) return [];
  try {
    const data = JSON.parse(result);
    const actions: ToolActionItem[] = [];
    if (Array.isArray(data.actions)) {
      for (const a of data.actions) {
        if (a && typeof a.type === 'string' && ALLOWED_ACTION_TYPES.has(a.type) && typeof a.label === 'string') {
          const tab = typeof a.tab === 'string' && a.tab.trim().length > 0 ? a.tab.trim() : undefined;
          const validTab = tab && ALLOWED_KNOWLEDGE_TABS.has(tab) ? tab : (a.type === 'open_knowledge_center' ? 'gap_analysis' : undefined);
          actions.push({
            type: a.type as ToolActionItem['type'],
            path: typeof a.path === 'string' && a.path.trim().length > 0 ? a.path.trim() : undefined,
            planId: typeof a.planId === 'string' && a.planId.trim().length > 0 ? a.planId.trim() : undefined,
            tab: validTab,
            label: a.label.trim(),
          });
        }
      }
    }
    if (actions.length === 0 && typeof data.action_link === 'string') {
      const raw = data.action_link.replace(/^(action:|zettel:\/\/|zettel:)/, '');
      const [name, queryStr] = raw.split('?');
      const params = new URLSearchParams(queryStr || '');
      const zh = isZh();
      if (name === 'open_canvas' || name === 'canvas') {
        const path = params.get('path')?.trim() || undefined;
        const planId = params.get('planId')?.trim() || undefined;
        actions.push({
          type: 'open_canvas',
          path,
          planId,
          label: zh ? '打开并审查 Canvas 计划' : 'Open & Review Canvas Plan',
        });
      } else if (name === 'open_knowledge_center' || name === 'knowledge_center' || name === 'open_knowledge') {
        const rawTab = params.get('tab')?.trim();
        const tab = rawTab && ALLOWED_KNOWLEDGE_TABS.has(rawTab) ? rawTab : 'gap_analysis';
        const planId = params.get('planId')?.trim() || undefined;
        actions.push({
          type: 'open_knowledge_center',
          tab,
          planId,
          label: zh ? '打开知识中心审查图谱计划' : 'Open Knowledge Center to Review Plan',
        });
      } else if (name === 'open_note' || name === 'note') {
        const path = params.get('path')?.trim() || undefined;
        actions.push({
          type: 'open_note',
          path,
          label: zh ? '在编辑器中打开笔记' : 'Open Note in Editor',
        });
      }
    }
    return actions;
  } catch {
    return [];
  }
}

export function ToolActionsBar({ actions }: { actions: ToolActionItem[] }) {
  if (!actions || actions.length === 0) return null;

  const handleAction = (action: ToolActionItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (action.type === 'open_canvas') {
      window.dispatchEvent(new CustomEvent('open-canvas', { detail: { path: action.path, planId: action.planId } }));
      window.dispatchEvent(new CustomEvent('zettel:open-view', { detail: 'canvas' }));
    } else if (action.type === 'open_knowledge_center') {
      window.dispatchEvent(new CustomEvent('open-knowledge-center', { detail: { tab: action.tab, planId: action.planId } }));
      if (action.tab) {
        window.dispatchEvent(new CustomEvent('zettel:knowledge-page', { detail: action.tab }));
      }
      window.dispatchEvent(new CustomEvent('zettel:open-view', { detail: 'knowledge' }));
    } else if (action.type === 'open_note') {
      if (action.path) {
        window.dispatchEvent(new CustomEvent('open-note', { detail: { path: action.path } }));
      }
      window.dispatchEvent(new CustomEvent('zettel:open-view', { detail: 'note' }));
    }
  };

  return (
    <div className="chat-tool-actions-bar">
      {actions.map((act, idx) => (
        <button
          key={idx}
          className="chat-tool-action-btn"
          onClick={(e) => handleAction(act, e)}
          type="button"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>{act.label}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.7 }}>
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function CanvasToolBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const canvasPath = argOf(toolCall.arguments, 'canvas_path', 'path');
  const zh = isZh();
  const actions = useMemo(() => parseToolActions(toolCall.result), [toolCall.result]);

  return (
    <div className="tool-body tool-body-canvas">
      {canvasPath && (
        <div className="tool-body-canvas-path">
          <span className="tool-body-chip">Canvas</span>
          <code>{canvasPath}</code>
        </div>
      )}
      <ToolActionsBar actions={actions} />
      {toolCall.result && (
        <div className="tool-body-section">
          <div className="tool-body-label">
            {zh ? '结果' : 'Result'}
            <ToolCopyButton text={toolCall.result} />
          </div>
          <pre className="trace-detail-code">{toolCall.result.slice(0, 1000)}</pre>
        </div>
      )}
    </div>
  );
}

function RelationToolBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const source = argOf(toolCall.arguments, 'source_path', 'path');
  const target = argOf(toolCall.arguments, 'target_path', 'destination');
  const relType = argOf(toolCall.arguments, 'relation_type', 'type');
  const zh = isZh();
  const actions = useMemo(() => parseToolActions(toolCall.result), [toolCall.result]);

  return (
    <div className="tool-body tool-body-relation">
      {(source || target) && (
        <div className="tool-body-edge">
          <code>{source || '?'}</code>
          <span className="tool-body-edge-arrow" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
          </span>
          <code>{target || '?'}</code>
          {relType && <span className="tool-body-chip">{relType}</span>}
        </div>
      )}
      <ToolActionsBar actions={actions} />
      {toolCall.result && (
        <div className="tool-body-section">
          <div className="tool-body-label">
            {zh ? '结果' : 'Result'}
            <ToolCopyButton text={toolCall.result} />
          </div>
          <pre className="trace-detail-code">{toolCall.result.slice(0, 800)}</pre>
        </div>
      )}
    </div>
  );
}

function GenericToolBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const zh = isZh();
  const actions = useMemo(() => parseToolActions(toolCall.result), [toolCall.result]);
  if (!toolCall.result) return null;
  let text = toolCall.result;
  try { text = JSON.stringify(JSON.parse(toolCall.result), null, 2); } catch { /* plain text */ }
  return (
    <div className="tool-body tool-body-generic">
      <ToolActionsBar actions={actions} />
      <div className="tool-body-label">
        {zh ? '结果' : 'Result'}
        <ToolCopyButton text={toolCall.result} />
      </div>
      <pre className="trace-detail-code">{text.slice(0, 1500)}</pre>
    </div>
  );
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Render a tool result using the renderer that fits its kind.
 * Falls back to pretty-printed JSON for unrecognized tools.
 */
export function ToolResultBody({ toolCall }: { toolCall: ToolCallInfo }) {
  const kind = toolKindOf(toolCall.name);
  switch (kind) {
    case 'note':     return <NoteToolBody toolCall={toolCall} />;
    case 'search':   return <SearchToolBody toolCall={toolCall} />;
    case 'graph':    return <GraphToolBody toolCall={toolCall} />;
    case 'relation': return <RelationToolBody toolCall={toolCall} />;
    case 'canvas':   return <CanvasToolBody toolCall={toolCall} />;
    default:         return <GenericToolBody toolCall={toolCall} />;
  }
}

/** Warning bar shown when a PRE hook flagged or vetoed the call. */
export function ToolRiskBanner({ toolCall }: { toolCall: ToolCallInfo }) {
  if (!toolCall.riskReason) return null;
  return (
    <div className={`tool-risk-banner${toolCall.blocked ? ' blocked' : ''}`} role="note">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16"/>
      </svg>
      <span>{toolCall.riskReason}</span>
    </div>
  );
}

/** Small badge showing how many secrets the POST hook scrubbed. */
export function ToolRedactionBadge({ count }: { count?: number }) {
  if (!count) return null;
  const zh = isZh();
  return (
    <span
      className="tool-redaction-badge"
      title={zh ? `已脱敏 ${count} 处敏感信息` : `${count} secret value(s) redacted before reaching the model`}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
      {count}
    </span>
  );
}
