import { ViewportPortal, useStore } from '@xyflow/react';
import type { HelperLine } from './useHelperLines';

/**
 * Snap guides, drawn inside the viewport in flow coordinates so they pan and
 * zoom with the cards (the old overlay was redrawn from screen maths on every
 * render and drifted while panning). Strokes stay 1px at any zoom.
 *
 * Alignment guides are a thin solid accent line; equal-gap guides are short
 * measured segments with end ticks, like tldraw's gap indicators.
 */
export function SnapGuides({ lines }: { lines: HelperLine[] }) {
  const zoom = useStore((s) => s.transform[2]);
  if (lines.length === 0) return null;
  const tick = 4 / zoom;

  return (
    <ViewportPortal>
      <svg className="zc-snap-guides" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', width: 1, height: 1, pointerEvents: 'none' }}>
        {lines.map((l) => {
          const v = l.type === 'vertical';
          const [x1, y1, x2, y2] = v
            ? [l.coordinate, l.min, l.coordinate, l.max]
            : [l.min, l.coordinate, l.max, l.coordinate];
          if (l.kind === 'gap') {
            return (
              <g key={l.id} className="zc-snap-gap">
                <line x1={x1} y1={y1} x2={x2} y2={y2} />
                {v ? (
                  <>
                    <line x1={x1 - tick} y1={y1} x2={x1 + tick} y2={y1} />
                    <line x1={x2 - tick} y1={y2} x2={x2 + tick} y2={y2} />
                  </>
                ) : (
                  <>
                    <line x1={x1} y1={y1 - tick} x2={x1} y2={y1 + tick} />
                    <line x1={x2} y1={y2 - tick} x2={x2} y2={y2 + tick} />
                  </>
                )}
              </g>
            );
          }
          return <line key={l.id} className="zc-snap-line" x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      </svg>
    </ViewportPortal>
  );
}
