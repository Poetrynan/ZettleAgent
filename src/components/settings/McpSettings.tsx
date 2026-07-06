import { useState, useEffect } from 'react';
import { IconPlug, IconTrash } from '../icons';
import { sectionTitle } from './settingsStyles';
import type { McpServerConfig } from '../../lib/tauri';
import {
  listMcpServers, addMcpServer, removeMcpServer, testMcpConnection,
} from '../../lib/tauri';

// ── Styles ───────────────────────────────────────────────────────

const cardBase: React.CSSProperties = {
  padding: 'var(--space-3)',
  background: 'var(--bg-secondary)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-subtle)',
  transition: 'border-color 0.2s',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  color: 'var(--text-secondary)',
  marginBottom: 4,
};

// ── Main Component ───────────────────────────────────────────────

export function McpServersSection({ isZh }: { isZh: boolean }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; tools: string[] } | null>(null);
  const [error, setError] = useState('');

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { loadServers(); }, []);

  const loadServers = async () => {
    try { setServers(await listMcpServers()); } catch { /* ignore */ }
  };

  const handleAdd = async () => {
    const url = newUrl.trim();
    if (!url) {
      setError(isZh ? '请输入服务地址' : 'Please enter the service URL');
      return;
    }
    setAdding(true);
    setError('');
    try {
      const label = newLabel.trim() || (() => { try { return new URL(url).hostname.split('.')[0]; } catch { return 'mcp-service'; } })();
      const env: Record<string, string> = {};
      if (newApiKey.trim()) env['API_KEY'] = newApiKey.trim();
      await addMcpServer(label, url, [], Object.keys(env).length > 0 ? env : undefined);
      setNewLabel(''); setNewUrl(''); setNewApiKey('');
      setShowAdd(false);
      await loadServers();
    } catch (e) { setError(String(e)); }
    setAdding(false);
  };

  const handleRemove = async (name: string) => {
    try {
      await removeMcpServer(name);
      await loadServers();
      setTestResult(null);
    } catch (e) { setError(String(e)); }
  };

  const handleTest = async (server: McpServerConfig) => {
    setTesting(server.name);
    setTestResult(null);
    setError('');
    try {
      const env = server.env && Object.keys(server.env).length > 0 ? server.env : undefined;
      const tools = await testMcpConnection(server.name, server.command, server.args, env);
      setTestResult({ name: server.name, tools });
    } catch (e) { setError(String(e)); }
    setTesting(null);
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconPlug size={18} /> {isZh ? '扩展工具 (MCP)' : 'Extensions (MCP)'}
      </h2>

      {/* Description + where to find MCP tools */}
      <p style={{
        fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
        marginBottom: 'var(--space-3)', lineHeight: 1.7,
      }}>
        {isZh
          ? '连接 MCP 服务，为 AI Agent 扩展更多工具能力。从 MCP 服务平台获取工具的 URL 和 API Key，填写后即可使用。'
          : 'Connect MCP services to extend AI Agent capabilities. Get the tool URL and API Key from an MCP platform, fill in below to connect.'}
      </p>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-4)',
        fontSize: 'var(--text-xs)',
        color: 'var(--text-secondary)',
      }}>
        <span>{isZh ? '推荐平台：' : 'Find MCP tools at: '}</span>
        <a href="https://modelscope.cn/mcp" target="_blank" rel="noopener noreferrer" className="mcp-link-pill">
          {isZh ? '魔搭社区' : 'ModelScope'}
        </a>
        <a href="https://ai.gitee.com" target="_blank" rel="noopener noreferrer" className="mcp-link-pill">
          Gitee AI
        </a>
        <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="mcp-link-pill">
          Composio
        </a>
        <a href="https://mcp.so" target="_blank" rel="noopener noreferrer" className="mcp-link-pill">
          mcp.so
        </a>
      </div>

      {/* ── Connected Services ─────────────────────────────────── */}
      {servers.length > 0 && (
        <section style={{ marginBottom: 'var(--space-3)' }} aria-label={isZh ? '已连接' : 'Connected'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {servers.map(s => {
              const isTesting = testing === s.name;
              return (
                <div key={s.name} style={{
                  ...cardBase,
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  padding: 'var(--space-2) var(--space-3)',
                }}>
                  <div
                    style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--success, #22c55e)',
                      boxShadow: '0 0 6px rgba(34,197,94,0.4)',
                    }}
                    aria-label={isZh ? '已连接' : 'Connected'}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', lineHeight: 1.4 }}>
                      {s.name}
                    </div>
                    <div style={{
                      fontSize: '11px', color: 'var(--text-tertiary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {s.command}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => handleTest(s)}
                      disabled={isTesting}
                      aria-label={isZh ? '测试连接' : 'Test connection'}
                      style={{
                        fontSize: 'var(--text-xs)', cursor: isTesting ? 'not-allowed' : 'pointer',
                        opacity: isTesting ? 0.5 : 1, transition: 'opacity 0.2s',
                      }}
                    >
                      {isTesting ? '...' : (isZh ? '测试' : 'Test')}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => handleRemove(s.name)}
                      aria-label={isZh ? '断开连接' : 'Disconnect'}
                      style={{ color: 'var(--danger)', cursor: 'pointer', transition: 'opacity 0.2s' }}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Test Result ────────────────────────────────────────── */}
      {testResult && (
        <div role="status" aria-live="polite" style={{
          padding: 'var(--space-2) var(--space-3)',
          background: 'rgba(34,197,94,0.06)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-xs)',
          marginBottom: 'var(--space-3)',
          border: '1px solid rgba(34,197,94,0.15)',
          lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--success, #22c55e)' }}>{testResult.name}</strong>
          {' '}{isZh ? '连接成功' : 'connected'} — {testResult.tools.length} {isZh ? '个工具可用' : 'tools available'}
          {testResult.tools.length > 0 && (
            <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
              {testResult.tools.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* ── Error ──────────────────────────────────────────────── */}
      {error && (
        <div role="alert" style={{
          fontSize: 'var(--text-xs)', color: 'var(--danger)',
          padding: 'var(--space-2) var(--space-3)',
          background: 'rgba(239,68,68,0.05)',
          borderRadius: 'var(--radius-sm)', marginBottom: 'var(--space-3)',
          border: '1px solid rgba(239,68,68,0.12)',
          wordBreak: 'break-all', lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      {/* ── Add Form ───────────────────────────────────────────── */}
      {showAdd ? (
        <div style={{ ...cardBase, background: 'var(--bg-primary)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <div>
              <label htmlFor="mcp-url" style={labelStyle}>
                {isZh ? '服务地址' : 'Service URL'}
              </label>
              <input
                id="mcp-url"
                className="input"
                placeholder="https://mcp.modelscope.cn/sse/..."
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                style={{ fontSize: 'var(--text-sm)', width: '100%' }}
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="mcp-key" style={labelStyle}>
                API Key
              </label>
              <input
                id="mcp-key"
                className="input"
                type="password"
                placeholder={isZh ? '粘贴你的 API Key' : 'Paste your API Key'}
                value={newApiKey}
                onChange={e => setNewApiKey(e.target.value)}
                style={{ fontSize: 'var(--text-sm)', width: '100%' }}
              />
            </div>
            <div>
              <label htmlFor="mcp-label" style={labelStyle}>
                {isZh ? '显示名称（可选）' : 'Display name (optional)'}
              </label>
              <input
                id="mcp-label"
                className="input"
                placeholder={isZh ? '方便自己识别，如"我的AI工具"' : 'e.g. "My AI Tools"'}
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                style={{ fontSize: 'var(--text-sm)', width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-1)' }}>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => { setShowAdd(false); setError(''); setNewUrl(''); setNewApiKey(''); setNewLabel(''); }}
                style={{ cursor: 'pointer' }}
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleAdd}
                disabled={adding}
                style={{
                  cursor: adding ? 'not-allowed' : 'pointer',
                  opacity: adding ? 0.6 : 1, transition: 'opacity 0.2s',
                  minWidth: 80,
                }}
              >
                {adding ? (isZh ? '连接中...' : 'Connecting...') : (isZh ? '连接' : 'Connect')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          className="mcp-add-dashed-btn"
          onClick={() => setShowAdd(true)}
        >
          <span style={{ fontSize: '15px', fontWeight: 'bold', lineHeight: 1 }}>+</span>
          <span>{isZh ? '添加 MCP 工具' : 'Add MCP Tool'}</span>
        </button>
      )}
    </div>
  );
}
