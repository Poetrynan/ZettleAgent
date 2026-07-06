/**
 * Milkdown Wikilink Plugin
 * 
 * Adds support for [[wikilink]] syntax in the Milkdown editor.
 * - Remark plugin: parses [[...]] in markdown AST
 * - ProseMirror node: renders wikilinks as clickable inline elements
 * - Serializer: converts back to [[...]] markdown
 */
import type { MilkdownPlugin } from '@milkdown/ctx';
import { $node } from '@milkdown/kit/utils';
import { $remark } from '@milkdown/kit/utils';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

// ── Remark Plugin: parse [[wikilink]] syntax ─────────────────────

/** Remark plugin that transforms [[text]] in text nodes into wikilink AST nodes */
function remarkWikiLinkPlugin() {
  return (tree: Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      
      const value = node.value as string;
      const regex = /\[\[([^\]]+)\]\]/g;
      let match;
      const children: Array<{ type: string; value?: string; data?: { title: string } }> = [];
      let lastIndex = 0;
      
      while ((match = regex.exec(value)) !== null) {
        // Add text before the match
        if (match.index > lastIndex) {
          children.push({ type: 'text', value: value.slice(lastIndex, match.index) });
        }
        // Add wikilink node
        children.push({
          type: 'wikilink',
          value: match[1],
          data: { title: match[1] },
        });
        lastIndex = match.index + match[0].length;
      }
      
      // No wikilinks found
      if (children.length === 0) return;
      
      // Add remaining text
      if (lastIndex < value.length) {
        children.push({ type: 'text', value: value.slice(lastIndex) });
      }
      
      // Replace the text node with our parsed children
      parent.children.splice(index, 1, ...children as any);
    });
  };
}

/** Milkdown wrapper for the remark wikilink plugin */
export const remarkWikiLink = $remark('remarkWikiLink', () => remarkWikiLinkPlugin);

/** Wikilink inline node definition */
export const wikilinkNode = $node('wikilink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    title: { default: '' },
  },
  parseDOM: [{
    tag: 'span.milkdown-wikilink',
    getAttrs: (dom: HTMLElement) => ({
      title: dom.getAttribute('data-title') || dom.textContent || '',
    }),
  }],
  toDOM: (node) => {
    return ['span', {
      class: 'milkdown-wikilink',
      'data-title': node.attrs.title,
    }, node.attrs.title];
  },
  parseMarkdown: {
    match: (mdNode) => mdNode.type === 'wikilink',
    runner: (state, mdNode, proseType) => {
      const title = (mdNode.value as string) || ((mdNode.data as Record<string, unknown>)?.title as string) || '';
      state.addNode(proseType, { title });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikilink',
    runner: (state, node) => {
      state.addNode('text', undefined, `[[${node.attrs.title}]]`);
    },
  },
}));

/** Get all wikilink plugins as an array for Milkdown editor.use() */
export function getWikilinkPlugins(): MilkdownPlugin[] {
  return [
    remarkWikiLink[0], // options ctx
    remarkWikiLink[1], // plugin
    wikilinkNode,
  ];
}
