import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useApp } from '../../contexts/AppContext';
import {
  runBatchAgent,
  cancelAgentTurn,
  undoAgentRun,
  type AgentEvent,
  type BatchAgentReport,
} from '../../lib/tauri';
import { t, tf } from '../../lib/i18n';

interface BatchAgentDialogProps {
  filePaths: string[];
  onClose: () => void;
  /** Called after a run finishes or is undone, so the table can reload. */
  onFinished: () => void;
}

interface Progress {
  index: number;
  total: number;
  filePath: string;
}

const PRESET_KEYS = [
  'overview.ai.preset.organize',
  'overview.ai.preset.contradictions',
  'overview.ai.preset.backlinks',
] as const;

type Phase = 'compose' | 'running' | 'done';

/**
 * "Send the selection to the AI" — one instruction, N notes, one undoable run.
 *
 * The dialog owns nothing about *how* the agent edits notes: writes still go
 * through the global `DiffApprovalCard`, which is why the compose step says so
 * out loud. What it does own is the batch's identity: the whole run shares one
 * `runId`, so a single `undoAgentRun` reverses every note it touched.
 */
export function BatchAgentDialog({ filePaths, onClose, onFinished }: BatchAgentDialogProps) {
  const { state, showToast } = useApp();

  const [instruction, setInstruction] = useState('');
  const [continueOnError, setContinueOnError] = useState(true);
  const [phase, setPhase] = useState<Phase>('compose');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [report, setReport] = useState<BatchAgentReport | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);

  // The run id we are currently displaying progress for. Events from any other
  // run (a stale turn, a concurrent chat) must not move this dialog's bar.
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unlisten = listen<AgentEvent>('agent-event', event => {
      const e = event.payload;
      if (e.type !== 'batch_progress') return;
      if (runIdRef.current && e.run_id && e.run_id !== runIdRef.current) return;
      if (!runIdRef.current && e.run_id) runIdRef.current = e.run_id;
      setProgress({
        index: e.index ?? 0,
        total: e.total ?? filePaths.length,
        filePath: e.file_path ?? '',
      });
    });
    return () => { void unlisten.then(fn => fn()); };
  }, [filePaths.length]);

  const handleRun = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!trimmed) {
      showToast(t('overview.ai.needInstruction'), 'error');
      return;
    }
    setPhase('running');
    setProgress(null);
    setCancelling(false);
    runIdRef.current = null;
    try {
      const result = await runBatchAgent({
        filePaths,
        instruction: trimmed,
        vaultPath: state.vaultPath || '',
        model: state.llmConfig.model,
        apiUrl: state.llmConfig.apiUrl,
        apiKey: state.llmConfig.apiKey || undefined,
        providerId: state.llmConfig.providerId,
        methodology: state.methodology,
        continueOnError,
      });
      runIdRef.current = result.runId;
      setReport(result);
      setPhase('done');
      onFinished();
    } catch (err) {
      console.error('[BatchAgent] run failed:', err);
      showToast(`${t('overview.ai.failed')}: ${String(err)}`, 'error');
      setPhase('compose');
    }
  }, [instruction, filePaths, state.vaultPath, state.llmConfig, state.methodology, continueOnError, showToast, onFinished]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await cancelAgentTurn();
    } catch (err) {
      console.warn('[BatchAgent] cancel failed:', err);
      setCancelling(false);
    }
  }, []);

  const handleUndo = useCallback(async () => {
    if (!report) return;
    setUndoing(true);
    try {
      await undoAgentRun(report.runId);
      setUndone(true);
      showToast(t('overview.ai.undoDone'), 'success');
      onFinished();
    } catch (err) {
      console.error('[BatchAgent] undo failed:', err);
      showToast(`${t('overview.ai.undoFailed')}: ${String(err)}`, 'error');
    } finally {
      setUndoing(false);
    }
  }, [report, showToast, onFinished]);

  const skipped = report ? report.total - report.succeeded - report.failed : 0;

  return (
    <div className="overview-modal-backdrop" role="presentation">
      <div className="overview-modal" role="dialog" aria-modal="true" aria-label={t('overview.ai.title')}>
        <div className="overview-modal-header">
          <h3>{t('overview.ai.title')}</h3>
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={onClose}
            aria-label={t('overview.ai.close')}
            disabled={phase === 'running'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {phase === 'compose' && (
          <div className="overview-modal-body">
            <p className="overview-modal-count">{tf('overview.ai.count', filePaths.length)}</p>

            <label className="overview-modal-label" htmlFor="batch-instruction">
              {t('overview.ai.instruction')}
            </label>
            <textarea
              id="batch-instruction"
              className="overview-modal-textarea"
              rows={3}
              value={instruction}
              placeholder={t('overview.ai.instructionPlaceholder')}
              onChange={e => setInstruction(e.target.value)}
            />

            <div className="overview-modal-presets">
              <span className="overview-modal-presets-label">{t('overview.ai.presets')}</span>
              {PRESET_KEYS.map(key => (
                <button
                  key={key}
                  type="button"
                  className="overview-preset-chip"
                  onClick={() => setInstruction(t(key))}
                >
                  {t(key)}
                </button>
              ))}
            </div>

            <label className="overview-modal-checkbox">
              <input
                type="checkbox"
                checked={continueOnError}
                onChange={e => setContinueOnError(e.target.checked)}
              />
              <span>{t('overview.ai.continueOnError')}</span>
            </label>

            <div className="overview-modal-warn" data-testid="batch-approval-warning">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{t('overview.ai.approvalWarn')}</span>
            </div>
          </div>
        )}

        {phase === 'running' && (
          <div className="overview-modal-body">
            <div className="overview-progress-line" data-testid="batch-progress">
              {progress
                ? tf('overview.ai.running', progress.index + 1, progress.total, progress.filePath)
                : t('overview.ai.starting')}
            </div>
            <div className="overview-progress-track">
              <div
                className="overview-progress-fill"
                style={{
                  width: progress && progress.total > 0
                    ? `${Math.round(((progress.index + 1) / progress.total) * 100)}%`
                    : '4%',
                }}
              />
            </div>
            {cancelling && <div className="overview-modal-hint">{t('overview.ai.cancelling')}</div>}
          </div>
        )}

        {phase === 'done' && report && (
          <div className="overview-modal-body">
            <div className="overview-report-summary" data-testid="batch-report">
              <strong>{t('overview.ai.reportTitle')}</strong>
              <span>{tf('overview.ai.reportSummary', report.succeeded, report.failed, skipped)}</span>
              {report.cancelled && <span className="overview-report-cancelled">{t('overview.ai.reportCancelled')}</span>}
            </div>
            <ul className="overview-report-list">
              {report.items.map(item => (
                <li key={item.filePath} className={`overview-report-item overview-report-${item.status}`}>
                  <span className={`overview-status-dot overview-status-${item.status}`} aria-hidden="true" />
                  <span className="overview-report-path">{item.filePath}</span>
                  <span className="overview-report-note">{item.error || item.summary || ''}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="overview-modal-footer">
          {phase === 'compose' && (
            <>
              <button className="btn btn-ghost" onClick={onClose}>{t('overview.ai.cancel')}</button>
              <button className="btn btn-primary" onClick={handleRun} data-testid="batch-run">{t('overview.ai.run')}</button>
            </>
          )}
          {phase === 'running' && (
            <button className="btn btn-ghost" onClick={handleCancel} disabled={cancelling}>
              {t('overview.ai.cancel')}
            </button>
          )}
          {phase === 'done' && report && (
            <>
              <button
                className="btn btn-ghost overview-undo-btn"
                onClick={handleUndo}
                disabled={undoing || undone}
                data-testid="batch-undo"
              >
                {t('overview.ai.undo')}
              </button>
              <button className="btn btn-primary" onClick={onClose}>{t('overview.ai.close')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
