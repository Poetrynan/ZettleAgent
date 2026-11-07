/**
 * Visualization palette — separate from UI chrome (theme-tokens.css).
 * Used by knowledge graph (Pixi), canvas (React Flow), and graph HUD.
 * Light / dark share semantic hues; contrast comes from surface, alpha, and label halos.
 */
import { getResolvedTheme, type ResolvedTheme } from './theme';

export type VizRelationKey =
  | 'default'
  | 'wikilink'
  | 'semantic'
  | 'supports'
  | 'contradicts'
  | 'refines'
  | 'supplementary'
  | 'depends_on'
  | 'exemplifies'
  | 'supersedes';

export interface VizEdgePair {
  hi: string;
  lo: string;
}

export interface VizPalette {
  surface: { bg: string; grid: string };
  label: {
    nodeFill: string;
    nodeHalo: string;
    edgeFill: string;
    edgeHalo: string;
    hubStar: string;
  };
  edge: Record<VizRelationKey, VizEdgePair>;
  nodes: Record<string, string>;
  nodeFallback: string;
  clusters: string[];
  ring: {
    selected: string;
    selectedStrong: string;
    multiSelect: string;
    hub: string;
    orphan: string;
    highlight: string;
  };
  filterAll: string;
  canvasDefaultEdge: string;
}

const NODE_TYPES_LIGHT: Record<string, string> = {
  permanent: '#34C759',
  literature: '#007AFF',
  fleeting: '#8E8E93',
  structure: '#FF9500',
  project: '#34C759',
  area: '#007AFF',
  resource: '#FF9500',
  archive: '#8E8E93',
  concept: '#34C759',
  reference: '#007AFF',
  task: '#8E8E93',
  journal: '#FF9500',
  capture: '#8E8E93',
  organize: '#007AFF',
  distill: '#FF9500',
  express: '#34C759',
  seed: '#8E8E93',
  sapling: '#007AFF',
  evergreen: '#34C759',
  compost: '#FF9500',
  inbox: '#8E8E93',
  next_action: '#34C759',
  waiting: '#FF9500',
  someday: '#007AFF',
  cue: '#FF9500',
  note: '#007AFF',
  summary: '#34C759',
  review: '#AF52DE',
  map: '#AF52DE',
  hub: '#34C759',
  dashboard: '#FF9500',
};

const NODE_TYPES_DARK: Record<string, string> = {
  ...NODE_TYPES_LIGHT,
  permanent: '#30D158',
  literature: '#0A84FF',
  fleeting: '#98989D',
  structure: '#FF9F0A',
  project: '#30D158',
  area: '#0A84FF',
  resource: '#FF9F0A',
  archive: '#8E8E93',
  concept: '#30D158',
  reference: '#0A84FF',
  task: '#98989D',
  journal: '#FF9F0A',
  capture: '#8E8E93',
  organize: '#0A84FF',
  distill: '#FF9F0A',
  express: '#30D158',
  seed: '#8E8E93',
  sapling: '#0A84FF',
  evergreen: '#30D158',
  compost: '#FF9F0A',
  inbox: '#8E8E93',
  next_action: '#30D158',
  waiting: '#FF9F0A',
  someday: '#0A84FF',
  cue: '#FF9F0A',
  note: '#0A84FF',
  summary: '#30D158',
  review: '#BF5AF2',
  map: '#BF5AF2',
  hub: '#30D158',
  dashboard: '#FF9F0A',
};

const CLUSTERS_LIGHT = [
  '#34C759', '#007AFF', '#FF9500', '#FF3B30', '#AF52DE',
  '#FF2D55', '#32ADE6', '#84CC16', '#F97316', '#5856D6',
  '#14B8A6', '#E11D48', '#A855F7', '#0EA5E9', '#D946EF',
];

const CLUSTERS_DARK = [
  '#30D158', '#0A84FF', '#FF9F0A', '#FF453A', '#BF5AF2',
  '#FF375F', '#64D2FF', '#A3E635', '#FB923C', '#5E5CE6',
  '#2DD4BF', '#FB7185', '#D8B4FE', '#38BDF8', '#E879F9',
];

