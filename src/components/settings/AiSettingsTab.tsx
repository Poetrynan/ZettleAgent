import { useEffect, useState } from 'react';
import { LLM_PROVIDERS, getProvider } from '../../lib/llm-providers';
import { getSecretStatus } from '../../lib/storage';
import type { SecretStatus } from '../../lib/secrets';

interface AiSettingsTabProps {
  isZh: boolean;
  llmConfig: { apiUrl: string; apiKey: string; model: string; providerId: string; supportsThinking?: boolean };
  draftProviderId?: string;
  localApiUrl: string; setLocalApiUrl: (value: string) => void;
  localApiKey: string; setLocalApiKey: (value: string) => void;
  localModel: string; setLocalModel: (value: string) => void;
  customModel: string; setCustomModel: (value: string) => void;
  localSupportsThinking: boolean; setLocalSupportsThinking: (value: boolean) => void;
  saved: boolean; hasChanges: boolean; saving?: boolean; saveError?: string;
  keyAction?: 'preserve' | 'replace' | 'clear';
  handleProviderChange: (id: string) => void; handleModelChange: (id: string) => void;
  handleSaveConfig: () => void | Promise<void>; onConfigDirty: () => void;
  onRemoveKey?: () => void; onDiscard?: () => void;
  onTest?: () => void | Promise<void>; testing?: boolean; testResult?: string;
}

