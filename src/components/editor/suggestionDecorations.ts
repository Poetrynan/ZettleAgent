/**
 * suggestionDecorations — ProseMirror Decoration API integration for
 * anchoring EditorSuggestion wave underlines and badge widgets to the
 * actual text ranges in the editor document.
 *
 * This replaces the old detached React floating-card approach with
 * ProseMirror inline decorations (wavy underline) + widget decorations
 * (clickable ⚠ badge) that move with the text as the user edits.
 *
 * Architecture:
 * - A ProseMirror plugin (via Milkdown $prose) holds a DecorationSet in
 *   its state, updated via transaction metadata.
 * - `updateSuggestionDecorations()` maps EditorSuggestion[] (which carry
 *   markdown-string offsets) to ProseMirror doc positions by searching
 *   for the suggestion's `triggerText` inside the doc's text nodes.
 * - Each suggestion produces an inline wave decoration + a widget badge
 *   at the end of the range. The badge dispatches a DOM CustomEvent on
 *   click, which the React layer listens to.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorSuggestion } from './useEditorSuggestions';

export const suggestionPluginKey = new PluginKey<DecorationSet>('suggestion-decorations');

/**
 * Find a ProseMirror doc range (from/to) that corresponds to the given
 * text string. Uses substring matching on the concatenated text of all
 * text nodes, with a char→position lookup table.
 *
 * Handles wikilink discrepancy: markdown `[[Title]]` renders as plain
 * `Title` in the ProseMirror doc, so `[[` and `]]` are stripped before
 * searching.
 */
function findDocRangeForText(doc: PmNode, text: string): { from: number; to: number } | null {
  const trimmed = text.trim();
  if (trimmed.length < 10) return null;

  // Collect text nodes with their positions
  const segments: { text: string; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segments.push({ text: node.text, pos });
    }
    return true;
  });

  if (segments.length === 0) return null;

  // Build full concatenated text and char→doc-position map
  let fullText = '';
  const charToPos: number[] = [];
  for (const seg of segments) {
    for (let i = 0; i < seg.text.length; i++) {
      charToPos.push(seg.pos + i);
    }
    fullText += seg.text;
  }

  if (charToPos.length === 0) return null;

  // Candidate needles: try original, then with [[ ]] stripped (wikilinks)
  const candidates = [
    trimmed.slice(0, 50),
    trimmed.slice(0, 30),
    trimmed.replace(/\[\[|\]\]/g, '').slice(0, 50),
    trimmed.replace(/\[\[|\]\]/g, '').slice(0, 30),
  ].filter(s => s.length >= 8);

  let fromIdx = -1;
  let usedNeedle = '';

  for (const needle of candidates) {
    fromIdx = fullText.indexOf(needle);
    if (fromIdx >= 0) {
      usedNeedle = needle;
      break;
    }
  }

  if (fromIdx < 0) return null;

  // Determine the end: try to find the suffix
  const suffixCandidates = [
    trimmed.slice(-30),
    trimmed.replace(/\[\[|\]\]/g, '').slice(-30),
  ].filter(s => s.length >= 8);

  let endIdx = fromIdx + usedNeedle.length;

  for (const suffix of suffixCandidates) {
    const suffixIdx = fullText.indexOf(suffix, fromIdx + usedNeedle.length);
    if (suffixIdx >= 0) {
      endIdx = suffixIdx + suffix.length;
      break;
    }
  }

  // Clamp to valid range
  const from = charToPos[fromIdx] ?? 0;
  const toIdx = Math.min(endIdx, fullText.length - 1);
  const to = (charToPos[toIdx] ?? charToPos[charToPos.length - 1]) + 1;

  if (to <= from) return null;
  return { from, to };
}

/**
 * Create a badge DOM element for a suggestion widget decoration.
 * Clicking it dispatches a CustomEvent that the React layer listens to.
 */
function createBadgeElement(type: string, suggestionId: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `suggestion-wave-badge suggestion-wave-badge-${type}`;
  badge.setAttribute('contenteditable', 'false');
  badge.setAttribute('data-suggestion-id', suggestionId);
  badge.textContent = '!';
  badge.title = 'Click to view suggestion';

  badge.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('suggestion-badge-click', {
      detail: { suggestionId },
    }));
  });

  return badge;
}

/**
 * Build a DecorationSet from the given suggestions by mapping each
 * suggestion's triggerText to a doc range. Also returns the ranges map
 * for use by the React layer (positioning cards, applying fixes).
 */
export function updateSuggestionDecorations(
  view: EditorView,
  suggestions: EditorSuggestion[],
): Map<string, { from: number; to: number }> {
  const ranges = new Map<string, { from: number; to: number }>();
  const decorations: Decoration[] = [];

  for (const sug of suggestions) {
    const range = findDocRangeForText(view.state.doc, sug.triggerText);
    if (!range) continue;

    ranges.set(sug.id, range);

    // Inline wave underline decoration
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: `suggestion-wave suggestion-wave-${sug.type}`,
        'data-suggestion-id': sug.id,
      }),
    );

    // Widget badge at the end of the range
    decorations.push(
      Decoration.widget(
        range.to,
        () => createBadgeElement(sug.type, sug.id),
        { side: 1, key: `badge-${sug.id}` },
      ),
    );
  }

  const decoSet = DecorationSet.create(view.state.doc, decorations);

  // Dispatch a metadata-only transaction to update the plugin state
  const tr = view.state.tr.setMeta(suggestionPluginKey, decoSet);
  view.dispatch(tr);

  return ranges;
}

/** Clear all suggestion decorations. */
export function clearSuggestionDecorations(view: EditorView): void {
  const tr = view.state.tr.setMeta(suggestionPluginKey, DecorationSet.empty);
  view.dispatch(tr);
}

/**
 * The Milkdown ProseMirror plugin that manages the suggestion decoration
 * state. Registered via `crepe.editor.use(suggestionPlugin)`.
 */
export const suggestionPlugin = $prose(() => {
  return new Plugin<DecorationSet>({
    key: suggestionPluginKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldState) {
        const meta = tr.getMeta(suggestionPluginKey);
        if (meta !== undefined) return meta;
        // Map decorations through document changes so they stay anchored
        if (tr.docChanged) return oldState.map(tr.mapping, tr.doc);
        return oldState;
      },
    },
    props: {
      decorations(state) {
        return suggestionPluginKey.getState(state);
      },
    },
  });
});
