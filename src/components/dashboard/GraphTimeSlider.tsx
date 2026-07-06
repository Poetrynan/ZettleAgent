import { GraphData } from '../../lib/tauri';

interface GraphTimeSliderProps {
  rawGraphData: GraphData;
  sortedNodeIds: string[];
  timeSliderValue: number;
  setTimeSliderValue: (v: number) => void;
  isZh: boolean;
  style?: React.CSSProperties;
}

export function GraphTimeSlider({
  rawGraphData,
  sortedNodeIds,
  timeSliderValue,
  setTimeSliderValue,
  isZh,
  style,
}: GraphTimeSliderProps) {
  if (sortedNodeIds.length < 2) return null;

  const sorted = [...rawGraphData.nodes].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  const totalNodes = sorted.length;
  const isActive = timeSliderValue >= 0 && timeSliderValue < totalNodes;
  const visibleCount = isActive ? timeSliderValue : totalNodes;
  const sliderPct = isActive ? (timeSliderValue / totalNodes) * 100 : 100;

  const latestNode = sorted[Math.min(visibleCount - 1, totalNodes - 1)];
  let dateStr = isZh ? '全部' : 'All';
  if (isActive && latestNode?.created_at) {
    const d = new Date(latestNode.created_at);
    if (!isNaN(d.getTime())) {
      dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }

  let firstDate = '';
  let lastDate = '';
  const fd = sorted[0]?.created_at ? new Date(sorted[0].created_at) : null;
  const ld = sorted[totalNodes - 1]?.created_at ? new Date(sorted[totalNodes - 1].created_at) : null;
  if (fd && !isNaN(fd.getTime())) firstDate = `${fd.getFullYear()}.${String(fd.getMonth() + 1).padStart(2, '0')}`;
  if (ld && !isNaN(ld.getTime())) lastDate = `${ld.getFullYear()}.${String(ld.getMonth() + 1).padStart(2, '0')}`;

  return (
    <div className={`kg-hud kg-time-slider ${isActive ? 'active' : ''}`} style={style}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: isActive ? 'var(--kg-text-subtle)' : 'var(--kg-text-faint)' }}>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>

      <span className="kg-time-date">{firstDate}</span>

      <input
        type="range"
        className="kg-time-input"
        min={1}
        max={totalNodes}
        step={1}
        value={isActive ? timeSliderValue : totalNodes}
        onChange={(e) => {
          const v = Number(e.target.value);
          setTimeSliderValue(v >= totalNodes ? -1 : v);
        }}
        style={{ ['--kg-slider-pct' as string]: `${sliderPct}%` }}
      />

      <span className="kg-time-date">{lastDate}</span>

      <span className={`kg-time-badge ${isActive ? 'active' : ''}`}>
        {isActive ? `${visibleCount}/${totalNodes}` : dateStr}
      </span>

      {isActive && (
        <button
          className="kg-time-reset"
          onClick={() => setTimeSliderValue(-1)}
          title={isZh ? '重置' : 'Reset'}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      )}
    </div>
  );
}
