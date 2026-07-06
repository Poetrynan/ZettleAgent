import { t } from '../../lib/i18n';
import { getLinkColor } from './graphHelpers';
import { getNoteColorMap, getVizLinkTint } from '../../lib/vizPalette';
import { useVizTheme } from '../../lib/useVizTheme';

interface GraphHoverCardProps {
  hoveredNode: any;
  hoveredConnections: number;
  hoveredRelationBreakdown: Record<string, number> | null;
  isZh: boolean;
  style?: React.CSSProperties;
}

export function GraphHoverCard({
  hoveredNode,
  hoveredConnections,
  hoveredRelationBreakdown,
  isZh,
  style,
}: GraphHoverCardProps) {
  useVizTheme();
  const noteColors = getNoteColorMap();

  const dateStr = hoveredNode.created_at
    ? new Date(hoveredNode.created_at).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', {
        month: 'numeric',
        day: 'numeric',
      })
    : null;

  return (
    <div className="kg-hud kg-hover-card" style={style}>
      <div className="kg-hover-card-header">
        <span
          className="kg-hover-card-dot-indicator"
          style={{ background: noteColors[hoveredNode.note_type] || 'var(--kg-text-faint)' }}
          aria-hidden
        />
        <span
          className="kg-hover-card-title"
          style={{ color: noteColors[hoveredNode.note_type] || undefined }}
        >
          {hoveredNode.label}
        </span>
        {hoveredNode.is_hub && (
          <span className="kg-hover-card-hub" title={t('graph.hubHint')}>
            ★
          </span>
        )}
      </div>
      <div className="kg-hover-card-meta">
        <span>{t(`type.${hoveredNode.note_type}` as any)}</span>
        <span className="kg-hover-card-sep" aria-hidden>·</span>
        <span>{hoveredNode.chunk_count} {t('graph.chunks')}</span>
        <span className="kg-hover-card-sep" aria-hidden>·</span>
        <span>{hoveredConnections} {t('graph.connections')}</span>
        {dateStr && (
          <>
            <span className="kg-hover-card-sep" aria-hidden>·</span>
            <span className="kg-hover-card-date">{dateStr}</span>
          </>
        )}
      </div>
      {hoveredRelationBreakdown && (
        <div className="kg-hover-card-relations">
          {Object.entries(hoveredRelationBreakdown).map(([rel, count]) => (
            <span
              key={rel}
              className="kg-hover-card-rel-chip"
              style={{
                background: getVizLinkTint(rel),
                color: getLinkColor(rel, true),
              }}
            >
              <span
                className="kg-hover-card-rel-dot"
                style={{ background: getLinkColor(rel, true) }}
              />
              {rel} ×{count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
