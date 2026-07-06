/**
 * GeneralSettingsTab — 通用设置（方法论、每日笔记、数据存储、关于）
 */
import { useState, useEffect } from 'react';
import { t, tf } from '../../lib/i18n';
import { sectionTitle } from './settingsStyles';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { saveDailyNotePath } from '../../lib/storage';
import { clearDataSelective } from '../../lib/tauri';
import { getThemeMode, setThemeMode, type ThemeMode } from '../../lib/theme';
import {
  IconGraph, IconDatabase, IconFolder, IconEdit, IconCheck, IconNote,
  IconClipboard, IconSearch, IconChevronRight, IconSun, IconMoon, IconSliders,
  IconTrash, IconWarning,
} from '../icons';
import { AboutSection } from './AboutSection';

interface GeneralSettingsTabProps {
  isZh: boolean;
  methodology: string;
  setMethodology: (m: string) => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  dataPath: string;
  dbPath: string;
  dailyNotePath: string | null;
  setDailyNotePath: (p: string | null) => void;
}

const METHODOLOGIES = [
  { key: 'zettelkasten', labelEn: 'Zettelkasten', labelZh: 'Zettelkasten', audienceEn: 'Researchers', audienceZh: '学术研究者', descEn: 'Permanent · Literature · Fleeting · Structure', descZh: '永久 · 文献 · 闪念 · 结构', icon: IconDatabase },
  { key: 'para', labelEn: 'PARA', labelZh: 'PARA', audienceEn: 'Knowledge Workers', audienceZh: '职场知识工作者', descEn: 'Projects · Areas · Resources · Archives', descZh: '项目 · 领域 · 资源 · 归档', icon: IconFolder },
  { key: 'code', labelEn: 'CODE', labelZh: 'CODE', audienceEn: 'Content Creators', audienceZh: '内容创作者', descEn: 'Capture → Organize → Distill → Express', descZh: '捕获 → 组织 → 提炼 → 表达', icon: IconEdit },
  { key: 'evergreen', labelEn: 'Evergreen', labelZh: '常青笔记', audienceEn: 'Deep Thinkers', audienceZh: '长期思考者', descEn: 'Seed → Sapling → Evergreen → Compost', descZh: '种子 → 树苗 → 常青 → 堆肥', icon: IconGraph },
  { key: 'gtd', labelEn: 'GTD', labelZh: 'GTD', audienceEn: 'Task-driven', audienceZh: '任务管理驱动型', descEn: 'Inbox → Next Action → Waiting → Someday', descZh: '收件箱 → 行动 → 等待 → 将来', icon: IconCheck },
  { key: 'cornell', labelEn: 'Cornell', labelZh: '康奈尔', audienceEn: 'Students', audienceZh: '学生 / 课堂学习', descEn: 'Cue → Note → Summary → Review', descZh: '线索 → 笔记 → 总结 → 复习', icon: IconNote },
  { key: 'generic', labelEn: 'Generic', labelZh: '通用', audienceEn: 'Everyone', audienceZh: '所有人', descEn: 'Concepts · References · Tasks · Journals', descZh: '概念 · 文献 · 任务 · 日志', icon: IconClipboard },
  { key: 'moc', labelEn: 'MOC / LYT', labelZh: 'MOC / LYT', audienceEn: 'PKM Power Users', audienceZh: 'PKM 重度用户', descEn: 'Note → Map of Content → Hub → Dashboard', descZh: '笔记 → 内容地图 → 枢纽 → 仪表盘', icon: IconSearch },
];

