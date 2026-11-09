import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';

import { invoke } from '@tauri-apps/api/core';
import { t, tf } from '../../lib/i18n';
import { getProvider } from '../../lib/llm-providers';
import { clearData, clearDataSelective, chatWithLlm } from '../../lib/tauri';
import {
  IconSettings, IconGlobe,
  IconTrash, IconSliders, IconKeyboard, IconBrain, IconDatabase,
  IconNote, IconSearch, IconFile, IconSync, IconPlug, IconFolder, IconKey,
} from '../icons';
import { loadDailyNotePath, loadNewFolderDefaultPath } from '../../lib/storage';

import { sectionTitle } from './settingsStyles';
import { McpServersSection } from './McpSettings';
import { McpServerExposeSection } from './McpServerExposeSection';
import { RerankSettingsSection } from './RerankSettings';
import { ReviewSettingsSection } from './ReviewSettings';
import { SkillDirectoriesSection } from './SkillSettings';
import { GeneralSettingsTab } from './GeneralSettingsTab';
import { AiSettingsTab } from './AiSettingsTab';
import { AiMemorySection } from './MemorySettings';
import { CoreMemorySection } from './CoreMemorySettings';
import { EmbeddingConfigSection } from './EmbeddingSettings';
import { SecuritySettingsSection } from './SecuritySettings';

import { open as openFolder } from '@tauri-apps/plugin-dialog';
import { ConfirmModal } from '../dashboard/ConfirmModal';
import { SETTINGS_CATEGORIES, searchSettings, type SettingsPage } from './settingsCatalog';
import { SettingsDrafts, useSettingsDraft } from './SettingsDrafts';
import type { View } from '../../contexts/BaseContext';
import '../../styles/settings-workbench.css';

