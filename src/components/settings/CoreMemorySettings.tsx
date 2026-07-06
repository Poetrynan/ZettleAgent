import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { IconChevronRight, IconBrain } from '../icons';
import { sectionTitle, labelStyle, codeBlock } from './settingsStyles';
import { t, tf } from '../../lib/i18n';
import { readMemoryFile, writeMemoryFile } from '../../lib/tauri';

interface StructuredMemory {
  version: number;
  lastUpdated: string | null;
  sections: Array<{ name: string; items: string[] }>;
}

const MEMORY_SECTIONS = [
  'User Preferences',
  'Workflow Habits',
  'Important Decisions',
  'Vault Context',
  'Research Topics'
];

const SECTION_KEYS = {
  'User Preferences': 'preferences',
  'Workflow Habits': 'habits',
  'Important Decisions': 'decisions',
  'Vault Context': 'vault',
  'Research Topics': 'research'
};

export function CoreMemorySection() {
  const { showToast, state } = useApp();
  const [expanded, setExpanded] = useState(true);
  const [memory, setMemory] = useState<StructuredMemory | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [newItem, setNewItem] = useState('');

  const parseMemoryContent = (content: string): StructuredMemory => {
    if (!content.trim()) {
      return {
        version: 2,
        lastUpdated: null,
        sections: MEMORY_SECTIONS.map(name => ({ name, items: [] }))
      };
    }

    const lines = content.split('\n');
    let currentSection: string | null = null;
    const sections: StructuredMemory['sections'] = [];
    let version = 2;
    let lastUpdated: string | null = null;

    // Parse frontmatter
    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '---') {
        inFrontmatter = !inFrontmatter;
        continue;
      }
      if (inFrontmatter) {
        if (line.startsWith('version:')) {
          version = parseInt(line.split(':')[1].trim()) || 2;
        } else if (line.startsWith('last_updated:')) {
          lastUpdated = line.split(':')[1].trim();
        }
      } else if (line.startsWith('## ')) {
        currentSection = line.slice(3).trim();
        if (!sections.find(s => s.name === currentSection)) {
          sections.push({ name: currentSection, items: [] });
        }
      } else if (line.startsWith('- ') && currentSection) {
        const section = sections.find(s => s.name === currentSection);
        if (section) {
          section.items.push(line.slice(2).trim());
        }
      }
    }

    // Add any missing default sections
    MEMORY_SECTIONS.forEach(sectionName => {
      if (!sections.find(s => s.name === sectionName)) {
        sections.push({ name: sectionName, items: [] });
      }
    });

    return { version, lastUpdated, sections };
  };

  const serializeMemory = (mem: StructuredMemory): string => {
    let result = '---\n';
    result += `version: ${mem.version}\n`;
    if (mem.lastUpdated) {
      result += `last_updated: ${mem.lastUpdated}\n`;
    }
    result += '---\n\n';

    mem.sections.forEach(section => {
      if (section.items.length > 0) {
        result += `## ${section.name}\n`;
        section.items.forEach(item => {
          result += `- ${item}\n`;
        });
        result += '\n';
      }
    });

    return result;
  };

  const loadMemory = async () => {
    if (!state.vaultPath) return;
    setLoading(true);
    try {
      const content = await readMemoryFile(state.vaultPath);
      setMemory(parseMemoryContent(content));
    } catch (e) {
      console.error('Failed to load core memory:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && state.vaultPath) {
      loadMemory();
    }
  }, [expanded, state.vaultPath]);

  const handleAddItem = async (sectionName: string) => {
    if (!newItem.trim() || !memory) return;

    const updatedMemory: StructuredMemory = {
      ...memory,
      lastUpdated: new Date().toISOString(),
      sections: memory.sections.map(s => {
        if (s.name === sectionName) {
          return { ...s, items: [...s.items, newItem.trim()] };
        }
        return s;
      })
    };

    try {
      await writeMemoryFile(state.vaultPath!, serializeMemory(updatedMemory));
      setMemory(updatedMemory);
      setNewItem('');
      setEditingSection(null);
      showToast(t('coreMemory.saved'), 'success');
    } catch (e) {
      console.error('Failed to save memory:', e);
    }
  };

  const handleDeleteItem = async (sectionName: string, index: number) => {
    if (!memory) return;

    const updatedMemory: StructuredMemory = {
      ...memory,
      lastUpdated: new Date().toISOString(),
      sections: memory.sections.map(s => {
        if (s.name === sectionName) {
          return { ...s, items: s.items.filter((_, i) => i !== index) };
        }
        return s;
      })
    };

    try {
      await writeMemoryFile(state.vaultPath!, serializeMemory(updatedMemory));
      setMemory(updatedMemory);
    } catch (e) {
      console.error('Failed to save memory:', e);
    }
  };

  const getSectionLabel = (sectionName: string): string => {
    const key = SECTION_KEYS[sectionName as keyof typeof SECTION_KEYS];
    if (key) {
      return t(`coreMemory.section_${key}` as any);
    }
    return sectionName;
  };

  return (
    <div className="settings-section-card">
      <h2
        style={{ ...sectionTitle, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          <IconChevronRight size={18} />
        </span>
        <IconBrain size={18} />
        {t('coreMemory.title')}
      </h2>

      {expanded && (
        <div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-4)' }}>
            {t('coreMemory.desc')}
          </p>

          {memory?.lastUpdated && (
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginBottom: 'var(--space-4)' }}>
              {tf('coreMemory.lastUpdated', memory.lastUpdated)}
            </p>
          )}

          {loading ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>加载中...</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {memory?.sections.map(section => (
                <div key={section.name} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
                  <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--space-2)', color: 'var(--text-primary)' }}>
                    {getSectionLabel(section.name)}
                  </h4>

                  {section.items.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{t('coreMemory.noItems')}</p>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                      {section.items.map((item, index) => (
                        <li key={index} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                          <span>• {item}</span>
                          <button
                            onClick={() => handleDeleteItem(section.name, index)}
                            style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--danger)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                          >
                            {t('coreMemory.delete')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {editingSection === section.name ? (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      <input
                        type="text"
                        value={newItem}
                        onChange={(e) => setNewItem(e.target.value)}
                        placeholder={t('coreMemory.addPlaceholder')}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)' }}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddItem(section.name)}
                        autoFocus
                      />
                      <button
                        onClick={() => handleAddItem(section.name)}
                        className="btn btn-primary btn-sm"
                        disabled={!newItem.trim()}
                      >
                        {t('coreMemory.save')}
                      </button>
                      <button
                        onClick={() => { setEditingSection(null); setNewItem(''); }}
                        className="btn btn-ghost btn-sm"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setEditingSection(section.name)}
                      className="btn btn-secondary btn-sm"
                      style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)' }}
                    >
                      + {t('coreMemory.addItem')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
