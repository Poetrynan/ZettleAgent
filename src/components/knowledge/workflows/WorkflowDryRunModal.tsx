import React, { useState } from 'react';
import type { WorkflowRunResult } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import { IconCheck, IconClose, IconFile, IconSparkle, IconWarning } from '../../icons';

interface WorkflowDryRunModalProps {
  result: WorkflowRunResult | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmLive: () => void;
  busy: boolean;
}

export const WorkflowDryRunModal: React.FC<WorkflowDryRunModalProps> = ({
  result,
  isOpen,
  onClose,
  onConfirmLive,
  busy,
}) => {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);

  if (!isOpen || !result) return null;

  return (
    <div className="wf-modal-overlay" role="dialog" aria-modal="true">
      <div className="wf-modal-content wf-modal-lg">
        <div className="wf-modal-header">
          <div>
            <h3>{t('workflows.dryRun.title')}</h3>
            <p className="wf-modal-subtitle">
              模拟执行完成：处理了 {result.items_processed} 项，产生了 {result.actions.length} 项拟执行动作（零实际写入）。
            </p>
          </div>
          <button type="button" className="wf-close-btn" onClick={onClose} disabled={busy}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="wf-dryrun-metrics-grid">
          <div className="wf-dryrun-metric">
            <span className="metric-label">预估 API 调用:</span>
            <span className="metric-value">{result.api_calls_used} 次</span>
          </div>
          <div className="wf-dryrun-metric">
            <span className="metric-label">预估 Token 消耗:</span>
            <span className="metric-value">{result.tokens_used.toLocaleString()} tokens</span>
          </div>
          <div className="wf-dryrun-metric">
            <span className="metric-label">运行状态:</span>
            <span className="metric-value text-success">
              <IconCheck size={12} /> 模拟验证通过
            </span>
          </div>
        </div>

        <div className="wf-dryrun-actions-list">
          <h4>{t('workflows.dryRun.simulatedActions')}</h4>
          {result.actions.length === 0 ? (
            <div className="wf-empty-actions">
              <IconWarning size={16} />
              <span>本次扫描未发现满足条件的待处理项。</span>
            </div>
          ) : (
            result.actions.map((act, idx) => (
              <div key={idx} className="wf-action-item">
                <div
                  className="wf-action-summary-row"
                  onClick={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
                >
                  <IconFile size={14} />
                  <span className="wf-action-badge">{act.action_type}</span>
                  <span className="wf-action-target">{act.target}</span>
                  <span className="wf-action-desc">{act.description}</span>
                  <span className="wf-expand-indicator">
                    {expandedIndex === idx ? '▲ 收起差异' : '▼ 查看差异'}
                  </span>
                </div>

                {expandedIndex === idx && act.diff_preview && (
                  <pre className="wf-action-diff">{act.diff_preview}</pre>
                )}
              </div>
            ))
          )}
        </div>

        <div className="wf-modal-actions">
          <button type="button" className="wf-btn wf-btn-secondary" onClick={onClose} disabled={busy}>
            {t('knowledge.cancel')}
          </button>
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={onConfirmLive}
            disabled={busy || result.actions.length === 0}
          >
            <IconSparkle size={14} />
            {busy ? '执行中...' : t('workflows.dryRun.confirmRun')}
          </button>
        </div>
      </div>
    </div>
  );
};
