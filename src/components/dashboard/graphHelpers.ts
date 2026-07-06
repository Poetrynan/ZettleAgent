/**
 * KnowledgeGraph Helpers
 *
 * Color maps, node sizing, and filter types used by the ForceGraph component.
 * Visualization colors live in vizPalette.ts (separate from UI theme tokens).
 */
import { GraphNode } from '../../lib/tauri';
import {
  getClusterColors,
  getNoteColorMap,
  getRelationFilterConfig,
  getVizLinkColor,
  getVizPalette,
} from '../../lib/vizPalette';

export { getNoteColorMap, getRelationFilterConfig };
export type { RelationFilterKey as RelationFilter } from '../../lib/vizPalette';

export const METHODOLOGY_TYPES: Record<string, string[]> = {
  zettelkasten: ['permanent', 'literature', 'fleeting', 'structure'],
  para: ['project', 'area', 'resource', 'archive'],
  generic: ['concept', 'reference', 'task', 'journal'],
  code: ['capture', 'organize', 'distill', 'express'],
  evergreen: ['seed', 'sapling', 'evergreen', 'compost'],
  gtd: ['inbox', 'next_action', 'waiting', 'someday'],
  cornell: ['cue', 'note', 'summary', 'review'],
  moc: ['map', 'note', 'hub', 'dashboard'],
};

/** @deprecated Use getNoteColorMap() — kept for gradual migration */
export function getNoteColors(): Record<string, string> {
  return getNoteColorMap();
}

// ── Cross-Methodology Type Mapping ─────────────────────────────────

const MATURITY_LEVELS: Record<string, number> = {
  fleeting: 0, literature: 1, permanent: 2, structure: 3,
  inbox: 0, waiting: 1, next_action: 2, someday: 3,
  capture: 0, organize: 1, distill: 2, express: 3,
  seed: 0, sapling: 1, evergreen: 2, compost: 3,
  cue: 0, note: 1, summary: 2, review: 3,
  map: 2, hub: 2, dashboard: 3,
  resource: 0, area: 1, project: 2, archive: 3,
  task: 0, reference: 1, concept: 2, journal: 3,
};

export function mapNoteType(noteType: string, targetMethodology: string): string {
  const targetTypes = METHODOLOGY_TYPES[targetMethodology];
  if (!targetTypes) return noteType;
  if (targetTypes.includes(noteType)) return noteType;
  const level = MATURITY_LEVELS[noteType];
  if (level === undefined) return noteType;
  return targetTypes[Math.min(level, targetTypes.length - 1)] || noteType;
}

export function getNodeColor(node: { note_type: string; cluster: number }, useClusterColors: boolean, methodology?: string): string {
  if (useClusterColors) {
    const clusters = getClusterColors();
    return clusters[node.cluster % clusters.length];
  }
  const displayType = methodology ? mapNoteType(node.note_type, methodology) : node.note_type;
  return getNoteColorMap()[displayType] || getVizPalette().nodeFallback;
}

export function getNodeVal(node: GraphNode & { degree?: number }): number {
  const degree = (node as any).degree ?? 1;
  const base = 1 + Math.sqrt(degree) * 1.2;
  return node.is_hub ? base * 1.5 : node.is_orphan ? base * 0.7 : base;
}

export function getNodeRadius(node: GraphNode & { degree?: number }): number {
  const degree = (node as any).degree ?? 1;
  const base = Math.min(6 + Math.sqrt(degree) * 5, 26);
  return node.is_hub ? base * 1.15 : node.is_orphan ? base * 0.8 : base;
}

export function getLinkColor(label?: string, isHighlighted?: boolean, edgeType?: string): string {
  return getVizLinkColor(label, isHighlighted, edgeType);
}
