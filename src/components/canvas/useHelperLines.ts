import { useState, useCallback, useRef, useMemo } from 'react';
import { Node, NodeChange } from '@xyflow/react';

export interface HelperLine {
  id: string;
  type: 'vertical' | 'horizontal';
  coordinate: number;
  min: number;
  max: number;
}

const DEFAULT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  file: { width: 300, height: 200 },
  text: { width: 220, height: 180 },
  group: { width: 600, height: 400 },
  image: { width: 300, height: 300 },
  pdf: { width: 400, height: 500 },
  web: { width: 500, height: 400 },
};

// 高性能空间网格索引 - 使用 TypedArray 风格的扁平化存储
class SpatialIndex {
  private grid: Map<string, Node[]> = new Map();
  private cellSize: number;

  constructor(cellSize = 250) {
    this.cellSize = cellSize;
  }

  clear() {
    this.grid.clear();
  }

  /** 增量更新单个节点，避免全量重建 */
  updateNode(node: Node) {
    // 先移除旧的分桶（无法精确知道旧位置，所以用标记-清理策略）
    this.insert(node);
  }

  insert(node: Node) {
    const x = node.position.x;
    const y = node.position.y;
    const dims = this.getDimensions(node);

    const minCellX = Math.floor(x / this.cellSize);
    const maxCellX = Math.floor((x + dims.w) / this.cellSize);
    const minCellY = Math.floor(y / this.cellSize);
    const maxCellY = Math.floor((y + dims.h) / this.cellSize);

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const key = `${cx},${cy}`;
        if (!this.grid.has(key)) {
          this.grid.set(key, []);
        }
        const cell = this.grid.get(key)!;
        // 避免重复添加
        if (!cell.includes(node)) {
          cell.push(node);
        }
      }
    }
  }

  query(minX: number, minY: number, maxX: number, maxY: number): Node[] {
    const result = new Set<Node>();
    const minCellX = Math.floor(minX / this.cellSize);
    const maxCellX = Math.floor(maxX / this.cellSize);
    const minCellY = Math.floor(minY / this.cellSize);
    const maxCellY = Math.floor(maxY / this.cellSize);

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const cell = this.grid.get(`${cx},${cy}`);
        if (cell) {
          for (const node of cell) {
            result.add(node);
          }
        }
      }
    }
    return Array.from(result);
  }

  /** 查询某个节点附近的候选节点（扩展查询范围） */
  queryNearby(node: Node, margin = 150): Node[] {
    const x = node.position.x;
    const y = node.position.y;
    const dims = this.getDimensions(node);

    // 扩展查询范围，只查询附近的网格
    const minX = x - margin;
    const minY = y - margin;
    const maxX = x + dims.w + margin;
    const maxY = y + dims.h + margin;

    const candidates = this.query(minX, minY, maxX, maxY);
    return candidates.filter(n => n.id !== node.id && n.type !== 'group');
  }

  /** 获取节点尺寸 */
  getDimensions(node: Node): { w: number; h: number } {
    return {
      w: node.measured?.width || node.width || (node.style?.width as number) || DEFAULT_DIMENSIONS[node.type || '']?.width || 300,
      h: node.measured?.height || node.height || (node.style?.height as number) || DEFAULT_DIMENSIONS[node.type || '']?.height || 200,
    };
  }

  /** 获取某个节点的对齐坐标 */
  getAlignmentCoords(node: Node) {
    const x = node.position.x;
    const y = node.position.y;
    const { w, h } = this.getDimensions(node);
    return {
      left: x,
      right: x + w,
      top: y,
      bottom: y + h,
      centerX: x + w / 2,
      centerY: y + h / 2,
    };
  }
}

