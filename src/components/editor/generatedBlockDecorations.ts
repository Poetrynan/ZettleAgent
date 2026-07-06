/**
 * ProseMirror decoration plugin for `<!-- @generated -->` / `<!-- /@generated -->`
 * (and `<!-- @user -->` / `<!-- /@user -->`) HTML comment markers.
 *
 * Hides:
 *  1. Marker spans (<!-- @generated --> etc.)
 *  2. Paragraphs that contain ONLY a marker span (empty lines)
 *  3. "**Note Type**: `xxx`" paragraphs inside @generated blocks
 *
 * The markers and badge text are preserved in the document model for backend use.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { $prose } from '@milkdown/kit/utils';
import type { Node as ProseNode } from 'prosemirror-model';

/** Matches the exact marker patterns used by the reconcile backend. */
const MARKER_RE = /^<!--\s*(\/?@(?:generated|user))\s*-->$/;

/** Matches "**Note Type**: `xxx`" (bold + inline code). */
const NOTE_TYPE_RE = /\*\*Note Type\*\*:\s*`([^`]+)`/;

const pluginKey = new PluginKey<DecorationSet>('generated-block-decorations');

function buildDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];

  // ── Phase 1: Hide marker spans and marker-only paragraphs ──
  doc.descendants((node, pos) => {
    if (node.type.name !== 'html') return;
    const value = (node.attrs.value as string).trim();
    if (!MARKER_RE.test(value)) return;

    decorations.push(
      Decoration.inline(pos, pos + 1, { class: 'cm-generated-marker-hidden' }),
    );

    const parent = doc.resolve(pos).parent;
    if (
      parent.type.name === 'paragraph' &&
      parent.childCount === 1 &&
      parent.firstChild?.type.name === 'html'
    ) {
      const parentPos = pos - 1;
      decorations.push(
        Decoration.node(parentPos, parentPos + parent.nodeSize, {
          class: 'cm-generated-marker-hidden',
        }),
      );
    }
  });

  // ── Phase 2: Hide "**Note Type**: `xxx`" paragraphs ──
  let inGeneratedBlock = false;
  doc.forEach((node, pos) => {
    if (node.type.name === 'html') {
      const val = (node.attrs.value as string).trim();
      if (val === '<!-- @generated -->') { inGeneratedBlock = true; return; }
      if (val === '<!-- /@generated -->') { inGeneratedBlock = false; return; }
    }
    if (inGeneratedBlock && node.type.name === 'paragraph' && NOTE_TYPE_RE.test(node.textContent)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'cm-generated-marker-hidden',
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const generatedBlockPlugin = $prose(() => {
  return new Plugin<DecorationSet>({
    key: pluginKey,
    state: {
      init: (_, { doc }) => buildDecorations(doc),
      apply(tr, oldDecorations) {
        if (tr.docChanged) return buildDecorations(tr.doc);
        return oldDecorations.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return pluginKey.getState(state);
      },
    },
  });
});
