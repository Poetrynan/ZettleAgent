/**
 * canvasTemplates — 画布内置模板(纯占位骨架)
 *
 * 设计原则:
 *  - 5 种模板降低空白页门槛:知识图谱 / 时间线 / 对比 / MOC / Zettelkasten 流程
 *  - 纯占位骨架:只给 group 框 + 标题文本 + 示例占位节点,坐标严格数学对齐
 *  - 所有间距/尺寸统一常量,保证每个模板像缩略图一样工整对称
 *  - 复用 8 种 methodology:占位节点按当前 methodology 的 note_type 着色
 *  - 输出格式严格对齐 InteractiveCanvas.handleOpenCanvas 的 Node/Edge 形状
 */
import type { Edge, Node } from '@xyflow/react';
import { getNoteColorMap, METHODOLOGY_TYPES } from '../dashboard/graphHelpers';
import { getVizPalette } from '../../lib/vizPalette';

// ── 统一尺寸常量(所有模板共用) ──────────────────────────────────────

const GROUP_W = 360;
const GROUP_H = 240;
const TEXT_W  = 240;
const TEXT_H  = 70;
const CENTER_W = 300;
const CENTER_H = 120;
const GAP = 140;   // 中心节点边缘到周围 group 边缘的间距

// ── 类型 ────────────────────────────────────────────────────────────

export interface TemplateMeta {
  id: string;
  icon: string;
  defaultMethodology: string;
  thumbnail: string;
}

export interface GeneratedCanvas {
  nodes: Node[];
  edges: Edge[];
}

// ── SVG 缩略图(不变) ─────────────────────────────────────────────────

const THUMB = {
  knowledgeGraph: `<svg viewBox="0 0 100 60" fill="none" stroke="#64748b" stroke-width="1.2">
    <rect x="6" y="6" width="18" height="13" rx="2" fill="#dbeafe"/>
    <rect x="76" y="6" width="18" height="13" rx="2" fill="#dbeafe"/>
    <rect x="6" y="41" width="18" height="13" rx="2" fill="#dbeafe"/>
    <rect x="76" y="41" width="18" height="13" rx="2" fill="#dbeafe"/>
    <circle cx="50" cy="30" r="6" fill="#3b82f6" stroke="none"/>
    <line x1="24" y1="13" x2="44" y2="28"/>
    <line x1="76" y1="13" x2="56" y2="28"/>
    <line x1="24" y1="47" x2="44" y2="32"/>
    <line x1="76" y1="47" x2="56" y2="32"/>
  </svg>`,
  timeline: `<svg viewBox="0 0 100 60" fill="none" stroke="#64748b" stroke-width="1.2">
    <rect x="4" y="22" width="22" height="16" rx="2" fill="#dbeafe"/>
    <rect x="39" y="22" width="22" height="16" rx="2" fill="#dbeafe"/>
    <rect x="74" y="22" width="22" height="16" rx="2" fill="#dbeafe"/>
    <path d="M27 30 L37 30 M33 26 L37 30 L33 34" stroke="#64748b" fill="none"/>
    <path d="M62 30 L72 30 M68 26 L72 30 L68 34" stroke="#64748b" fill="none"/>
  </svg>`,
  compare: `<svg viewBox="0 0 100 60" fill="none" stroke="#64748b" stroke-width="1.2">
    <rect x="4" y="10" width="32" height="40" rx="2" fill="#dbeafe"/>
    <rect x="64" y="10" width="32" height="40" rx="2" fill="#dbeafe"/>
    <line x1="38" y1="20" x2="62" y2="20"/>
    <line x1="38" y1="30" x2="62" y2="30"/>
    <line x1="38" y1="40" x2="62" y2="40"/>
  </svg>`,
  moc: `<svg viewBox="0 0 100 60" fill="none" stroke="#64748b" stroke-width="1.2">
    <rect x="38" y="24" width="24" height="12" rx="2" fill="#a855f7" stroke="none"/>
    <rect x="6" y="6" width="20" height="11" rx="2" fill="#ede9fe"/>
    <rect x="74" y="6" width="20" height="11" rx="2" fill="#ede9fe"/>
    <rect x="6" y="43" width="20" height="11" rx="2" fill="#ede9fe"/>
    <rect x="74" y="43" width="20" height="11" rx="2" fill="#ede9fe"/>
    <line x1="26" y1="12" x2="38" y2="28"/>
    <line x1="74" y1="12" x2="62" y2="28"/>
    <line x1="26" y1="48" x2="38" y2="32"/>
    <line x1="74" y1="48" x2="62" y2="32"/>
  </svg>`,
  zettelkasten: `<svg viewBox="0 0 100 60" fill="none" stroke="#64748b" stroke-width="1.2">
    <rect x="3" y="22" width="18" height="16" rx="2" fill="#d1fae5"/>
    <rect x="28" y="22" width="18" height="16" rx="2" fill="#dbeafe"/>
    <rect x="53" y="22" width="18" height="16" rx="2" fill="#d1fae5"/>
    <rect x="78" y="22" width="18" height="16" rx="2" fill="#fef3c7"/>
    <path d="M22 30 L27 30 M25 27 L27 30 L25 33" fill="none"/>
    <path d="M47 30 L52 30 M50 27 L52 30 L50 33" fill="none"/>
    <path d="M72 30 L77 30 M75 27 L77 30 L75 33" fill="none"/>
  </svg>`,
  blank: `<svg viewBox="0 0 100 60" fill="none" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3 3">
    <rect x="10" y="10" width="80" height="40" rx="2"/>
  </svg>`,
};

