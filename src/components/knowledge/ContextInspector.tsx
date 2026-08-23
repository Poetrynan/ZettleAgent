import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ContextInspectorItem, ContextPackageSummary } from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';
import { KcEmpty, KcPill, translateCode } from './states';
import { EvidenceDrawer } from './EvidenceDrawer';

/**
 * Context Inspector —— “这一轮 Agent 依据什么回答的”。
 *
 * 默认视图说人话：分组标题、召回条目、每条为什么在这儿、哪几条有风险。技术信息
 * （score、objectId、原始 code、token 账）收进“技术详情”，因为普通一轮里用户要
 * 判断的只有一件事：这个答案该不该信。
 *
 * 三处刻意不做的事：
 * 1. **不把 `usedTokens/maxTokens` 画成百分比进度条。** 编译器只把 3/4 预算给
 *    检索，注入的核心记忆与附件根本不计入 `usedTokens`，所以那个比例永远到不了
 *    100%，画成进度条等于告诉用户“还很空”——而真实 prompt 可能已经很大。这里只
 *    给数字，并注明它算的是哪一部分。
 * 2. **不把 warning code 直接显示出来。** 每个 code 都必须有 zh/en 文案；缺翻译
 *    在 dev 下会告警，而不是把 `no_stable_identity` 甩给用户。
 * 3. **不假装能定位到段落。** 编辑器目前只能打开文件，没有行级导航，所以按钮就
 *    叫“打开来源”，`locator` 里的行号只在技术详情里出现。
 */

const SECTION_ORDER = ['current', 'fact', 'memory', 'task', 'related', 'conflict'] as const;

/** 只有 `conflict` 是“必须处理”，其余分组的语气不该像报警。 */
function sectionTone(section: string): 'neutral' | 'warning' {
  return section === 'conflict' ? 'warning' : 'neutral';
}

export function ContextInspector({
  pkg,
  onOpenSource,
  children,
}: {
  pkg: ContextPackageSummary | null;
  /** 打开某条的来源文件。没传就不显示“打开来源”。 */
  onOpenSource?: (locator: string) => void;
  /** 尾部插槽，用于挂本轮审计明细等宿主自己的东西。 */
  children?: ReactNode;
}) {
  const [evidenceFor, setEvidenceFor] = useState<string[] | null>(null);

  const grouped = useMemo(() => groupBySection(pkg?.items ?? []), [pkg]);

  if (!pkg) {
    return (
      <KcEmpty
        title={t('knowledge.context.empty')}
        hint={t('knowledge.context.emptyHint')}
      />
    );
  }

  const ftsOnly = pkg.warnings.includes('fts_only_no_query_embedding');

  return (
    <div className="kc-inspector">
      <div className="kc-kv-row">
        <span className="kc-kv-key">{t('knowledge.context.question')}</span>
        <span className="kc-kv-val">{pkg.query}</span>
      </div>

      <div className="kc-inspector-summary">
        <div className="kc-inspector-count">{tf('knowledge.context.usedCount', pkg.items.length)}</div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.context.scope')}</span>
          <span className="kc-kv-val">
            {pkg.scope.length ? pkg.scope.join(', ') : t('knowledge.context.unscoped')}
          </span>
        </div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.context.recallPath')}</span>
          <span className="kc-kv-val">
            {ftsOnly ? t('knowledge.context.recall.ftsOnly') : t('knowledge.context.recall.hybrid')}
          </span>
        </div>
      </div>

      {/* 包级警示。`fts_only_no_query_embedding` 是最要紧的一条：它直接意味着
          “同义不同词的笔记可能被漏掉”，所以用整句话讲，不用一个标签。 */}
      {pkg.warnings.length > 0 && (
        <div className="kc-warn" role="status">
          {pkg.warnings.map(code => (
            <div className="kc-warn-line" key={code}>
              {translateCode('knowledge.warning.', code)}
            </div>
          ))}
        </div>
      )}

      {pkg.budget.truncatedCandidates > 0 && (
        <div className="kc-warn" role="status">
          {tf('knowledge.context.dropped', pkg.budget.truncatedCandidates)}
        </div>
      )}

      {pkg.items.length === 0 ? (
        <KcEmpty
          title={t('knowledge.context.nothingFound')}
          hint={t('knowledge.context.nothingFoundHint')}
        />
      ) : (
        SECTION_ORDER.filter(s => grouped[s]?.length).map(section => (
          <section className="kc-inspector-section" key={section}>
            <h4 className="kc-section-title">
              {translateCode('knowledge.context.section.', section)}
              <span className="kc-section-n">{grouped[section].length}</span>
            </h4>
            {grouped[section].map((item, idx) => (
              <ContextItemCard
                key={`${item.objectId ?? item.locator ?? idx}`}
                item={item}
                tone={sectionTone(section)}
                onOpenSource={onOpenSource}
                onShowEvidence={() => setEvidenceFor(item.evidenceIds)}
              />
            ))}
          </section>
        ))
      )}

      {pkg.knowledgeGaps.length > 0 && (
        <section className="kc-inspector-section">
          <h4 className="kc-section-title">{t('knowledge.context.gaps')}</h4>
          {pkg.knowledgeGaps.map(gap => (
            <div className="kc-gap" key={gap}>{gap}</div>
          ))}
        </section>
      )}

      {/* token 账是排查信息，不是给用户的进度条。 */}
      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <div className="kc-kv-val kc-mono">
          {tf('knowledge.context.budgetUsed', pkg.budget.usedTokens, pkg.budget.maxTokens)}
        </div>
        <div className="kc-muted">{t('knowledge.context.budgetNote')}</div>
      </details>

      {children}

      {evidenceFor && (
        <EvidenceDrawer
          evidenceIds={evidenceFor}
          onClose={() => setEvidenceFor(null)}
          onOpenSource={onOpenSource}
        />
      )}
    </div>
  );
}

