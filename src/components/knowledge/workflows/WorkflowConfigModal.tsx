import React, { useState } from 'react';
import type { WorkflowConfig } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import { IconClose } from '../../icons';

interface WorkflowConfigModalProps {
  config: WorkflowConfig;
  isOpen: boolean;
  onClose: () => void;
  onSave: (updated: WorkflowConfig) => Promise<void>;
}

export const WorkflowConfigModal: React.FC<WorkflowConfigModalProps> = ({
  config,
  isOpen,
  onClose,
  onSave,
}) => {
  const [enabled, setEnabled] = useState(config.enabled);
  const [maxApiCalls, setMaxApiCalls] = useState(config.budget.max_api_calls);
  const [maxTokens, setMaxTokens] = useState(config.budget.max_tokens);
  const [pathPattern, setPathPattern] = useState(config.scope.path_patterns.join(', '));
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated: WorkflowConfig = {
        ...config,
        enabled,
        budget: {
          ...config.budget,
          max_api_calls: Number(maxApiCalls),
          max_tokens: Number(maxTokens),
        },
        scope: {
          ...config.scope,
          path_patterns: pathPattern.split(',').map((s) => s.trim()).filter(Boolean),
        },
        updated_at: new Date().toISOString(),
      };
      await onSave(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wf-modal-overlay" role="dialog" aria-modal="true">
      <div className="wf-modal-content">
        <div className="wf-modal-header">
          <h3>配置工作流: {config.name}</h3>
          <button type="button" className="wf-close-btn" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="wf-config-form">
          <div className="wf-form-group">
            <label className="wf-checkbox-label">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>启用此工作流 (Active)</span>
            </label>
          </div>

          <div className="wf-form-group">
            <label>单次执行最大 API 调用数 (熔断上限)</label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxApiCalls}
              onChange={(e) => setMaxApiCalls(Number(e.target.value))}
              required
            />
            <span className="wf-form-hint">达到调用次数上限立即优雅中止并保存阶段产物，防止死循环。</span>
          </div>

          <div className="wf-form-group">
            <label>单次执行最大 Token 预算 (Token Cap)</label>
            <input
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              required
            />
            <span className="wf-form-hint">保护外部 LLM API 额度，杜绝意外烧光 token。</span>
          </div>

          <div className="wf-form-group">
            <label>扫描路径作用域模式 (逗号分隔)</label>
            <input
              type="text"
              value={pathPattern}
              onChange={(e) => setPathPattern(e.target.value)}
              required
            />
            <span className="wf-form-hint">例如: _sources/** 或 **/*.md</span>
          </div>

          <div className="wf-modal-actions">
            <button type="button" className="wf-btn wf-btn-secondary" onClick={onClose} disabled={saving}>
              {t('knowledge.cancel')}
            </button>
            <button type="submit" className="wf-btn wf-btn-primary" disabled={saving}>
              {saving ? '保存中...' : '保存配置'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
