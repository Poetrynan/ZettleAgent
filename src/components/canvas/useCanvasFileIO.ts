/**
 * useCanvasFileIO — extracted file I/O handlers for the Interactive Canvas.
 *
 * Provides save / open / new canvas, template application, and node-creation
 * helpers (file cards, sticky notes, groups, web embeds, PDF viewers).
 *
 * Compatible with Obsidian JSON Canvas 1.0 schema.
 */

import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { OPPOSITE_SIDE, placeAgainst, type AddNoteTarget } from './canvasGeometry';
import { DEFAULT_STICKY_HUE } from './cardContent';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readMarkdownFile, writeMarkdownFile, listDirectoryTree } from '../../lib/tauri';
import type { DirTreeNode } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { getRelationTypes } from './canvasConstants';
import { generateTemplate } from './canvasTemplates';

// ─── Supported file extensions for canvas file cards ───
const CANVAS_FILE_EXTENSIONS = new Set([
  'md', 'txt', 'canvas',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'pdf',
  'html', 'htm',
]);

// ─── Preset color map (JSON Canvas 1.0 spec) ───
const PRESET_COLORS: Record<string, string> = {
  '1': '#ef4444', // red
  '2': '#f97316', // orange
  '3': '#eab308', // yellow
  '4': '#22c55e', // green
  '5': '#06b6d4', // cyan
  '6': '#a855f7', // purple
};

/** Resolve a Canvas preset color number to a hex string, or pass through hex values. */
function resolveColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  return PRESET_COLORS[c] || c;
}

// ─── Image / PDF extension sets for type detection when loading ───
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const PDF_EXTS = new Set(['pdf']);

function getFileExt(filePath: string): string {
  return (filePath.split('.').pop() || '').toLowerCase();
}

/** Convert Obsidian JSON Canvas object → React Flow nodes/edges. */
function canvasObjectToFlow(
  canvasObj: { nodes?: any[]; edges?: any[] },
  lang: string,
): { rfNodes: Node[]; rfEdges: Edge[] } {
  const rfNodes: Node[] = (canvasObj.nodes || []).map((n: any) => {
    const w = n.width || 400;
    const h = n.height || 300;
    const base = {
      id: n.id,
      position: { x: n.x || 0, y: n.y || 0 },
      width: w,
      height: h,
      style: { width: w, height: h },
    };
    const color = resolveColor(n.color);

    if (n.type === 'link') {
      return { ...base, type: 'web', data: { url: n.url || '', lang, color } };
    }

    if (n.type === 'file' && n.file) {
      const ext = getFileExt(n.file);

      if (IMAGE_EXTS.has(ext)) {
        return { ...base, type: 'image', data: { file: n.file, color } };
      }
      if (PDF_EXTS.has(ext)) {
        return { ...base, type: 'pdf', data: { file: n.file, lang, color } };
      }

      const title =
        n.file.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || n.file;
      return {
        ...base,
        type: 'file',
        data: {
          file: n.file,
          title,
          color: color || '#3b82f6',
          ...(n.subpath ? { subpath: n.subpath } : {}),
        },
      };
    }

    if (n.type === 'text') {
      return {
        ...base,
        type: 'text',
        data: {
          text: n.text || '',
          label: n.label,
          color,
          lang,
        },
      };
    }

    if (n.type === 'group') {
      return {
        ...base,
        type: 'group',
        data: {
          label: n.label || '',
          color,
          ...(n.background ? { background: n.background } : {}),
          ...(n.backgroundStyle ? { backgroundStyle: n.backgroundStyle } : {}),
        },
      };
    }

    return {
      ...base,
      type: n.type || 'file',
      data: {
        file: n.file,
        text: n.text,
        label: n.label,
        color,
        url: n.url,
        title: n.title,
        lang,
        ...(n.background ? { background: n.background } : {}),
        ...(n.backgroundStyle ? { backgroundStyle: n.backgroundStyle } : {}),
        ...(n.subpath ? { subpath: n.subpath } : {}),
      },
    };
  });

  const rfEdges: Edge[] = (canvasObj.edges || []).map((e: any) => {
    const relationType = e.relationType;
    const rel = relationType
      ? getRelationTypes().find((r) => r.type === relationType)
      : undefined;
    const edgeColor = resolveColor(e.color) || rel?.color;
    return {
      id: e.id,
      source: e.fromNode,
      target: e.toNode,
      sourceHandle: e.fromSide || 'right',
      targetHandle: e.toSide || 'left',
      label: e.label,
      style: edgeColor ? { stroke: edgeColor } : undefined,
      data: {
        color: resolveColor(e.color),
        fromEnd: e.fromEnd,
        toEnd: e.toEnd,
        relationType,
      },
    };
  });

  return { rfNodes, rfEdges };
}

