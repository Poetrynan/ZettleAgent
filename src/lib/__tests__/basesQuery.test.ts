import { describe, it, expect } from 'vitest';
import { parseQuery } from '../basesQuery';

describe('basesQuery parseQuery', () => {
  it('should return empty rules and keywords for empty query', () => {
    const { rules, keywords } = parseQuery('');
    expect(rules).toHaveLength(0);
    expect(keywords).toHaveLength(0);
  });

  it('should parse tag shorthand correctly', () => {
    const { rules, keywords } = parseQuery('#ideas #research');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      token: '#ideas',
      field: 'tag',
      operator: 'equals',
      value: 'ideas',
    });
    expect(rules[1]).toEqual({
      token: '#research',
      field: 'tag',
      operator: 'equals',
      value: 'research',
    });
    expect(keywords).toHaveLength(0);
  });

  it('should parse colon filters correctly', () => {
    const { rules, keywords } = parseQuery('type:permanent folder:"My Folder"');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      token: 'type:permanent',
      field: 'noteType',
      operator: 'contains',
      value: 'permanent',
    });
    expect(rules[1]).toEqual({
      token: 'folder:"My Folder"',
      field: 'folder',
      operator: 'contains',
      value: 'My Folder',
    });
    expect(keywords).toHaveLength(0);
  });

  it('should parse relational filters correctly', () => {
    const { rules, keywords } = parseQuery('links>=5 conf<0.8');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      token: 'links>=5',
      field: 'linkCount',
      operator: 'greaterEqual',
      value: '5',
    });
    expect(rules[1]).toEqual({
      token: 'conf<0.8',
      field: 'confidence',
      operator: 'less',
      value: '0.8',
    });
    expect(keywords).toHaveLength(0);
  });

  it('should parse normal keywords alongside rules', () => {
    const { rules, keywords } = parseQuery('biology type:permanent #cell');
    expect(rules).toHaveLength(2);
    expect(keywords).toEqual(['biology']);
    expect(rules[0]).toEqual({
      token: 'type:permanent',
      field: 'noteType',
      operator: 'contains',
      value: 'permanent',
    });
    expect(rules[1]).toEqual({
      token: '#cell',
      field: 'tag',
      operator: 'equals',
      value: 'cell',
    });
  });

  it('should ignore invalid field names and treat them as keywords', () => {
    const { rules, keywords } = parseQuery('unknownField:val');
    expect(rules).toHaveLength(0);
    expect(keywords).toEqual(['unknownfield:val']);
  });
});
