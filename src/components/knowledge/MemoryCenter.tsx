import { useState } from 'react';
import {
  MemoryDetail,
  MemoryItem,
  MemoryKind,
  MemoryLifecycle,
  confirmMemory,
  editMemory,
  forgetMemory,
  getMemoryDetail,
  listMemories,
  rejectMemory,
  restoreMemory,
  syncMemoryFile,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { KcEmpty, KcFailed, KcLoading, KcPill, KcTone, translateCode, useAsync } from './states';
import { EvidenceList } from './EvidenceDrawer';

/**
 * Memory Center —— “你到底记住了我什么”。
 *
 * 与聊天侧栏那个 Memory tab 的分工是刻意的：侧栏只放收件箱（等我裁决的候选），这里
 * 是全量视图。三条设计决定：
 *
 * 1. **默认显示全部生命周期**，包括被替换的、我否掉的、已遗忘的。只显示"生效中"会
 *    让用户无从回答"我是不是拒绝过这条"，也看不到自己的历史被怎么改写的。
 * 2. **状态说人话**：`superseded` 显示成"已被替换"，`archived` 显示成"你否掉的"。
 *    Rust 枚举名不进界面。
 * 3. **改写不是覆盖**：保存后端会新提一条取代旧的，所以这里保存完必须重新拉列表
 *    （新条目 id 不同），并且文案先说清"旧说法留在历史里"。
 */

const LIFECYCLES: MemoryLifecycle[] = [
  'candidate',
  'active',
  'verified',
  'superseded',
  'expired',
  'archived',
  'forgotten',
];

const KINDS: MemoryKind[] = [
  'profile',
  'semantic',
  'procedural',
  'episodic',
  'resource',
  'task',
  'error',
];

/** 状态的语气。只有"等你裁决"需要催一下，历史状态是中性的。 */
function lifecycleTone(lifecycle: MemoryLifecycle): KcTone {
  switch (lifecycle) {
    case 'candidate':
      return 'info';
    case 'active':
    case 'verified':
      return 'success';
    case 'archived':
    case 'forgotten':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function MemoryCenter({
  vaultPath,
  onChanged,
  onOpenSource,
}: {
  vaultPath: string | null;
  /** 记忆数量变了就通知外面刷新角标。 */
  onChanged?: () => void;
  onOpenSource?: (locator: string) => void;
}) {
  const [lifecycles, setLifecycles] = useState<MemoryLifecycle[]>([]);
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [search, setSearch] = useState('');

  const { data, error, busy, reload } = useAsync<MemoryItem[]>(
    () =>
      listMemories({
        lifecycles: lifecycles.length ? lifecycles : undefined,
        kinds: kind ? [kind] : undefined,
        search: search.trim() || undefined,
        limit: 200,
      }),
    [lifecycles.join(','), kind, search.trim()],
  );

  const filtered = lifecycles.length > 0 || !!kind || !!search.trim();

  const afterChange = async () => {
    await reload();
    onChanged?.();
  };

  return (
    <div className="kc-memory">
      <MemoryFileSyncRow vaultPath={vaultPath} onSynced={afterChange} />

      <div className="kc-filters">
        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.memory.searchLabel')}</span>
          <input
            className="kc-input"
            type="search"
            value={search}
            placeholder={t('knowledge.memory.searchPlaceholder')}
            onChange={e => setSearch(e.target.value)}
          />
        </label>

        <fieldset className="kc-chipset">
          <legend className="kc-field-label">{t('knowledge.memory.filterState')}</legend>
          {LIFECYCLES.map(l => {
            const on = lifecycles.includes(l);
            return (
              <label className={`kc-chip ${on ? 'active' : ''}`} key={l}>
                <input
                  type="checkbox"
                  className="kc-chip-input"
                  checked={on}
                  onChange={() =>
                    setLifecycles(prev => (on ? prev.filter(x => x !== l) : [...prev, l]))
                  }
                />
                {translateCode('knowledge.lifecycle.', l)}
              </label>
            );
          })}
        </fieldset>

        <label className="kc-field">
          <span className="kc-field-label">{t('knowledge.memory.filterKind')}</span>
          <select className="kc-input" value={kind} onChange={e => setKind(e.target.value as MemoryKind | '')}>
            <option value="">{t('knowledge.memory.allKinds')}</option>
            {KINDS.map(k => (
              <option value={k} key={k}>
                {translateCode('knowledge.kind.', k)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <KcFailed error={error} onRetry={reload} />
      ) : !data ? (
        <KcLoading />
      ) : data.length === 0 ? (
        <KcEmpty
          title={t(filtered ? 'knowledge.memory.emptyFiltered' : 'knowledge.memory.empty')}
          hint={t(filtered ? 'knowledge.memory.emptyFilteredHint' : 'knowledge.memory.emptyHint')}
          action={
            filtered
              ? {
                  label: t('knowledge.memory.clearFilters'),
                  onClick: () => {
                    setLifecycles([]);
                    setKind('');
                    setSearch('');
                  },
                }
              : undefined
          }
        />
      ) : (
        <div className="kc-list" aria-busy={busy}>
          <div className="kc-muted">{tf('knowledge.memory.count', data.length)}</div>
          {data.map(item => (
            <MemoryCard
              key={item.id}
              item={item}
              vaultPath={vaultPath}
              onChanged={afterChange}
              onOpenSource={onOpenSource}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** `memory.md` 回流。三种状态都要留着这个入口——收件箱空的时候恰恰最想手改文件。 */
function MemoryFileSyncRow({
  vaultPath,
  onSynced,
}: {
  vaultPath: string | null;
  onSynced: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (!vaultPath) return <div className="kc-muted">{t('knowledge.memory.noVault')}</div>;

  const run = async () => {
    setBusy(true);
    setNote(null);
    setFailed(null);
    try {
      const r = await syncMemoryFile(vaultPath);
      setNote(tf('knowledge.memory.syncResult', r.adopted, r.unchanged, r.forgotten));
      onSynced();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kc-note">
      <div>{t('knowledge.memory.syncHint')}</div>
      <div className="kc-item-actions">
        <button className="kc-btn" disabled={busy} onClick={() => void run()}>
          {busy ? t('knowledge.memory.syncing') : t('knowledge.memory.syncFile')}
        </button>
        {note && <span className="kc-muted">{note}</span>}
      </div>
      {failed && (
        <div className="kc-warn" role="alert">
          {t('knowledge.loadFailed')}
          <details className="kc-details">
            <summary>{t('knowledge.advanced')}</summary>
            <pre className="kc-pre">{failed}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

function MemoryCard({
  item,
  vaultPath,
  onChanged,
  onOpenSource,
}: {
  item: MemoryItem;
  vaultPath: string | null;
  onChanged: () => void;
  onOpenSource?: (locator: string) => void;
}) {
  const [acting, setActing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.claim);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setActing(true);
    setFailed(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const openDetail = async () => {
    setShowDetail(v => !v);
    if (detail) return;
    setFailed(null);
    try {
      setDetail(await getMemoryDetail(item.id));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  const pending = item.lifecycle === 'candidate';
  const live = item.lifecycle === 'active' || item.lifecycle === 'verified';
  const undoable = item.lifecycle === 'archived' || item.lifecycle === 'forgotten';

  return (
    <div className="kc-card">
      <div className="kc-card-head">
        <KcPill tone={lifecycleTone(item.lifecycle)} label={translateCode('knowledge.lifecycle.', item.lifecycle)} />
        <span className="kc-muted">{translateCode('knowledge.kind.', item.kind)}</span>
      </div>

      {editing ? (
        <div className="kc-edit">
          <textarea
            className="kc-input kc-textarea"
            value={draft}
            rows={3}
            aria-label={t('knowledge.memory.edit')}
            onChange={e => setDraft(e.target.value)}
          />
          <div className="kc-muted">{t('knowledge.memory.editHint')}</div>
          <div className="kc-item-actions">
            <button
              className="kc-btn kc-btn-primary"
              disabled={acting || !draft.trim()}
              onClick={() =>
                void act(async () => {
                  await editMemory(item.id, draft);
                  setEditing(false);
                })
              }
            >
              {t('knowledge.memory.save')}
            </button>
            <button
              className="kc-btn"
              disabled={acting}
              onClick={() => {
                setDraft(item.claim);
                setEditing(false);
              }}
            >
              {t('knowledge.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="kc-card-title">{item.claim}</div>
      )}

      {!item.confirmed_by && !pending && (
        <div className="kc-muted">{t('knowledge.memory.notConfirmed')}</div>
      )}

      {!editing && (
        <div className="kc-item-actions">
          {pending && (
            <>
              <button
                className="kc-btn kc-btn-primary"
                disabled={acting}
                onClick={() => void act(() => confirmMemory(item.id, vaultPath ?? undefined))}
              >
                {t('knowledge.action.confirm')}
              </button>
              <button className="kc-btn" disabled={acting} onClick={() => void act(() => rejectMemory(item.id))}>
                {t('knowledge.action.reject')}
              </button>
            </>
          )}
          {(pending || live) && (
            <button className="kc-btn" disabled={acting} onClick={() => setEditing(true)}>
              {t('knowledge.memory.edit')}
            </button>
          )}
          {live && (
            <button className="kc-btn kc-btn-danger" disabled={acting} onClick={() => void act(() => forgetMemory(item.id))}>
              {t('knowledge.action.forget')}
            </button>
          )}
          {undoable && (
            <button className="kc-btn" disabled={acting} onClick={() => void act(() => restoreMemory(item.id))}>
              {t('knowledge.memory.restore')}
            </button>
          )}
          <button className="kc-btn kc-btn-quiet" onClick={() => void openDetail()}>
            {t('knowledge.memory.details')}
          </button>
        </div>
      )}

      {failed && (
        <div className="kc-warn" role="alert">
          {t('knowledge.loadFailed')}
          <details className="kc-details">
            <summary>{t('knowledge.advanced')}</summary>
            <pre className="kc-pre">{failed}</pre>
          </details>
        </div>
      )}

      {showDetail && <MemoryProvenance detail={detail} item={item} onOpenSource={onOpenSource} />}
    </div>
  );
}

/** 一条记忆的来历：取代链、冲突对、证据。 */
function MemoryProvenance({
  detail,
  item,
  onOpenSource,
}: {
  detail: MemoryDetail | null;
  item: MemoryItem;
  onOpenSource?: (locator: string) => void;
}) {
  if (!detail) return <KcLoading rows={2} />;

  return (
    <div className="kc-drawer">
      {detail.supersededBy && (
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.memory.replacedBy')}</span>
          <span className="kc-kv-val">{detail.supersededBy.claim}</span>
        </div>
      )}
      {detail.supersedes && (
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.memory.replaces')}</span>
          <span className="kc-kv-val">{detail.supersedes.claim}</span>
        </div>
      )}
      {detail.conflictsWith && (
        <div className="kc-warn">
          <span className="kc-kv-key">{t('knowledge.memory.conflictsWith')}</span>
          <span className="kc-kv-val">{detail.conflictsWith.claim}</span>
        </div>
      )}

      {detail.evidence.length === 0 ? (
        <div className="kc-muted">{t('knowledge.memory.noEvidence')}</div>
      ) : (
        <EvidenceList items={detail.evidence} onOpenSource={onOpenSource} />
      )}

      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.memory.updated')}</span>
        <span className="kc-kv-val">{new Date(item.updated_at_ms).toLocaleString()}</span>
      </div>
      {item.confirmed_by && (
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.memory.confirmedBy')}</span>
          <span className="kc-kv-val">{item.confirmed_by}</span>
        </div>
      )}
      {item.expires_at_ms && (
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.memory.expires')}</span>
          <span className="kc-kv-val">{new Date(item.expires_at_ms).toLocaleString()}</span>
        </div>
      )}

      {/* 置信度是模型的自评分，不是"这条有多真"。放在技术详情里，别让它被当成权威。 */}
      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.memory.confidence')}</span>
          <span className="kc-kv-val kc-mono">{item.confidence.toFixed(2)}</span>
        </div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.memory.scope')}</span>
          <span className="kc-kv-val kc-mono">{item.scope || '—'}</span>
        </div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">id</span>
          <span className="kc-kv-val kc-mono">{item.id}</span>
        </div>
      </details>
    </div>
  );
}