export function Settings() {
  const { state, setLlmConfig, setMethodology, showToast, setView, addVaultPath, removeVaultPath, setPrimaryVaultPath } = useApp();
  const { llmConfig } = state;
  const isZh = state.lang === 'zh';
  const copy = (zh: string, en: string) => isZh ? zh : en;
  const [active, setActive] = useState<SettingsPage>('general');
  const [visited, setVisited] = useState<Set<SettingsPage>>(() => new Set(['general']));
  const [query, setQuery] = useState('');
  const [localProvider, setLocalProvider] = useState(llmConfig.providerId);
  const [localApiUrl, setLocalApiUrl] = useState(llmConfig.apiUrl);
  const [localApiKey, setLocalApiKey] = useState('');
  const [keyAction, setKeyAction] = useState<'preserve' | 'replace' | 'clear'>('preserve');
  const [localModel, setLocalModel] = useState(llmConfig.model);
  const [localSupportsThinking, setLocalSupportsThinking] = useState(!!llmConfig.supportsThinking);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [dataPath, setDataPath] = useState('');
  const [dbPath, setDbPath] = useState('');
  const [dailyNotePath, setDailyNotePath] = useState<string | null>(null);
  const [newFolderDefaultPath, setNewFolderDefaultPath] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [leaving, setLeaving] = useState<View | null>(null);
  const allowLeave = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const hasChanges = localProvider !== llmConfig.providerId || localApiUrl !== llmConfig.apiUrl || localModel !== llmConfig.model || localSupportsThinking !== !!llmConfig.supportsThinking || keyAction !== 'preserve';
  const dirty = hasChanges || Object.values(drafts).some(Boolean);
  const reportDraft = useCallback((id: string, value: boolean) => setDrafts(old => old[id] === value ? old : { ...old, [id]: value }), []);
  const results = searchSettings(query);
  const visible = query.trim() ? results.map(item => item.id) : [active];
  useEffect(() => {
    if (query.trim()) setVisited(previous => new Set([...previous, ...searchSettings(query).map(item => item.id)]));
  }, [query]);
  const icons = { general: IconSettings, workspace: IconFolder, models: IconBrain, agent: IconSliders, memory: IconNote, tools: IconPlug, search: IconSearch, permissions: IconKey, review: IconSync, storage: IconDatabase, shortcuts: IconKeyboard };
  const groups = [
    { id: 'workbench', label: copy('工作台', 'Workbench') },
    { id: 'agent', label: 'Agent' },
    { id: 'system', label: copy('系统', 'System') },
  ];

  useEffect(() => {
    let alive = true;
    const assign = <T,>(promise: Promise<T>, setter: (value: T) => void) => {
      void promise.then(value => { if (alive) setter(value); }).catch(() => {});
    };
    assign(invoke<string>('get_data_path'), setDataPath);
    assign(invoke<string>('get_db_path'), setDbPath);
    assign(loadDailyNotePath(), setDailyNotePath);
    assign(loadNewFolderDefaultPath(), setNewFolderDefaultPath);
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    setLocalProvider(llmConfig.providerId); setLocalApiUrl(llmConfig.apiUrl);
    setLocalModel(llmConfig.model); setLocalSupportsThinking(!!llmConfig.supportsThinking);
    setLocalApiKey(''); setKeyAction('preserve');
  }, [llmConfig.providerId, llmConfig.apiUrl, llmConfig.model, llmConfig.supportsThinking]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (state.view === 'settings' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select();
      }
    };
    const beforeLeave = (event: Event) => {
      const next = (event as CustomEvent<{ view: View }>).detail?.view;
      if (saving && next && next !== 'settings') { event.preventDefault(); return; }
      if (dirty && !allowLeave.current && next && next !== 'settings') { event.preventDefault(); setLeaving(next); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('keydown', keyboard);
    window.addEventListener('zettel:before-navigate', beforeLeave);
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('keydown', keyboard); window.removeEventListener('zettel:before-navigate', beforeLeave); window.removeEventListener('beforeunload', beforeUnload); };
  }, [dirty, saving, state.view]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const navigate = (id: SettingsPage) => { if (saving) return; setActive(id); setQuery(''); setVisited(prev => new Set([...prev, id])); };
  const dirtyModel = () => { setSaved(false); setSaveError(''); setTestResult(''); };
  const resetConnection = () => {
    setLocalProvider(llmConfig.providerId); setLocalApiUrl(llmConfig.apiUrl); setLocalModel(llmConfig.model);
    setLocalSupportsThinking(!!llmConfig.supportsThinking); setLocalApiKey(''); setKeyAction('preserve'); setSaveError('');
  };
  const changeProvider = (id: string) => {
    const provider = getProvider(id); if (!provider) return;
    setLocalProvider(id); setLocalApiKey(''); setKeyAction(id === llmConfig.providerId ? 'preserve' : 'clear');
    setLocalApiUrl(id === llmConfig.providerId ? llmConfig.apiUrl : provider.baseUrl);
    setLocalModel(id === llmConfig.providerId ? llmConfig.model : provider.models[0]?.id || ''); dirtyModel();
  };
  const handleSaveConfig = async () => {
    if (saving) return;
    setSaveError('');
    let url: URL;
    try { url = new URL(localApiUrl.trim()); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { setSaveError(copy('请输入有效的 HTTP 或 HTTPS 服务地址。', 'Enter a valid HTTP or HTTPS endpoint.')); return; }
    if (!localModel.trim()) { setSaveError(copy('请填写模型名称。', 'Enter a model name.')); return; }
    const provider = getProvider(localProvider);
    let originChanged = localProvider !== llmConfig.providerId;
    try { originChanged ||= new URL(llmConfig.apiUrl).origin !== url.origin; } catch { originChanged = true; }
    if (originChanged && provider?.needsApiKey && keyAction !== 'replace') {
      setSaveError(copy('更换模型服务后，请为新服务填写密钥。原有密钥不会被自动发送到新服务。', 'Enter a credential for the new service. The saved key is not reused across services.')); return;
    }
    const payload: Record<string, unknown> = {
      providerId: localProvider, apiUrl: localApiUrl.trim(), model: localModel.trim(),
      supportsThinking: localSupportsThinking,
      contextWindow: provider?.models.find(item => item.id === localModel.trim())?.contextWindow,
    };
    if (keyAction === 'replace') payload.apiKey = localApiKey.trim();
    if (keyAction === 'clear') payload.apiKey = '';
    setSaving(true);
    try {
      await setLlmConfig(payload); setSaved(true); setLocalApiKey(''); setKeyAction('preserve');
      showToast(copy('模型连接已保存', 'Connection saved'), 'success');
    } catch (error) { setSaveError(copy('保存失败：', 'Save failed: ') + String(error)); }
    finally { setSaving(false); }
  };
  const testConnection = async () => {
    if (hasChanges || testing) return;
    setTesting(true); setTestResult('');
    try {
      await chatWithLlm({ messages: [{ role: 'user', content: 'Reply with OK.' }], apiUrl: llmConfig.apiUrl,
        apiKey: llmConfig.apiKey || undefined, model: llmConfig.model, providerId: llmConfig.providerId });
      setTestResult(copy('服务已返回响应。', 'The service returned a response.'));
    } catch (error) { setTestResult(copy('连接测试失败：', 'Connection test failed: ') + String(error)); }
    finally { setTesting(false); }
  };
  const generalProps = { isZh, methodology: state.methodology, setMethodology: (m: string) => setMethodology(m as any), showToast, dataPath, dbPath, dailyNotePath, setDailyNotePath, newFolderDefaultPath, setNewFolderDefaultPath };
  const renderPage = (id: SettingsPage) => {
    switch (id) {
      case 'general': return <GeneralSettingsTab {...generalProps} section="appearance" />;
      case 'workspace': return <>
        <div className="settings-section-card settings-vaults"><h3>{copy('已打开的知识库', 'Open vaults')}</h3>
          <p>{copy('知识库是存放 Markdown 笔记的本地文件夹。移出工作区不会删除文件。', 'A vault is a local folder of Markdown notes. Removing it from the workspace keeps its files.')}</p>
          {(state.vaultPaths?.length ? state.vaultPaths : state.vaultPath ? [state.vaultPath] : []).map(path => <div className="settings-vault-row" key={path}><div><strong>{path.split(/[/\\]/).filter(Boolean).pop()}</strong><code>{path}</code></div>{path === state.vaultPath ? <span>{copy('主知识库', 'Primary')}</span> : <button className="btn btn-sm" onClick={() => void setPrimaryVaultPath(path)}>{copy('设为主库', 'Make primary')}</button>}<button className="btn btn-ghost btn-sm" aria-label={copy(`移出工作区：${path}`, `Remove from workspace: ${path}`)} onClick={() => void removeVaultPath(path)}>{copy('移出', 'Remove')}</button></div>)}
          <button className="btn btn-sm" onClick={async () => { try { const path = await openFolder({ directory: true, multiple: false }); if (typeof path === 'string') await addVaultPath(path); } catch (error) { showToast(String(error), 'error'); } }}>{copy('打开知识库…', 'Open vault…')}</button>
        </div><GeneralSettingsTab {...generalProps} section="workspace" /></>;
      case 'models': return <AiSettingsTab isZh={isZh} llmConfig={llmConfig} draftProviderId={localProvider}
        localApiUrl={localApiUrl} setLocalApiUrl={setLocalApiUrl} localApiKey={localApiKey}
        setLocalApiKey={value => { setLocalApiKey(value); setKeyAction(value ? 'replace' : 'preserve'); }}
        localModel={localModel} setLocalModel={setLocalModel} customModel="" setCustomModel={() => {}}
        localSupportsThinking={localSupportsThinking} setLocalSupportsThinking={setLocalSupportsThinking}
        saved={saved} hasChanges={hasChanges} saving={saving} saveError={saveError} keyAction={keyAction}
        handleProviderChange={changeProvider} handleModelChange={value => { setLocalModel(value); dirtyModel(); }}
        handleSaveConfig={handleSaveConfig} onConfigDirty={dirtyModel} onDiscard={resetConnection}
        onRemoveKey={() => { setLocalApiKey(''); setKeyAction('clear'); dirtyModel(); }}
        onTest={testConnection} testing={testing} testResult={testResult} />;
      case 'agent': return <OrganizeSettingsTab isZh={isZh} />;
      case 'search': return <><EmbeddingConfigSection isZh={isZh} /><RerankSettingsSection /></>;
      case 'memory': return <><CoreMemorySection /><AiMemorySection section="memory" /></>;
      case 'tools': return <><McpServersSection isZh={isZh} /><McpServerExposeSection /><SkillDirectoriesSection /></>;
      case 'permissions': return <SecuritySettingsSection isZh={isZh} vaultPath={state.vaultPath} />;
      case 'review': return <ReviewSettingsSection />;
      case 'storage': return <><AiMemorySection section="storage" /><GeneralSettingsTab {...generalProps} section="storage" /></>;
      case 'shortcuts': return <ShortcutsSettingsTab isZh={isZh} key={state.lang} />;
    }
  };

  return <SettingsDrafts.Provider value={reportDraft}><div className="settings-container"><div className="settings-workbench">
    <header className="settings-workbench-header"><div><h1>{copy('设置', 'Settings')}</h1><p>{copy('知识管理 Agent 的工作方式与运行环境', 'Configure your knowledge-management Agent')}</p></div><span className="settings-scope-badge">{copy('应用默认值', 'Application defaults')}</span>
      <div className="settings-search-field"><IconSearch size={16} /><input ref={searchRef} type="search" aria-label={copy('搜索设置', 'Search settings')} placeholder={copy('搜索设置，例如模型、权限、每日笔记', 'Search settings, e.g. model, permissions, daily notes')} value={query} onChange={event => setQuery(event.target.value)} /><kbd>Ctrl / ⌘ F</kbd></div>
      <select className="settings-workbench-select" aria-label={copy('设置分类', 'Settings category')} value={active} onChange={event => navigate(event.target.value as SettingsPage)}>{groups.map(group => <optgroup key={group.id} label={group.label}>{SETTINGS_CATEGORIES.filter(item => item.group === group.id).map(item => <option key={item.id} value={item.id}>{isZh ? item.zh : item.en}</option>)}</optgroup>)}</select>
    </header>
    <nav className="settings-workbench-nav" aria-label={copy('设置分类', 'Settings categories')}>{groups.map(group => <div key={group.id} className="settings-nav-group"><h2>{group.label}</h2>{SETTINGS_CATEGORIES.filter(item => item.group === group.id).map(item => { const Icon = icons[item.id]; return <button key={item.id} type="button" aria-current={!query && active === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon size={15} /><span>{isZh ? item.zh : item.en}</span>{(item.id === 'models' ? hasChanges : drafts[item.id]) && <i className="settings-dirty-dot" aria-hidden="true" />}</button>; })}</div>)}</nav>
    <main className="settings-workbench-content" aria-label={copy('设置内容', 'Settings content')}>
      {query.trim() && <p className="settings-search-count" role="status">{copy(`找到 ${results.length} 个相关设置分区`, `${results.length} matching settings sections`)}</p>}
      {query.trim() && results.length === 0 && <div className="settings-search-empty"><h2>{copy('没有找到相关设置', 'No matching settings')}</h2><p>{copy('试试“模型”“索引”“权限”等关键词。', 'Try model, indexing, or permissions.')}</p><button className="btn btn-sm" onClick={() => setQuery('')}>{copy('清除搜索', 'Clear search')}</button></div>}
      {SETTINGS_CATEGORIES.filter(item => visited.has(item.id) || visible.includes(item.id)).map(item => <section key={item.id} className="settings-workbench-page" style={!visible.includes(item.id) ? { display: 'none' } : undefined} aria-labelledby={`settings-page-${item.id}`}><header className="settings-page-heading"><h2 id={`settings-page-${item.id}`}>{isZh ? item.zh : item.en}</h2><p>{isZh ? item.descriptionZh : item.descriptionEn}</p>{['general','workspace','review','permissions'].includes(item.id) && <span>{copy(item.id === 'workspace' ? '笔记规则是应用默认值；文件列表属于当前工作区。' : '此分区的偏好在更改后生效。', item.id === 'workspace' ? 'Note rules are application defaults; the folder list belongs to this workspace.' : 'Preferences in this section apply when changed.')}</span>}</header>{renderPage(item.id)}</section>)}
    </main>
    {dirty && <div className="settings-workbench-draft-status" role="status">{copy('有尚未保存的改动，切换设置分区不会丢失草稿。', 'Unsaved changes. Your drafts are kept when switching settings categories.')}</div>}
    <ConfirmModal isOpen={leaving !== null} title={copy('离开设置？', 'Leave settings?')} message={copy('尚未保存的改动将被丢弃。你也可以返回设置继续编辑并保存。', 'Unsaved changes will be discarded. Return to settings to keep editing and save them.')} confirmLabel={copy('丢弃并离开', 'Discard and leave')} cancelLabel={copy('继续编辑', 'Keep editing')} variant="warning" onCancel={() => setLeaving(null)} onConfirm={() => { if (leaving) { allowLeave.current = true; setView(leaving); } }} />
  </div></div></SettingsDrafts.Provider>;
}

interface ClearCategory { key: string; label_zh: string; label_en: string; desc_zh: string; desc_en: string; danger?: boolean }
const CLEAR_CATEGORIES: ClearCategory[] = [
{ key: 'db_cache', label_zh: '文件元数据缓存', label_en: 'File Metadata Cache', desc_zh: '文件同步记录、分块等。清除后需重新同步。', desc_en: 'Sync records, chunks. Requires re-sync.' },
{ key: 'card_meta', label_zh: '笔记卡片属性', label_en: 'Note Card Attributes', desc_zh: 'AI 生成的标签、类型、知识冲突等。', desc_en: 'AI-generated tags, types, contradictions.' },
{ key: 'connections', label_zh: '智能关联连线', label_en: 'Suggested Connections', desc_zh: '清除图谱中 AI 推荐的关联（含语义边），物理 wikilink 不受影响。', desc_en: 'Clears AI-suggested + semantic edges; wikilinks unaffected.' },
{ key: 'embeddings', label_zh: '向量搜索索引', label_en: 'Vector Embeddings', desc_zh: '语义向量索引，清除后需重建以启用混合检索。', desc_en: 'Semantic vectors; requires rebuild for hybrid search.' },
{ key: 'chat_history', label_zh: '聊天记录', label_en: 'Chat History', desc_zh: '所有 AI 对话会话和消息。', desc_en: 'All AI chat sessions and messages.' },
{ key: 'ai_memory', label_zh: 'AI 长期记忆', label_en: 'AI Long-term Memory', desc_zh: 'AI 记住的关于你的信息。', desc_en: 'Information AI remembers about you.' },
{ key: 'snapshots', label_zh: '笔记版本快照', label_en: 'Note Snapshots', desc_zh: '编辑历史版本记录（含 SQLite 和本地缓存）。', desc_en: 'Edit version history (SQLite + local cache).' },
{ key: 'canvas_drawings', label_zh: '白板手绘数据', label_en: 'Canvas Drawings', desc_zh: '白板上的手绘笔触数据。', desc_en: 'Freehand drawing strokes on canvas.' },
{ key: 'settings', label_zh: '应用本地设置', label_en: 'App Settings', desc_zh: 'API 密钥、接口地址及首选项。', desc_en: 'API keys, URLs, and preferences.', danger: true },
];

export function ClearDataDialog({ isZh, onClose }: { isZh: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === CLEAR_CATEGORIES.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(CLEAR_CATEGORIES.map(c => c.key)));
    }
  };

  const handleClear = async () => {
    if (selected.size === 0) return;
    setClearing(true);
    try {
      const cats = Array.from(selected);
      if (cats.length === CLEAR_CATEGORIES.length) {
        await clearData();
        localStorage.clear();
        // Also clear IndexedDB snapshots
        try { indexedDB.deleteDatabase('zettelagent-snapshots'); } catch { /* ignore */ }
      } else {
        await clearDataSelective(cats);
        if (cats.includes('settings')) {
          // Clear app-related localStorage keys
          const settingsKeys = Object.keys(localStorage).filter(k =>
            k.startsWith('zettelagent-') || k.startsWith('zettel-')
          );
          settingsKeys.forEach(k => localStorage.removeItem(k));
        }
        if (cats.includes('canvas_drawings')) {
          Object.keys(localStorage).filter(k => k.startsWith('zettel-freehand-')).forEach(k => localStorage.removeItem(k));
        }
        if (cats.includes('snapshots')) {
          try { indexedDB.deleteDatabase('zettelagent-snapshots'); } catch { /* ignore */ }
        }
      }
      onClose();
      // Brief toast before reload
      const msg = tf('settings.clearedMsg', cats.length);
      // Use a native alert-style approach since the app reloads immediately
      alert(msg);
      window.location.reload();
    } catch (err) {
      alert((t('settings.clearFail')) + ': ' + err);
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
      >
        <div className="modal-header">
          <h3 className="modal-title" style={{ color: 'var(--danger)' }}>
            <IconTrash size={20} />
            {t('settings.selectiveClear')}
          </h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label={t('settings.cancelBtn')}>&times;</button>
        </div>

        <div className="modal-content clear-data-content">
          <p className="clear-data-item-desc">{t('settings.selectiveClearDesc')}</p>

          <div className="clear-data-toolbar">
            <label className="clear-data-toolbar-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="clear-data-checkbox"
                checked={selected.size === CLEAR_CATEGORIES.length}
                onChange={selectAll}
              />
              {t('settings.selectAll')}
            </label>
          </div>

          <div className="clear-data-list">
            {CLEAR_CATEGORIES.map(cat => (
              <label
                key={cat.key}
                className={`clear-data-item${selected.has(cat.key) ? ' selected' : ''}`}
              >
                <input
                  type="checkbox"
                  className="clear-data-checkbox"
                  checked={selected.has(cat.key)}
                  onChange={() => toggle(cat.key)}
                />
                <span className="clear-data-item-text">
                  <span className="clear-data-item-label" style={cat.danger ? { color: 'var(--danger)' } : undefined}>
                    {isZh ? cat.label_zh : cat.label_en}
                  </span>
                  <span className="clear-data-item-desc">{isZh ? cat.desc_zh : cat.desc_en}</span>
                </span>
              </label>
            ))}
          </div>

          {selected.size > 0 && (
            <div className="clear-data-warning">
              <IconWarningTriangle size={14} />
              <span>{tf('settings.clearWarning', selected.size)}</span>
            </div>
          )}

          <div className="clear-data-footer">
            <button type="button" className="btn btn-secondary clear-data-cancel" onClick={onClose}>
              {t('settings.cancelBtn')}
            </button>
            <button
              type="button"
              className="btn btn-primary clear-data-confirm"
              onClick={handleClear}
              disabled={selected.size === 0 || clearing}
              title={selected.size === 0 ? t('settings.selectAtLeast') : undefined}
              style={selected.size > 0 ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
            >
              {clearing ? <span className="spinner" /> : null}
              {tf('settings.clearBtn', selected.size)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconWarningTriangle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}



// ── Smart Organize Settings ────────────────────────────────────────

const ORGANIZE_STORAGE_KEY = 'smartOrganizeConfig';
const BACKGROUND_ORGANIZE_KEY = 'backgroundOrganizeEnabled';

export interface SmartOrganizeConfig {
  batchSize: number;
  intervalSecs: number;
  searchResultCount: number;
  contentTruncationLimit: number;
  /** Whether to include journal/diary notes in organizing (default: true) */
  includeJournals: boolean;
  /** Minimum character limit for note organization (default: 100) */
  minNoteLength: number;
}

const ORGANIZE_DEFAULTS: SmartOrganizeConfig = {
  batchSize: 5,
  intervalSecs: 3600,
  searchResultCount: 8,
  contentTruncationLimit: 3000,
  includeJournals: true,
  minNoteLength: 100,
};

export function getSmartOrganizeConfig(): SmartOrganizeConfig {
  try {
    const raw = localStorage.getItem(ORGANIZE_STORAGE_KEY);
    if (raw) return { ...ORGANIZE_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...ORGANIZE_DEFAULTS };
}

/** Whether the hourly background auto-organize loop should be active. */
export function getBackgroundOrganizeEnabled(): boolean {
  try {
    return localStorage.getItem(BACKGROUND_ORGANIZE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setBackgroundOrganizeEnabled(enabled: boolean): void {
  localStorage.setItem(BACKGROUND_ORGANIZE_KEY, enabled ? 'true' : 'false');
}

function saveSmartOrganizeConfig(config: SmartOrganizeConfig) {
  localStorage.setItem(ORGANIZE_STORAGE_KEY, JSON.stringify(config));
}

function NumberInputCard({
  f,
  value,
  defaultValue,
  isZh,
  update,
  t,
}: {
  f: any;
  value: number;
  defaultValue: number;
  isZh: boolean;
  update: (patch: any) => void;
  t: (key: any) => string;
}) {
  const [localVal, setLocalVal] = useState<string>(String(value));

  // Sync from props if config changes from outside (e.g. reset defaults)
  useEffect(() => {
    setLocalVal(String(value));
  }, [value]);

  const handleBlur = () => {
    let num = Number(localVal);
    if (isNaN(num)) {
      setLocalVal(String(value));
      return;
    }
    // Clamp to [f.min, f.max]
    num = Math.max(f.min, Math.min(f.max, num));
    setLocalVal(String(num));
    update({ [f.key]: num });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleBlur();
      e.currentTarget.blur();
    }
  };

  const adjust = (delta: number) => {
    const nextVal = Math.max(f.min, Math.min(f.max, value + delta));
    setLocalVal(String(nextVal));
    update({ [f.key]: nextVal });
  };

  const isModified = value !== defaultValue;
  const displayValue = f.format ? f.format(value) : String(value);
  const inputId = `organize-input-${f.key}`;

  return (
    <div
      className="settings-section-card"
      style={{
        transition: 'border-color 0.2s, box-shadow 0.2s',
        borderColor: isModified ? 'var(--accent-primary)' : undefined,
        boxShadow: isModified ? '0 0 0 1px rgba(16, 185, 129, 0.08)' : undefined,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
      }}
    >
      {/* Left side: Info (Title, Description, and Range hints) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            color: 'var(--accent-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 'var(--radius-md)',
            background: 'rgba(16, 185, 129, 0.08)',
            flexShrink: 0,
            fontSize: 14,
          }}>
            {f.icon}
          </span>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {isZh ? f.zh : f.en}
          </span>
          {isModified && (
            <span style={{
              fontSize: 9,
              fontWeight: 600,
              color: 'var(--accent-primary)',
              background: 'var(--accent-tint)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-full)',
              textTransform: 'none' as const,
            }}>
              {t('settings.modified')}
            </span>
          )}
        </div>
        
        {/* Description */}
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
          {isZh ? f.descZh : f.descEn}
        </span>
        
        {/* Range limit hint */}
        <span style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
        }}>
          {isZh ? '范围' : 'Range'}: {f.format ? f.format(f.min) : f.min} – {f.format ? f.format(f.max) : f.max}
        </span>
      </div>

      {/* Right side: Input wrapper and current formatted value */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        {/* Input box with +/- controls */}
        <div className="settings-number-input-wrapper" style={{ height: 32 }}>
          <button
            onClick={() => adjust(-f.step)}
            disabled={value <= f.min}
            style={{
              border: 'none',
              background: 'none',
              color: value <= f.min ? 'var(--text-muted)' : 'var(--text-secondary)',
              width: 24,
              height: 24,
              cursor: value <= f.min ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              fontWeight: 'bold',
              borderRadius: 'var(--radius-sm)',
            }}
            type="button"
          >
            -
          </button>
          <input
            id={inputId}
            type="text"
            value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            style={{
              border: 'none',
              background: 'none',
              color: 'var(--text-primary)',
              width: '100%',
              textAlign: 'center',
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              outline: 'none',
              padding: 0,
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <button
            onClick={() => adjust(f.step)}
            disabled={value >= f.max}
            style={{
              border: 'none',
              background: 'none',
              color: value >= f.max ? 'var(--text-muted)' : 'var(--text-secondary)',
              width: 24,
              height: 24,
              cursor: value >= f.max ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              fontWeight: 'bold',
              borderRadius: 'var(--radius-sm)',
            }}
            type="button"
          >
            +
          </button>
        </div>
        
        {/* Formatted display value (e.g., "100 字符", "不过滤") */}
        <span style={{ 
          fontSize: 'var(--text-xs)', 
          color: 'var(--accent-primary)', 
          fontWeight: 600,
          minHeight: 18,
        }}>
          {displayValue}
        </span>
      </div>
    </div>
  );
}

function OrganizeSettingsTab({ isZh }: { isZh: boolean }) {
  const [savedConfig, setSavedConfig] = useState<SmartOrganizeConfig>(getSmartOrganizeConfig);
  const [config, setConfig] = useState<SmartOrganizeConfig>(getSmartOrganizeConfig);
  const [saved, setSaved] = useState(false);

  const { showToast } = useApp();

  // Sync draft with saved config if saved config changes
  useEffect(() => {
    setConfig(savedConfig);
  }, [savedConfig]);

  const updateDraft = (patch: Partial<SmartOrganizeConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }));
  };

  const handleSave = () => {
    saveSmartOrganizeConfig(config);
    setSavedConfig(config);
    setSaved(true);
    showToast(t('settings.organizeSaved'), 'success');
    setTimeout(() => setSaved(false), 1800);
  };

  const resetDefaults = () => {
    setConfig({ ...ORGANIZE_DEFAULTS });
  };

  const formatInterval = (secs: number) => {
    if (secs >= 3600) return `${(secs / 3600).toFixed(1)}h`;
    return `${Math.round(secs / 60)}m`;
  };

  const FIELDS: Array<{
    key: keyof SmartOrganizeConfig;
    icon: React.ReactNode;
    zh: string; en: string;
    descZh: string; descEn: string;
    min: number; max: number; step: number;
    format?: (v: number) => string;
  }> = [
    {
      key: 'batchSize',
      icon: <IconNote size={16} />,
      zh: '每批处理笔记数', en: 'Batch Size',
      descZh: '每次执行智能整理时处理的笔记数量。增大可加快进度，但会消耗更多 API 配额。',
      descEn: 'Number of notes to process per organize run. Larger batches are faster but use more API quota.',
      min: 1, max: 50, step: 1,
    },
    {
      key: 'searchResultCount',
      icon: <IconSearch size={16} />,
      zh: '关联搜索数', en: 'Search Results',
      descZh: '为每篇笔记检索多少条语义相关的候选笔记。越多匹配越精确，但速度更慢且消耗更多 token。',
      descEn: 'How many semantically similar notes to retrieve per note. More results = better accuracy, but slower and uses more tokens.',
      min: 3, max: 20, step: 1,
    },
    {
      key: 'minNoteLength',
      icon: <IconFile size={16} />,
      zh: '超短笔记过滤字数门槛', en: 'Min Note Length',
      descZh: '整理时判定为超短笔记的字符长度下限。少于此字符数的笔记将被跳过；设置为 0 则不进行字数过滤。',
      descEn: 'Notes shorter than this will be skipped during organization. Set to 0 to disable length filtering.',
      min: 0, max: 500, step: 10,
      format: (v: number) => v === 0 ? (isZh ? '不过滤' : 'No Limit') : `${v} ${isZh ? '字符' : 'chars'}`,
    },
    {
      key: 'contentTruncationLimit',
      icon: <IconFile size={16} />,
      zh: '内容截断长度', en: 'Content Truncation',
      descZh: '发送给 AI 分析的最大字符数。长笔记超过此限制时截断，以节省 token 费用。',
      descEn: 'Maximum characters sent to AI for analysis. Notes longer than this are truncated to save token costs.',
      min: 500, max: 10000, step: 500,
      format: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v),
    },
    {
      key: 'intervalSecs',
      icon: <IconSync size={16} />,
      zh: '自动执行间隔', en: 'Auto Interval',
      descZh: '后台自动整理任务的执行间隔。仅在启用后台调度器时生效。',
      descEn: 'Time between automatic organize runs. Only applies when the background scheduler is active.',
      min: 300, max: 86400, step: 300,
      format: formatInterval,
    },
  ];

  const isDefault = JSON.stringify(config) === JSON.stringify(ORGANIZE_DEFAULTS);
  const hasUnsavedChanges = JSON.stringify(config) !== JSON.stringify(savedConfig);
  useSettingsDraft('agent', hasUnsavedChanges);

  return (
    <div className="settings-tab-content">
      {/* Section Header */}
      <div style={{ marginTop: 24, marginBottom: 16 }}>
        <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
          <IconSliders size={18} />
          {isZh ? '智能整理参数' : 'Organize Parameters'}
        </h3>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', margin: '4px 0 0 0', lineHeight: 1.5 }}>
          {t('settings.organizeDesc')}
        </p>
      </div>

      {/* Settings Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {FIELDS.map(f => (
          <NumberInputCard
            key={f.key}
            f={f}
            value={config[f.key] as number}
            defaultValue={ORGANIZE_DEFAULTS[f.key] as number}
            isZh={isZh}
            update={updateDraft}
            t={t}
          />
        ))}
      </div>

      {/* Journal Toggle */}
      <div
        className="settings-section-card"
        style={{ padding: '14px 16px', marginTop: 4 }}
      >
        <div
          className="settings-toggle-row"
          onClick={() => updateDraft({ includeJournals: !config.includeJournals })}
          role="switch"
          aria-checked={config.includeJournals}
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); updateDraft({ includeJournals: !config.includeJournals }); } }}
          style={{ marginBottom: 6 }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              color: 'var(--accent-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-tint)',
              flexShrink: 0,
            }}>
              <IconNote size={16} />
            </span>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('settings.includeJournals')}
            </span>
          </span>
          <div className={`settings-toggle-track ${config.includeJournals ? 'active' : ''}`}>
            <div className="settings-toggle-thumb" />
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, paddingLeft: 36 }}>
          {t('settings.journalDesc')}
        </div>
      </div>

      {/* Footer Actions */}
      <div style={{
        marginTop: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTop: '1px solid var(--border-subtle)',
        paddingTop: 16,
      }}>
        {/* Left side hint */}
        <div>
          {hasUnsavedChanges && (
            <span style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--accent-primary)',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}>
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent-primary)',
                display: 'inline-block'
              }} />
              {isZh ? '有未保存的改动' : 'Unsaved changes'}
            </span>
          )}
        </div>

        {/* Right side buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="btn btn-sm btn-ghost"
            onClick={resetDefaults}
            disabled={isDefault}
            aria-label={t('settings.resetDefaults')}
            style={{
              fontSize: 'var(--text-xs)',
              color: isDefault ? 'var(--text-muted)' : 'var(--text-secondary)',
              cursor: isDefault ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'color 0.2s, opacity 0.2s',
              opacity: isDefault ? 0.5 : 1,
            }}
          >
            <IconSync size={12} />
            {t('settings.resetDefaults')}
          </button>

          <button
            className="btn btn-sm"
            onClick={handleSave}
            disabled={!hasUnsavedChanges}
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              color: hasUnsavedChanges ? '#FFFFFF' : 'var(--text-muted)',
              background: hasUnsavedChanges ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
              border: hasUnsavedChanges ? '1px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '6px 16px',
              cursor: hasUnsavedChanges ? 'pointer' : 'not-allowed',
              pointerEvents: 'auto',
              opacity: hasUnsavedChanges ? 1 : 0.5,
              transition: 'all 0.2s',
            }}
          >
            {isZh ? '保存设置' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsSettingsTab({ isZh }: { isZh: boolean }) {
  const categories = [
    {
      title: isZh ? '导航' : 'Navigation',
      shortcuts: [
        { keys: ['Ctrl', '1'], desc: isZh ? '仪表盘' : 'Dashboard' },
        { keys: ['Ctrl', '2'], desc: isZh ? '笔记' : 'Note' },
        { keys: ['Ctrl', '3'], desc: isZh ? '知识图谱' : 'Knowledge Graph' },
        { keys: ['Ctrl', '4'], desc: isZh ? '白板 (Canvas)' : 'Whiteboard (Canvas)' },
        { keys: ['Ctrl', '5'], desc: isZh ? 'Bases' : 'Bases' },
        { keys: ['Ctrl', '6'], desc: isZh ? '日历' : 'Calendar' },
        { keys: ['Ctrl', '7'], desc: isZh ? '设置' : 'Settings' },
        { keys: ['Ctrl', ','], desc: isZh ? '打开设置' : 'Open Settings' },
        { keys: ['Ctrl', 'P'], desc: isZh ? '快速搜索与切换笔记 (Quick Switcher)' : 'Quick Switcher' },
        { keys: ['Ctrl', 'Shift', 'F'], desc: isZh ? '全局全文检索 (Search Panel)' : 'Global Full-text Search' },
      ]
    },
    {
      title: isZh ? '编辑' : 'Editing',
      shortcuts: [
        { keys: ['Ctrl', 'N'], desc: isZh ? '新建笔记' : 'New Note' },
        { keys: ['Ctrl', 'S'], desc: isZh ? '保存笔记' : 'Save Note' },
        { keys: ['Ctrl', 'J'], desc: isZh ? '笔记时间线' : 'Note Timeline' },
        { keys: ['Ctrl', 'V'], desc: isZh ? '智能粘贴 (剪贴板→卡片)' : 'Smart Paste (Clipboard→Card)' },
        { keys: ['Ctrl', 'D'], desc: isZh ? '打开每日笔记' : 'Open Daily Note' },
      ]
    },
    {
      title: isZh ? '工具' : 'Tools',
      shortcuts: [
        { keys: ['Ctrl', 'L'], desc: isZh ? '开关 Chat 对话面板' : 'Toggle Chat Panel' },
        { keys: ['Ctrl', 'K'], desc: isZh ? '开关 AI 建议面板 (知识库洞察)' : 'Toggle AI Agent Panel' },
        { keys: ['Ctrl', 'B'], desc: isZh ? '开关侧边栏' : 'Toggle Sidebar' },
        { keys: ['Ctrl', '/'], desc: isZh ? '显示快捷键说明' : 'Show Shortcuts' },
      ]
    },
    {
      title: t('shortcuts.knowledgeGraph'),
      shortcuts: [
        { keys: ['Ctrl', t('shortcuts.keyClick')], desc: t('shortcuts.multiSelect') },
        { keys: ['Shift', t('shortcuts.keyScroll')], desc: t('shortcuts.zoomGraph') },
        { keys: ['Shift', t('shortcuts.keyDrag')], desc: t('shortcuts.panGraph') },
        { keys: [t('shortcuts.keyDragNode')], desc: t('shortcuts.dragNode') },
        { keys: [t('shortcuts.keyDoubleClick')], desc: t('shortcuts.doubleClickNode') },
        { keys: ['Space'], desc: t('shortcuts.autoFit') }
      ]
    },
    {
      title: isZh ? '白板 (Canvas) 操作' : 'Whiteboard (Canvas) Controls',
      shortcuts: [
        { keys: ['Space'], desc: isZh ? '适配整个白板视图居中' : 'Fit canvas view to screen' },
        { keys: ['Delete'], desc: isZh ? '删除选中的卡片节点或连线' : 'Delete selected card nodes or edges' },
        { keys: ['P'], desc: isZh ? '切换画笔 (自由绘制)' : 'Toggle pen (freehand draw)' },
        { keys: ['E'], desc: isZh ? '切换橡皮擦' : 'Toggle eraser' },
        { keys: ['Ctrl', 'Z'], desc: isZh ? '撤销 (画笔)' : 'Undo (pen mode)' },
      ]
    }
  ];

  return (
    <div className="settings-section-card">
      <h2 className="shortcuts-guide-title">
        <IconKeyboard size={18} />
        {isZh ? '快捷键说明书' : 'Keyboard Shortcuts'}
      </h2>
      <div className="shortcuts-guide-groups">
        {categories.map((cat, i) => (
          <div key={i}>
            <h3 className="shortcuts-category-title">{cat.title}</h3>
            <div className="shortcuts-list">
              {cat.shortcuts.map((s, idx) => (
                <div key={idx} className="shortcut-row">
                  <span className="shortcut-desc">{s.desc}</span>
                  <div className="shortcut-keys">
                    {s.keys.map((k, kidx) => (
                      <kbd key={kidx} className="shortcut-kbd">
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

