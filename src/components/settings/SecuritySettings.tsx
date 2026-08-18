import { useState, useEffect, useCallback } from 'react';
import { IconKey, IconTrash, IconSync, IconWarning, IconCheck, IconFile } from '../icons';
import { sectionTitle } from './settingsStyles';
import {
  getPermissionMode, setPermissionMode,
  listApprovalRules, deleteApprovalRule,
  listAgentRuns, undoAgentRun,
  listTrash, restoreFromTrash, emptyTrash,
  getTrashRetentionDays, setTrashRetentionDays,
  DEFAULT_TRASH_RETENTION_DAYS,
} from '../../lib/tauri';
import type {
  PermissionMode, ApprovalRule, TrashEntry, AgentRunSummary, UndoReport,
} from '../../lib/tauri';

/**
 * Security & recovery settings — the user-facing half of the permission system in
 * `src-tauri/src/llm/approval.rs` and the recycle bin in
 * `src-tauri/src/commands/undo_commands.rs`.
 *
 * Three cards, in order of how often they matter:
 *   1. Permission mode — the standing answer to "how much do I trust the agent"
 *   2. Allow rules — the accumulated "stop asking me about this", reviewable and revocable
 *   3. Recycle bin — where deleted notes actually go
 */
export function SecuritySettingsSection({ isZh, vaultPath }: {
  isZh: boolean;
  vaultPath: string | null;
}) {
  return (
    <>
      <PermissionModeCard isZh={isZh} />
      <ApprovalRulesCard isZh={isZh} />
      <AgentRunsCard isZh={isZh} />
      <TrashCard isZh={isZh} vaultPath={vaultPath} />

    </>
  );
}

// ── 1. Permission mode ──────────────────────────────────────────────

const MODES: Array<{
  id: PermissionMode;
  zh: string; en: string;
  zhDesc: string; enDesc: string;
}> = [
  {
    id: 'readOnly',
    zh: '只读', en: 'Read-only',
    zhDesc: 'Agent 只能查询，任何写入直接拒绝并告知模型。适合让它分析、不动库。',
    enDesc: 'The agent can only read. Every write is denied outright and the reason is fed back to the model.',
  },
  {
    id: 'standard',
    zh: '标准（推荐）', en: 'Standard (recommended)',
    zhDesc: '每次写入都弹审批，除非命中你自己添加的允许规则。',
    enDesc: 'Every write asks for approval, unless one of your allow rules matches.',
  },
  {
    id: 'trusted',
    zh: '信任', en: 'Trusted',
    zhDesc: '低/中风险写入自动执行；高风险仍然询问，删除永远询问。',
    enDesc: 'Low and medium risk writes run unattended; high risk still asks, deletion always asks.',
  },
];

function PermissionModeCard({ isZh }: { isZh: boolean }) {
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getPermissionMode().then(setMode).catch(e => setError(String(e)));
  }, []);

  const handleSelect = async (next: PermissionMode) => {
    const previous = mode;
    setMode(next);           // optimistic — reverted below if the backend refuses
    setError('');
    try {
      await setPermissionMode(next);
    } catch (e) {
      setMode(previous);
      setError(String(e));
    }
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconKey size={18} /> {isZh ? 'Agent 权限档位' : 'Agent permissions'}
      </h2>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
        {isZh
          ? '决定 Agent 修改笔记库前是否需要你确认。无论哪个档位，删除类操作都会询问。'
          : 'Controls whether the agent needs your confirmation before changing the vault. Deletion asks in every mode.'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {MODES.map(m => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => handleSelect(m.id)}
              aria-pressed={active}
              style={{
                textAlign: 'left',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-3)',
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
                background: active ? 'color-mix(in srgb, var(--accent, #3b82f6) 8%, transparent)' : 'var(--bg-primary)',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 16, flexShrink: 0, display: 'inline-flex', paddingTop: 2, color: 'var(--accent, #3b82f6)' }}>
                {active && <IconCheck size={14} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                  {isZh ? m.zh : m.en}
                </span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {isZh ? m.zhDesc : m.enDesc}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-2)' }}>{error}</div>
      )}
    </div>
  );
}

// ── 2. Allow rules ──────────────────────────────────────────────────

const RISK_LABEL: Record<string, { zh: string; en: string }> = {
  low: { zh: '低', en: 'low' },
  medium: { zh: '中', en: 'medium' },
  high: { zh: '高', en: 'high' },
  critical: { zh: '不可逆', en: 'critical' },
};