function ContextItemCard({
  item,
  tone,
  onOpenSource,
  onShowEvidence,
}: {
  item: ContextInspectorItem;
  tone: 'neutral' | 'warning';
  onOpenSource?: (locator: string) => void;
  onShowEvidence: () => void;
}) {
  return (
    <div className={`kc-item kc-item-${tone}`}>
      <div className="kc-item-head">
        <span className="kc-item-title">{item.title}</span>
      </div>

      {/* 为什么它在这儿。这是“可解释”的核心，所以在默认视图里，不折叠。 */}
      {item.why.length > 0 && (
        <div className="kc-why">
          {item.why.map(code => (
            <span className="kc-why-item" key={code}>{translateCode('knowledge.why.', code)}</span>
          ))}
        </div>
      )}

      {item.warnings.length > 0 && (
        <div className="kc-item-warnings">
          {item.warnings.map(code => (
            <KcPill key={code} tone="warning" label={translateCode('knowledge.warning.', code)} />
          ))}
        </div>
      )}

      <div className="kc-item-actions">
        {item.locator && onOpenSource ? (
          <button className="kc-btn kc-btn-quiet" onClick={() => onOpenSource(item.locator!)}>
            {t('knowledge.context.openSource')}
          </button>
        ) : (
          !item.locator && <span className="kc-muted">{t('knowledge.context.noLocator')}</span>
        )}
        {item.evidenceIds.length > 0 && (
          <button className="kc-btn kc-btn-quiet" onClick={onShowEvidence}>
            {tf('knowledge.context.evidenceCount', item.evidenceIds.length)}
          </button>
        )}
      </div>

      <details className="kc-details">
        <summary>{t('knowledge.advanced')}</summary>
        <div className="kc-kv-row">
          <span className="kc-kv-key">{t('knowledge.context.score')}</span>
          <span className="kc-kv-val kc-mono">{item.score.toFixed(3)}</span>
        </div>
        <div className="kc-kv-row">
          <span className="kc-kv-key">kind</span>
          <span className="kc-kv-val kc-mono">{item.kind}</span>
        </div>
        {item.objectId && (
          <div className="kc-kv-row">
            <span className="kc-kv-key">objectId</span>
            <span className="kc-kv-val kc-mono">{item.objectId}</span>
          </div>
        )}
        {item.locator && (
          <div className="kc-kv-row">
            <span className="kc-kv-key">locator</span>
            <span className="kc-kv-val kc-mono">{item.locator}</span>
          </div>
        )}
      </details>
    </div>
  );
}

/**
 * 按后端给的 `section` 分组。
 *
 * 旧事件没有 `section` 字段（升级前发出的那一轮仍在内存里），落到 `fact` 而不是
 * 丢掉——宁可分组略粗，也不能让条目从界面上消失。
 */
function groupBySection(items: ContextInspectorItem[]): Record<string, ContextInspectorItem[]> {
  const out: Record<string, ContextInspectorItem[]> = {};
  for (const item of items) {
    const key = SECTION_ORDER.includes(item.section as never) ? item.section : 'fact';
    (out[key] ||= []).push(item);
  }
  return out;
}
