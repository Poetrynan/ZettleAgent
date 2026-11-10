import React from 'react';
import type { WorkflowRunRecord } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import { IconCheck, IconClose, IconExternalLink, IconTimeline, IconWarning } from '../../icons';

interface WorkflowHistoryTableProps {
  history: WorkflowRunRecord[];
  onOpenChangeReview?: (changesetId?: string) => void;
}

export const WorkflowHistoryTable: React.FC<WorkflowHistoryTableProps> = ({
  history,
  onOpenChangeReview,
}) => {
  if (history.length === 0) {
    return (
      <div className="wf-history-empty">
        <IconTimeline size={24} />
        <p>{t('workflows.emptyHistory')}</p>
      </div>
    );
  }

  const renderStatus = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <span className="wf-badge-status success">
            <IconCheck size={11} /> 完成
          </span>
        );
      case 'budget_exhausted':
        return (
          <span className="wf-badge-status warning">
            <IconWarning size={11} /> 触碰预算熔断
          </span>
        );
      case 'failed':
        return (
          <span className="wf-badge-status error">
            <IconClose size={11} /> 失败
          </span>
        );
      default:
        return <span className="wf-badge-status neutral">{status}</span>;
    }
  };

  return (
    <div className="wf-history-table-container">
      <table className="wf-history-table">
        <thead>
          <tr>
            <th>触发时间</th>
            <th>工作流</th>
            <th>执行模式</th>
            <th>状态</th>
            <th>耗时</th>
            <th>预算消耗</th>
            <th>处理项</th>
            <th>变更提案</th>
          </tr>
        </thead>
        <tbody>
          {history.map((rec) => (
            <tr key={rec.id}>
              <td className="wf-time-cell">
                {new Date(rec.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </td>
              <td>
                <span className="wf-table-kind">{rec.kind}</span>
              </td>
              <td>
                {rec.is_dry_run ? (
                  <span className="wf-pill-mode dry">试运行 (Dry)</span>
                ) : (
                  <span className="wf-pill-mode live">正式执行</span>
                )}
              </td>
              <td>{renderStatus(rec.status)}</td>
              <td>{(rec.duration_ms / 1000).toFixed(1)}s</td>
              <td className="wf-budget-cell">
                {rec.api_calls_used} 次 / {rec.tokens_used.toLocaleString()} t
              </td>
              <td>{rec.items_processed} 项</td>
              <td>
                {rec.changeset_id ? (
                  <button
                    type="button"
                    className="wf-link-btn"
                    title={`审查变更集: ${rec.changeset_id}`}
                    onClick={() => onOpenChangeReview?.(rec.changeset_id)}
                  >
                    <span>待审提案</span>
                    <IconExternalLink size={11} />
                  </button>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
