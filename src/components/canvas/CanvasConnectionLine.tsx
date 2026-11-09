import { getBezierPath, type ConnectionLineComponentProps } from '@xyflow/react';

/**
 * The line drawn while dragging out a connection.
 *
 * Accent coloured, with a dot that follows the pointer. When the pointer is
 * close enough to a connection point to snap, the end jumps onto it and the dot
 * fills in, so you can see the connection will "take" before letting go
 * (tldraw's bound-arrow feedback; React Flow supplies the snapped toX/toY).
 */
export function CanvasConnectionLine({
  fromX, fromY, toX, toY, fromPosition, toPosition, connectionStatus,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const snapped = connectionStatus === 'valid';
  return (
    <g className={`zc-connection-line ${snapped ? 'is-snapped' : ''}`}>
      <path className="zc-connection-path" d={path} fill="none" />
      <circle className="zc-connection-origin" cx={fromX} cy={fromY} r={3.5} />
      <circle className="zc-connection-end" cx={toX} cy={toY} r={snapped ? 5.5 : 4} />
    </g>
  );
}
