/**
 * The *inbound* half of the MCP group: exposing this vault to external MCP
 * clients (Claude Desktop, Cursor, …). Rendered directly under
 * `McpServersSection` from `McpSettings.tsx`, which is the *outbound* half —
 * this app calling out to other servers. Both used to be titled just "MCP";
 * both titles now carry an arrow, because the two have opposite consequences
 * and only one of them shares your notes.
 *
 * ## Why there are no toggles, ports or tokens
 *
 * The transport is stdio: the client launches this executable as a subprocess
 * with `--mcp-server` and talks over its stdin/stdout. There is nothing
 * listening on a socket, so there is no port to pick, no on/off switch to flip
 * and no token to rotate. Rendering any of those would imply a network surface
 * that does not exist.
 *
 * ## Why "read-only" is stated everywhere
 *
 * `EXPOSED_TOOLS` in `src-tauri/src/tools/mcp_server/mod.rs` lists only readers,
 * and the SQLite connection is opened `SQLITE_OPEN_READ_ONLY`. The UI must not
 * hint at write access it does not have, so the title, the badge, the note and
 * the capability list all say so.
 */
import { useEffect, useState } from 'react';
import { IconPlug, IconClipboard, IconCheck, IconTool, IconFile, IconSparkle } from '../icons';
import { sectionTitle } from './settingsStyles';
import { t } from '../../lib/i18n';
import {
  getDbPath,
  mcpServerClientConfig,
  parseMcpServerCapabilities,
  type McpServerCapabilities,
} from '../../lib/tauri';

export function McpServerExposeSection() {
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [caps, setCaps] = useState<McpServerCapabilities | null>(null);
  // `null` = not probed, `false` = probed and missing. Distinguishing the two
  // keeps the "unavailable" banner from flashing before the first load resolves.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    let alive = true;
    getDbPath()
      .then(p => { if (alive) setDbPath(p); })
      .catch(() => { /* path unresolved; copy button stays disabled */ });
    parseMcpServerCapabilities().then(c => {
      if (!alive) return;
      setCaps(c);
      setAvailable(c !== null);
    });
    return () => { alive = false; };
  }, []);

  const handleCopy = async () => {
    if (!dbPath) return;
    try {
      const snippet = await mcpServerClientConfig(dbPath);
      await navigator.clipboard.writeText(snippet);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2500);
    } catch (e) {
      console.warn('[mcp-server] copy failed:', e);
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconPlug size={18} /> {t('settings.mcpServer.title')}
      </h2>

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)', lineHeight: 1.6 }}>
        {t('settings.mcpServer.desc')}
      </div>

      {available === false && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          {t('settings.mcpServer.unavailable')}
        </div>
      )}

      {available !== false && (
        <>
          {/* Read-only banner — the single most important claim on this card. */}
          <div
            data-testid="mcp-readonly-note"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'color-mix(in srgb, var(--accent, #3b82f6) 8%, transparent)',
              marginBottom: 'var(--space-3)',
            }}
          >
            <span
              className="badge"
              style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}
            >
              {t('settings.mcpServer.readOnlyBadge')}
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {t('settings.mcpServer.readOnlyNote')}
            </span>
          </div>

          {/* Copy config */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <button
              className={`btn btn-sm ${copyState === 'copied' ? 'btn-success' : 'btn-primary'}`}
              onClick={handleCopy}
              disabled={!dbPath}
              title={!dbPath ? t('settings.mcpServer.noDbPath') : undefined}
            >
              {copyState === 'copied' ? <IconCheck size={14} /> : <IconClipboard size={14} />}
              {' '}
              {copyState === 'copied' ? t('settings.mcpServer.copied') : t('settings.mcpServer.copyConfig')}
            </button>
            {copyState === 'failed' && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>
                {t('settings.mcpServer.copyFailed')}
              </span>
            )}
            {!dbPath && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                {t('settings.mcpServer.noDbPath')}
              </span>
            )}
          </div>

          {/* Capability list — read straight from the backend, never invented. */}
          {caps && (
            <div style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                  {t('settings.mcpServer.capabilities')}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
                  {t('settings.mcpServer.protocol')}: {caps.protocolVersion}
                </span>
              </div>

              <CapabilityRow
                icon={<IconTool size={14} />}
                label={t('settings.mcpServer.tools')}
                items={caps.tools}
              />
              <CapabilityRow
                icon={<IconFile size={14} />}
                label={t('settings.mcpServer.resources')}
                items={[`${caps.resources.scheme} (${caps.resources.mimeType})`]}
              />
              <CapabilityRow
                icon={<IconSparkle size={14} />}
                label={t('settings.mcpServer.prompts')}
                items={caps.prompts}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One labelled group of read-only capability chips. */
function CapabilityRow({ icon, label, items }: { icon: React.ReactNode; label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)' }}>
        {icon} {label}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map(item => (
          <code
            key={item}
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 'var(--radius-full, 999px)',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              wordBreak: 'break-all',
            }}
          >
            {item}
          </code>
        ))}
      </div>
    </div>
  );
}