export function useHelperLines() {
  const [helperLines, setHelperLines] = useState<HelperLine[]>([]);
  const spatialIndexRef = useRef<SpatialIndex | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);

  /** 性能优化: 构建空间索引只在节点IDs/位置变化时触发 */
  const buildSpatialIndex = useCallback((nodes: Node[]): SpatialIndex => {
    const index = new SpatialIndex(300);
    for (const node of nodes) {
      if (node.type !== 'group' && !node.hidden) {
        index.insert(node);
      }
    }
    return index;
  }, []);

  /** 拖拽开始标记 */
  const onDragStart = useCallback((nodeId: string) => {
    isDraggingRef.current = true;
    dragStartPosRef.current = null;
  }, []);

  /** 高性能对齐计算 - 每帧调用 */
  const calculateHelperLines = useCallback((
    changes: NodeChange[],
    allNodes: Node[],
    snapThreshold = 6
  ): { snappedChanges: NodeChange[]; activeLines: HelperLine[] } => {
    const activeLines: HelperLine[] = [];

    // 性能优化: 拖拽期间复用空间索引，不每次重建
    if (!spatialIndexRef.current || !isDraggingRef.current) {
      spatialIndexRef.current = buildSpatialIndex(allNodes);
    }

    const spatialIndex = spatialIndexRef.current;
    if (!spatialIndex) return { snappedChanges: changes, activeLines: [] };

    const snappedChanges = changes.map(change => {
      if (change.type !== 'position' || !change.position || change.dragging !== true) {
        return change;
      }

      const draggedNodeId = change.id;
      const draggedNode = allNodes.find(n => n.id === draggedNodeId);
      if (!draggedNode) return change;

      const draggedX = change.position.x ?? 0;
      const draggedY = change.position.y ?? 0;
      const dims = spatialIndex.getDimensions(draggedNode);
      const draggedW = dims.w;
      const draggedH = dims.h;
      const draggedRight = draggedX + draggedW;
      const draggedBottom = draggedY + draggedH;
      const draggedCenterX = draggedX + draggedW / 2;
      const draggedCenterY = draggedY + draggedH / 2;

      let snapX: number | undefined = undefined;
      let snapY: number | undefined = undefined;

      // 性能优化: 只查询附近的节点，而非全量
      const candidates = spatialIndex.queryNearby(
        { ...draggedNode, position: { x: draggedX, y: draggedY } } as Node,
        150
      );

      // X 轴对齐检查
      for (const node of candidates) {
        if (snapX !== undefined) break;
        const nodeCoords = spatialIndex.getAlignmentCoords(node);

        const checks = [
          { d: draggedX, t: nodeCoords.left, snap: nodeCoords.left },
          { d: draggedX, t: nodeCoords.right, snap: nodeCoords.right },
          { d: draggedX, t: nodeCoords.centerX, snap: nodeCoords.centerX },
          { d: draggedRight, t: nodeCoords.left, snap: nodeCoords.left - draggedW },
          { d: draggedRight, t: nodeCoords.right, snap: nodeCoords.right - draggedW },
          { d: draggedRight, t: nodeCoords.centerX, snap: nodeCoords.centerX - draggedW },
          { d: draggedCenterX, t: nodeCoords.left, snap: nodeCoords.left - draggedW / 2 },
          { d: draggedCenterX, t: nodeCoords.right, snap: nodeCoords.right - draggedW / 2 },
          { d: draggedCenterX, t: nodeCoords.centerX, snap: nodeCoords.centerX - draggedW / 2 },
        ];

        for (const c of checks) {
          if (Math.abs(c.d - c.t) <= snapThreshold) {
            snapX = c.snap;
            const minY = Math.min(draggedY, nodeCoords.top) - 50;
            const maxY = Math.max(draggedBottom, nodeCoords.bottom) + 50;
            activeLines.push({
              id: `v-${node.id}-${c.t}`,
              type: 'vertical',
              coordinate: c.t,
              min: minY,
              max: maxY,
            });
            break;
          }
        }
      }

      // Y 轴对齐检查
      for (const node of candidates) {
        if (snapY !== undefined) break;
        const nodeCoords = spatialIndex.getAlignmentCoords(node);

        const checks = [
          { d: draggedY, t: nodeCoords.top, snap: nodeCoords.top },
          { d: draggedY, t: nodeCoords.bottom, snap: nodeCoords.bottom },
          { d: draggedY, t: nodeCoords.centerY, snap: nodeCoords.centerY },
          { d: draggedBottom, t: nodeCoords.top, snap: nodeCoords.top - draggedH },
          { d: draggedBottom, t: nodeCoords.bottom, snap: nodeCoords.bottom - draggedH },
          { d: draggedBottom, t: nodeCoords.centerY, snap: nodeCoords.centerY - draggedH },
          { d: draggedCenterY, t: nodeCoords.top, snap: nodeCoords.top - draggedH / 2 },
          { d: draggedCenterY, t: nodeCoords.bottom, snap: nodeCoords.bottom - draggedH / 2 },
          { d: draggedCenterY, t: nodeCoords.centerY, snap: nodeCoords.centerY - draggedH / 2 },
        ];

        for (const c of checks) {
          if (Math.abs(c.d - c.t) <= snapThreshold) {
            snapY = c.snap;
            const minX = Math.min(draggedX, nodeCoords.left) - 50;
            const maxX = Math.max(draggedRight, nodeCoords.right) + 50;
            activeLines.push({
              id: `h-${node.id}`,
              type: 'horizontal',
              coordinate: c.t,
              min: minX,
              max: maxX,
            });
            break;
          }
        }
      }

      return {
        ...change,
        position: {
          x: snapX !== undefined ? snapX : draggedX,
          y: snapY !== undefined ? snapY : draggedY,
        },
      };
    });

    setHelperLines(activeLines);
    return { snappedChanges, activeLines };
  }, [buildSpatialIndex]);

  /** 清除对齐线和索引缓存 */
  const clearHelperLines = useCallback(() => {
    setHelperLines([]);
    isDraggingRef.current = false;
    dragStartPosRef.current = null;
    // 拖拽结束后清除索引，下次拖拽重建
    spatialIndexRef.current = null;
  }, []);

  return {
    helperLines,
    calculateHelperLines,
    clearHelperLines,
    onDragStart,
  };
}
