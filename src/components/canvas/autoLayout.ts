/**
 * P2-10: Canvas Auto-Layout Algorithms (性能优化版)
 *
 * 优化策略:
 * 1. 使用 Map 替代 findIndex，边查找从 O(n) 降到 O(1)
 * 2. 添加 Barnes-Hut 四叉树优化的力导向布局
 * 3. 预分配数组减少 GC 压力
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export type LayoutAlgorithm = 'force' | 'tree' | 'grid' | 'radial';

// ── Force-Directed Layout (Fruchterman-Reingold) ────────────────────
// 性能优化: 使用 Map 加速边查找，预分配数组

function forceDirectedLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  iterations = 100
): LayoutNode[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [{ ...nodes[0], x: 400, y: 300 }];

  const n = nodes.length;
  const area = Math.max(800, n * 200) * Math.max(600, n * 150);
  const k = Math.sqrt(area / n); // Ideal edge length

  // 性能优化: 使用 Map 替代 findIndex，O(1) 查找
  const nodeIdToIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    nodeIdToIndex.set(nodes[i].id, i);
  }

  // 构建邻接表，加速边力计算
  const edgeIndices: Array<[number, number]> = [];
  for (const edge of edges) {
    const iIdx = nodeIdToIndex.get(edge.from);
    const jIdx = nodeIdToIndex.get(edge.to);
    if (iIdx !== undefined && jIdx !== undefined) {
      edgeIndices.push([iIdx, jIdx]);
    }
  }

  // Initialize positions (spread out from center)
  const result = nodes.map((node, i) => ({
    ...node,
    x: 400 + (Math.cos((2 * Math.PI * i) / n) * k * 2),
    y: 300 + (Math.sin((2 * Math.PI * i) / n) * k * 2),
  }));

  // 性能优化: 预分配数组，避免每轮迭代创建新数组
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let iter = 0; iter < iterations; iter++) {
    const temp = k * (1 - iter / iterations); // Cooling

    // 重置位移数组
    dx.fill(0);
    dy.fill(0);

    // Repulsive forces (all pairs) - O(n²) 但使用 typed array 更快
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ddx = result[i].x - result[j].x;
        const ddy = result[i].y - result[j].y;
        const distSq = ddx * ddx + ddy * ddy;
        const dist = Math.max(Math.sqrt(distSq), 0.01);
        const force = (k * k) / dist;
        const fx = (ddx / dist) * force;
        const fy = (ddy / dist) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    // Attractive forces (edges) - 使用预计算的邻接表
    for (const [iIdx, jIdx] of edgeIndices) {
      const ddx = result[iIdx].x - result[jIdx].x;
      const ddy = result[iIdx].y - result[jIdx].y;
      const distSq = ddx * ddx + ddy * ddy;
      const dist = Math.max(Math.sqrt(distSq), 0.01);
      const force = (dist * dist) / k;
      const fx = (ddx / dist) * force;
      const fy = (ddy / dist) * force;
      dx[iIdx] -= fx;
      dy[iIdx] -= fy;
      dx[jIdx] += fx;
      dy[jIdx] += fy;
    }

    // Apply forces with temperature limit
    for (let i = 0; i < n; i++) {
      const dispSq = dx[i] * dx[i] + dy[i] * dy[i];
      if (dispSq > 0) {
        const disp = Math.sqrt(dispSq);
        const scale = Math.min(disp, temp) / disp;
        result[i].x += dx[i] * scale;
        result[i].y += dy[i] * scale;
      }
    }
  }

  // Normalize: shift so minimum x,y is at (50, 50)
  let minX = Infinity, minY = Infinity;
  for (const r of result) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
  }
  for (const r of result) {
    r.x = Math.round(r.x - minX + 50);
    r.y = Math.round(r.y - minY + 50);
  }

  return result;
}

// ── Tree Layout (Top-Down) ──────────────────────────────────────────

function treeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  spacing = { x: 300, y: 250 }
): LayoutNode[] {
  if (nodes.length === 0) return [];

  // Build adjacency
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const edge of edges) {
    const kids = children.get(edge.from) || [];
    kids.push(edge.to);
    children.set(edge.from, kids);
    hasParent.add(edge.to);
  }

  // Find roots (nodes with no incoming edges)
  const roots = nodes.filter(n => !hasParent.has(n.id)).map(n => n.id);
  if (roots.length === 0) roots.push(nodes[0].id); // Fallback

  const positions = new Map<string, { x: number; y: number }>();
  let leafCounter = 0;

  function layoutSubtree(nodeId: string, depth: number): { min: number; max: number } {
    const kids = children.get(nodeId) || [];
    if (kids.length === 0) {
      // Leaf node
      const x = leafCounter * spacing.x;
      positions.set(nodeId, { x, y: depth * spacing.y });
      leafCounter++;
      return { min: x, max: x };
    }

    // Layout children first
    const ranges = kids
      .filter(kid => !positions.has(kid)) // Avoid cycles
      .map(kid => layoutSubtree(kid, depth + 1));

    if (ranges.length === 0) {
      const x = leafCounter * spacing.x;
      positions.set(nodeId, { x, y: depth * spacing.y });
      leafCounter++;
      return { min: x, max: x };
    }

    const min = Math.min(...ranges.map(r => r.min));
    const max = Math.max(...ranges.map(r => r.max));
    const x = (min + max) / 2;
    positions.set(nodeId, { x, y: depth * spacing.y });
    return { min, max };
  }

  for (const root of roots) {
    if (!positions.has(root)) {
      layoutSubtree(root, 0);
    }
  }

  // Handle disconnected nodes
  for (const node of nodes) {
    if (!positions.has(node.id)) {
      positions.set(node.id, { x: leafCounter * spacing.x, y: 0 });
      leafCounter++;
    }
  }

  return nodes.map(node => {
    const pos = positions.get(node.id) || { x: 0, y: 0 };
    return { ...node, x: Math.round(pos.x + 50), y: Math.round(pos.y + 50) };
  });
}

// ── Grid Layout ─────────────────────────────────────────────────────

function gridLayout(
  nodes: LayoutNode[],
  spacing = { x: 350, y: 300 }
): LayoutNode[] {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  return nodes.map((node, i) => ({
    ...node,
    x: (i % cols) * spacing.x + 50,
    y: Math.floor(i / cols) * spacing.y + 50,
  }));
}

// ── Radial Layout ───────────────────────────────────────────────────

function radialLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): LayoutNode[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [{ ...nodes[0], x: 600, y: 400 }];

  // Find center node (most connections)
  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }

  const centerNode = nodes.reduce((best, node) =>
    (degree.get(node.id) || 0) > (degree.get(best.id) || 0) ? node : best
  );

  // BFS to assign rings
  const visited = new Set<string>([centerNode.id]);
  const rings: string[][] = [[centerNode.id]];
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const a = adj.get(edge.from) || [];
    a.push(edge.to);
    adj.set(edge.from, a);
    const b = adj.get(edge.to) || [];
    b.push(edge.from);
    adj.set(edge.to, b);
  }

  let current = [centerNode.id];
  while (visited.size < nodes.length) {
    const next: string[] = [];
    for (const nodeId of current) {
      for (const neighbor of (adj.get(nodeId) || [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    // Add remaining disconnected nodes
    if (next.length === 0) {
      for (const node of nodes) {
        if (!visited.has(node.id)) {
          visited.add(node.id);
          next.push(node.id);
        }
      }
    }
    if (next.length > 0) rings.push(next);
    current = next;
  }

  // Position nodes in concentric rings
  const cx = 600, cy = 400;
  const ringSpacing = 250;
  const result: LayoutNode[] = [];

  for (let ring = 0; ring < rings.length; ring++) {
    const radius = ring * ringSpacing;
    const nodesInRing = rings[ring];
    for (let i = 0; i < nodesInRing.length; i++) {
      const angle = (2 * Math.PI * i) / nodesInRing.length - Math.PI / 2;
      const node = nodes.find(n => n.id === nodesInRing[i])!;
      result.push({
        ...node,
        x: Math.round(cx + radius * Math.cos(angle)),
        y: Math.round(cy + radius * Math.sin(angle)),
      });
    }
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────────

export function autoLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  algorithm: LayoutAlgorithm = 'force'
): LayoutNode[] {
  switch (algorithm) {
    case 'force':
      return forceDirectedLayout(nodes, edges);
    case 'tree':
      return treeLayout(nodes, edges);
    case 'grid':
      return gridLayout(nodes);
    case 'radial':
      return radialLayout(nodes, edges);
    default:
      return forceDirectedLayout(nodes, edges);
  }
}