// ─── Unique ID helper ───
function genId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Hook parameter interface ───

export interface CanvasFileIOParams {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  reactFlowInstance: any;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  lang: string;
  methodology: string;
  vaultPath: string | null;
  vaultPaths: string[];
  canvasPath: string | null;
  setCanvasPath: (p: string | null) => void;
  /** Set after a local save so external-reload listeners can skip self-triggered events. */
  lastLocalCanvasSaveRef?: MutableRefObject<{ path: string; at: number } | null>;
}

// ─── Hook return type ───

export interface CanvasFileIOReturn {
  // File I/O
  handleSaveCanvas: () => Promise<void>;
  handleOpenCanvas: () => Promise<void>;
  handleNewCanvas: () => void;
  applyTemplate: (templateId: string | null) => void;
  /** Reload an on-disk .canvas file (e.g. after Agent modify_canvas). */
  reloadCanvasFromPath: (path: string, options?: { silent?: boolean; fitView?: boolean }) => Promise<void>;

  // Node creators
  handleAddNoteNode: (filePath: string) => void;
  handleAddTextNode: () => void;
  handleAddGroupNode: () => void;
handleAddWebNode: () => void;
handleAddPdfNode: () => Promise<void>;
handleAddImageNode: () => Promise<void>;

  // Utility
  flattenTree: (node: DirTreeNode) => string[];
  openAddNoteModal: (target?: AddNoteTarget) => Promise<void>;

  // UI state for modals (caller renders the modal UI)
  isAddNoteOpen: boolean;
  setIsAddNoteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isTemplateOpen: boolean;
  setIsTemplateOpen: React.Dispatch<React.SetStateAction<boolean>>;
  noteSearch: string;
  setNoteSearch: React.Dispatch<React.SetStateAction<string>>;
  vaultNotes: string[];
  setVaultNotes: React.Dispatch<React.SetStateAction<string[]>>;
}

// ─── Hook ───

