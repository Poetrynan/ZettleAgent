/**
 * Canvas constants — shared between InteractiveCanvas and its hooks.
 */

import { getLang } from '../../lib/i18n';
import { getRelationTypes, type RelationTypeMeta } from '../../lib/vizPalette';

// ── Card color palette for node color picker ──
export const CARD_COLORS = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Pink', value: '#ec4899' },
];

export { getRelationTypes };
export type RelationType = ReturnType<typeof getRelationTypes>[number];

export function getRelationLabel(rel: Pick<RelationTypeMeta, 'label' | 'labelZh'>): string {
  return getLang() === 'zh' ? rel.labelZh : rel.label;
}