function ApprovalRulesCard({ isZh }: { isZh: boolean }) {
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await listApprovalRules());
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (id: number) => {
    setBusy(true);
    try {
      await deleteApprovalRule(id);
      await load();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconCheck size={18} /> {isZh ? '允许规则' : 'Allow rules'}
      </h2>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
        {isZh
          ? '你在审批卡上点过「始终允许此类」的记录。规则只在其风险上限内生效，删除操作永不受规则影响。'
          : 'Everything you approved with "Always allow this kind". A rule only applies up to its risk ceiling, and never covers deletion.'}
      </div>

      <div style={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        maxHeight: 260,
        overflowY: 'auto',
      }}>
        {rules.length === 0 && (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', padding: 'var(--space-3) 0', textAlign: 'center' }}>
            {isZh ? '暂无规则 — 每次写入都会询问你' : 'No rules — every write will ask'}
          </div>
        )}
        {rules.map(rule => (
          <div key={rule.id} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>
                  {rule.tool_name === '*' ? (isZh ? '所有工具' : 'all tools') : rule.tool_name}
                </code>
                <span className="badge" style={{ fontSize: 10 }}>
                  {isZh ? '风险上限 ' : 'max '}
                  {(isZh ? RISK_LABEL[rule.max_risk]?.zh : RISK_LABEL[rule.max_risk]?.en) ?? rule.max_risk}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                  {rule.scope === 'session'
                    ? (isZh ? '仅本次运行' : 'this session only')
                    : (isZh ? '长期' : 'persistent')}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2, wordBreak: 'break-all' }}>
                {rule.path_prefix
                  ? `${isZh ? '限定路径：' : 'path: '}${rule.path_prefix}`
                  : (isZh ? '整个笔记库' : 'entire vault')}
                {rule.note ? ` · ${rule.note}` : ''}
              </div>
            </div>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => handleRevoke(rule.id)}
              disabled={busy}
              style={{ color: 'var(--danger)' }}
              title={isZh ? '撤销这条规则' : 'Revoke this rule'}
            >
              <IconTrash size={14} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
        <button className="btn btn-sm btn-secondary" onClick={load} disabled={busy}>
          <IconSync size={14} /> {isZh ? '刷新' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-2)' }}>{error}</div>
      )}
    </div>
  );
}

// ── 3. Recent agent changes (Checkpoint / Rewind) ───────────────────

/**
 * Whole-turn undo. Reads `agent_run_journal`, so it survives restarts and is
 * independent of the chat transcript — which is also its deliberate limit:
 * undoing a run rewrites files back, it does not rewind the conversation.
 */
function AgentRunsCard({ isZh }: { isZh: boolean }) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState<UndoReport | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await listAgentRuns(20));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUndo = async (run: AgentRunSummary) => {
    const ok = window.confirm(isZh
      ? `回滚这一轮对 ${run.change_count} 处文件的改动？笔记会恢复到 Agent 修改前的内容，对话记录不变。`
      : `Roll back this turn's ${run.change_count} file change(s)? Notes revert to their pre-agent content; the conversation is untouched.`);
    if (!ok) return;
    setBusy(run.run_id);
    setReport(null);
    try {
      setReport(await undoAgentRun(run.run_id));
      await load();
    } catch (e) {
      setError(String(e));
    }
    setBusy('');
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconSync size={18} /> {isZh ? '最近的 Agent 改动' : 'Recent agent changes'}
      </h2>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
        {isZh
          ? 'Agent 每轮的文件改动都记了账，可以整轮撤销。撤销只还原文件，不回退对话。'
          : 'Every agent turn that touched files is journaled and can be rolled back as a unit. Files only — the conversation is not rewound.'}
      </div>

      <div style={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        maxHeight: 300,
        overflowY: 'auto',
      }}>
        {runs.length === 0 && (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', padding: 'var(--space-3) 0', textAlign: 'center' }}>
            {isZh ? 'Agent 还没有改过任何文件' : 'The agent has not changed any files yet'}
          </div>
        )}
        {runs.map(run => (
          <div key={run.run_id} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            opacity: run.undone ? 0.6 : 1,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>
                  {new Date(run.started_at_ms).toLocaleString()}
                </span>
                <span className="badge" style={{ fontSize: 10 }}>
                  {isZh ? `${run.change_count} 处改动` : `${run.change_count} change(s)`}
                </span>
                {run.undone && (
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                    {isZh ? '已撤销' : 'undone'}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2, wordBreak: 'break-all' }}>
                {run.affected_paths.join(' · ') || run.run_id}
              </div>
            </div>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => handleUndo(run)}
              disabled={run.undone || busy !== ''}
              title={isZh ? '回滚这一轮的全部文件改动' : 'Roll back every file change of this turn'}
            >
              {busy === run.run_id
                ? (isZh ? '回滚中…' : 'Undoing…')
                : (isZh ? '撤销本轮' : 'Undo turn')}
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
        <button className="btn btn-sm btn-secondary" onClick={load} disabled={busy !== ''}>
          <IconSync size={14} /> {isZh ? '刷新' : 'Refresh'}
        </button>
      </div>

      {report && <UndoReportView report={report} isZh={isZh} />}

      {error && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-2)' }}>{error}</div>
      )}
    </div>
  );
}

