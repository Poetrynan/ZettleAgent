import { useState } from 'react';
import { t, tf } from '../../lib/i18n';
import {
  addNoteRelation,
  deleteNoteRelation,
  explainRelationship,
} from '../../lib/tauri';
import { getRelationTypes, getRelationLabel } from '../canvas/canvasConstants';
import { RelationEvidenceDrawer } from '../knowledge/RelationEvidenceDrawer';
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
  const [showExplainPicker, setShowExplainPicker] = useState(false);
  /** 打开证据抽屉时选中的那条边。关系类型必须由用户指定——两篇笔记之间可以有多条。 */
  const [evidenceEdge, setEvidenceEdge] = useState<{
    source: string;
    target: string;
    relationType: string;
  } | null>(null);

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
    const label = relationLabelOf(relationType);
    try {
      // 后端回的是「真的发生了什么」，不是 void：已存在与曾被拒绝都不是新增，
      // 报成「已添加」就是假成功。
      const outcome = await addNoteRelation(a.id, b.id, relationType, 'Created from graph view');
      if (outcome === 'added') {
        showToast?.(tf('graph.relation.added', label), 'success');
        onRelationChanged?.();
      } else if (outcome === 'already_exists') {
        showToast?.(tf('graph.relation.alreadyExists', label), 'info');
      } else {
        showToast?.(tf('graph.relation.rejectedByUser', label), 'info');
      }
      close();
    } catch (e) {
      showToast?.(tf('graph.relation.addFailed', String(e)), 'error');
    }
  };

  const handleDeleteRelation = async (relationType: string) => {
    if (!pairNodes) return;
    const [a, b] = pairNodes;
    const label = relationLabelOf(relationType);
    try {
      // 关系有方向，两个方向各删一次；两次都说「不存在」才算真的没有这条边。
      const forward = await deleteNoteRelation(a.id, b.id, relationType);
      const backward = await deleteNoteRelation(b.id, a.id, relationType);
      if (forward || backward) {
        showToast?.(tf('graph.relation.deleted', label), 'success');
        onRelationChanged?.();
      } else {
        showToast?.(tf('graph.relation.notFound', label), 'info');
      }
      close();
    } catch (e) {
      showToast?.(tf('graph.relation.deleteFailed', String(e)), 'error');
    }
  };

  /** 打开证据抽屉：这条边的来历、语义与原文都由后端给，前端不猜。 */
  const handleExplainRelation = (relationType: string) => {
    if (!pairNodes) return;
    const [a, b] = pairNodes;
    setShowExplainPicker(false);
    setEvidenceEdge({ source: a.id, target: b.id, relationType });
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
    <>
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

          {/* 解释关系 —— 后端证据抽屉：来历、语义、原文、接受/拒绝 */}
          <div
            className="kg-context-menu-item"
            onClick={() => setShowExplainPicker(!showExplainPicker)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            {t('graph.relation.explain')}
          </div>
          {showExplainPicker && (
            <div className="kg-context-submenu">
              <div className="kg-context-hint">{t('graph.relation.pickType')}</div>
              {getRelationTypes().map(rel => (
                <div
                  key={rel.type}
                  className="kg-context-relation-item"
                  onClick={() => handleExplainRelation(rel.type)}
                >
                  <div className="kg-context-relation-dot" style={{ backgroundColor: rel.color }} />
                  {getRelationLabel(rel)}
                </div>
              ))}
            </div>
          )}

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
                  {getRelationLabel(rel)}
                </div>
              ))}
            </div>
          )}

          {/* Delete relation — 必须指定关系类型，两篇笔记之间可能有多条边 */}
          <div
            className="kg-context-menu-item"
            onClick={() => setShowDeleteRelation(!showDeleteRelation)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: -1 }}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            {isZh ? '删除关系' : 'Delete Relation'}
          </div>
          {showDeleteRelation && (
            <div className="kg-context-submenu">
              <div className="kg-context-hint">{t('graph.relation.deletePick')}</div>
              {getRelationTypes().map(rel => (
                <div
                  key={rel.type}
                  className="kg-context-relation-item kg-context-relation-danger"
                  onClick={() => handleDeleteRelation(rel.type)}
                >
                  <div className="kg-context-relation-dot" style={{ backgroundColor: rel.color }} />
                  {getRelationLabel(rel)}
                </div>
              ))}
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

    {evidenceEdge && (
      <RelationEvidenceDrawer
        sourcePath={evidenceEdge.source}
        targetPath={evidenceEdge.target}
        relationType={evidenceEdge.relationType}
        showToast={showToast}
        onDecided={() => onRelationChanged?.()}
        onClose={() => setEvidenceEdge(null)}
      />
    )}
    </>
  );
}

/** 关系类型的人类可读名字，找不到就退回原始串（而不是造一个假标签）。 */
function relationLabelOf(relationType: string): string {
  const meta = getRelationTypes().find(r => r.type === relationType);
  return meta ? getRelationLabel(meta) : relationType;
}
