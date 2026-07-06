export interface QueryRule {
  token: string;
  field: 'title' | 'noteType' | 'tag' | 'folder' | 'linkCount' | 'confidence' | 'createdAt' | 'lastSynced';
  operator: 'contains' | 'equals' | 'greater' | 'less' | 'greaterEqual' | 'lessEqual';
  value: string;
}

export function mapField(fieldRaw: string): QueryRule['field'] | null {
  const f = fieldRaw.toLowerCase();
  if (f === 'type' || f === 'notetype') return 'noteType';
  if (f === 'tag' || f === 'tags') return 'tag';
  if (f === 'folder' || f === 'dir') return 'folder';
  if (f === 'links' || f === 'link' || f === 'linkcount') return 'linkCount';
  if (f === 'confidence' || f === 'conf') return 'confidence';
  if (f === 'created' || f === 'createdat') return 'createdAt';
  if (f === 'modified' || f === 'updated' || f === 'lastsynced') return 'lastSynced';
  if (f === 'title' || f === 'name') return 'title';
  return null;
}

export function mapOperator(opRaw: string): QueryRule['operator'] {
  if (opRaw === '>') return 'greater';
  if (opRaw === '<') return 'less';
  if (opRaw === '>=') return 'greaterEqual';
  if (opRaw === '<=') return 'lessEqual';
  return 'equals';
}

export function parseQuery(searchQuery: string): { rules: QueryRule[]; keywords: string[] } {
  const rules: QueryRule[] = [];
  const keywords: string[] = [];
  
  if (!searchQuery.trim()) {
    return { rules, keywords };
  }

  // Regex to match:
  // 1. Relational rules (e.g. links>=5 or conf>"0.8")
  // 2. Colon rules (e.g. type:permanent or folder:"My Folder")
  // 3. Shorthand tags (e.g. #daily)
  // 4. Fallback keywords (e.g. biology or "some phrase")
  const tokenRegex = /([a-zA-Z]+(?:>=|<=|>|<|=)(?:"[^"]*"|'[^']*'|[^\s]+))|([a-zA-Z]+:(?:"[^"]*"|'[^']*'|[^\s]+))|(#[^\s]+)|("[^"]*"|'[^']*'|[^\s]+)/g;
  
  let match;
  const tokens: string[] = [];
  while ((match = tokenRegex.exec(searchQuery)) !== null) {
    const token = match[0].trim();
    if (token) {
      tokens.push(token);
    }
  }

  for (const token of tokens) {
    // 1. Shorthand tag: #daily
    if (token.startsWith('#') && token.length > 1) {
      rules.push({
        token,
        field: 'tag',
        operator: 'equals',
        value: token.slice(1),
      });
      continue;
    }

    // 2. Relational filters: links>=3, conf>80
    const relMatch = token.match(/^([a-zA-Z]+)(>=|<=|>|<|=)(.+)$/);
    if (relMatch) {
      const [, fieldRaw, opRaw, valRaw] = relMatch;
      const field = mapField(fieldRaw);
      const operator = mapOperator(opRaw);
      if (field) {
        rules.push({
          token,
          field,
          operator,
          value: valRaw.replace(/^["']|["']$/g, ''),
        });
        continue;
      }
    }

    // 3. Key-Value colon filters: type:permanent, folder:notes
    const colonMatch = token.match(/^([a-zA-Z]+):(.+)$/);
    if (colonMatch) {
      const [, fieldRaw, valRaw] = colonMatch;
      const field = mapField(fieldRaw);
      if (field) {
        rules.push({
          token,
          field,
          operator: 'contains',
          value: valRaw.replace(/^["']|["']$/g, ''),
        });
        continue;
      }
    }

    // 4. Fallback: regular keyword search
    keywords.push(token.replace(/^["']|["']$/g, '').toLowerCase());
  }

  return { rules, keywords };
}