const VIZ_LIGHT: VizPalette = {
  surface: { bg: '#FFFFFF', grid: '#EEEEF1' },
  label: {
    nodeFill: '#334155',
    nodeHalo: '#FFFFFF',
    edgeFill: '#4B5563',
    edgeHalo: '#FFFFFF',
    hubStar: '#FFFFFF',
  },
  edge: {
    default: { hi: '#007AFF', lo: 'rgba(100, 116, 139, 0.28)' },
    wikilink: { hi: '#64748B', lo: 'rgba(100, 116, 139, 0.28)' },
    semantic: { hi: '#32ADE6', lo: 'rgba(6, 182, 212, 0.35)' },
    supports: { hi: '#34C759', lo: 'rgba(16, 185, 129, 0.35)' },
    contradicts: { hi: '#FF3B30', lo: 'rgba(239, 68, 68, 0.35)' },
    refines: { hi: '#007AFF', lo: 'rgba(59, 130, 246, 0.35)' },
    supplementary: { hi: '#FF9500', lo: 'rgba(245, 158, 11, 0.35)' },
    depends_on: { hi: '#AF52DE', lo: 'rgba(139, 92, 246, 0.35)' },
    exemplifies: { hi: '#007AFF', lo: 'rgba(59, 130, 246, 0.35)' },
    supersedes: { hi: '#F97316', lo: 'rgba(249, 115, 22, 0.35)' },
  },
  nodes: NODE_TYPES_LIGHT,
  nodeFallback: '#8E8E93',
  clusters: CLUSTERS_LIGHT,
  ring: {
    selected: '#2563EB',
    selectedStrong: '#007AFF',
    multiSelect: '#A855F7',
    hub: '#34C759',
    orphan: '#64748B',
    highlight: '#2563EB',
  },
  filterAll: '#64748B',
  canvasDefaultEdge: '#64748B',
};

const VIZ_DARK: VizPalette = {
  surface: { bg: '#1E1E1E', grid: '#2C2C2E' },
  label: {
    nodeFill: '#E2E8F0',
    nodeHalo: '#0F172A',
    edgeFill: '#98989D',
    edgeHalo: '#0F172A',
    hubStar: '#FDE68A',
  },
  edge: {
    default: { hi: '#0A84FF', lo: 'rgba(148, 163, 184, 0.5)' },
    wikilink: { hi: '#8E8E93', lo: 'rgba(148, 163, 184, 0.45)' },
    semantic: { hi: '#64D2FF', lo: 'rgba(34, 211, 238, 0.48)' },
    supports: { hi: '#4ADE80', lo: 'rgba(74, 222, 128, 0.45)' },
    contradicts: { hi: '#FF453A', lo: 'rgba(248, 113, 113, 0.48)' },
    refines: { hi: '#0A84FF', lo: 'rgba(96, 165, 250, 0.45)' },
    supplementary: { hi: '#FF9F0A', lo: 'rgba(251, 191, 36, 0.45)' },
    depends_on: { hi: '#BF5AF2', lo: 'rgba(192, 132, 252, 0.48)' },
    exemplifies: { hi: '#0A84FF', lo: 'rgba(96, 165, 250, 0.45)' },
    supersedes: { hi: '#FB923C', lo: 'rgba(251, 146, 60, 0.48)' },
  },
  nodes: NODE_TYPES_DARK,
  nodeFallback: '#8E8E93',
  clusters: CLUSTERS_DARK,
  ring: {
    selected: '#0A84FF',
    selectedStrong: '#93C5FD',
    multiSelect: '#BF5AF2',
    hub: '#4ADE80',
    orphan: '#8E8E93',
    highlight: '#0A84FF',
  },
  filterAll: '#8E8E93',
  canvasDefaultEdge: '#8E8E93',
};

const PALETTES: Record<ResolvedTheme, VizPalette> = {
  light: VIZ_LIGHT,
  dark: VIZ_DARK,
};

export function getVizPalette(theme?: ResolvedTheme): VizPalette {
  const resolved = theme ?? getResolvedTheme();
  return PALETTES[resolved];
}

/** Push --viz-* CSS variables for stylesheet consumers (canvas grid, surfaces). */
export function applyVizCssVars(resolved: ResolvedTheme) {
  const p = PALETTES[resolved];
  const root = document.documentElement;
  root.style.setProperty('--viz-surface-bg', p.surface.bg);
  root.style.setProperty('--viz-surface-grid', p.surface.grid);
  root.style.setProperty('--viz-label-node-fill', p.label.nodeFill);
  root.style.setProperty('--viz-label-node-halo', p.label.nodeHalo);
  root.style.setProperty('--viz-label-edge-fill', p.label.edgeFill);
  root.style.setProperty('--viz-canvas-default-edge', p.canvasDefaultEdge);
  root.style.setProperty('--viz-edge-default-lo', p.edge.default.lo);
  root.style.setProperty('--viz-edge-default-hi', p.edge.default.hi);
}

export function hexToPixi(hex: string): number {
  const s = hex.trim();
  if (s.startsWith('rgba') || s.startsWith('rgb')) {
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      return (parseInt(m[1], 10) << 16) + (parseInt(m[2], 10) << 8) + parseInt(m[3], 10);
    }
  }
  const h = s.startsWith('#') ? s.slice(1) : s;
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return parseInt(full, 16);
}

