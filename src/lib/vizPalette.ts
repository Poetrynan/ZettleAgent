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
  permanent: '#10B981',
  literature: '#3B82F6',
  fleeting: '#94A3B8',
  structure: '#F59E0B',
  project: '#10B981',
  area: '#3B82F6',
  resource: '#F59E0B',
  archive: '#94A3B8',
  concept: '#10B981',
  reference: '#3B82F6',
  task: '#94A3B8',
  journal: '#F59E0B',
  capture: '#94A3B8',
  organize: '#3B82F6',
  distill: '#F59E0B',
  express: '#10B981',
  seed: '#94A3B8',
  sapling: '#3B82F6',
  evergreen: '#10B981',
  compost: '#F59E0B',
  inbox: '#94A3B8',
  next_action: '#10B981',
  waiting: '#F59E0B',
  someday: '#3B82F6',
  cue: '#F59E0B',
  note: '#3B82F6',
  summary: '#10B981',
  review: '#8B5CF6',
  map: '#8B5CF6',
  hub: '#10B981',
  dashboard: '#F59E0B',
};

const NODE_TYPES_DARK: Record<string, string> = {
  ...NODE_TYPES_LIGHT,
  permanent: '#34D399',
  literature: '#60A5FA',
  fleeting: '#CBD5E1',
  structure: '#FBBF24',
  project: '#34D399',
  area: '#60A5FA',
  resource: '#FBBF24',
  archive: '#94A3B8',
  concept: '#34D399',
  reference: '#60A5FA',
  task: '#CBD5E1',
  journal: '#FBBF24',
  capture: '#94A3B8',
  organize: '#60A5FA',
  distill: '#FBBF24',
  express: '#34D399',
  seed: '#94A3B8',
  sapling: '#60A5FA',
  evergreen: '#34D399',
  compost: '#FBBF24',
  inbox: '#94A3B8',
  next_action: '#34D399',
  waiting: '#FBBF24',
  someday: '#60A5FA',
  cue: '#FBBF24',
  note: '#60A5FA',
  summary: '#34D399',
  review: '#C084FC',
  map: '#C084FC',
  hub: '#34D399',
  dashboard: '#FBBF24',
};

const CLUSTERS_LIGHT = [
  '#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1',
  '#14B8A6', '#E11D48', '#A855F7', '#0EA5E9', '#D946EF',
];

const CLUSTERS_DARK = [
  '#34D399', '#60A5FA', '#FBBF24', '#F87171', '#C084FC',
  '#F472B6', '#22D3EE', '#A3E635', '#FB923C', '#818CF8',
  '#2DD4BF', '#FB7185', '#D8B4FE', '#38BDF8', '#E879F9',
];

const VIZ_LIGHT: VizPalette = {
  surface: { bg: '#FAFBFC', grid: '#D0D5DD' },
  label: {
    nodeFill: '#334155',
    nodeHalo: '#FFFFFF',
    edgeFill: '#4B5563',
    edgeHalo: '#FFFFFF',
    hubStar: '#FFFFFF',
  },
  edge: {
    default: { hi: '#3B82F6', lo: 'rgba(100, 116, 139, 0.28)' },
    wikilink: { hi: '#64748B', lo: 'rgba(100, 116, 139, 0.28)' },
    semantic: { hi: '#06B6D4', lo: 'rgba(6, 182, 212, 0.35)' },
    supports: { hi: '#10B981', lo: 'rgba(16, 185, 129, 0.35)' },
    contradicts: { hi: '#EF4444', lo: 'rgba(239, 68, 68, 0.35)' },
    refines: { hi: '#3B82F6', lo: 'rgba(59, 130, 246, 0.35)' },
    supplementary: { hi: '#F59E0B', lo: 'rgba(245, 158, 11, 0.35)' },
    depends_on: { hi: '#8B5CF6', lo: 'rgba(139, 92, 246, 0.35)' },
    exemplifies: { hi: '#3B82F6', lo: 'rgba(59, 130, 246, 0.35)' },
    supersedes: { hi: '#F97316', lo: 'rgba(249, 115, 22, 0.35)' },
  },
  nodes: NODE_TYPES_LIGHT,
  nodeFallback: '#94A3B8',
  clusters: CLUSTERS_LIGHT,
  ring: {
    selected: '#2563EB',
    selectedStrong: '#3B82F6',
    multiSelect: '#A855F7',
    hub: '#10B981',
    orphan: '#64748B',
    highlight: '#2563EB',
  },
  filterAll: '#64748B',
  canvasDefaultEdge: '#64748B',
};

const VIZ_DARK: VizPalette = {
  surface: { bg: '#0F172A', grid: '#334155' },
  label: {
    nodeFill: '#E2E8F0',
    nodeHalo: '#0F172A',
    edgeFill: '#CBD5E1',
    edgeHalo: '#0F172A',
    hubStar: '#FDE68A',
  },
  edge: {
    default: { hi: '#60A5FA', lo: 'rgba(148, 163, 184, 0.5)' },
    wikilink: { hi: '#94A3B8', lo: 'rgba(148, 163, 184, 0.45)' },
    semantic: { hi: '#22D3EE', lo: 'rgba(34, 211, 238, 0.48)' },
    supports: { hi: '#4ADE80', lo: 'rgba(74, 222, 128, 0.45)' },
    contradicts: { hi: '#F87171', lo: 'rgba(248, 113, 113, 0.48)' },
    refines: { hi: '#60A5FA', lo: 'rgba(96, 165, 250, 0.45)' },
    supplementary: { hi: '#FBBF24', lo: 'rgba(251, 191, 36, 0.45)' },
    depends_on: { hi: '#C084FC', lo: 'rgba(192, 132, 252, 0.48)' },
    exemplifies: { hi: '#60A5FA', lo: 'rgba(96, 165, 250, 0.45)' },
    supersedes: { hi: '#FB923C', lo: 'rgba(251, 146, 60, 0.48)' },
  },
  nodes: NODE_TYPES_DARK,
  nodeFallback: '#94A3B8',
  clusters: CLUSTERS_DARK,
  ring: {
    selected: '#60A5FA',
    selectedStrong: '#93C5FD',
    multiSelect: '#C084FC',
    hub: '#4ADE80',
    orphan: '#94A3B8',
    highlight: '#60A5FA',
  },
  filterAll: '#94A3B8',
  canvasDefaultEdge: '#94A3B8',
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
