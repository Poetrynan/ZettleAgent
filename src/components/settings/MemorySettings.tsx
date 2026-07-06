import { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { open } from '@tauri-apps/plugin-dialog';
import { IconChevronRight, IconBrain, IconFolder, IconSettings, IconDatabase } from '../icons';
import { sectionTitle, labelStyle, codeBlock } from './settingsStyles';
import { t, tf } from '../../lib/i18n';
import {
  getAiMemories, addAiMemory, deleteAiMemory,
  exportAllSessions, getSetting, setSetting, getDataPath,
} from '../../lib/tauri';

export function AiMemorySection() {
  const { showToast } = useApp();
  const [memories, setMemories] = useState<{ id: number; content: string; category: string; createdAt: string }[]>([]);
  const [newMemory, setNewMemory] = useState('');
  const [chatExportPath, setChatExportPath] = useState('');
  const [memoryExportPath, setMemoryExportPath] = useState('');
  const [memoryThreshold, setMemoryThreshold] = useState('3');
  const [dataStoragePath, setDataStoragePath] = useState('');
  const [customDbPathInput, setCustomDbPathInput] = useState('');
  const [isCustomDb, setIsCustomDb] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!expanded) return;
    getAiMemories().then(setMemories).catch(e => console.error('Failed to load memories:', e));
    getSetting('chat_export_path').then(v => v && setChatExportPath(v)).catch(e => console.error('Failed to load chat export path:', e));
    getSetting('memory_export_path').then(v => v && setMemoryExportPath(v)).catch(e => console.error('Failed to load memory export path:', e));
    getSetting('memory_threshold').then(v => v && setMemoryThreshold(v)).catch(e => console.error('Failed to load memory threshold:', e));
    getDataPath().then(setDataStoragePath).catch(e => console.error('Failed to load data path:', e));
    // Load custom DB path
    import('../../lib/tauri').then(({ getCustomDbPath }) => {
      getCustomDbPath().then(v => {
        if (v) {
          setCustomDbPathInput(v);
          setIsCustomDb(true);
        }
      }).catch(e => console.error('Failed to load custom db path:', e));
    });
  }, [expanded]);

  const handleAddMemory = async () => {
    if (!newMemory.trim()) return;
    try {
      await addAiMemory(newMemory.trim());
      setNewMemory('');
      const updated = await getAiMemories();
      setMemories(updated);
      showToast(t('memory.added'), 'success');
    } catch (e: any) {
      setError(e.toString());
      showToast(t('memory.addFail'), 'error');
    }
  };

  const handleDeleteMemory = async (id: number) => {
    try {
      await deleteAiMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
      showToast(t('memory.deleted'), 'success');
    } catch (e) {
      console.error('Failed to delete memory:', e);
      showToast(t('memory.deleteFail'), 'error');
    }
  };

  const handleSelectExportPath = async (settingKey: string, setter: (v: string) => void) => {
    const selected = await open({ directory: true, multiple: false, title: t('memory.selectExportPath') });
    if (selected) {
      setter(selected as string);
      await setSetting(settingKey, selected as string).catch(e => console.error('Failed to save setting:', e));
    }
  };

  const handleExportAll = async () => {
    if (!chatExportPath) {
      showToast(t('memory.exportSetPath'), 'error');
      return;
    }
    try {
      const paths = await exportAllSessions('markdown', chatExportPath);
      showToast(tf('memory.exported', paths.length), 'success');
    } catch (e: any) {
      setError(e.toString());
      showToast(t('memory.exportFail'), 'error');
    }
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
        {t('memory.title')}
      </h2>

      {expanded && (
        <>
          {/* Data storage info + Custom DB Path */}
          <div style={{ background: 'rgba(139, 92, 246, 0.04)', border: '1px solid rgba(139, 92, 246, 0.15)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
            <div style={{ ...labelStyle, fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: '6px' }}><IconDatabase size={14} /> {t('memory.dbPath')}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: '1.5' }}>
              {t('memory.dbPathDesc')}
            </div>
            <code style={{ ...codeBlock, fontSize: '11px', color: 'var(--accent-primary)', wordBreak: 'break-all', marginBottom: '8px', display: 'block' }}>
              {isCustomDb ? customDbPathInput : (dataStoragePath ? `${dataStoragePath}${dataStoragePath.endsWith('\\') || dataStoragePath.endsWith('/') ? '' : '/'}zettelagent.db` : '...')}
            </code>
            {isCustomDb && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-primary)', marginBottom: '8px' }}>
                ✅ {t('memory.customPathActive')}
              </div>
            )}
            
            {/* Custom path input */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: '6px', alignItems: 'center' }}>
              <input
                className="input"
                style={{ flex: 1, fontSize: 'var(--text-xs)', padding: '4px 8px', height: '28px' }}
                value={customDbPathInput}
                onChange={e => setCustomDbPathInput(e.target.value)}
                placeholder={t('memory.customPathPlaceholder')}
              />
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontSize: 'var(--text-xs)', padding: '4px 8px', height: '28px', flexShrink: 0 }}
                onClick={async () => {
                  try {
                    const { open } = await import('@tauri-apps/plugin-dialog');
                    const selected = await open({ directory: true, title: t('memory.browseDbDir') });
                    if (selected) {
                      setCustomDbPathInput(typeof selected === 'string' ? selected : String(selected));
                    }
                  } catch (e) { console.error('Failed to open dialog:', e); }
                }}
              >
                {t('memory.browse')}
              </button>
            </div>
            
            {/* Apply buttons */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary btn-sm"
                style={{ fontSize: 'var(--text-xs)', padding: '4px 10px', height: '28px' }}
                onClick={async () => {
                  if (!customDbPathInput.trim()) return;
                  try {
                    const { setCustomDbPath } = await import('../../lib/tauri');
                    const result = await setCustomDbPath(customDbPathInput.trim(), true);
                    setCustomDbPathInput(result);
                    setIsCustomDb(true);
                    showToast(t('memory.migrateSuccess'), 'success');
                  } catch (e) {
                    showToast(`${t('memory.migrateFail')}: ${e}`, 'error');
                  }
                }}
                disabled={!customDbPathInput.trim()}
              >
                {t('memory.migrateApply')}
              </button>
              {isCustomDb && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 'var(--text-xs)', padding: '4px 10px', height: '28px', color: 'var(--danger)' }}
                  onClick={async () => {
                    try {
                      const { setCustomDbPath } = await import('../../lib/tauri');
                      await setCustomDbPath('', false);
                      setCustomDbPathInput('');
                      setIsCustomDb(false);
                      showToast(t('memory.resetSuccess'), 'success');
                    } catch (e) {
                      showToast(`${t('memory.resetFail')}: ${e}`, 'error');
                    }
                  }}
                >
                  {t('memory.resetDefault')}
                </button>
              )}
            </div>
            
            {/* Recommendation */}
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '8px', lineHeight: '1.6', background: 'rgba(0,0,0,0.02)', padding: '6px 8px', borderRadius: '4px' }}>
              💡 <strong>{t('memory.recommendedPath')}</strong>：{t('memory.recommendedDesc')}<br/>
              • <code>D:\ZettelAgent_Data\</code> — {t('memory.recommendedDrive')}<br/>
              • <code>C:\Users\You\Documents\ZettelAgent\</code> — {t('memory.recommendedDocs')}<br/>
              • {t('memory.recommendedVault')}<br/>
              {t('memory.recommendedNote')}
            </div>
          </div>

          {/* Memory entries */}
          <div>
            <div style={labelStyle}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> {t('memory.entries')} ({memories.length})</div>
            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {memories.length === 0 ? (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: 'var(--space-2)' }}>
                  {t('memory.noMemories')}
                </div>
              ) : memories.map(m => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-1) var(--space-2)', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)' }}>
                  <span style={{ flex: 1, color: 'var(--text-primary)' }}>{m.content}</span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: '10px' }}>{m.category}</span>
                  <button className="btn btn-ghost" onClick={() => handleDeleteMemory(m.id)} style={{ padding: '2px', fontSize: '12px', height: 'auto', minWidth: 0, color: 'var(--danger)' }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
              <input
                value={newMemory}
                onChange={e => setNewMemory(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddMemory()}
                placeholder={t('memory.addPlaceholder')}
                className="input"
                style={{ flex: 1, fontSize: 'var(--text-xs)' }}
              />
              <button className="btn btn-sm btn-primary" onClick={handleAddMemory} disabled={!newMemory.trim()} title={!newMemory.trim() ? t('memory.addEmpty') : undefined}>+</button>
            </div>
          </div>

          {/* Export paths */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--space-3)' }}>
            <div style={labelStyle}><IconFolder size={14} /> {t('memory.chatExportPath')}</div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <code style={{ ...codeBlock, flex: 1, fontSize: 'var(--text-xs)' }}>{chatExportPath || t('memory.exportPathNotSet')}</code>
              <button className="btn btn-sm btn-secondary" onClick={() => handleSelectExportPath('chat_export_path', setChatExportPath)}>
                <IconFolder size={14} />
              </button>
            </div>
          </div>

          <div>
            <div style={labelStyle}><IconFolder size={14} /> {t('memory.memoryExportPath')}</div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <code style={{ ...codeBlock, flex: 1, fontSize: 'var(--text-xs)' }}>{memoryExportPath || t('memory.exportPathNotSet')}</code>
              <button className="btn btn-sm btn-secondary" onClick={() => handleSelectExportPath('memory_export_path', setMemoryExportPath)}>
                <IconFolder size={14} />
              </button>
            </div>
          </div>

          {/* Memory threshold */}
          <div>
            <div style={labelStyle}><IconSettings size={14} /> {t('memory.threshold')}</div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <input
                type="number"
                value={memoryThreshold}
                onChange={e => { setMemoryThreshold(e.target.value); setSetting('memory_threshold', e.target.value).catch(err => console.error('Failed to save threshold:', err)); }}
                className="input"
                style={{ width: '80px', fontSize: 'var(--text-xs)' }}
                min="1"
                max="20"
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{t('memory.thresholdDesc')}</span>
            </div>
          </div>

          {/* Export all button */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--space-3)' }}>
            <button
              className="btn btn-secondary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)' }}
              onClick={handleExportAll}
              disabled={!chatExportPath}
              title={!chatExportPath ? t('memory.exportSetPath') : undefined}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {t('memory.exportAll')}
            </button>
          </div>

          {error && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{error}</div>}
        </>
      )}
    </div>
  );
}
