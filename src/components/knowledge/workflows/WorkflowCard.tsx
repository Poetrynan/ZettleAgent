import React from 'react';
import type { WorkflowConfig } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import { IconCalendar, IconSliders, IconSparkle } from '../../icons';

interface WorkflowCardProps {
  config: WorkflowConfig;
  busy: boolean;
  onDryRun: (config: WorkflowConfig) => void;
  onRunNow: (config: WorkflowConfig) => void;
  onConfigure: (config: WorkflowConfig) => void;
}

export const WorkflowCard: React.FC<WorkflowCardProps> = ({
  config,
  busy,
  onDryRun,
  onRunNow,
  onConfigure,
}) => {
  const getPipelineLabel = (kind: string) => {
    switch (kind) {
      case 'source_ingestion':
        return t('workflows.pipeline.source_ingestion');
      case 'fact_impact_sentinel':
        return t('workflows.pipeline.fact_impact_sentinel');
      case 'weekly_review':
        return t('workflows.pipeline.weekly_review');
      default:
        return config.name;
    }
  };

  const getTriggerText = () => {
    if (config.trigger.type === 'file_event') {
      return `文件事件: ${config.trigger.path_pattern}`;
    }
    if (config.trigger.type === 'scheduled') {
      const days = Math.round(config.trigger.interval_secs / 86400);
      return `定期调度: 每 ${days || 7} 天`;
    }
    return '手动触发';
  };

  return (
    <div className={`wf-card ${config.enabled ? 'active' : 'paused'}`}>
      <div className="wf-card-header">
        <div className="wf-card-title-group">
          <span className="wf-card-badge">{config.kind}</span>
          <h3 className="wf-card-title">{getPipelineLabel(config.kind)}</h3>
        </div>
        <div className="wf-card-header-actions">
          <span className={`wf-status-pill ${config.enabled ? 'enabled' : 'disabled'}`}>
            {config.enabled ? t('workflows.active') : t('workflows.disabled')}
          </span>
          <button
            type="button"
            className="wf-icon-btn"
            title={t('workflows.configure')}
            onClick={() => onConfigure(config)}
          >
            <IconSliders size={14} />
          </button>
        </div>
      </div>

      <p className="wf-card-desc">{config.description}</p>

      <div className="wf-card-meta-grid">
        <div className="wf-meta-item">
          <IconCalendar size={12} />
          <span className="wf-meta-label">触发规则:</span>
          <span className="wf-meta-value">{getTriggerText()}</span>
        </div>
        <div className="wf-meta-item">
          <IconSparkle size={12} />
          <span className="wf-meta-label">单次预算上限:</span>
          <span className="wf-meta-value">
            {config.budget.max_api_calls} 次调用 / {config.budget.max_tokens.toLocaleString()} tokens
          </span>
        </div>
      </div>

      <div className="wf-card-actions">
        <button
          type="button"
          className="wf-btn wf-btn-secondary"
          disabled={busy}
          onClick={() => onDryRun(config)}
        >
          {t('workflows.dryRun')}
        </button>
        <button
          type="button"
          className="wf-btn wf-btn-primary"
          disabled={busy || !config.enabled}
          onClick={() => onRunNow(config)}
        >
          {t('workflows.runNow')}
        </button>
      </div>
    </div>
  );
};
