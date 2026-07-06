import { describe, it, expect } from 'vitest';

// Duplicate helper functions under test to isolate tests
function getPdfAnnotations(content: string) {
  const match = content.match(/<!-- @pdf-annotations\r?\n([\s\S]*?)\r?\n-->/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return [];
  }
}

function setPdfAnnotations(content: string, annotations: any[]): string {
  let cleanContent = content.replace(/\r?\n?<!-- @pdf-annotations\r?\n[\s\S]*?\r?\n-->/g, '');
  if (annotations.length === 0) return cleanContent;
  const jsonStr = JSON.stringify(annotations, null, 2);
  return `${cleanContent.trim()}\n\n<!-- @pdf-annotations\n${jsonStr}\n-->\n`;
}

describe('PDF Annotations serialization and parsing', () => {
  const mockAnnotations = [
    {
      id: 'anno_1',
      page: 3,
      text: 'Functions should do one thing. They should do it well.',
      comment: '函数的单一职责原则',
      color: 'yellow',
      rects: [{ left: 10, top: 20, width: 100, height: 30 }],
      created_at: '2026-06-26T12:00:00.000Z'
    }
  ];

  it('should parse empty annotations array when comment block is missing', () => {
    const markdown = '# My Note\n\nSome body text here.';
    const annos = getPdfAnnotations(markdown);
    expect(annos).toEqual([]);
  });

  it('should parse empty annotations when comment block contains invalid JSON', () => {
    const markdown = '# My Note\n\n<!-- @pdf-annotations\n{invalid json}\n-->';
    const annos = getPdfAnnotations(markdown);
    expect(annos).toEqual([]);
  });

  it('should serialize and then parse annotations correctly', () => {
    const originalMarkdown = '# My Note\n\nSome body text.';
    const serialized = setPdfAnnotations(originalMarkdown, mockAnnotations);

    // Should append HTML comment block
    expect(serialized).toContain('<!-- @pdf-annotations');
    expect(serialized).toContain('函数的单一职责原则');

    const parsed = getPdfAnnotations(serialized);
    expect(parsed).toEqual(mockAnnotations);
  });

  it('should overwrite and replace existing annotations block when updated', () => {
    const firstSave = setPdfAnnotations('# Note', mockAnnotations);
    
    const updatedAnnotations = [
      ...mockAnnotations,
      {
        id: 'anno_2',
        page: 5,
        text: 'Clean code looks like written by someone who cares.',
        comment: '整洁代码',
        color: 'green',
        rects: [],
        created_at: '2026-06-26T12:05:00.000Z'
      }
    ];

    const secondSave = setPdfAnnotations(firstSave, updatedAnnotations);
    
    // Check it only contains ONE comment block, not duplicated
    const matches = secondSave.match(/<!-- @pdf-annotations/g);
    expect(matches?.length).toBe(1);

    const parsed = getPdfAnnotations(secondSave);
    expect(parsed.length).toBe(2);
    expect(parsed[1].comment).toBe('整洁代码');
  });

  it('should completely strip annotation block when empty array is passed', () => {
    const serialized = setPdfAnnotations('# Note', mockAnnotations);
    const cleared = setPdfAnnotations(serialized, []);
    
    expect(cleared).not.toContain('<!-- @pdf-annotations');
    expect(cleared.trim()).toBe('# Note');
  });
});
