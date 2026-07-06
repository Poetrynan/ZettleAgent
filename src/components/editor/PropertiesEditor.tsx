import { useState, useCallback, useMemo, useEffect, useRef, ReactNode } from 'react';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

// ── YAML frontmatter parsing ────────────────────────────────────

export interface FrontmatterField {
  key: string;
  value: string | string[] | number | boolean | null;
  type: 'text' | 'list' | 'number' | 'boolean' | 'date';
}

export function parseFrontmatter(content: string): {
  fields: FrontmatterField[];
  body: string;
  raw: string;
  hasFrontmatter: boolean;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { fields: [], body: content, raw: '', hasFrontmatter: false };
  }

  const raw = match[1];
  const body = content.slice(match[0].length);
  const fields: FrontmatterField[] = [];

  try {
    const parsed: any = yamlParse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        fields.push(inferFieldType(key, value));
      }
    }
  } catch {
    // YAML parse error — fallback: return empty fields but preserve body
    return { fields: [], body, raw, hasFrontmatter: true };
  }

  return { fields, body, raw, hasFrontmatter: true };
}

function inferFieldType(key: string, value: any): FrontmatterField {
  if (Array.isArray(value)) {
    return {
      key,
      value: value.map(v => (typeof v === 'string' ? v : String(v))),
      type: 'list',
    };
  }
  if (typeof value === 'boolean') {
    return { key, value, type: 'boolean' };
  }
  if (typeof value === 'number') {
    return { key, value, type: 'number' };
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return { key, value, type: 'date' };
    }
    return { key, value, type: 'text' };
  }
  if (value === null || value === undefined) {
    return { key, value: '', type: 'text' };
  }
  // Objects, dates, etc. — stringify
  return { key, value: String(value), type: 'text' };
}

export function serializeFrontmatter(fields: FrontmatterField[], body: string): string {
  if (fields.length === 0) return body;

  const obj: Record<string, any> = {};
  for (const f of fields) {
    obj[f.key] = f.value;
  }

  const yamlStr = yamlStringify(obj, { lineWidth: 0 });
  return `---\n${yamlStr}---\n${body}`;
}

// ── Frontmatter type SVGs ────────────────────────────────────────

const TYPE_ICONS: Record<string, ReactNode> = {
  text: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
  list: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  number: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  ),
  boolean: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  date: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
};

// ── Component ────────────────────────────────────────────────────

interface PropertiesEditorProps {
  content: string;
  onChange: (newContent: string) => void;
  lang: string;
}

