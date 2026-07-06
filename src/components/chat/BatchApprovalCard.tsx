/**
 * Batch Approval Card
 * 
 * Groups multiple write operations into a single approval request.
 * Reduces interruptions and improves workflow efficiency.
 */

import { t } from '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

export interface ApprovalItem {
    id: string;
    toolName: string;
    description: string;
    diffPreview?: string;
    severity: 'low' | 'medium' | 'high'; // low = safe, high = destructive
}

interface BatchApprovalCardProps {
    approvals: ApprovalItem[];
    onApproveAll: () => void;
    onRejectAll: () => void;
    onReviewEach: () => void;
    onApproveOne: (id: string) => void;
    onRejectOne: (id: string) => void;
    timeoutSeconds?: number;
}

// ── Tool Icons ─────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
    'create_note': '📝',
    'edit_note': '✏️',
    'patch_note': '🔧',
    'delete_note': '🗑️',
    'rename_note': '🏷️',
    'move_note': '📦',
    'merge_notes': '🔀',
    'modify_canvas': '🎨',
    'create_canvas': '🖼️',
    'add_relation': '🔗',
    'delete_relation': '💔',
};

function getToolIcon(toolName: string): string {
    return TOOL_ICONS[toolName] || '⚙️';
}

function getSeverityColor(severity: ApprovalItem['severity']): string {
    switch (severity) {
        case 'low': return '#22c55e';
        case 'medium': return '#f59e0b';
        case 'high': return '#ef4444';
    }
}

function getSeverityLabel(severity: ApprovalItem['severity']): string {
    switch (severity) {
        case 'low': return t('approval.severityLow' as any) || 'Safe';
        case 'medium': return t('approval.severityMedium' as any) || 'Moderate';
        case 'high': return t('approval.severityHigh' as any) || 'Destructive';
    }
}

// ── Main Component ─────────────────────────────────────────────────

export function BatchApprovalCard({
    approvals,
    onApproveAll,
    onRejectAll,
    onReviewEach,
    onApproveOne,
    onRejectOne,
    timeoutSeconds = 60,
}: BatchApprovalCardProps) {
    const highSeverityCount = approvals.filter(a => a.severity === 'high').length;
    const mediumSeverityCount = approvals.filter(a => a.severity === 'medium').length;
    const lowSeverityCount = approvals.filter(a => a.severity === 'low').length;

    return (
        <div className="batch-approval-card">
            {/* Header */}
            <div className="batch-approval-header">
                <div className="batch-approval-title">
                    <span className="batch-icon">📋</span>
                    <h3>{t('approval.batchTitle' as any) || `${approvals.length} operations pending approval`}</h3>
                </div>
                <div className="batch-approval-stats">
                    {highSeverityCount > 0 && (
                        <span className="batch-stat high">{highSeverityCount} destructive</span>
                    )}
                    {mediumSeverityCount > 0 && (
                        <span className="batch-stat medium">{mediumSeverityCount} moderate</span>
                    )}
                    {lowSeverityCount > 0 && (
                        <span className="batch-stat low">{lowSeverityCount} safe</span>
                    )}
                </div>
            </div>

            {/* Summary List */}
            <div className="batch-approval-summary">
                {approvals.map((approval) => (
                    <div key={approval.id} className="batch-approval-item">
                        <span className="batch-item-icon">{getToolIcon(approval.toolName)}</span>
                        <div className="batch-item-content">
                            <span className="batch-item-description">{approval.description}</span>
                            <span
                                className="batch-item-severity"
                                style={{ color: getSeverityColor(approval.severity) }}
                            >
                                {getSeverityLabel(approval.severity)}
                            </span>
                        </div>
                        <div className="batch-item-actions">
                            <button
                                className="batch-item-approve"
                                onClick={() => onApproveOne(approval.id)}
                                title={t('approval.approve' as any) || 'Approve'}
                            >
                                ✓
                            </button>
                            <button
                                className="batch-item-reject"
                                onClick={() => onRejectOne(approval.id)}
                                title={t('approval.reject' as any) || 'Reject'}
                            >
                                ✗
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            {/* Action Buttons */}
            <div className="batch-approval-actions">
                <button className="batch-btn batch-btn-approve-all" onClick={onApproveAll}>
                    <span>✓</span>
                    {t('approval.approveAll' as any) || 'Approve All'}
                </button>
                <button className="batch-btn batch-btn-review" onClick={onReviewEach}>
                    <span>🔍</span>
                    {t('approval.reviewEach' as any) || 'Review Each'}
                </button>
                <button className="batch-btn batch-btn-reject-all" onClick={onRejectAll}>
                    <span>✗</span>
                    {t('approval.rejectAll' as any) || 'Reject All'}
                </button>
            </div>

            {/* Timeout Notice */}
            <div className="batch-approval-footer">
                <span className="batch-timeout-notice">
                    ⏱️ {t('approval.autoTimeout' as any) || `Auto-timeout in ${timeoutSeconds}s`}
                </span>
            </div>
        </div>
    );
}

// ── Compact Version ────────────────────────────────────────────────

interface CompactBatchApprovalProps {
    count: number;
    onApproveAll: () => void;
    onReview: () => void;
}

export function CompactBatchApproval({ count, onApproveAll, onReview }: CompactBatchApprovalProps) {
    return (
        <div className="compact-batch-approval">
            <span className="compact-batch-icon">📋</span>
            <span className="compact-batch-text">
                {count} operations pending
            </span>
            <button className="compact-batch-approve" onClick={onApproveAll}>
                Approve All
            </button>
            <button className="compact-batch-review" onClick={onReview}>
                Review
            </button>
        </div>
    );
}

export default BatchApprovalCard;