export function AiSettingsTab(props: AiSettingsTabProps) {
  const { isZh, llmConfig, localApiUrl, localApiKey, localModel, localSupportsThinking,
    hasChanges, saved, saving = false, keyAction = 'preserve' } = props;
  const copy = (zh: string, en: string) => isZh ? zh : en;
  const providerId = props.draftProviderId ?? llmConfig.providerId;
  const provider = getProvider(providerId);
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    let alive = true;
    void getSecretStatus(true).then(status => { if (alive) { setSecretStatus(status); setStatusError(false); } })
      .catch(() => { if (alive) setStatusError(true); });
    return () => { alive = false; };
  }, [saved]);
  const unprotected = secretStatus?.has_key === true && secretStatus.protected === false;
  return <div className="settings-connection settings-section-card">
    <div className="settings-connection-status"><strong>{copy('当前模型连接', 'Current model connection')}</strong><span>{hasChanges ? copy('草稿 · 保存后生效', 'Draft · applies after saving') : saved ? copy('已保存', 'Saved') : llmConfig.apiUrl && llmConfig.model ? copy('已配置 · 可测试连接', 'Configured · connection can be tested') : copy('尚未配置', 'Not configured')}</span></div>
    <p className="settings-explainer">{copy('此连接用于对话、知识诊断与笔记整理。检索使用的嵌入模型在“索引与检索”中单独配置。', 'Used for chat, knowledge diagnosis, and note organization. Configure embedding models separately in Indexing & retrieval.')}</p>
    <fieldset disabled={saving} className="settings-connection-fields">
      <div className="settings-form-row"><div><label htmlFor="settings-provider">{copy('模型服务', 'Provider')}</label><p>{copy('选择本地模型、云端服务或兼容接口。', 'Choose a local model service, cloud provider, or compatible endpoint.')}</p></div><select id="settings-provider" className="input" value={providerId} onChange={event => props.handleProviderChange(event.target.value)}><option value="" disabled>{copy('选择模型服务', 'Select a provider')}</option>{LLM_PROVIDERS.map(item => <option key={item.id} value={item.id}>{isZh ? item.nameZh : item.name}</option>)}</select></div>
      <div className="settings-form-row"><div><label htmlFor="settings-api-url">{copy('服务地址', 'API endpoint')}</label><p>{provider ? (isZh ? provider.descriptionZh : provider.description) : copy('填写模型服务的完整接口地址。', 'Enter the full model API endpoint.')}</p></div><input id="settings-api-url" className="input" type="url" value={localApiUrl} onChange={event => { props.setLocalApiUrl(event.target.value); props.onConfigDirty(); }} placeholder="https://api.example.com/v1/chat/completions" spellCheck={false} /></div>
      <div className="settings-form-row"><div><label htmlFor="settings-model-name">{copy('模型名称', 'Model name')}</label><p>{copy('可以从建议中选择，也可以直接填写服务提供的模型 ID。', 'Choose a suggestion or enter the model ID provided by your service.')}</p></div><div><input id="settings-model-name" className="input" value={localModel} list="settings-model-suggestions" onChange={event => { props.handleModelChange(event.target.value); props.onConfigDirty(); }} placeholder={copy('输入模型 ID', 'Enter a model ID')} spellCheck={false} /><datalist id="settings-model-suggestions">{provider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></div></div>
      <div className="settings-form-row"><div><label htmlFor="settings-api-key">API Key</label><p>{keyAction === 'clear' ? copy('保存后移除旧密钥。为新服务填写密钥可替换此操作。', 'Saving removes the old credential. Enter a new key to replace it instead.') : secretStatus?.has_key ? copy('已有保存的密钥。留空会保留它；更换服务时请填写新密钥。', 'A credential is saved. Leave blank to keep it; enter a new key when changing services.') : copy('无需密钥的本地服务可留空。', 'Leave blank for local services that do not require a key.')}</p></div><div><div className="settings-key-input"><input id="settings-api-key" className="input" type={showKey ? 'text' : 'password'} value={localApiKey} onChange={event => { props.setLocalApiKey(event.target.value); props.onConfigDirty(); }} placeholder={secretStatus?.has_key ? copy('保留已保存的密钥', 'Keep saved credential') : copy('输入密钥', 'Enter credential')} autoComplete="new-password" spellCheck={false} /><button className="btn btn-ghost btn-sm" type="button" disabled={!localApiKey} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? copy('隐藏', 'Hide') : copy('显示', 'Show')}</button></div>
        {secretStatus?.has_key && props.onRemoveKey && <button type="button" className="btn btn-ghost btn-sm settings-remove-key" onClick={props.onRemoveKey}>{copy('移除已保存密钥', 'Remove saved key')}</button>}
        {provider?.keyUrl && <a className="settings-key-link" href={provider.keyUrl} target="_blank" rel="noopener noreferrer">{copy('前往服务商获取密钥', 'Get a key from this provider')}</a>}
      </div></div>
      <div className="settings-form-row"><div><label htmlFor="settings-model-reasoning">{copy('推理能力', 'Reasoning capability')}</label><p>{copy('按模型实际能力选择，避免发送不支持的推理参数。', 'Match the model capability to avoid unsupported reasoning parameters.')}</p></div><select id="settings-model-reasoning" className="input" value={localSupportsThinking ? 'native' : 'standard'} onChange={event => { props.setLocalSupportsThinking(event.target.value === 'native'); props.onConfigDirty(); }}><option value="standard">{copy('标准输出', 'Standard output')}</option><option value="native">{copy('原生推理', 'Native reasoning')}</option></select></div>
    </fieldset>
    {unprotected && <div className="settings-inline-warning" role="alert" data-testid="api-key-unprotected-warning">{copy('当前已保存密钥未受系统凭据库保护，正以明文保存在本地文件中。请安装或解锁系统钥匙串后重新保存。', 'The saved key is NOT protected by the system credential store. It is kept in a plaintext local file. Install or unlock the system keyring, then save it again.')}{secretStatus?.fallback_reason && <p>{secretStatus.fallback_reason}</p>}</div>}
    {secretStatus?.protected && <p className="settings-save-hint" data-testid="api-key-protected-note">{copy('已保存的密钥受操作系统凭据库保护。', 'The saved credential is protected by the OS credential store.')}</p>}
    {statusError && <p className="settings-save-hint">{copy('暂时无法读取密钥存储状态。', 'Credential storage status is unavailable.')}</p>}
    {props.saveError && <p className="settings-inline-error" role="alert">{props.saveError}</p>}
    <div className="settings-connection-actions"><button type="button" className="btn btn-primary" disabled={saving || !hasChanges} onClick={() => void props.handleSaveConfig()}>{saving ? copy('正在保存…', 'Saving…') : copy('保存连接', 'Save connection')}</button>{props.onDiscard && <button type="button" className="btn" disabled={saving || !hasChanges} onClick={props.onDiscard}>{copy('撤销草稿', 'Discard draft')}</button>}{props.onTest && <button type="button" className="btn btn-ghost" disabled={saving || hasChanges || props.testing || !llmConfig.apiUrl || !llmConfig.model} title={hasChanges ? copy('保存后可测试连接', 'Save before testing the connection') : undefined} onClick={() => void props.onTest?.()}>{props.testing ? copy('测试中…', 'Testing…') : copy('测试连接', 'Test connection')}</button>}</div>
    <p className="settings-save-hint">{copy('保存会替换当前连接。测试仅发送一条固定消息，不包含笔记内容。', 'Saving replaces the current connection. The test sends one fixed message without note content.')}</p>
    {props.testResult && <p className="settings-test-result" role="status">{props.testResult}</p>}
  </div>;
}