export function GeneralSettingsTab({
  isZh, methodology, setMethodology, showToast, dataPath, dbPath, dailyNotePath, setDailyNotePath,
}: GeneralSettingsTabProps) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [dailyPathSaved, setDailyPathSaved] = useState(false);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());

  useEffect(() => {
    const onThemeChange = () => setThemeModeState(getThemeMode());
    window.addEventListener('zettel:theme-changed', onThemeChange);
    return () => window.removeEventListener('zettel:theme-changed', onThemeChange);
  }, []);

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    setThemeModeState(mode);
  };

  const THEME_OPTIONS: { id: ThemeMode; label: string; icon: typeof IconSun }[] = [
    { id: 'light', label: t('settings.themeLight'), icon: IconSun },
    { id: 'dark', label: t('settings.themeDark'), icon: IconMoon },
    { id: 'system', label: t('settings.themeSystem'), icon: IconSliders },
  ];

  return (
    <div className="settings-tab-content">
      {/* Appearance */}
      <div className="settings-section-card">
        <h2 style={sectionTitle}>
          <IconMoon size={18} /> {t('settings.appearance')}
        </h2>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)', lineHeight: 1.5 }}>
          {t('settings.appearanceDesc')}
        </div>
        <div className="theme-segment-row" role="radiogroup" aria-label={t('settings.appearance')}>
          {THEME_OPTIONS.map(opt => {
            const Icon = opt.icon;
            const active = themeMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`theme-segment-btn ${active ? 'active' : ''}`}
                onClick={() => handleThemeChange(opt.id)}
              >
                <Icon size={16} />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Methodology */}
      <div className="settings-section-card">
        <h2 style={sectionTitle}>
          <IconGraph size={18} /> {t('settings.methodology')}
        </h2>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)', lineHeight: 1.5 }}>
          {t('settings.methodologyDesc')}
        </div>
        <div className="methodology-grid">
          {METHODOLOGIES.map(m => {
            const isActive = methodology === m.key;
            const Icon = m.icon;
            return (
              <button key={m.key} onClick={() => setMethodology(m.key)} className={`methodology-card ${isActive ? 'active' : ''}`}>
                <div className="methodology-header">
                  <span className="methodology-icon"><Icon size={16} /></span>
                  <span className="methodology-title">{isZh ? m.labelZh : m.labelEn}</span>
                </div>
                <span className="methodology-audience-badge">{isZh ? m.audienceZh : m.audienceEn}</span>
                <span className="methodology-desc">{isZh ? m.descZh : m.descEn}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Daily Note Path */}
      <div className="settings-section-card storage-card">
        <h2 style={sectionTitle}>
          <IconNote size={18} /> {t('settings.dailyNoteLoc')}
        </h2>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)', lineHeight: 1.6 }}>
          {t('settings.dailyNoteDesc')}
        </div>
        <div className="storage-path-display">
          <div className="storage-path-icon"><IconFolder size={16} /></div>
          <code className="storage-path-text" title={dailyNotePath || undefined}>{dailyNotePath || t('settings.dailyDefault')}</code>
          {dailyNotePath && (
            <button className="storage-copy-btn" onClick={() => { navigator.clipboard.writeText(dailyNotePath); showToast(isZh ? '已复制路径' : 'Path copied', 'success'); }} title={isZh ? '复制路径' : 'Copy path'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            </button>
          )}
        </div>
        <div className="storage-actions">
          <button className="btn btn-sm btn-secondary" onClick={async () => {
            try {
              const selected = await openDialog({ directory: true, multiple: false, title: t('settings.dailySelectDir') });
              if (selected && typeof selected === 'string') {
                setDailyNotePath(selected);
                await saveDailyNotePath(selected);
                setDailyPathSaved(true);
                showToast(t('settings.dailyPathSaved'), 'success');
                setTimeout(() => setDailyPathSaved(false), 2000);
              }
            } catch (err) { showToast(t('settings.dailySelectFail'), 'error'); }
          }}>
            <IconFolder size={14} /> {t('settings.dailyBrowse')}
          </button>
          {dailyNotePath && (
            <button className="btn btn-sm btn-ghost" onClick={async () => {
              try { setDailyNotePath(null); await saveDailyNotePath(null); setDailyPathSaved(true); showToast(t('settings.dailyReset'), 'success'); setTimeout(() => setDailyPathSaved(false), 2000); }
              catch { showToast(t('settings.dailyResetFail'), 'error'); }
            }}>
              {t('settings.dailyResetBtn')}
            </button>
          )}
        </div>
        {dailyPathSaved && <div className="storage-saved-badge"><IconCheck size={12} /> {t('settings.dailySaved')}</div>}
      </div>

      {/* Data Storage */}
      <div className="settings-section-card storage-card">
        <h2 style={sectionTitle}><IconDatabase size={18} /> {t('settings.dataStorage')}</h2>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-3)', lineHeight: 1.6 }}>{t('settings.dataStorageDesc')}</div>
        <div className="storage-info-grid">
          <div className="storage-info-item">
            <div className="storage-info-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" /></svg>
              {t('settings.dbLabel')}
            </div>
            <div className="storage-path-display">
              <div className="storage-path-icon"><IconDatabase size={16} /></div>
              <code className="storage-path-text" title={dbPath || undefined}>{dbPath || '...'}</code>
              {dbPath && <button className="storage-copy-btn" onClick={() => { navigator.clipboard.writeText(dbPath); showToast(isZh ? '已复制路径' : 'Path copied', 'success'); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>}
            </div>
          </div>
          <div className="storage-info-item">
            <div className="storage-info-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
              {t('settings.dataDir')}
            </div>
            <div className="storage-path-display">
              <div className="storage-path-icon"><IconFolder size={16} /></div>
              <code className="storage-path-text" title={dataPath || undefined}>{dataPath || '...'}</code>
              {dataPath && <button className="storage-copy-btn" onClick={() => { navigator.clipboard.writeText(dataPath); showToast(isZh ? '已复制路径' : 'Path copied', 'success'); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>}
            </div>
          </div>
        </div>
        <div className="storage-danger-zone">
          <button
            type="button"
            className="storage-clear-row"
            onClick={() => setShowClearConfirm(true)}
            aria-haspopup="dialog"
          >
            <span className="storage-clear-row-icon" aria-hidden>
              <IconTrash size={18} />
            </span>
            <span className="storage-clear-row-body">
              <span className="storage-clear-row-title">{t('settings.clearData')}</span>
              <span className="storage-clear-row-desc">{t('settings.clearDataDesc')}</span>
            </span>
            <span className="storage-clear-row-chevron" aria-hidden>
              <IconChevronRight size={16} />
            </span>
          </button>
          <p className="storage-clear-hint">{t('settings.clearDataHint')}</p>
        </div>
      </div>

      {/* About */}
      <div className="settings-section-card about-card">
        <h2 style={{ ...sectionTitle, cursor: 'pointer', userSelect: 'none' }} onClick={() => setAboutOpen(!aboutOpen)}>
          <span style={{ display: 'inline-block', transform: aboutOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}><IconChevronRight size={18} /></span>
          {t('settings.about')}
        </h2>
        {aboutOpen && (
          <div className="about-section-wrap">
            <AboutSection isZh={isZh} showToast={showToast} />
          </div>
        )}
      </div>

      {/* Clear Data Dialog */}
      {showClearConfirm && (
        <ClearDataDialog onClose={() => setShowClearConfirm(false)} showToast={showToast} />
      )}
    </div>
  );
}

// ── Clear Data Dialog ──
const CLEAR_DATA_CATEGORIES = [
  { key: 'chat_history', labelKey: 'settings.clearDataCat.chatHistory', descKey: 'settings.clearDataCat.chatHistoryDesc' },
  { key: 'ai_memory', labelKey: 'settings.clearDataCat.aiMemory', descKey: 'settings.clearDataCat.aiMemoryDesc' },
  { key: 'connections', labelKey: 'settings.clearDataCat.connections', descKey: 'settings.clearDataCat.connectionsDesc' },
  { key: 'semantic_edges', labelKey: 'settings.clearDataCat.semanticEdges', descKey: 'settings.clearDataCat.semanticEdgesDesc' },
  { key: 'card_meta', labelKey: 'settings.clearDataCat.cardMeta', descKey: 'settings.clearDataCat.cardMetaDesc' },
  { key: 'embeddings', labelKey: 'settings.clearDataCat.embeddings', descKey: 'settings.clearDataCat.embeddingsDesc' },
  { key: 'db_cache', labelKey: 'settings.clearDataCat.dbCache', descKey: 'settings.clearDataCat.dbCacheDesc' },
  { key: 'snapshots', labelKey: 'settings.clearDataCat.snapshots', descKey: 'settings.clearDataCat.snapshotsDesc' },
  { key: 'canvas_drawings', labelKey: 'settings.clearDataCat.canvasDrawings', descKey: 'settings.clearDataCat.canvasDrawingsDesc' },
  { key: 'settings', labelKey: 'settings.clearDataCat.settings', descKey: 'settings.clearDataCat.settingsDesc' },
] as const;

function ClearDataDialog({ onClose, showToast }: { onClose: () => void; showToast: (msg: string, type?: 'success' | 'error' | 'info') => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);

  const toggle = (k: string) => setSelected(prev => {
    const n = new Set(prev);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });

  const allSelected = selected.size === CLEAR_DATA_CATEGORIES.length;

  const selectAll = () => {
    setSelected(allSelected ? new Set() : new Set(CLEAR_DATA_CATEGORIES.map(c => c.key)));
  };

  const handleClear = async () => {
    if (selected.size === 0 || clearing) return;
    setClearing(true);
    try {
      const cats = Array.from(selected);
      await clearDataSelective(cats);

      // Clear IndexedDB snapshot database
      if (cats.includes('snapshots')) {
        try {
          const dbReq = indexedDB.deleteDatabase('zettelagent-snapshots');
          await new Promise<void>((resolve) => {
            dbReq.onsuccess = () => resolve();
            dbReq.onerror = () => resolve();
            dbReq.onblocked = () => resolve();
          });
        } catch { /* ignore */ }
      }

      // Clear canvas freehand drawing data from localStorage
      if (cats.includes('canvas_drawings')) {
        try {
          const keysToRemove = Object.keys(localStorage).filter(k => k.startsWith('zettel-freehand-'));
          keysToRemove.forEach(k => localStorage.removeItem(k));
        } catch { /* ignore */ }
      }

      // Clear app settings from localStorage
      if (cats.includes('settings')) {
        try {
          const settingsKeys = Object.keys(localStorage).filter(k =>
            k.startsWith('zettelagent-') || k.startsWith('zettel-')
          );
          settingsKeys.forEach(k => localStorage.removeItem(k));
        } catch { /* ignore */ }
      }

      onClose();
      showToast(t('settings.clearDataSuccess'), 'success');
    } catch {
      showToast(t('settings.clearDataFail'), 'error');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="modal-overlay clear-data-overlay" onClick={onClose} role="presentation">
      <div
        className="modal-container clear-data-dialog"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-data-title"
      >
        <div className="modal-header">
          <h3 id="clear-data-title" className="modal-title">{t('settings.clearDataTitle')}</h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label={t('settings.clearDataCancel')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        <div className="modal-content clear-data-content">
          <div className="clear-data-warning">
            <IconWarning size={16} aria-hidden />
            <span>{t('settings.clearDataWarning')}</span>
          </div>

          <div className="clear-data-toolbar">
            <span className="clear-data-toolbar-label">{t('settings.clearDataChoose')}</span>
            <button type="button" className="clear-data-select-all" onClick={selectAll}>
              {allSelected ? t('settings.clearDataDeselectAll') : t('settings.clearDataSelectAll')}
            </button>
          </div>

          <div className="clear-data-list" role="group" aria-label={t('settings.clearDataChoose')}>
            {CLEAR_DATA_CATEGORIES.map(c => {
              const checked = selected.has(c.key);
              return (
                <label
                  key={c.key}
                  className={`clear-data-item${checked ? ' selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="clear-data-checkbox"
                    checked={checked}
                    onChange={() => toggle(c.key)}
                  />
                  <span className="clear-data-item-text">
                    <span className="clear-data-item-label">{t(c.labelKey)}</span>
                    <span className="clear-data-item-desc">{t(c.descKey)}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="clear-data-footer">
            <button type="button" className="btn btn-secondary clear-data-cancel" onClick={onClose} disabled={clearing}>
              {t('settings.clearDataCancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger clear-data-confirm"
              disabled={selected.size === 0 || clearing}
              onClick={() => void handleClear()}
            >
              {clearing
                ? t('settings.clearDataClearing')
                : selected.size > 0
                  ? tf('settings.clearDataConfirmCount', selected.size)
                  : t('settings.clearDataConfirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
