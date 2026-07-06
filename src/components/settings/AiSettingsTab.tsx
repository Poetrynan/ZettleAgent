/**
 * AiSettingsTab — AI 设置（LLM 提供商、API 配置、模型选择、嵌入配置）
 */
import { t } from '../../lib/i18n';
import { LLM_PROVIDERS, getProvider } from '../../lib/llm-providers';
import { sectionTitle, labelStyle } from './settingsStyles';
import { IconBrain, IconKey } from '../icons';

interface AiSettingsTabProps {
  isZh: boolean;
  llmConfig: { apiUrl: string; apiKey: string; model: string; providerId: string; supportsThinking?: boolean };
  localApiUrl: string;
  setLocalApiUrl: (v: string) => void;
  localApiKey: string;
  setLocalApiKey: (v: string) => void;
  localModel: string;
  setLocalModel: (v: string) => void;
  customModel: string;
  setCustomModel: (v: string) => void;
  localSupportsThinking: boolean;
  setLocalSupportsThinking: (v: boolean) => void;
  saved: boolean;
  hasChanges: boolean;
  handleProviderChange: (id: string) => void;
  handleModelChange: (id: string) => void;
  handleSaveConfig: () => void;
  onConfigDirty: () => void;
}

export function AiSettingsTab({
  isZh, llmConfig, localApiUrl, setLocalApiUrl, localApiKey, setLocalApiKey,
  localModel, setLocalModel, customModel, setCustomModel,
  localSupportsThinking, setLocalSupportsThinking,
  saved, hasChanges, handleProviderChange, handleModelChange, handleSaveConfig, onConfigDirty,
}: AiSettingsTabProps) {
  const currentProvider = getProvider(llmConfig.providerId);

  return (
    <div className="settings-tab-content">
      <div className="settings-section-card">
        <h2 style={sectionTitle}>
          <IconBrain size={18} /> {t('settings.llmConfig')}
        </h2>

        {/* Provider Grid */}
        <div className="provider-grid">
          {LLM_PROVIDERS.map(p => {
            const isActive = llmConfig.providerId === p.id;
            return (
              <button key={p.id} className={`provider-card ${isActive ? 'active' : ''}`} onClick={() => handleProviderChange(p.id)}>
                <div className="provider-name">{isZh ? p.nameZh : p.name}</div>
                <div className="provider-id-tag">{p.id}</div>
              </button>
            );
          })}
        </div>

        {/* Provider Description + Key Link */}
        {currentProvider && (
          <div style={{ padding: 'var(--space-3)', background: 'var(--info-bg)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
            <span>{isZh ? currentProvider.descriptionZh : currentProvider.description}</span>
            {currentProvider.keyUrl && (
              <a href={currentProvider.keyUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-primary" style={{ flexShrink: 0, textDecoration: 'none' }}>
                <IconKey size={12} /> {t('settings.getKey')}
              </a>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* API URL */}
          <div>
            <label style={labelStyle}>{t('settings.apiEndpoint')}</label>
            <input type="text" className="input" value={localApiUrl} onChange={e => { setLocalApiUrl(e.target.value); onConfigDirty(); }} placeholder="https://api.example.com/v1/chat/completions" />
          </div>

          {/* API Key */}
          {currentProvider?.needsApiKey !== false && (
            <div>
              <label style={labelStyle}><IconKey size={12} /> API Key</label>
              <input type="password" className="input" value={localApiKey} onChange={e => { setLocalApiKey(e.target.value); onConfigDirty(); }} placeholder="sk-..." />
            </div>
          )}

          {/* Model Selection */}
          {currentProvider && currentProvider.models.length > 0 && (
            <div>
              <label style={labelStyle}>{t('settings.llmModel')}</label>
              <div className="model-tag-group">
                {currentProvider.models.map(m => {
                  const isActive = localModel === m.id;
                  return (
                    <button key={m.id} className={`model-tag-btn ${isActive ? 'active' : ''}`} onClick={() => handleModelChange(m.id)} title={m.description}>
                      {m.name}
                    </button>
                  );
                })}
              </div>
              <input type="text" className="input" value={customModel} onChange={e => {
                setCustomModel(e.target.value);
                if (e.target.value.trim()) setLocalModel(e.target.value.trim());
              }} placeholder={t('settings.customModel')} style={{ fontSize: 'var(--text-xs)' }} />
            </div>
          )}

          {/* Custom provider: manual model input */}
          {currentProvider?.id === 'custom' && (
            <div>
              <label style={labelStyle}>{t('settings.llmModel')}</label>
              <input type="text" className="input" value={localModel} onChange={e => setLocalModel(e.target.value)} placeholder="gpt-4o-mini" />
            </div>
          )}

          {/* Model reasoning type — required */}
          <div>
            <label style={labelStyle}>
              {t('settings.reasoningType')}
              <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>
            </label>
            <div className="model-tag-group" role="radiogroup" aria-required="true">
              <button
                type="button"
                className={`model-tag-btn ${localSupportsThinking ? 'active' : ''}`}
                onClick={() => { setLocalSupportsThinking(true); onConfigDirty(); }}
                role="radio"
                aria-checked={localSupportsThinking}
              >
                {t('settings.reasoningNative')}
              </button>
              <button
                type="button"
                className={`model-tag-btn ${!localSupportsThinking ? 'active' : ''}`}
                onClick={() => { setLocalSupportsThinking(false); onConfigDirty(); }}
                role="radio"
                aria-checked={!localSupportsThinking}
              >
                {t('settings.reasoningStandard')}
              </button>
            </div>
          </div>

          {/* Config Summary */}
          <div className="config-summary-card">
            <span className="summary-status-dot" />
            <span className="summary-text">{localApiUrl || '(no endpoint)'} → {localModel || '(no model)'}</span>
          </div>

          {/* Save Button */}
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <button
              className={`btn ${saved ? 'btn-success' : hasChanges ? 'btn-primary' : 'btn-secondary'}`}
              onClick={handleSaveConfig}
              disabled={!hasChanges && !saved}
              title={!hasChanges && !saved ? t('settings.noChanges') : undefined}
              style={{ minWidth: '120px' }}
            >
              {saved ? t('settings.savedBtn') : t('settings.saveConfig')}
            </button>
            {hasChanges && !saved && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                {t('settings.unsavedChanges')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