/** Partial rollback is normal — show exactly what happened rather than a green tick. */
function UndoReportView({ report, isZh }: { report: UndoReport; isZh: boolean }) {
  const lines: string[] = [];
  lines.push(isZh
    ? `已还原 ${report.restored} 处，重建索引 ${report.reindexed} 个文件`
    : `Restored ${report.restored}, re-indexed ${report.reindexed} file(s)`);
  if (report.skipped_already_undone > 0) {
    lines.push(isZh
      ? `跳过 ${report.skipped_already_undone} 处（已撤销过）`
      : `Skipped ${report.skipped_already_undone} (already undone)`);
  }
  if (report.trashed.length > 0) {
    lines.push(isZh
      ? `移入回收站：${report.trashed.join(', ')}`
      : `Moved to recycle bin: ${report.trashed.join(', ')}`);
  }
  return (
    <div style={{
      marginTop: 'var(--space-3)',
      padding: 'var(--space-2) var(--space-3)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
      background: 'var(--bg-primary)',
      fontSize: 'var(--text-xs)',
    }}>
      {lines.map((line, i) => (
        <div key={`ok-${i}`} style={{ color: 'var(--text-secondary)' }}>{line}</div>
      ))}
      {report.failed.map((f, i) => (
        <div key={`fail-${i}`} style={{ color: 'var(--danger)', marginTop: 2 }}>{f}</div>
      ))}
      {report.warnings.map((w, i) => (
        <div key={`warn-${i}`} style={{ color: 'var(--warning, #d97706)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{w}</div>
      ))}
    </div>
  );
}

// ── 4. Recycle bin ──────────────────────────────────────────────────


function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `YYYYMMDD-HHMMSS` → `YYYY-MM-DD HH:MM`. Falls back to the raw stamp if it doesn't match. */
function formatStamp(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/.exec(stamp);
  if (!m) return stamp;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function TrashCard({ isZh, vaultPath }: { isZh: boolean; vaultPath: string | null }) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // Retention is a vault-independent app setting, so it loads even with no vault
  // open — unlike the entry list below.
  const [retention, setRetention] = useState<number | null>(null);
  const [retentionDraft, setRetentionDraft] = useState('');

  const load = useCallback(async () => {
    if (!vaultPath) { setEntries([]); return; }
    try {
      setEntries(await listTrash(vaultPath));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, [vaultPath]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    getTrashRetentionDays()
      .then(d => { if (alive) { setRetention(d); setRetentionDraft(String(d)); } })
      .catch(() => {
        // Command missing on an older build: fall back to showing the documented
        // default rather than an empty box that looks like "no retention".
        if (alive) { setRetention(DEFAULT_TRASH_RETENTION_DAYS); setRetentionDraft(String(DEFAULT_TRASH_RETENTION_DAYS)); }
      });
    return () => { alive = false; };
  }, []);

  const commitRetention = async () => {
    const parsed = Number(retentionDraft);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setRetentionDraft(String(retention ?? DEFAULT_TRASH_RETENTION_DAYS));
      return;
    }
    const days = Math.round(parsed);
    if (days === retention) return;
    const previous = retention;
    setRetention(days);            // optimistic, same as the permission card
    setRetentionDraft(String(days));
    try {
      await setTrashRetentionDays(days);
      setNotice(isZh
        ? (days === 0 ? '已关闭回收站自动清理' : `保留期已设为 ${days} 天`)
        : (days === 0 ? 'Automatic cleanup disabled' : `Retention set to ${days} day(s)`));
    } catch (e) {
      setRetention(previous);
      setRetentionDraft(String(previous ?? DEFAULT_TRASH_RETENTION_DAYS));
      setError(String(e));
    }
  };


  const handleRestore = async (trashPath: string) => {
    if (!vaultPath) return;
    setBusy(true); setNotice('');
    try {
      const restored = await restoreFromTrash(vaultPath, trashPath);
      setNotice(isZh ? `已恢复：${restored}` : `Restored: ${restored}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const handleEmpty = async () => {
    if (!vaultPath) return;
    const ok = window.confirm(isZh
      ? '彻底清空回收站？此操作不可恢复。'
      : 'Permanently empty the recycle bin? This cannot be undone.');
    if (!ok) return;
    setBusy(true); setNotice('');
    try {
      const removed = await emptyTrash(vaultPath);   // no older-than → clear all
      setNotice(isZh ? `已清除 ${removed} 个文件` : `Removed ${removed} file(s)`);
      await load();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconTrash size={18} /> {isZh ? '回收站' : 'Recycle bin'}
      </h2>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
        {isZh
          ? '删除的笔记（无论是你还是 Agent 删的）都会先进这里，存放在 .zettelagent/trash/，可随时恢复。'
          : 'Deleted notes — whether you or the agent removed them — land here in .zettelagent/trash/ and can be restored.'}
      </div>

      {/* Retention window. Independent of whether a vault is open, because it is
          an app-level setting the sweep reads on every launch. */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 'var(--space-4)',
        padding: 'var(--space-3)',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--space-3)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor="trash-retention-days" style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            {isZh ? '自动清理保留期' : 'Automatic cleanup retention'}
          </label>
          <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>
            {isZh
              ? '超过这个天数的回收站批次会在启动时被自动清除。填 0 表示关闭自动清理 —— 是「永不自动删」，不是「立刻全清」。'
              : 'Trash batches older than this many days are swept on launch. 0 disables the sweep entirely — it means "never auto-delete", not "delete everything now".'}
          </span>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)', marginTop: 4 }}>
            {isZh ? `默认 ${DEFAULT_TRASH_RETENTION_DAYS} 天` : `default ${DEFAULT_TRASH_RETENTION_DAYS} days`}
            {retention === 0 ? (isZh ? ' · 当前：已关闭' : ' · currently: disabled') : ''}
          </span>
        </div>
        <input
          id="trash-retention-days"
          data-testid="trash-retention-days"
          className="input"
          type="number"
          min={0}
          max={3650}
          step={1}
          value={retentionDraft}
          onChange={e => setRetentionDraft(e.target.value)}
          onBlur={commitRetention}
          onKeyDown={e => { if (e.key === 'Enter') { commitRetention(); e.currentTarget.blur(); } }}
          style={{ width: 100, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}
        />
      </div>


      {!vaultPath && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <IconWarning size={14} /> {isZh ? '未打开笔记库' : 'No vault open'}
        </div>
      )}

      {vaultPath && (
        <>
          <div style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            maxHeight: 300,
            overflowY: 'auto',
          }}>
            {entries.length === 0 && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', padding: 'var(--space-3) 0', textAlign: 'center' }}>
                {isZh ? '回收站是空的' : 'The recycle bin is empty'}
              </div>
            )}
            {entries.map(entry => (
              <div key={entry.trash_path} style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-3)',
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
              }}>
                <IconFile size={14} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <code style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, wordBreak: 'break-all' }}>
                    {entry.original_relative_path}
                  </code>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {formatStamp(entry.deleted_at)} · {formatBytes(entry.size)}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleRestore(entry.trash_path)}
                  disabled={busy}
                  title={isZh ? '恢复到原位置' : 'Restore to original location'}
                >
                  {isZh ? '恢复' : 'Restore'}
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <button className="btn btn-sm btn-secondary" onClick={load} disabled={busy}>
              <IconSync size={14} /> {isZh ? '刷新' : 'Refresh'}
            </button>
            {entries.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={handleEmpty} disabled={busy} style={{ color: 'var(--danger)' }}>
                <IconTrash size={14} /> {isZh ? '清空回收站' : 'Empty recycle bin'}
              </button>
            )}
          </div>
        </>
      )}

      {notice && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success, #22c55e)', marginTop: 'var(--space-2)' }}>{notice}</div>
      )}
      {error && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-2)' }}>{error}</div>
      )}
    </div>
  );
}


