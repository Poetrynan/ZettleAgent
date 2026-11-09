import { describe, expect, it } from 'vitest';
import { cardHue, linkifyWikilinks, prepareNoteMarkdown } from '../cardContent';

describe('prepareNoteMarkdown', () => {
  it('turns frontmatter into tags and type instead of showing it as text', () => {
    const p = prepareNoteMarkdown('---\ntags: [method, pkm]\ntype: permanent\n---\nBody text', 'Note');
    expect(p.tags).toEqual(['method', 'pkm']);
    expect(p.type).toBe('permanent');
    expect(p.body).toBe('Body text');
  });

  it('reads block-list tags', () => {
    const p = prepareNoteMarkdown('---\ntags:\n  - a\n  - "#b"\n---\nx', 'Note');
    expect(p.tags).toEqual(['a', 'b']);
  });

  it('drops a first heading that repeats the card title, keeps other headings', () => {
    expect(prepareNoteMarkdown('# 知识图谱\n\n正文', '知识图谱').body).toBe('正文');
    expect(prepareNoteMarkdown('# Another\n\nbody', 'Note').body).toBe('# Another\n\nbody');
  });

  it('leaves notes without frontmatter alone', () => {
    const p = prepareNoteMarkdown('Just text', 'Note');
    expect(p).toEqual({ body: 'Just text', tags: [], type: undefined });
  });
});

describe('linkifyWikilinks', () => {
  it('turns [[target|alias]] into a link the card can handle', () => {
    expect(linkifyWikilinks('see [[Zettelkasten 方法]] and [[A|the a]]')).toBe(
      'see <a class="wikilink" data-target="Zettelkasten 方法">Zettelkasten 方法</a> and <a class="wikilink" data-target="A">the a</a>',
    );
  });

  it('keeps headings in the label but links to the note', () => {
    expect(linkifyWikilinks('[[Note#Part]]')).toBe('<a class="wikilink" data-target="Note">Note#Part</a>');
  });

  it('does not touch code or embeds, and escapes HTML', () => {
    expect(linkifyWikilinks('`[[x]]` and ![[img.png]]')).toBe('`[[x]]` and ![[img.png]]');
    expect(linkifyWikilinks('```\n[[x]]\n```')).toBe('```\n[[x]]\n```');
    expect(linkifyWikilinks('[[<b>]]')).toBe('<a class="wikilink" data-target="&lt;b&gt;">&lt;b&gt;</a>');
  });
});

describe('cardHue', () => {
  it('maps the old pastel sticky colours to their hue, passes others through', () => {
    expect(cardHue('#fef08a')).toBe('#E5B800');
    expect(cardHue('#FFE4E6')).toBe('#E5484D');
    expect(cardHue('#123456')).toBe('#123456');
    expect(cardHue(undefined)).toBe('#E5B800');
  });
});
