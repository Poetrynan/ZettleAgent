/**
 * GhostEdge — Custom React Flow edge component for AI-suggested "phantom" connections.
 * 
 * Renders an animated dashed bezier path with floating Accept (✅) / Reject (❌) buttons.
 * The edge visually distinguishes itself from real edges through:
 * - Dashed stroke with a flowing animation
 * - Semi-transparent rendering
 * - Hover-activated action buttons positioned at the midpoint
 * - Color-coding by suggestion type (blue=semantic, red=contradiction, orange=duplicate)
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
  EdgeLabelRenderer,
} from '@xyflow/react';

export interface GhostEdgeData {
  _smart: boolean;
  _smartType: 'suggestion' | 'contradiction' | 'duplicate' | 'supports';
  similarity?: number;
  relationType?: string;
  onAccept?: (edgeId: string) => void;
  onReject?: (edgeId: string) => void;
  label?: string;
  [key: string]: unknown;
}

// Color scheme per smart type
const GHOST_COLORS: Record<string, { stroke: string; glow: string; bg: string }> = {
  suggestion:    { stroke: '#60a5fa', glow: 'rgba(96, 165, 250, 0.3)',  bg: 'rgba(96, 165, 250, 0.12)' },
  contradiction: { stroke: '#ef4444', glow: 'rgba(239, 68, 68, 0.3)',   bg: 'rgba(239, 68, 68, 0.12)' },
  duplicate:     { stroke: '#f97316', glow: 'rgba(249, 115, 22, 0.3)',  bg: 'rgba(249, 115, 22, 0.12)' },
  supports:      { stroke: '#22c55e', glow: 'rgba(34, 197, 94, 0.3)',   bg: 'rgba(34, 197, 94, 0.12)' },
};

export function GhostEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const edgeData = data as GhostEdgeData | undefined;
  const smartType = edgeData?._smartType || 'suggestion';
  const colors = GHOST_COLORS[smartType] || GHOST_COLORS.suggestion;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const handleAccept = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    edgeData?.onAccept?.(id);
  }, [id, edgeData]);

  const handleReject = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    edgeData?.onReject?.(id);
  }, [id, edgeData]);

  // Build the label text
  const labelText = useMemo(() => {
    if (edgeData?.label) return edgeData.label as string;
    switch (smartType) {
      case 'suggestion':
        return edgeData?.similarity ? `💡 ${edgeData.similarity}%` : '💡 Similar';
      case 'contradiction':
        return '⚠️ Contradiction';
      case 'duplicate':
        return edgeData?.similarity ? `⚠️ Duplicate ${edgeData.similarity}%` : '⚠️ Duplicate';
      case 'supports':
        return '🤝 Supports';
      default:
        return '💡 Suggested';
    }
  }, [smartType, edgeData?.similarity, edgeData?.label]);

  // Build the dash pattern per type
  const dashArray = smartType === 'contradiction' ? '8 4' : smartType === 'duplicate' ? '6 4' : '4 6';
  const strokeWidth = smartType === 'contradiction' || smartType === 'duplicate' ? 2 : 1.5;

  return (
    <>
      {/* Glow underlay on hover */}
      {isHovered && (
        <BaseEdge
          id={`${id}-glow`}
          path={edgePath}
          style={{
            stroke: colors.glow,
            strokeWidth: strokeWidth + 6,
            strokeDasharray: dashArray,
            filter: `blur(4px)`,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Main ghost edge path (性能优化: 只在悬停时运行动画) */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: colors.stroke,
          strokeWidth,
          strokeDasharray: dashArray,
          opacity: isHovered ? 0.95 : 0.55,
          transition: 'opacity 0.2s ease, stroke-width 0.2s ease',
          cursor: 'pointer',
          // 性能优化: 只在悬停时运行动画，减少 GPU 负担
          animation: isHovered ? 'ghostEdgeFlow 1.5s linear infinite' : 'none',
        }}
      />

      {/* Invisible wider hitbox for hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      />

      {/* Label + action buttons */}
      <EdgeLabelRenderer>
        <div
          className="ghost-edge-label-container"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Label pill */}
          <div
            className="ghost-edge-label"
            style={{
              background: colors.bg,
              borderColor: colors.stroke,
              color: colors.stroke,
            }}
          >
            <span className="ghost-edge-label-text">{labelText}</span>
          </div>

          {/* Accept / Reject buttons — appear on hover */}
          <div
            className={`ghost-edge-actions ${isHovered ? 'visible' : ''}`}
          >
            <button
              className="ghost-edge-btn ghost-edge-btn-accept"
              onClick={handleAccept}
              title="Accept connection"
              aria-label="Accept suggested connection"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
            <button
              className="ghost-edge-btn ghost-edge-btn-reject"
              onClick={handleReject}
              title="Dismiss suggestion"
              aria-label="Dismiss suggested connection"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default GhostEdge;