export function useCanvasFileIO(params: CanvasFileIOParams): CanvasFileIOReturn {
  const {
    nodes, edges,
    setNodes, setEdges,
    reactFlowInstance,
    showToast,
    lang, methodology,
    vaultPath, vaultPaths,
    canvasPath, setCanvasPath,
    lastLocalCanvasSaveRef,
  } = params;

  // ── Local UI state for modals ──
  const [isAddNoteOpen, setIsAddNoteOpen] = useState(false);
  const [isTemplateOpen, setIsTemplateOpen] = useState(false);
  const [noteSearch, setNoteSearch] = useState('');
  const [vaultNotes, setVaultNotes] = useState<string[]>([]);
  /** Where the next picked note goes: a right-click spot, or the end of a dragged line. */
  const addNoteTargetRef = useRef<AddNoteTarget | null>(null);

  // ────────────────────────────────────────────────
  //  Where a new card goes: the centre of the visible canvas (not the window,
  //  which is off-centre with the sidebar open), or the nearest free spot
  //  around it, so new cards never land on top of each other.
  // ────────────────────────────────────────────────

  const placeNewNode = useCallback((w: number, h: number, opts: { avoidGroups?: boolean } = {}) => {
    const el = document.querySelector('.interactive-canvas-container .react-flow') as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    const center = reactFlowInstance.screenToFlowPosition({
      x: r ? r.left + r.width / 2 : window.innerWidth / 2,
      y: r ? r.top + r.height / 2 : window.innerHeight / 2,
    });
    const snap = (v: number) => Math.round(v / 20) * 20;
    const GAP = 24;

    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const n of reactFlowInstance.getNodes() as Node[]) {
      if (n.type === 'group' && !opts.avoidGroups) continue; // cards may go inside groups
      const abs = reactFlowInstance.getInternalNode?.(n.id)?.internals?.positionAbsolute ?? n.position;
      boxes.push({
        x: abs.x,
        y: abs.y,
        w: n.measured?.width ?? n.width ?? (n.style?.width as number) ?? 300,
        h: n.measured?.height ?? n.height ?? (n.style?.height as number) ?? 200,
      });
    }
    const free = (x: number, y: number) =>
      !boxes.some(b => x < b.x + b.w + GAP && x + w + GAP > b.x && y < b.y + b.h + GAP && y + h + GAP > b.y);

    const x0 = center.x - w / 2;
    const y0 = center.y - h / 2;
    if (free(x0, y0)) return { x: snap(x0), y: snap(y0) };
    // Search rings outward on a grid the size of the new card; nearest free cell wins.
    const stepX = w + GAP;
    const stepY = h + GAP;
    for (let ring = 1; ring <= 8; ring++) {
      let best: { x: number; y: number; d: number } | null = null;
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const x = x0 + i * stepX;
          const y = y0 + j * stepY;
          if (!free(x, y)) continue;
          const d = Math.hypot(i * stepX, j * stepY);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
      if (best) return { x: snap(best.x), y: snap(best.y) };
    }
    return { x: snap(x0), y: snap(y0) };
  }, [reactFlowInstance]);

  // ────────────────────────────────────────────────
  //  Flatten a DirTreeNode into a list of file paths
  // ────────────────────────────────────────────────

  const flattenTree = useCallback((node: DirTreeNode): string[] => {
    if (!node.is_dir) {
      const ext = node.name.split('.').pop()?.toLowerCase() || '';
      return CANVAS_FILE_EXTENSIONS.has(ext) ? [node.path] : [];
    }
    return node.children.flatMap((child) => flattenTree(child));
  }, []);

  // ────────────────────────────────────────────────
  //  Open the "Add Note" modal — load vault file list
  // ────────────────────────────────────────────────

  const openAddNoteModal = useCallback(async (target?: AddNoteTarget) => {
    // Called straight from onClick handlers too, which pass the click event.
    addNoteTargetRef.current = target && 'kind' in target ? target : null;
    if (!vaultPaths || vaultPaths.length === 0) {
      showToast(t('canvas.noVault'), 'error');
      return;
    }
    try {
      const allFiles: string[] = [];
      for (const vp of vaultPaths) {
        const tree = await listDirectoryTree(vp);
        allFiles.push(...flattenTree(tree));
      }
      // Deduplicate and sort alphabetically by filename
      setVaultNotes(
        [...new Set(allFiles)].sort((a, b) => {
          const na = a.replace(/\\/g, '/').split('/').pop() || a;
          const nb = b.replace(/\\/g, '/').split('/').pop() || b;
          return na.localeCompare(nb);
        }),
      );
      setIsAddNoteOpen(true);
      setNoteSearch('');
    } catch (err) {
      showToast(String(err), 'error');
    }
  }, [vaultPaths, flattenTree, showToast]);

  // ────────────────────────────────────────────────
  //  Add a file card to the canvas (auto-detect type)
  // ────────────────────────────────────────────────

  const handleAddNoteNode = useCallback(
    (filePath: string) => {
      const name =
        filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || filePath;
      const ext = filePath.split('.').pop()?.toLowerCase() || '';

      const target = addNoteTargetRef.current;
      addNoteTargetRef.current = null;
      const size = ext === 'pdf' ? { w: 420, h: 450 } : ext === 'html' || ext === 'htm' ? { w: 500, h: 400 } : { w: 400, h: 300 };
      const position = target
        ? placeAgainst(target.at, size.w, size.h, target.kind === 'connect' ? target.fromSide : undefined)
        : placeNewNode(size.w, size.h);

      let newNode: Node;

      if (ext === 'pdf') {
        newNode = {
          id: genId(), type: 'pdf', position,
          width: 420, height: 450,
          style: { width: 420, height: 450 },
          data: { file: filePath, lang },
        };
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
        newNode = {
          id: genId(), type: 'image', position,
          width: 400, height: 300,
          style: { width: 400, height: 300 },
          data: { file: filePath },
        };
      } else if (['html', 'htm'].includes(ext)) {
        newNode = {
          id: genId(), type: 'web', position,
          width: 500, height: 400,
          style: { width: 500, height: 400 },
          data: { url: filePath, lang },
        };
      } else {
        // Default: markdown / text file node
        newNode = {
          id: genId(), type: 'file', position,
          width: 400, height: 300,
          style: { width: 400, height: 300 },
          data: { file: filePath, title: name },
        };
      }

      setNodes((nds) => nds.concat(newNode));
      if (target?.kind === 'connect') {
        setEdges((eds) => eds.concat({
          id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          source: target.sourceNodeId,
          sourceHandle: target.fromSide,
          target: newNode.id,
          targetHandle: OPPOSITE_SIDE[target.fromSide],
          data: { relationType: 'wikilink', fromEnd: 'none', toEnd: 'arrow' },
        }));
      }
      setIsAddNoteOpen(false);
    },
    [placeNewNode, lang, setNodes, setEdges],
  );

  // ────────────────────────────────────────────────
  //  Add a yellow sticky text node
  // ────────────────────────────────────────────────

  const handleAddTextNode = useCallback(() => {
    const position = placeNewNode(250, 250);

    const newNode: Node = {
      id: genId(),
      type: 'text',
      position,
      width: 250,
      height: 250,
      style: { width: 250, height: 250 },
      data: { text: '', color: DEFAULT_STICKY_HUE },
    };

    setNodes((nds) => nds.concat(newNode));
  }, [placeNewNode, setNodes]);

  // ────────────────────────────────────────────────
  //  Add a dashed group node
  // ────────────────────────────────────────────────

  const handleAddGroupNode = useCallback(() => {
    const position = placeNewNode(600, 400);

    const newNode: Node = {
      id: genId(),
      type: 'group',
      position,
      width: 600,
      height: 400,
      style: { width: 600, height: 400 },
      data: { label: lang === 'zh' ? '新分组' : 'New group' },
    };

    setNodes((nds) => nds.concat(newNode));
  }, [reactFlowInstance, setNodes]);

  // ────────────────────────────────────────────────
  //  Add a web embed (iframe) node
  // ────────────────────────────────────────────────

  const handleAddWebNode = useCallback(() => {
    const position = placeNewNode(360, 280);

    const newNode: Node = {
      id: genId(),
      type: 'web',
      position,
      width: 360,
      height: 280,
      style: { width: 360, height: 280 },
      data: { url: '', lang },
    };

    setNodes((nds) => nds.concat(newNode));
  }, [reactFlowInstance, lang, setNodes]);

  // ────────────────────────────────────────────────
  //  Add a PDF viewer node via file dialog
  // ────────────────────────────────────────────────

  const handleAddPdfNode = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        title: lang === 'zh' ? '选择 PDF 文件' : 'Select PDF File',
        defaultPath: vaultPath || undefined,
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      });
      if (!selected) return;

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      const position = placeNewNode(420, 560);

      const newNode: Node = {
        id: genId(),
        type: 'pdf',
        position,
        width: 420,
        height: 450,
        style: { width: 420, height: 450 },
        data: { file: filePath, lang },
      };

      setNodes((nds) => nds.concat(newNode));
    } catch (err) {
      showToast(`Failed to add PDF: ${err}`, 'error');
    }
  }, [reactFlowInstance, lang, vaultPath, setNodes, showToast]);

  // ────────────────────────────────────────────────
  //  Add an image node via file dialog
  // ────────────────────────────────────────────────

  const handleAddImageNode = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        title: lang === 'zh' ? '选择图片文件' : 'Select Image File',
        defaultPath: vaultPath || undefined,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      });
      if (!selected) return;

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      const position = placeNewNode(400, 300);

      const newNode: Node = {
        id: genId(),
        type: 'image',
        position,
        width: 400,
        height: 300,
        style: { width: 400, height: 300 },
        data: { file: filePath },
      };

      setNodes((nds) => nds.concat(newNode));
    } catch (err) {
      showToast(`Failed to add image: ${err}`, 'error');
    }
  }, [reactFlowInstance, lang, vaultPath, setNodes, showToast]);

  // ────────────────────────────────────────────────
  //  Save whiteboard to .canvas JSON file
  // ────────────────────────────────────────────────

  const handleSaveCanvas = useCallback(async () => {
    let targetPath = canvasPath;

    // If no path yet, prompt the user for a save location
    if (!targetPath) {
      try {
        const selected = await save({
          title: 'Save Whiteboard Canvas',
          defaultPath: vaultPath ? `${vaultPath}/whiteboard.canvas` : undefined,
          filters: [{ name: 'Obsidian Canvas', extensions: ['canvas'] }],
        });
        if (!selected) return;
        targetPath = selected;
      } catch (err) {
        showToast(`Failed to open save dialog: ${err}`, 'error');
        return;
      }
    }

    try {
      // Map to Obsidian-compatible JSON Canvas 1.0 schema.
      // Custom types are mapped to standard spec types for interop:
      //   image -> file   (Obsidian treats images as file nodes)
      //   pdf   -> file   (same)
      //   web   -> link   (spec-standard URL node type)
      // Sort by zIndex for correct z-ordering (array order = z-index).
      const sortedNodes = [...nodes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

      const canvasNodes = sortedNodes.map((n) => {
        const width = Math.round(n.width || (n.style?.width as number) || 400);
        const height = Math.round(n.height || (n.style?.height as number) || 300);
        const color = n.data.color as string | undefined;
        const base = {
          id: n.id,
          x: Math.round(n.position.x),
          y: Math.round(n.position.y),
          width,
          height,
        };

        if (n.type === 'file') {
          const result: any = { ...base, type: 'file', file: n.data.file as string, color };
          if (n.data.subpath) result.subpath = n.data.subpath;
          return result;
        }

        if (n.type === 'text') {
          return { ...base, type: 'text', text: (n.data.text as string) || '', color };
        }

        if (n.type === 'image') {
          return { ...base, type: 'file', file: n.data.file as string, color };
        }

        if (n.type === 'pdf') {
          return { ...base, type: 'file', file: n.data.file as string, color };
        }

        if (n.type === 'web') {
          return { ...base, type: 'link', url: n.data.url as string, color };
        }

        // Group node — preserve background fields for Obsidian interop
        const group: any = { ...base, type: 'group', label: (n.data.label as string) || '', color };
        if (n.data.background) group.background = n.data.background;
        if (n.data.backgroundStyle) group.backgroundStyle = n.data.backgroundStyle;
        return group;
      });

      const canvasEdges = edges.map((e) => ({
        id: e.id,
        fromNode: e.source,
        fromSide: e.sourceHandle || 'right',
        fromEnd: (e.data?.fromEnd as string) || 'none',
        toNode: e.target,
        toSide: e.targetHandle || 'left',
        toEnd: (e.data?.toEnd as string) || 'arrow',
        label: e.label,
        color: e.data?.color as string | undefined,
        relationType: e.data?.relationType as string | undefined,
      }));

      const canvasJson = JSON.stringify({ nodes: canvasNodes, edges: canvasEdges }, null, 2);
      await writeMarkdownFile(targetPath!, canvasJson);
      setCanvasPath(targetPath);
      if (lastLocalCanvasSaveRef) {
        lastLocalCanvasSaveRef.current = { path: targetPath!, at: Date.now() };
      }
      showToast(t('canvas.savedOk'), 'success');
    } catch (err) {
      console.error('Failed to save canvas:', err);
      showToast(`Save failed: ${err}`, 'error');
    }
  }, [nodes, edges, canvasPath, vaultPath, setCanvasPath, showToast, lastLocalCanvasSaveRef]);

  const applyCanvasObject = useCallback(
    (
      canvasObj: { nodes?: any[]; edges?: any[] },
      path: string,
      options?: { silent?: boolean; fitView?: boolean },
    ) => {
      if (!canvasObj || !Array.isArray(canvasObj.nodes)) {
        if (!options?.silent) {
          showToast('Invalid .canvas file structure', 'error');
        }
        return false;
      }

      const { rfNodes, rfEdges } = canvasObjectToFlow(canvasObj, lang);
      setNodes(rfNodes);
      setEdges(rfEdges);
      setCanvasPath(path);

      if (!options?.silent) {
        showToast(t('canvas.loadedOk'), 'success');
      }
      if (options?.fitView !== false) {
        setTimeout(() => {
          reactFlowInstance.fitView({ padding: 0.1, duration: options?.silent ? 400 : 800 });
        }, 100);
      }
      return true;
    },
    [lang, reactFlowInstance, setNodes, setEdges, setCanvasPath, showToast],
  );

  const reloadCanvasFromPath = useCallback(
    async (path: string, options?: { silent?: boolean; fitView?: boolean }) => {
      try {
        const jsonStr = await readMarkdownFile(path);
        const canvasObj = JSON.parse(jsonStr);
        applyCanvasObject(canvasObj, path, options);
      } catch (err) {
        console.error('Failed to reload canvas:', err);
        if (!options?.silent) {
          showToast(`Load failed: ${err}`, 'error');
        }
      }
    },
    [applyCanvasObject, showToast],
  );

  // ────────────────────────────────────────────────
  //  Load an existing .canvas file
  // ────────────────────────────────────────────────

  const handleOpenCanvas = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        title: 'Open Whiteboard Canvas',
        defaultPath: vaultPath || undefined,
        filters: [{ name: 'Obsidian Canvas', extensions: ['canvas'] }],
      });
      if (!selected) return;

      const path = Array.isArray(selected) ? selected[0] : selected;
      await reloadCanvasFromPath(path);
    } catch (err) {
      console.error('Failed to open canvas:', err);
      showToast(`Load failed: ${err}`, 'error');
    }
  }, [vaultPath, reloadCanvasFromPath, showToast]);

  // ────────────────────────────────────────────────
  //  New canvas — opens the template selector
  // ────────────────────────────────────────────────

  const handleNewCanvas = useCallback(() => {
    setIsTemplateOpen(true);
  }, []);

  // ────────────────────────────────────────────────
  //  Apply a canvas template (null = blank canvas)
  // ────────────────────────────────────────────────

  const applyTemplate = useCallback(
    (templateId: string | null) => {
      if (templateId === null) {
        // Blank canvas
        setNodes([]);
        setEdges([]);
        setCanvasPath(null);
        showToast(t('canvas.newCreated'), 'info');
      } else {
        const { nodes: tn, edges: te } = generateTemplate(templateId, methodology);
        setNodes(tn);
        setEdges(te);
        setCanvasPath(null);
        showToast(t('canvas.templateApplied'), 'success');
        setTimeout(() => reactFlowInstance.fitView({ padding: 0.15, duration: 800 }), 100);
      }
      setIsTemplateOpen(false);
    },
    [methodology, reactFlowInstance, setNodes, setEdges, setCanvasPath, showToast],
  );

  // ────────────────────────────────────────────────
  //  Return everything
  // ────────────────────────────────────────────────

  return {
    // File I/O
    handleSaveCanvas,
    handleOpenCanvas,
    handleNewCanvas,
    applyTemplate,
    reloadCanvasFromPath,

    // Node creators
    handleAddNoteNode,
    handleAddTextNode,
    handleAddGroupNode,
handleAddWebNode,
handleAddPdfNode,
handleAddImageNode,

    // Utility
    flattenTree,
    openAddNoteModal,

    // Modal UI state
    isAddNoteOpen,
    setIsAddNoteOpen,
    isTemplateOpen,
    setIsTemplateOpen,
    noteSearch,
    setNoteSearch,
    vaultNotes,
    setVaultNotes,
  };
}
