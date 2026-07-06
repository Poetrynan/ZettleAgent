/**
 * Agent Progress Panel
 * 
 * Real-time progress visualization for agent execution.
 * Inspired by Manus "Manus's Computer" panel.
 */

import { t } from '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

export interface ProgressStep {
    id: string;
    label: string;
    status: 'pending' | 'running' | 'done' | 'error';
    duration?: number;
    details?: string;
}

interface AgentProgressPanelProps {
    isVisible: boolean;
    currentAgent: string;
    steps: ProgressStep[];
    overallProgress?: number; // 0-100
    onToggle: () => void;
}

// ── Agent Icons ────────────────────────────────────────────────────

const AGENT_ICONS: Record<string, string> = {
    'knowledge': '🔬',
    'creator': '✍️',
    'curator': '📦',
    'Knowledge Agent': '🔬',
    'Creator Agent': '✍️',
    'Curator Agent': '📦',
};

function getAgentIcon(agentName: string): string {
    return AGENT_ICONS[agentName] || '🤖';
}

// ── Step Indicator ─────────────────────────────────────────────────

function StepIndicator({ status }: { status: ProgressStep['status'] }) {
    switch (status) {
        case 'running':
            return (
                <span className="step-indicator running">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                </span>
            );
        case 'done':
            return (
                <span className="step-indicator done">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                </span>
            );
        case 'error':
            return (
                <span className="step-indicator error">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                </span>
            );
        default: // pending
            return <span className="step-indicator pending">○</span>;
    }
}

// ── Main Component ─────────────────────────────────────────────────

export function AgentProgressPanel({
    isVisible,
    currentAgent,
    steps,
    overallProgress,
    onToggle,
}: AgentProgressPanelProps) {
    if (!isVisible) return null;

    const completedSteps = steps.filter(s => s.status === 'done').length;
    const totalSteps = steps.length;
    const progress = overallProgress ?? (totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0);

    return (
        <div className="agent-progress-panel">
            {/* Header */}
            <div className="progress-panel-header">
                <div className="progress-agent-info">
                    <span className="progress-agent-icon">{getAgentIcon(currentAgent)}</span>
                    <span className="progress-agent-name">{currentAgent}</span>
                </div>
                <button className="progress-panel-close" onClick={onToggle} title={t('common.close' as any)}>
                    ✕
                </button>
            </div>

            {/* Overall Progress Bar */}
            <div className="progress-overall">
                <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                </div>
                <span className="progress-percentage">{progress}%</span>
            </div>

            {/* Steps Timeline */}
            <div className="progress-steps">
                {steps.map((step, idx) => (
                    <div key={step.id} className={`progress-step status-${step.status}`}>
                        <div className="step-connector">
                            {idx > 0 && <div className="step-connector-line" />}
                        </div>
                        <StepIndicator status={step.status} />
                        <div className="step-content">
                            <div className="step-label">{step.label}</div>
                            <div className="step-meta">
                                {step.duration !== undefined && step.duration > 0.1 && (
                                    <span className="step-duration">{step.duration.toFixed(1)}s</span>
                                )}
                                {step.details && (
                                    <span className="step-details">{step.details}</span>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Footer Summary */}
            <div className="progress-panel-footer">
                <span className="progress-summary">
                    {completedSteps}/{totalSteps} {t('chat.stepsCompleted' as any) || 'steps completed'}
                </span>
            </div>
        </div>
    );
}

// ── Compact Version (for inline display) ───────────────────────────

interface CompactProgressProps {
    currentAgent: string;
    currentStep: string;
    progress: number; // 0-100
}

export function CompactAgentProgress({ currentAgent, currentStep, progress }: CompactProgressProps) {
    return (
        <div className="compact-progress">
            <span className="compact-agent-icon">{getAgentIcon(currentAgent)}</span>
            <div className="compact-progress-bar">
                <div className="compact-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="compact-step-label">{currentStep}</span>
        </div>
    );
}

export default AgentProgressPanel;
