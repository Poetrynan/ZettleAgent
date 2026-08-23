import { EvidenceRecord, getEvidenceByIds } from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { KcFailed, KcLoading, useAsync } from './states';

/**
 * 证据抽屉 / the evidence drawer.
 *
 * 一条结论要么能指回原文，要么不能——这个抽屉的全部作用就是把这件事摊开。
 *
 * 三种“说不出口”的情况都必须显式说出来，因为它们都会影响用户该不该相信这条结论：
 * 1. 没有绑定证据：无法验证，按未确认对待；
 * 2. 绑定了但取不到（id 在，行没了）：库里已经没有这条记录，不显示空白占位；
 * 3. 有记录但 `locator` 为 null：追不回原文位置。
 */

export function EvidenceDrawer({
  evidenceIds,
  onClose,
  onOpenSource,
}: {
  evidenceIds: string[];
  onClose: () => void;
  /** 打开证据指向的原文。没传就不显示“打开来源”。 */
  onOpenSource?: (locator: string) => void;
}) {
  const { data, error, busy, reload } = useAsync<EvidenceRecord[]>(
    () => getEvidenceByIds(evidenceIds),
    [evidenceIds.join(',')],
  );

  // 取不到的 id 不会返回占位行，所以差值就是“已经不在库里”的条数。
  const missing = data ? evidenceIds.length - data.length : 0;

  return (
    <div className="kc-drawer" role="dialog" aria-label={t('knowledge.evidence.title')}>
      <div className="kc-drawer-head">
        <span className="kc-drawer-title">{t('knowledge.evidence.title')}</span>
        <button className="kc-btn kc-btn-quiet" onClick={onClose}>
          {t('knowledge.evidence.close')}
        </button>
      </div>

      {evidenceIds.length === 0 ? (
        <div className="kc-empty">
          <div className="kc-empty-title">{t('knowledge.evidence.empty')}</div>
          <div className="kc-empty-hint">{t('knowledge.evidence.emptyHint')}</div>
        </div>
      ) : error ? (
        <KcFailed error={error} onRetry={reload} />
      ) : !data ? (
        <KcLoading rows={2} />
      ) : (
        <div className="kc-drawer-body" aria-busy={busy}>
          {missing > 0 && (
            <div className="kc-warn" role="status">
              {tf('knowledge.evidence.missing', missing)}
            </div>
          )}
          {data.map(ev => (
            <EvidenceCard key={ev.id} ev={ev} onOpenSource={onOpenSource} />
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceCard({
  ev,
  onOpenSource,
}: {
  ev: EvidenceRecord;
  onOpenSource?: (locator: string) => void;
}) {
  return (
    <div className="kc-evidence">
      <div className="kc-evidence-head">
        <span className="kc-evidence-source">{shortSourceLabel(ev)}</span>
        {ev.locator && onOpenSource ? (
          <button className="kc-btn kc-btn-quiet" onClick={() => onOpenSource(ev.locator!)}>
            {t('knowledge.context.openSource')}
          </button>
        ) : (
          !ev.locator && <span className="kc-muted">{t('knowledge.context.noLocator')}</span>
        )}
      </div>

      <div className="kc-evidence-excerpt">
        {ev.excerpt ? ev.excerpt : <span className="kc-muted">{t('knowledge.evidence.noExcerpt')}</span>}
      </div>

      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.evidence.capturedAt')}</span>
        <span className="kc-kv-val">{new Date(ev.captured_at_ms).toLocaleString()}</span>
      </div>

      {/* 主界面不出现 id、checksum、pipeline 版本；排查的人才需要它们。 */}
      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <div className="kc-kv-row">
          <span className="kc-kv-key">id</span>
          <span className="kc-kv-val kc-mono">{ev.id}</span>
        </div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.source')}</span>
          <span className="kc-kv-val kc-mono">{ev.source_type}:{ev.source_id}</span>
        </div>
        {ev.locator && (
          <div className="kc-kv-row">
            <span className="kc-kv-key">locator</span>
            <span className="kc-kv-val kc-mono">{ev.locator}</span>
          </div>
        )}
        {ev.checksum && (
          <div className="kc-kv-row">
            <span className="kc-kv-key">checksum</span>
            <span className="kc-kv-val kc-mono">{ev.checksum}</span>
          </div>
        )}
        {(ev.extraction_model || ev.pipeline_version) && (
          <div className="kc-kv-row">
            <span className="kc-kv-key">{t('knowledge.evidence.extractedBy')}</span>
            <span className="kc-kv-val kc-mono">
              {[ev.extraction_model, ev.pipeline_version].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}
        {ev.author && (
          <div className="kc-kv-row">
            <span className="kc-kv-key">author</span>
            <span className="kc-kv-val kc-mono">{ev.author}</span>
          </div>
        )}
      </details>
    </div>
  );
}

/**
 * 人能读的来源名。
 *
 * 绝对路径和 UUID 不进主文案：`locator` 有就取文件名，没有就退回来源类型，
 * 完整值留在技术详情里。
 */
function shortSourceLabel(ev: EvidenceRecord): string {
  if (ev.locator) {
    const path = ev.locator.split('#')[0];
    const name = path.split(/[/\\]/).filter(Boolean).pop();
    if (name) return name;
  }
  return ev.source_type;
}