export function PropertiesEditor({ content, onChange, lang }: PropertiesEditorProps) {
  const { fields, body, hasFrontmatter } = useMemo(() => parseFrontmatter(content), [content]);
  
  // Collapse state initialized from localStorage
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('zettel:properties-collapsed') === 'true';
  });
  
  const [addMode, setAddMode] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newType, setNewType] = useState<FrontmatterField['type']>('text');
  const newKeyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addMode && newKeyRef.current) {
      newKeyRef.current.focus();
    }
  }, [addMode]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('zettel:properties-collapsed', String(next));
      return next;
    });
  }, []);

  const updateField = useCallback((key: string, newValue: FrontmatterField['value']) => {
    const newFields = fields.map(f =>
      f.key === key ? { ...f, value: newValue } : f
    );
    onChange(serializeFrontmatter(newFields, body));
  }, [fields, body, onChange]);

  const removeField = useCallback((key: string) => {
    const newFields = fields.filter(f => f.key !== key);
    onChange(serializeFrontmatter(newFields, body));
  }, [fields, body, onChange]);

  const addField = useCallback(() => {
    const trimmed = newKey.trim();
    if (!trimmed || fields.some(f => f.key === trimmed)) return;

    const defaultValues: Record<string, FrontmatterField['value']> = {
      text: '',
      list: [],
      number: 0,
      boolean: false,
      date: new Date().toISOString().split('T')[0],
    };

    const newFields: FrontmatterField[] = [...fields, {
      key: trimmed,
      value: defaultValues[newType] ?? '',
      type: newType,
    }];
    onChange(serializeFrontmatter(newFields, body));
    setNewKey('');
    setAddMode(false);
  }, [newKey, newType, fields, body, onChange]);

  // If no frontmatter, show add-frontmatter button
  if (!hasFrontmatter) {
    return (
      <div className="props-editor-empty">
        <button
          className="props-add-frontmatter-btn"
          onClick={() => {
            const defaultFields: FrontmatterField[] = [
              { key: 'type', value: 'permanent', type: 'text' },
              { key: 'tags', value: [], type: 'list' },
              { key: 'date', value: new Date().toISOString().split('T')[0], type: 'date' },
            ];
            onChange(serializeFrontmatter(defaultFields, content));
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {lang === 'zh' ? '添加属性 (Frontmatter)' : 'Add Properties'}
        </button>
      </div>
    );
  }

  return (
    <div className="props-editor">
      {/* Header */}
      <div className="props-editor-header" onClick={toggleCollapsed}>
        <div className="props-editor-header-left">
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          <span className="props-editor-label">
            {lang === 'zh' ? '属性' : 'Properties'}
          </span>
          <span className="props-editor-count">{fields.length}</span>
        </div>
        <button
          className="props-add-btn"
          onClick={(e) => { e.stopPropagation(); setAddMode(!addMode); }}
          title={lang === 'zh' ? '添加属性' : 'Add property'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="props-editor-body">
          {fields.map((field) => (
            <div key={field.key} className="props-field-row">
              {/* Key */}
              <div className="props-field-key">
                <span className="props-field-type-icon" title={field.type}>
                  {TYPE_ICONS[field.type] || TYPE_ICONS.text}
                </span>
                <span className="props-field-key-text">{field.key}</span>
              </div>

              {/* Value */}
              <div className="props-field-value">
                {field.type === 'boolean' ? (
                  <label className="props-toggle">
                    <input
                      type="checkbox"
                      checked={!!field.value}
                      onChange={(e) => updateField(field.key, e.target.checked)}
                    />
                    <span className="props-toggle-slider" />
                  </label>
                ) : field.type === 'list' && Array.isArray(field.value) ? (
                  <TagListEditor
                    tags={field.value}
                    onChange={(tags) => updateField(field.key, tags)}
                    lang={lang}
                  />
                ) : field.type === 'date' ? (
                  <input
                    type="date"
                    className="props-input props-date-input"
                    value={String(field.value ?? '')}
                    onChange={(e) => updateField(field.key, e.target.value)}
                  />
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    className="props-input"
                    value={String(field.value ?? '')}
                    onChange={(e) => updateField(field.key, Number(e.target.value))}
                    style={{ width: '80px' }}
                  />
                ) : (
                  <input
                    type="text"
                    className="props-input"
                    value={String(field.value ?? '')}
                    onChange={(e) => updateField(field.key, e.target.value)}
                  />
                )}
              </div>

              {/* Remove */}
              <button
                className="props-field-remove"
                onClick={() => removeField(field.key)}
                title={lang === 'zh' ? '移除属性' : 'Remove'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}

          {/* Add new field inline */}
          {addMode && (
            <div className="props-add-row">
              <input
                ref={newKeyRef}
                type="text"
                className="props-input"
                placeholder={lang === 'zh' ? '属性名' : 'Property name'}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addField(); if (e.key === 'Escape') setAddMode(false); }}
                style={{ flex: 1 }}
              />
              <select
                className="props-type-select"
                value={newType}
                onChange={(e) => setNewType(e.target.value as FrontmatterField['type'])}
              >
                <option value="text">Text</option>
                <option value="list">List</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
                <option value="date">Date</option>
              </select>
              <button className="props-add-confirm" onClick={addField}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button className="props-add-cancel" onClick={() => setAddMode(false)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TagListEditor (inline tag list with add/remove) ──────────────

function TagListEditor({ tags, onChange, lang }: { tags: string[]; onChange: (t: string[]) => void; lang: string }) {
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = () => {
    const trimmed = inputVal.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInputVal('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter(t => t !== tag));
  };

  return (
    <div className="props-tag-editor">
      {tags.map(tag => (
        <span key={tag} className="props-tag-pill">
          {tag}
          <span className="props-tag-remove" onClick={() => removeTag(tag)}>&times;</span>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        className="props-tag-input"
        placeholder={lang === 'zh' ? '新标签...' : 'Add tag...'}
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); addTag(); }
          if (e.key === 'Backspace' && inputVal === '' && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => { if (inputVal.trim()) addTag(); }}
      />
    </div>
  );
}