export function vizRelationKey(label?: string, edgeType?: string): VizRelationKey {
  if (edgeType === 'semantic') return 'semantic';
  if (edgeType === 'wikilink') return 'wikilink';
  if (!label) return 'default';
  const lbl = label.toLowerCase();
  if (lbl === 'contradicts' || lbl === 'refutes') return 'contradicts';
  if (lbl === 'supports' || lbl === 'extends') return 'supports';
  if (lbl === 'refines') return 'refines';
  if (lbl === 'exemplifies') return 'exemplifies';
  if (lbl === 'supplementary') return 'supplementary';
  if (lbl === 'depends_on') return 'depends_on';
  if (lbl === 'supersedes') return 'supersedes';
  return 'default';
}

export function getVizLinkColor(label?: string, highlighted?: boolean, edgeType?: string, theme?: ResolvedTheme): string {
  const p = getVizPalette(theme);
  const key = vizRelationKey(label, edgeType);
  const pair = p.edge[key] ?? p.edge.default;
  return highlighted ? pair.hi : pair.lo;
}

/** Soft tint for badges / chips on graph hover card */
export function getVizLinkTint(label?: string, edgeType?: string, theme?: ResolvedTheme): string {
  const hi = getVizLinkColor(label, true, edgeType, theme);
  if (hi.startsWith('#')) {
    const r = parseInt(hi.slice(1, 3), 16);
    const g = parseInt(hi.slice(3, 5), 16);
    const b = parseInt(hi.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${getResolvedTheme() === 'dark' ? 0.22 : 0.12})`;
  }
  return hi.replace(/[\d.]+\)$/, m => {
    const n = parseFloat(m);
    return `${Math.min(n + 0.15, 0.55)})`;
  });
}

export function getNoteColorMap(theme?: ResolvedTheme): Record<string, string> {
  return getVizPalette(theme).nodes;
}

export function getClusterColors(theme?: ResolvedTheme): string[] {
  return getVizPalette(theme).clusters;
}

export const RELATION_TYPE_META = [
  { type: 'wikilink', label: 'Link', labelZh: '链接' },
  { type: 'semantic', label: 'Related', labelZh: '相关' },
  { type: 'supports', label: 'Supports', labelZh: '支持' },
  { type: 'contradicts', label: 'Contradicts', labelZh: '矛盾' },
  { type: 'refines', label: 'Refines', labelZh: '完善' },
  { type: 'supplementary', label: 'Supplement', labelZh: '补充' },
  { type: 'depends_on', label: 'Depends', labelZh: '依赖' },
  { type: 'exemplifies', label: 'Example', labelZh: '举例' },
  { type: 'supersedes', label: 'Supersedes', labelZh: '取代' },
] as const;

export type RelationTypeMeta = (typeof RELATION_TYPE_META)[number];
export type RelationTypeKey = RelationTypeMeta['type'];

export function getRelationTypes(theme?: ResolvedTheme) {
  const p = getVizPalette(theme);
  return RELATION_TYPE_META.map(meta => {
    const key = meta.type as VizRelationKey;
    const pair = p.edge[key] ?? p.edge.default;
    return { ...meta, color: pair.hi };
  });
}

export type RelationFilterKey =
  | 'all'
  | 'semantic'
  | 'supports'
  | 'contradicts'
  | 'refines'
  | 'supplementary'
  | 'exemplifies'
  | 'depends_on'
  | 'supersedes';

export function getRelationFilterConfig(theme?: ResolvedTheme) {
  const p = getVizPalette(theme);
  const items: { key: RelationFilterKey; labelZh: string; labelEn: string; color: string }[] = [
    { key: 'all', labelZh: '全部', labelEn: 'All', color: p.filterAll },
    { key: 'semantic', labelZh: '语义', labelEn: 'Semantic', color: p.edge.semantic.hi },
    { key: 'supports', labelZh: '支持', labelEn: 'Supports', color: p.edge.supports.hi },
    { key: 'contradicts', labelZh: '矛盾', labelEn: 'Contradicts', color: p.edge.contradicts.hi },
    { key: 'refines', labelZh: '细化', labelEn: 'Refines', color: p.edge.refines.hi },
    { key: 'supplementary', labelZh: '补充', labelEn: 'Supplement', color: p.edge.supplementary.hi },
    { key: 'exemplifies', labelZh: '举例', labelEn: 'Exemplifies', color: p.edge.exemplifies.hi },
    { key: 'depends_on', labelZh: '依赖', labelEn: 'Depends On', color: p.edge.depends_on.hi },
    { key: 'supersedes', labelZh: '替代', labelEn: 'Supersedes', color: p.edge.supersedes.hi },
  ];
  return items;
}
