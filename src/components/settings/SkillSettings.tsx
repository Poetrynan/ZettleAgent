import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { IconFolder, IconTool, IconTrash } from '../icons';
import { sectionTitle } from './settingsStyles';
import { t, tf } from '../../lib/i18n';
import type { SkillInfo } from '../../lib/tauri';
import {
  listSkillDirectories, addSkillDirectory, removeSkillDirectory, scanSkills,
} from '../../lib/tauri';

export function SkillDirectoriesSection() {
  const [directories, setDirectories] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadDirs(); }, []);

  const loadDirs = async () => {
    try {
      const dirs = await listSkillDirectories();
      setDirectories(dirs);
    } catch { /* ignore */ }
  };

  const handleAddDir = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t('skill.selectDir') });
      if (selected) {
        await addSkillDirectory(selected as string);
        await loadDirs();
      }
    } catch (e) { setError(String(e)); }
  };

  const handleRemoveDir = async (dir: string) => {
    try {
      await removeSkillDirectory(dir);
      await loadDirs();
      setSkills([]);
    } catch (e) { setError(String(e)); }
  };

  const handleScan = async () => {
    setScanning(true);
    setError('');
    try {
      const result = await scanSkills();
      setSkills(result);
    } catch (e) { setError(String(e)); }
    setScanning(false);
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconTool size={18} /> {t('skill.title')}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-1)' }}>
          {t('skill.desc')}
        </div>

        {/* Directory list */}
        <div style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-2)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          minHeight: '50px',
        }}>
          {directories.length === 0 && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', padding: 'var(--space-3) 0', textAlign: 'center' }}>
              {t('skill.noDirectories')}
            </div>
          )}
          {directories.map(dir => (
            <div key={dir} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
              background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
            }}>
              <IconFolder size={14} />
              <code style={{ flex: 1, fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>{dir}</code>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => handleRemoveDir(dir)}
                style={{ color: 'var(--danger)' }}
                title={t('skill.remove')}
              >
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn btn-sm btn-secondary" onClick={handleAddDir}>
            + {t('skill.addDir')}
          </button>
          {directories.length > 0 && (
            <button className="btn btn-sm btn-primary" onClick={handleScan} disabled={scanning} title={scanning ? t('skill.scanning') : undefined}>
              {scanning ? t('skill.scanning') : t('skill.scanBtn')}
            </button>
          )}
        </div>

        {/* Scan results */}
        {skills.length > 0 && (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
              {tf('skill.found', skills.length)}
            </div>
            <div style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              maxHeight: '240px',
              overflowY: 'auto',
            }}>
              {skills.map(skill => (
                <div key={skill.directory} style={{
                  padding: 'var(--space-2) var(--space-3)',
                  background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <IconTool size={12} />
                    <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{skill.name}</span>
                    <span className="badge badge-primary" style={{ fontSize: '10px' }}>v{skill.version}</span>
                    {skill.has_skill_md && <span style={{ fontSize: '10px', color: 'var(--success, #22c55e)' }}>📄 SKILL.md</span>}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
                    {skill.description}
                  </div>
                  {skill.tools.length > 0 && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
                      {t('skill.tools')}{skill.tools.join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>⚠️ {error}</div>
        )}
      </div>
    </div>
  );
}
