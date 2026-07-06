/**
 * 空间索引 - 用于快速视口剔除和节点查找
 * 
 * 实现: 简单的网格空间分区 (无需外部依赖)
 * 对于 100,000+ 节点，可替换为 RBush (R-tree)
 */

import type { GraphNode, GraphEdge, Viewport } from './types';

interface GridCell {
  nodeIds: Set<string>;
}

export class SpatialIndex {
  private cellSize: number;
  private grid: Map<string, GridCell> = new Map();
  private nodeMap: Map<string, GraphNode> = new Map();
  private nodeCellMap: Map<string, Set<string>> = new Map(); // 节点所在的所有 cell

  constructor(cellSize = 200) {
    this.cellSize = cellSize;
  }

  /** 清空索引 */
  clear() {
    this.grid.clear();
    this.nodeMap.clear();
    this.nodeCellMap.clear();
  }

  /** 批量加载节点 - O(n) */
  bulkLoad(nodes: GraphNode[]) {
    this.clear();
    for (const node of nodes) {
      this.insert(node);
    }
  }

  /** 插入单个节点 */
  insert(node: GraphNode) {
    this.nodeMap.set(node.id, node);
    
    const minX = node.x;
    const minY = node.y;
    const maxX = node.x + node.width;
    const maxY = node.y + node.height;

    const minCellX = Math.floor(minX / this.cellSize);
    const maxCellX = Math.floor(maxX / this.cellSize);
    const minCellY = Math.floor(minY / this.cellSize);
    const maxCellY = Math.floor(maxY / this.cellSize);

    const cells = new Set<string>();

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const key = this.getCellKey(cx, cy);
        cells.add(key);

        let cell = this.grid.get(key);
        if (!cell) {
          cell = { nodeIds: new Set() };
          this.grid.set(key, cell);
        }
        cell.nodeIds.add(node.id);
      }
    }

    this.nodeCellMap.set(node.id, cells);
  }

  /** 更新节点位置 */
  updateNode(node: GraphNode) {
    this.remove(node.id);
    this.insert(node);
  }

  /** 移除节点 */
  remove(nodeId: string) {
    const cells = this.nodeCellMap.get(nodeId);
    if (cells) {
      for (const key of cells) {
        const cell = this.grid.get(key);
        if (cell) {
          cell.nodeIds.delete(nodeId);
          if (cell.nodeIds.size === 0) {
            this.grid.delete(key);
          }
        }
      }
    }
    this.nodeCellMap.delete(nodeId);
    this.nodeMap.delete(nodeId);
  }

  /** 视口查询 - 只返回可能可见的节点 ID */
  queryViewport(viewport: Viewport, buffer = 100): Set<string> {
    const minX = viewport.x - buffer;
    const minY = viewport.y - buffer;
    const maxX = viewport.x + viewport.width + buffer;
    const maxY = viewport.y + viewport.height + buffer;

    const minCellX = Math.floor(minX / this.cellSize);
    const maxCellX = Math.floor(maxX / this.cellSize);
    const minCellY = Math.floor(minY / this.cellSize);
    const maxCellY = Math.floor(maxY / this.cellSize);

    const result = new Set<string>();

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const cell = this.grid.get(this.getCellKey(cx, cy));
        if (cell) {
          for (const nodeId of cell.nodeIds) {
            result.add(nodeId);
          }
        }
      }
    }

    return result;
  }

  /** 获取视口内的节点 */
  getNodesInViewport(viewport: Viewport, buffer = 100): GraphNode[] {
    const visibleIds = this.queryViewport(viewport, buffer);
    const result: GraphNode[] = [];
    for (const id of visibleIds) {
      const node = this.nodeMap.get(id);
      if (node && this.intersectsViewport(node, viewport, buffer)) {
        result.push(node);
      }
    }
    return result;
  }

  /** 圆形范围查询 */
  queryRadius(x: number, y: number, radius: number): GraphNode[] {
    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellY = Math.floor((y - radius) / this.cellSize);
    const maxCellY = Math.floor((y + radius) / this.cellSize);

    const result: GraphNode[] = [];
    const rSq = radius * radius;

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const cell = this.grid.get(this.getCellKey(cx, cy));
        if (cell) {
          for (const nodeId of cell.nodeIds) {
            const node = this.nodeMap.get(nodeId);
            if (node) {
              const dx = (node.x + node.width / 2) - x;
              const dy = (node.y + node.height / 2) - y;
              if (dx * dx + dy * dy <= rSq) {
                result.push(node);
              }
            }
          }
        }
      }
    }

    return result;
  }

  /** 最近邻查询 */
  nearest(x: number, y: number, maxDist = 50): GraphNode | null {
    const candidates = this.queryRadius(x, y, maxDist);
    let nearest: GraphNode | null = null;
    let minDist = Infinity;

    for (const node of candidates) {
      const dx = (node.x + node.width / 2) - x;
      const dy = (node.y + node.height / 2) - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) {
        minDist = dist;
        nearest = node;
      }
    }

    return nearest;
  }

  /** 获取所有节点 */
  getAll(): GraphNode[] {
    return Array.from(this.nodeMap.values());
  }

  /** 获取节点数量 */
  get size(): number {
    return this.nodeMap.size;
  }

  /** 动态调整网格大小 */
  private getOptimalCellSize(): number {
    // 根据节点密度动态调整
    const nodeCount = this.nodeMap.size;
    if (nodeCount < 100) return 300;
    if (nodeCount < 1000) return 200;
    if (nodeCount < 10000) return 150;
    return 100;
  }

  private getCellKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private intersectsViewport(node: GraphNode, vp: Viewport, buffer: number): boolean {
    return !(
      node.x + node.width < vp.x - buffer ||
      node.x > vp.x + vp.width + buffer ||
      node.y + node.height < vp.y - buffer ||
      node.y > vp.y + vp.height + buffer
    );
  }
}

