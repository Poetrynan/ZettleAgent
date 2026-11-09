/**
 * Shared helpers for canvas cards: how a note's Markdown is shown on a card,
 * and the colour language every card type uses.
 *
 * Colours are still stored as hex in .canvas files (Obsidian-compatible), but a
 * card never paints the raw hex as its surface: CSS mixes it into the current
 * theme's card background, so the same file looks right in light and dark.
 */

/** Sticky / card hues. Muted system colours; no purple. */
export const CARD_HUES: { name: string; nameZh: string; value: string }[] = [
  { name: 'Yellow', nameZh: '黄', value: '#E5B800' },
  { name: 'Orange', nameZh: '橙', value: '#F08A24' },
  { name: 'Red', nameZh: '红', value: '#E5484D' },
  { name: 'Green', nameZh: '绿', value: '#30A46C' },
  { name: 'Blue', nameZh: '蓝', value: '#0A84FF' },
  { name: 'Graphite', nameZh: '石墨', value: '#8E8E93' },
];

/** Older pastel sticky colours (and the old default) → the hue they stood for. */
const LEGACY_HUES: Record<string, string> = {
  '#fef9c3': '#E5B800',
  '#fef08a': '#E5B800',
  '#d1fae5': '#30A46C',
  '#dbeafe': '#0A84FF',
  '#ffe4e6': '#E5484D',
  '#ede9fe': '#8E8E93',
  '#ffedd5': '#F08A24',
};

export const DEFAULT_STICKY_HUE = '#E5B800';

/** The hue a card should be tinted with, from whatever its stored colour is. */
export function cardHue(color: unknown, fallback = DEFAULT_STICKY_HUE): string {
  if (typeof color !== 'string' || !color.trim()) return fallback;
  const c = color.trim();
  return LEGACY_HUES[c.toLowerCase()] ?? c;
}

export interface PreparedNote {
  /** Markdown body ready to render (frontmatter and a duplicate title removed). */
  body: string;
  tags: string[];
  type?: string;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function parseList(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  return inner
    .split(',')
    .map(s => s.trim().replace(/^['"#]+|['"]+$/g, ''))
    .filter(Boolean);
}

/** Pull `tags` and `type` out of YAML frontmatter (simple key: value / list forms only). */
function readFrontmatter(yaml: string): { tags: string[]; type?: string } {
  const tags: string[] = [];
  let type: string | undefined;
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'tags' || key === 'tag') {
      if (m[2].trim()) {
        tags.push(...parseList(m[2]));
      } else {
        // block list:  tags:\n  - a\n  - b
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          tags.push(lines[++i].replace(/^\s*-\s+/, '').trim().replace(/^['"#]+|['"]+$/g, ''));
        }
      }
    } else if (key === 'type' && m[2].trim()) {
      type = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { tags: tags.filter(Boolean), type };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `[[target|alias]]` → a link element the card can handle; code spans and fences are left alone. */
export function linkifyWikilinks(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside code
      return part.replace(/(!?)\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (whole, bang, target, heading, alias) => {
        if (bang) return whole; // embeds stay as written
        const t = String(target).trim();
        const label = String(alias ?? (heading ? `${t}${heading}` : t)).trim();
        return `<a class="wikilink" data-target="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
      });
    })
    .join('');
}

/** What a note card shows: no raw frontmatter, no repeated title, clickable links. */
export function prepareNoteMarkdown(text: string, title: string): PreparedNote {
  let body = text ?? '';
  let tags: string[] = [];
  let type: string | undefined;

  const fm = body.match(FRONTMATTER);
  if (fm) {
    ({ tags, type } = readFrontmatter(fm[1]));
    body = body.slice(fm[0].length);
  }

  // The card header already shows the title; drop a first heading that repeats it.
  const lead = body.match(/^\s*#{1,2}\s+(.+?)\s*#*\s*(?:\r?\n|$)/);
  if (lead && lead[1].trim().toLowerCase() === title.trim().toLowerCase()) {
    body = body.slice(lead[0].length);
  }

  return { body: linkifyWikilinks(body.trimStart()), tags, type };
}
