import { useState } from 'react';
import {
  knowledgeGraphDecideRelation,
  knowledgeGraphRelationEvidence,
  type GraphEvidence,
  type RelationEvidenceView,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { KcFailed, KcLoading, KcPill, useAsync } from './states';

/**
 * 关系抽屉 / where one edge came from.
 *
 * 图谱上一条线只有颜色，说明不了任何事。这个抽屉负责把一条边身上所有能判断真伪的
 * 信息摊开：
 *
 * - **来历**：`user_link` 是用户自己连的，`agent_proposed` 是 Agent 提议、经审批写入的。
 *   这两者绝不能长得一样——前者不需要用户再判断，后者需要。
 * - **是否确认过**：`confirmed` 为 false 时，即使这条边已经在库里，它也还没被人认过。
 * - **语义**：`supports` / `contradicts` / `depends_on` 必须用人话解释，否则等于没说。
 * - **两端原文**：只到文件级的依据要写明「文件级依据」，不许假装有出处。
 *
 * 复用知识中心的 `kc-*` 抽屉样式，不新建一套视觉语言。
 */

export function RelationEvidenceDrawer({
  sourcePath,
  targetPath,
  relationType,
  onClose,
  onDecided,
  showToast,
}: {
  sourcePath: string;
  targetPath: string;
  relationType: string;
  onClose: () => void;
  /** 用户接受/拒绝之后通知外面刷新图谱。 */
  onDecided?: (accepted: boolean) => void;
  showToast?: (msg: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const [deciding, setDeciding] = useState(false);

  const { data, error, busy, reload } = useAsync<RelationEvidenceView>(
    () => knowledgeGraphRelationEvidence(sourcePath, targetPath, relationType),
    [sourcePath, targetPath, relationType],
  );

  const decide = async (accept: boolean) => {
    setDeciding(true);
    try {
      await knowledgeGraphDecideRelation(sourcePath, targetPath, relationType, accept);
      showToast?.(accept ? t('graph.relation.accepted') : t('graph.relation.rejected'), 'success');
      onDecided?.(accept);
      await reload();
    } catch (e) {
      showToast?.(tf('graph.relation.decideFailed', String(e)), 'error');
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="kc-drawer kg-relation-drawer"
        role="dialog"
        aria-label={t('graph.relation.title')}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="kc-drawer-head">
          <span className="kc-drawer-title">{t('graph.relation.title')}</span>
          <button className="kc-btn kc-btn-quiet" onClick={onClose}>
            {t('graph.relation.close')}
          </button>
        </div>

        {error ? (
          <KcFailed error={error} onRetry={reload} />
        ) : !data ? (
          <KcLoading rows={3} />
        ) : (
          <div className="kc-drawer-body" aria-busy={busy}>
            <RelationFacts
              view={data}
              sourcePath={sourcePath}
              targetPath={targetPath}
              relationType={relationType}
            />

            {data.detail && (
              <div className="kc-card-actions">
                <button
                  className="kc-btn kc-btn-primary"
                  disabled={deciding}
                  onClick={() => decide(true)}
                >
                  {t('graph.relation.accept')}
                </button>
                <button
                  className="kc-btn kc-btn-danger"
                  disabled={deciding}
                  onClick={() => decide(false)}
                >
                  {t('graph.relation.reject')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RelationFacts({
  view,
  sourcePath,
  targetPath,
  relationType,
}: {
  view: RelationEvidenceView;
  sourcePath: string;
  targetPath: string;
  relationType: string;
}) {
  const detail = view.detail;

  return (
    <>
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('graph.relation.direction')}</span>
        <span className="kc-kv-val">
          {shortName(detail?.sourcePath ?? sourcePath)} → {shortName(detail?.targetPath ?? targetPath)}
        </span>
      </div>
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('graph.relation.type')}</span>
        <span className="kc-kv-val kc-mono">{detail?.relationType ?? relationType}</span>
      </div>

      {/* 没有 detail 说明库里根本没有这条边：不画一个空壳，直说。 */}
      {!detail ? (
        <div className="kc-warn" role="status">
          {t('graph.relation.missing')}
        </div>
      ) : (
        <>
          <div className="kc-kv-row">
            <span className="kc-kv-key">{t('graph.relation.origin')}</span>
            <span className="kc-kv-val">{originLabel(detail.origin)}</span>
          </div>
          <div className="kc-kv-row">
            <span className="kc-kv-key">{t('graph.relation.confidence')}</span>
            <span className="kc-kv-val kc-mono">{detail.confidence.toFixed(2)}</span>
          </div>

          {/* 确认状态是一个判断依据，不是装饰：未确认要能一眼看出来。 */}
          <div className="kc-card-actions">
            <KcPill
              tone={detail.confirmed ? 'success' : 'warning'}
              label={detail.confirmed ? t('graph.relation.confirmed') : t('graph.relation.unconfirmed')}
            />
          </div>

          {detail.decision && (
            <div className="kc-note">
              {detail.decision === 'accepted'
                ? t('graph.relation.decision.accepted')
                : detail.decision === 'rejected'
                  ? t('graph.relation.decision.rejected')
                  : detail.decision}
            </div>
          )}

          <div className="kc-card-why">
            <span className="kc-card-why-label">{t('graph.relation.reason')}</span>
            <span>{detail.reason ? detail.reason : <span className="kc-muted">{t('graph.relation.noReason')}</span>}</span>
          </div>
        </>
      )}

      <div className="kc-card-why">
        <span className="kc-card-why-label">{t('graph.relation.semantics')}</span>
        <span>{view.semantics}</span>
      </div>

      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('graph.relation.similarity')}</span>
        <span className="kc-kv-val">
          {view.semanticSimilarity === null ? (
            <span className="kc-muted">{t('graph.relation.noSimilarity')}</span>
          ) : (
            <span className="kc-mono">{view.semanticSimilarity.toFixed(2)}</span>
          )}
        </span>
      </div>

      <div className="kc-card-why">
        <span className="kc-card-why-label">{t('graph.relation.excerpts')}</span>
      </div>
      {view.evidence.map((ev, i) => (
        <GraphEvidenceCard key={`${ev.path}-${i}`} ev={ev} />
      ))}

      {detail && (
        <details className="kc-details">
          <summary>{t('knowledge.advanced')}</summary>
          <div className="kc-kv-row">
            <span className="kc-kv-key">source</span>
            <span className="kc-kv-val kc-mono">{detail.sourcePath}</span>
          </div>
          <div className="kc-kv-row">
            <span className="kc-kv-key">target</span>
            <span className="kc-kv-val kc-mono">{detail.targetPath}</span>
          </div>
          {detail.changesetId && (
            <div className="kc-kv-row">
              <span className="kc-kv-key">changeset</span>
              <span className="kc-kv-val kc-mono">{detail.changesetId}</span>
            </div>
          )}
          {detail.createdAt && (
            <div className="kc-kv-row">
              <span className="kc-kv-key">createdAt</span>
              <span className="kc-kv-val kc-mono">{detail.createdAt}</span>
            </div>
          )}
        </details>
      )}
    </>
  );
}

/**
 * 一条图谱证据 / one piece of graph evidence.
 *
 * `kind === 'file_level'` 或 `chunkId === null` 都表示这条依据只指到文件，指不回段落。
 * 这必须写在界面上，否则用户会以为它有原文出处。
 */
export function GraphEvidenceCard({ ev }: { ev: GraphEvidence }) {
  const fileLevel = ev.kind === 'file_level' || ev.chunkId === null;
  return (
    <div className="kc-evidence">
      <div className="kc-evidence-head">
        <span className="kc-evidence-source">{shortName(ev.path)}</span>
        {fileLevel && <KcPill tone="warning" label={t('gap.plan.fileLevelEvidence')} />}
      </div>
      <div className="kc-evidence-excerpt">
        {ev.excerpt ? ev.excerpt : <span className="kc-muted">{t('gap.plan.noExcerpt')}</span>}
      </div>
      {fileLevel && <div className="kc-muted">{t('gap.plan.fileLevelHint')}</div>}
    </div>
  );
}

/** 来历必须是人话，`agent_proposed` 直接印出来等于没解释。 */
export function originLabel(origin: string): string {
  if (origin === 'user_link') return t('graph.relation.origin.user_link');
  if (origin === 'agent_proposed') return t('graph.relation.origin.agent_proposed');
  return t('graph.relation.origin.other');
}

/** 绝对路径不进主文案，只留文件名。 */
export function shortName(path: string): string {
  const name = path.split(/[/\\]/).filter(Boolean).pop();
  return name || path;
}