/** 视口剔除工具函数 */
export function cullNodes(nodes: GraphNode[], viewport: Viewport, buffer = 100): GraphNode[] {
  const { x, y, width, height } = viewport;
  return nodes.filter(n => {
    return !(
      n.x + n.width < x - buffer ||
      n.x > x + width + buffer ||
      n.y + n.height < y - buffer ||
      n.y > y + height + buffer
    );
  });
}

/** 边视口剔除 - 保留端点可见或边穿过视口的边 */
export function cullEdges(
  edges: GraphEdge[],
  visibleNodeIds: Set<string>,
  viewport: Viewport,
  buffer = 100
): GraphEdge[] {
  const { x, y, width, height } = viewport;
  const maxX = x + width + buffer;
  const maxY = y + height + buffer;
  const minX = x - buffer;
  const minY = y - buffer;

  return edges.filter(e => {
    // 如果任一端点在可见节点集合中，保留
    if (visibleNodeIds.has(e.source) || visibleNodeIds.has(e.target)) {
      return true;
    }
    // 检查边是否穿过视口
    return lineIntersectsRect(
      e.sourceX, e.sourceY, e.targetX, e.targetY,
      minX, minY, maxX, maxY
    );
  });
}

function lineIntersectsRect(
  x1: number, y1: number, x2: number, y2: number,
  minX: number, minY: number, maxX: number, maxY: number
): boolean {
  // Cohen-Sutherland 线段裁剪
  const INSIDE = 0, LEFT = 1, RIGHT = 2, BOTTOM = 4, TOP = 8;

  function code(x: number, y: number): number {
    let c = INSIDE;
    if (x < minX) c |= LEFT;
    else if (x > maxX) c |= RIGHT;
    if (y < minY) c |= BOTTOM;
    else if (y > maxY) c |= TOP;
    return c;
  }

  let c1 = code(x1, y1);
  let c2 = code(x2, y2);

  while (true) {
    if (!(c1 | c2)) return true;
    if (c1 & c2) return false;

    const cOut = c1 || c2;
    let x = 0, y = 0;

    if (cOut & TOP) {
      x = x1 + (x2 - x1) * (maxY - y1) / (y2 - y1);
      y = maxY;
    } else if (cOut & BOTTOM) {
      x = x1 + (x2 - x1) * (minY - y1) / (y2 - y1);
      y = minY;
    } else if (cOut & RIGHT) {
      y = y1 + (y2 - y1) * (maxX - x1) / (x2 - x1);
      x = maxX;
    } else {
      y = y1 + (y2 - y1) * (minX - x1) / (x2 - x1);
      x = minX;
    }

    if (cOut === c1) {
      x1 = x; y1 = y;
      c1 = code(x1, y1);
    } else {
      x2 = x; y2 = y;
      c2 = code(x2, y2);
    }
  }
}
