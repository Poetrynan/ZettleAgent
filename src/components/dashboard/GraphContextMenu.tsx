import { useState } from 'react';
import { t } from '../../lib/i18n';
import {
  addNoteRelation,
  deleteNoteRelation,
  explainRelationship,
} from '../../lib/tauri';
import { getRelationTypes } from '../canvas/canvasConstants';
import type { LlmConfig } from '../../contexts/BaseContext';
import type { FGNode } from './KnowledgeGraph';

interface GraphContextMenuProps {
  contextMenu: { x: number; y: number; node: FGNode };
  setContextMenu: (menu: null) => void;
  setCurrentFile: (file: string) => void;
  setView: (view: any) => void;
  setIsLocalMode: (local: boolean) => void;
  setFocusNodeId: (id: string | null) => void;
  handleDeleteNode: () => void;
  handleFilterSwitch: (cb: () => void) => void;
  isZh: boolean;
  /** All currently selected nodes (for multi-node operations) */
  selectedNodes?: FGNode[];
  /** LLM config for AI-powered features */
  llmConfig?: LlmConfig;
  /** Callback after a relation is added/deleted (to refresh graph) */
  onRelationChanged?: () => void;
  /** Callback to show a toast message */
  showToast?: (msg: string, type?: 'info' | 'success' | 'error') => void;
}

export function GraphContextMenu({
  contextMenu,
  setContextMenu,
  setCurrentFile,
  setView,
  setIsLocalMode,
  setFocusNodeId,
  handleDeleteNode,
  handleFilterSwitch,
  isZh,
  selectedNodes = [],
  llmConfig,
  onRelationChanged,
  showToast,
}: GraphContextMenuProps) {
  const [showRelationPicker, setShowRelationPicker] = useState(false);
  const [showDeleteRelation, setShowDeleteRelation] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const node = contextMenu.node;
  // Determine if we have a pair for relationship operations
  // If multiple nodes selected, use the first selected + the right-clicked node as the pair
  const pairNodes: [FGNode, FGNode] | null = (() => {
    if (selectedNodes.length >= 2) {
      const other = selectedNodes.find(n => n.id !== node.id);
      if (other) return [other, node];
      return [selectedNodes[0], selectedNodes[1]];
    }
    // If only right-clicked node is selected but there's exactly one other selected node
    if (selectedNodes.length === 1 && selectedNodes[0].id !== node.id) {
      return [selectedNodes[0], node];
    }
    return null;
  })();

  const close = () => setContextMenu(null);

  const handleOpen = () => {
    close();
    setCurrentFile(node.id);
    setView('note');
  };

  const handleFocus = () => {
    close();
    setIsLocalMode(true);
    setFocusNodeId(node.id);
    handleFilterSwitch(() => {});
  };

  const handleAddRelation = async (relationType: string) => {
    if (!pairNodes) return;
    const [a, b] = pairNodes;
    try {
      await addNoteRelation(a.id, b.id, relationType, 'Created from graph view');
      showToast?.(isZh ? `已添加关系: ${relationType}` : `Relation added: ${relationType}`, 'success');
      onRelationChanged?.();
      close();
    } catch (e) {
      showToast?.(isZh ? `添加关系失败: ${e}` : `Failed: ${e}`, 'error');
    }
  };

  const handleDeleteRelation = async () => {
    if (!pairNodes) return;
    const [a, b] = pairNodes;
    try {
      const deleted = await deleteNoteRelation(a.id, b.id);
      if (deleted) {
        // Also try reverse direction
        await deleteNoteRelation(b.id, a.id);
      }
      showToast?.(isZh ? '已删除关系' : 'Relation deleted', 'success');
      onRelationChanged?.();
      close();
    } catch (e) {
      showToast?.(isZh ? `删除失败: ${e}` : `Failed: ${e}`, 'error');
    }
  };

  const handleAiExplain = async () => {
    if (!pairNodes || !llmConfig) {
      showToast?.(isZh ? '请先配置 LLM' : 'Please configure LLM first', 'error');
      return;
    }
    const [a, b] = pairNodes;
    setAiLoading(true);
    setAiExplanation(null);
    try {
      const result = await explainRelationship(
        a.id, b.id,
        llmConfig.apiUrl,
        llmConfig.apiKey || null,
        llmConfig.model,
        llmConfig.providerId || null,
      );
      setAiExplanation(result);
    } catch (e) {
      setAiExplanation(isZh ? `分析失败: ${e}` : `Analysis failed: ${e}`);
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div
      className="kg-context-menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Basic operations */}
      <div className="kg-context-menu-item" onClick={handleOpen}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        {t('common.open' as any)}
      </div>
      <div className="kg-context-menu-item" onClick={handleFocus}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        {isZh ? '聚焦此节点' : 'Focus Here'}
      </div>

      {/* Relation operations — only when 2 nodes are selected */}
      {pairNodes && (
        <>
          <div className="kg-context-divider" />

          {/* AI Explain Relationship */}
          <div className="kg-context-menu-item kg-context-menu-ai" onClick={handleAiExplain}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><path d="M9 11H1l8-8 8 8h-8v8"/><path d="M22 19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2"/></svg>
            {isZh ? 'AI 解释关系' : 'AI Explain Relation'}
          </div>

          {/* Add relation submenu */}
          <div
            className="kg-context-menu-item"
            onClick={() => setShowRelationPicker(!showRelationPicker)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            {isZh ? '建立关系' : 'Add Relation'}
          </div>
          {showRelationPicker && (
            <div className="kg-context-submenu">
              {getRelationTypes().map(rel => (
                <div
                  key={rel.type}
                  className="kg-context-relation-item"
                  onClick={() => handleAddRelation(rel.type)}
                >
                  <div
                    className="kg-context-relation-dot"
                    style={{ backgroundColor: rel.color }}
                  />
                  {isZh ? rel.labelZh : rel.label}
                </div>
              ))}
            </div>
          )}

          {/* Delete relation */}
          <div
            className="kg-context-menu-item"
            onClick={() => setShowDeleteRelation(!showDeleteRelation)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            {isZh ? '删除关系' : 'Delete Relation'}
          </div>
          {showDeleteRelation && (
            <div className="kg-context-submenu">
              <div
                className="kg-context-relation-item kg-context-relation-danger"
                onClick={handleDeleteRelation}
              >
                {isZh ? '确认删除连线' : 'Confirm delete'}
              </div>
            </div>
          )}
        </>
      )}

      {/* AI Explanation result */}
      {aiLoading && (
        <div className="kg-context-ai-loading">
          <span className="kg-context-spinner" />
          {isZh ? 'AI 分析中...' : 'AI analyzing...'}
        </div>
      )}
      {aiExplanation && (
        <div className="kg-context-ai-result">
          {aiExplanation}
          <div className="kg-context-ai-actions">
            <button
              className="kg-context-ai-btn"
              onClick={() => {
                navigator.clipboard?.writeText(aiExplanation);
                showToast?.(isZh ? '已复制' : 'Copied', 'success');
              }}
            >
              {isZh ? '复制' : 'Copy'}
            </button>
            <button
              className="kg-context-ai-close"
              onClick={() => setAiExplanation(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Hint when only 1 node is selected */}
      {!pairNodes && (
        <div className="kg-context-hint">
          {isZh
            ? 'Ctrl+点击另一节点可建立关系'
            : 'Ctrl+Click another node to relate'}
        </div>
      )}

      <div className="kg-context-divider" />
      <div className="kg-context-menu-item danger" onClick={handleDeleteNode}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        {t('common.delete' as any)}
      </div>
    </div>
  );
}
