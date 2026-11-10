import React, { useCallback, useEffect, useState } from 'react';
import {
  getWorkflowConfigs,
  getWorkflowHistory,
  runWorkflowNow,
  updateWorkflowConfig,
  type WorkflowConfig,
  type WorkflowRunRecord,
  type WorkflowRunResult,
} from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import { IconSync, IconTimeline, IconWarning } from '../../icons';
import { WorkflowCard } from './WorkflowCard';
import { WorkflowConfigModal } from './WorkflowConfigModal';
import { WorkflowDryRunModal } from './WorkflowDryRunModal';
import { WorkflowHistoryTable } from './WorkflowHistoryTable';

interface WorkflowDashboardProps {
  vaultPath: string | null;
  onOpenChangeReview?: (changesetId?: string) => void;
}

export const WorkflowDashboard: React.FC<WorkflowDashboardProps> = ({
  vaultPath,
  onOpenChangeReview,
}) => {
  const [configs, setConfigs] = useState<WorkflowConfig[]>([]);
  const [history, setHistory] = useState<WorkflowRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [activeConfigForEdit, setActiveConfigForEdit] = useState<WorkflowConfig | null>(null);
  const [dryRunResult, setDryRunResult] = useState<WorkflowRunResult | null>(null);
  const [isDryRunModalOpen, setIsDryRunModalOpen] = useState(false);
  const [selectedWorkflowForLive, setSelectedWorkflowForLive] = useState<WorkflowConfig | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [cfgs, hist] = await Promise.all([
        getWorkflowConfigs(),
        getWorkflowHistory(undefined, 30),
      ]);
      setConfigs(cfgs);
      setHistory(hist);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDryRun = async (config: WorkflowConfig) => {
    setBusy(true);
    setSelectedWorkflowForLive(config);
    try {
      const res = await runWorkflowNow(config.id, true, vaultPath || undefined);
      setDryRunResult(res);
      setIsDryRunModalOpen(true);
    } catch (e) {
      setError(`试运行失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRunNow = async (config: WorkflowConfig) => {
    setBusy(true);
    try {
      await runWorkflowNow(config.id, false, vaultPath || undefined);
      await loadData();
    } catch (e) {
      setError(`执行失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmLiveFromModal = async () => {
    if (!selectedWorkflowForLive) return;
    setBusy(true);
    try {
      await runWorkflowNow(selectedWorkflowForLive.id, false, vaultPath || undefined);
      setIsDryRunModalOpen(false);
      await loadData();
    } catch (e) {
      setError(`正式执行失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveConfig = async (updated: WorkflowConfig) => {
    await updateWorkflowConfig(updated);
    await loadData();
  };

  if (loading) {
    return (
      <div className="wf-loading-container">
        <IconSync size={20} spinning />
        <p>{t('knowledge.loading')}</p>
      </div>
    );
  }

  return (
    <div className="wf-dashboard-container">
      <div className="wf-dashboard-header">
        <div>
          <h2 className="wf-dashboard-title">{t('workflows.title')}</h2>
          <p className="wf-dashboard-subtitle">{t('workflows.subtitle')}</p>
        </div>
        <button
          type="button"
          className="wf-btn wf-btn-secondary"
          onClick={loadData}
          disabled={busy}
          title={t('knowledge.refresh')}
        >
          <IconSync size={14} spinning={busy} />
          <span>{t('knowledge.refresh')}</span>
        </button>
      </div>

      {error && (
        <div className="wf-error-banner" role="alert">
          <IconWarning size={16} />
          <span>{error}</span>
          <button type="button" className="wf-error-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* 三大固定流程卡片网格 */}
      <div className="wf-cards-grid">
        {configs.map((cfg) => (
          <WorkflowCard
            key={cfg.id}
            config={cfg}
            busy={busy}
            onDryRun={handleDryRun}
            onRunNow={handleRunNow}
            onConfigure={setActiveConfigForEdit}
          />
        ))}
      </div>

      {/* 运行历史与审计表格 */}
      <div className="wf-history-section">
        <div className="wf-section-title-row">
          <IconTimeline size={16} />
          <h3>{t('workflows.history')}</h3>
        </div>
        <WorkflowHistoryTable history={history} onOpenChangeReview={onOpenChangeReview} />
      </div>

      {/* 配置弹窗 */}
      {activeConfigForEdit && (
        <WorkflowConfigModal
          config={activeConfigForEdit}
          isOpen={!!activeConfigForEdit}
          onClose={() => setActiveConfigForEdit(null)}
          onSave={handleSaveConfig}
        />
      )}

      {/* 试运行预演弹窗 */}
      <WorkflowDryRunModal
        result={dryRunResult}
        isOpen={isDryRunModalOpen}
        onClose={() => setIsDryRunModalOpen(false)}
        onConfirmLive={handleConfirmLiveFromModal}
        busy={busy}
      />
    </div>
  );
};