export const CANVAS_TEMPLATES: TemplateMeta[] = [
  { id: 'knowledge-graph', icon: '🕸️', defaultMethodology: 'moc',          thumbnail: THUMB.knowledgeGraph },
  { id: 'timeline',        icon: '⏱️', defaultMethodology: 'generic',      thumbnail: THUMB.timeline },
  { id: 'compare',         icon: '⚖️', defaultMethodology: 'generic',      thumbnail: THUMB.compare },
  { id: 'moc',             icon: '🗺️', defaultMethodology: 'moc',          thumbnail: THUMB.moc },
  { id: 'zettelkasten',    icon: '🌱', defaultMethodology: 'zettelkasten', thumbnail: THUMB.zettelkasten },
];

export const BLANK_THUMBNAIL = THUMB.blank;

// ── 工具 ────────────────────────────────────────────────────────────

let _idSeq = 0;
function genId(prefix: 'node' | 'edge' = 'node'): string {
  _idSeq = (_idSeq + 1) % 1_000_000;
  return `${prefix}-${Date.now()}-${_idSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

function typesOf(methodology: string): string[] {
  return METHODOLOGY_TYPES[methodology] || METHODOLOGY_TYPES.generic;
}

function colorOf(noteType: string): string {
  return getNoteColorMap()[noteType] || getVizPalette().nodeFallback;
}

/** 占位便签(居中于 group 内) */
function placeholderNode(gx: number, gy: number, text: string, color: string): Node {
  const x = gx + (GROUP_W - TEXT_W) / 2;
  const y = gy + (GROUP_H - TEXT_H) / 2;
  return {
    id: genId('node'),
    type: 'text',
    position: { x, y },
    width: TEXT_W, height: TEXT_H,
    style: { width: TEXT_W, height: TEXT_H },
    data: { text, color },
  };
}

function groupNode(x: number, y: number, label: string, color: string): Node {
  return {
    id: genId('node'),
    type: 'group',
    position: { x, y },
    width: GROUP_W, height: GROUP_H,
    style: { width: GROUP_W, height: GROUP_H },
    data: { label, color },
  };
}

function centerNode(text: string, color: string): Node {
  return {
    id: genId('node'),
    type: 'text',
    position: { x: -CENTER_W / 2, y: -CENTER_H / 2 },
    width: CENTER_W, height: CENTER_H,
    style: { width: CENTER_W, height: CENTER_H },
    data: { text, color },
  };
}

function arrowEdge(
  source: string, target: string, color: string, label?: string,
  sourceSide = 'right', targetSide = 'left',
): Edge {
  return {
    id: genId('edge'),
    source, target,
    sourceHandle: sourceSide,
    targetHandle: targetSide,
    type: 'default',
    label,
    labelStyle: label ? { fontSize: 11, fill: color, fontWeight: 500 } : undefined,
    style: { stroke: color },
    data: { color, fromEnd: 'none', toEnd: 'arrow' },
  };
}

// ── 位置计算常量(基于统一尺寸) ─────────────────────────────────────

// 中心节点边缘到四周 group 近边的间距 = GAP
// 上/下 group:x 居中于中心节点;y = 中心y - CENTER_H/2 - GAP - GROUP_H
const TOP_Y    = -(CENTER_H / 2 + GAP + GROUP_H);
const BOTTOM_Y = CENTER_H / 2 + GAP;
const TOP_BOTTOM_X = -GROUP_W / 2;   // group 宽等于中心节点宽? CENTER_W=300, GROUP_W=360 → group 略宽,居中偏移 -30

// 左/右 group:y 居中于中心节点;x = 中心右/左边缘 ± GAP
const RIGHT_X = CENTER_W / 2 + GAP;
const LEFT_X  = -(CENTER_W / 2 + GAP + GROUP_W);
const LEFT_RIGHT_Y = -GROUP_H / 2;

// 时间线模板:等距排列
const TL_GAP = 60;
const TL_ITEM_W = GROUP_W;
const TL_ITEM_H = GROUP_H;
const TL_START_X = -(TL_ITEM_W * 1.5 + TL_GAP);   // 3 个 item 的总宽 = 3*360 + 2*60 = 1200, 居中于 0

// 对比模板:左右对称
const CMP_GAP = 160;

// Zettelkasten 模板:4 个节点等距
const ZK_GAP = 80;
const ZK_ITEM_W = 260;
const ZK_ITEM_H = 160;
const ZK_START_X = -(ZK_ITEM_W * 2 + ZK_GAP * 1.5);

// ── 模板 1: 知识图谱画布 ─────────────────────────────────────────────

function tplKnowledgeGraph(methodology: string): GeneratedCanvas {
  const types = typesOf(methodology);
  const centerColor = colorOf(types[2]);

  const center = centerNode('🧭 中心主题 / MOC', centerColor);

  // 4 方向 group:上 / 右 / 下 / 左,严格对称
  const dirs = [
    { x: TOP_BOTTOM_X, y: TOP_Y,    nt: types[0], side: 'top' as const,    tside: 'bottom' as const },
    { x: RIGHT_X,       y: LEFT_RIGHT_Y, nt: types[1], side: 'right' as const,  tside: 'left' as const },
    { x: TOP_BOTTOM_X, y: BOTTOM_Y, nt: types[2], side: 'bottom' as const, tside: 'top' as const },
    { x: LEFT_X,        y: LEFT_RIGHT_Y, nt: types[3], side: 'left' as const,   tside: 'right' as const },
  ];

  const nodes: Node[] = [center];
  const edges: Edge[] = [];

  dirs.forEach(d => {
    const g = groupNode(d.x, d.y, d.nt, colorOf(d.nt));
    const ph = placeholderNode(d.x, d.y, '在此拖入相关笔记…', colorOf(d.nt));
    nodes.push(g, ph);
    edges.push(arrowEdge(center.id, g.id, colorOf(d.nt), '关联', d.side, d.tside));
  });

  return { nodes, edges };
}

// ── 模板 2: 时间线画布 ──────────────────────────────────────────────

function tplTimeline(methodology: string): GeneratedCanvas {
  const types = typesOf(methodology);
  const stages = [
    { label: '⏮ 过去', noteType: types[0] },
    { label: '⏸ 现在', noteType: types[1] },
    { label: '⏭ 未来', noteType: types[2] },
  ];

  const tlY = -TL_ITEM_H / 2;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const groupIds: string[] = [];

  stages.forEach((s, i) => {
    const x = TL_START_X + i * (TL_ITEM_W + TL_GAP);
    const g = groupNode(x, tlY, s.label, colorOf(s.noteType));
    const ph = placeholderNode(x, tlY, '在此记录关键节点…', colorOf(s.noteType));
    nodes.push(g, ph);
    groupIds.push(g.id);
  });

  edges.push(arrowEdge(groupIds[0], groupIds[1], '#6b7280', '演进'));
  edges.push(arrowEdge(groupIds[1], groupIds[2], '#6b7280', '演进'));

  return { nodes, edges };
}

// ── 模板 3: 对比画布 ────────────────────────────────────────────────

function tplCompare(methodology: string): GeneratedCanvas {
  const types = typesOf(methodology);
  const cmpY = -GROUP_H / 2;
  const aColor = colorOf(types[2]);
  const a = groupNode(-GROUP_W - CMP_GAP / 2, cmpY, '主题 A', aColor);
  const b = groupNode(CMP_GAP / 2, cmpY, '主题 B', aColor);
  const phA = placeholderNode(a.position.x, a.position.y, '在此放入主题 A 的笔记…', colorOf(types[1]));
  const phB = placeholderNode(b.position.x, b.position.y, '在此放入主题 B 的笔记…', colorOf(types[1]));

  const edges: Edge[] = ['维度 1', '维度 2', '维度 3'].map(d =>
    arrowEdge(a.id, b.id, '#0891b2', d)
  );

  return { nodes: [a, b, phA, phB], edges };
}

// ── 模板 4: MOC 画布 ────────────────────────────────────────────────

function tplMoc(_methodology: string): GeneratedCanvas {
  const types = typesOf('moc');
  const mapColor = colorOf('map');
  const center = centerNode('🗺️ Map of Content', mapColor);

  const dirs = [
    { x: TOP_BOTTOM_X, y: TOP_Y,    nt: types[0], label: '分支 1' },
    { x: RIGHT_X,       y: LEFT_RIGHT_Y, nt: types[1], label: '分支 2' },
    { x: TOP_BOTTOM_X, y: BOTTOM_Y, nt: types[2], label: '分支 3' },
    { x: LEFT_X,        y: LEFT_RIGHT_Y, nt: types[3], label: '分支 4' },
  ];

  const nodes: Node[] = [center];
  const edges: Edge[] = [];

  dirs.forEach(d => {
    const g = groupNode(d.x, d.y, d.label, colorOf(d.nt));
    const ph = placeholderNode(d.x, d.y, '在此组织该分支笔记…', colorOf(d.nt));
    nodes.push(g, ph);
    edges.push(arrowEdge(center.id, g.id, mapColor));
  });

  return { nodes, edges };
}

// ── 模板 5: Zettelkasten 流程画布 ───────────────────────────────────

function tplZettelkastenFlow(_methodology: string): GeneratedCanvas {
  const items = [
    { text: '📥 Fleeting\n灵光一现', nt: 'fleeting' },
    { text: '📚 Literature\n文献笔记', nt: 'literature' },
    { text: '💎 Permanent\n永久笔记', nt: 'permanent' },
    { text: '🗂️ Structure\n结构笔记', nt: 'structure' },
  ];

  const zkY = -ZK_ITEM_H / 2;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const ids: string[] = [];

  items.forEach((item, i) => {
    const x = ZK_START_X + i * (ZK_ITEM_W + ZK_GAP);
    const n: Node = {
      id: genId('node'),
      type: 'text',
      position: { x, y: zkY },
      width: ZK_ITEM_W, height: ZK_ITEM_H,
      style: { width: ZK_ITEM_W, height: ZK_ITEM_H },
      data: { text: item.text, color: colorOf(item.nt) },
    };
    nodes.push(n);
    ids.push(n.id);
  });

  const flowColor = '#6b7280';
  edges.push(arrowEdge(ids[0], ids[1], flowColor, '提炼'));
  edges.push(arrowEdge(ids[1], ids[2], flowColor, '沉淀'));
  edges.push(arrowEdge(ids[2], ids[3], flowColor, '索引'));

  return { nodes, edges };
}

// ── 对外入口 ────────────────────────────────────────────────────────

const BUILDERS: Record<string, (methodology: string) => GeneratedCanvas> = {
  'knowledge-graph': tplKnowledgeGraph,
  timeline:          tplTimeline,
  compare:           tplCompare,
  moc:               tplMoc,
  zettelkasten:      tplZettelkastenFlow,
};

export function generateTemplate(templateId: string, methodology: string): GeneratedCanvas {
  const builder = BUILDERS[templateId];
  if (!builder) return { nodes: [], edges: [] };
  _idSeq = 0;
  return builder(methodology);
}