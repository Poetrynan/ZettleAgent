import React, { useState } from 'react';
import { getLang } from '../../lib/i18n';
import {
  IconClose,
  IconSync,
  IconBrain,
  IconSparkle,
  IconWarning,
  IconCanvas,
  IconSearch,
  IconCheck,
  IconDatabase,
  IconChart,
} from '../icons';

interface QuickActionsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QuickActionsHelp({ isOpen, onClose }: QuickActionsHelpProps) {
  const [activeTab, setActiveTab] = useState<'actions' | 'matrix' | 'workflow'>('actions');
  if (!isOpen) return null;

  const isZh = getLang() === 'zh';

  const ACTIONS = [
    {
      id: 'sync',
      icon: <IconSync size={18} />,
      title: isZh ? '知识库同步 (Sync Vault)' : 'Sync Vault',
      badge: 'FTS5 · SHA-256',
      desc: isZh
        ? '增量扫描 Vault 笔记目录，比对文件 SHA-256 哈希，将新增或变更的 Markdown 笔记切片分块并构建 FTS5 全文索引。'
        : 'Incrementally scan the vault folder, compare SHA-256 hashes, chunk modified Markdown files, and build FTS5 full-text index.',
      details: [
        isZh ? '自动解析 YAML Frontmatter（标签、分类、别名）并入库' : 'Parses YAML Frontmatter (tags, category, aliases) into database metadata',
        isZh ? '自动维护 SQLite FTS5 倒排索引，支持中英文分词与前缀即时匹配' : 'Maintains SQLite FTS5 inverted index for instant prefix and lexical search',
        isZh ? '轻量零显存开销，完全在 Rust 原生层多线程毫秒级完成' : 'Zero GPU memory cost, processed natively in Rust multi-threaded in milliseconds',
      ],
      ftsStatus: isZh ? '自动增量构建 (FTS5)' : 'Auto-built (FTS5)',
      embStatus: isZh ? '不在此阶段生成 (需构建向量索引)' : 'Not generated (Run Vector Indexing)',
      tip: isZh
        ? '💡 建议在外部编辑器（如 Obsidian/VSCode）新增或批量修改笔记后点击同步。'
        : '💡 Recommended to run after adding or modifying notes in external editors.',
    },
    {
      id: 'embed',
      icon: <IconBrain size={18} />,
      title: isZh ? '构建向量索引 (Vector Indexing)' : 'Build Vector Index',
      badge: 'SQLITE-VEC · ONNX INT8',
      desc: isZh
        ? '调用本地内置的神经网络 Embedding 模型，为全部卡片切片生成稠密向量，存入 SQLite-Vec 向量数据库。'
        : 'Runs local ONNX neural embedding model to generate dense semantic vectors for all note chunks in SQLite-Vec.',
      details: [
        isZh ? '纯本地离线计算，100% 隐私安全，不向外部 API 泄漏任何笔记内容' : '100% offline local computation with complete privacy, zero external API leakage',
        isZh ? '解锁混合检索（Hybrid RRF）、语义近似去重与隐藏关联挖掘' : 'Unlocks Hybrid Search (RRF), semantic duplicate detection, and hidden link mining',
        isZh ? '为 AI Agent 提供精准的多维语义上下文检索能力' : 'Powers AI Agent with high-precision dense semantic retrieval',
      ],
      ftsStatus: '—',
      embStatus: isZh ? '本地模型离线编码入库' : 'Locally embedded to SQLite-Vec',
      tip: isZh
        ? '⚡ 向量索引只需在新笔记积累或初次导入时构建一次，后续增量更新。'
        : '⚡ Only needed when importing new notes or on first setup; updates incrementally.',
    },
    {
      id: 'organize',
      icon: <IconSparkle size={18} />,
      title: isZh ? '立即智能整理 (Smart Organize)' : 'Smart Organize',
      badge: 'LLM REFINEMENT · GRAPH LINKING',
      desc: isZh
        ? '调度 AI 对笔记进行结构化整理：自动提取知识标签、推荐双向链接（Suggested Connections）、识别知识矛盾与时间线。'
        : 'Leverages AI to batch-organize notes: extracts tags, suggests bidirectional links, detects contradictions, and tracks timelines.',
      details: [
        isZh ? '自动在相关笔记之间推荐 [[双向链接]]，强化卡片盒网络' : 'Recommends bidirectional [[wikilinks]] between relevant notes to enrich the mesh',
        isZh ? '提取结构化事实三元组，发现知识点之间的潜在冲突与演变' : 'Extracts structured knowledge facts and detects contradictions across notes',
        isZh ? '将整理结果写入元数据并支持差异预览与一键回退' : 'Stores organized metadata with diff preview and one-click undo support',
      ],
      ftsStatus: isZh ? '用于粗筛初排上下文' : 'Used for lexical candidate retrieval',
      embStatus: isZh ? '若已构建，自动启用混合搜索 (FTS+向量)' : 'Auto-enables Hybrid RRF when vector index is ready',
      tip: isZh
        ? '🚀 构建向量索引后运行智能整理，关联精准度会有显著质的提升。'
        : '🚀 Running after Vector Indexing significantly boosts recommendation accuracy.',
    },
    {
      id: 'lint',
      icon: <IconWarning size={18} />,
      title: isZh ? '知识库健康检查 (Health Diagnostics)' : 'Health Diagnostics & Lint',
      badge: 'TOPOLOGY LINT · AUTO FIX',
      desc: isZh
        ? '全面扫描知识库拓扑，诊断断链并提供一键修复建议，探测孤立笔记、缺失元数据以及图谱连通性。'
        : 'Scans knowledge base topology to detect and auto-fix broken links, find orphan notes, and analyze graph health.',
      details: [
        isZh ? '断链检测：定位指向不存在笔记的 [[wikilink]]，支持模糊匹配与自动创建' : 'Broken Links: Finds dead links with fuzzy match suggestions and one-click note creation',
        isZh ? '孤岛探测：找出入链为 0 的孤立笔记，避免知识碎片被遗忘' : 'Orphan Notes: Identifies disconnected notes to prevent knowledge siloing',
        isZh ? '图谱拓扑：监测 Hub 节点过载、连通分量与向量覆盖率' : 'Graph Topology: Monitors hub overload, connected components, and vector coverage',
      ],
      ftsStatus: isZh ? '用于断链修复模糊搜索建议' : 'Used for fuzzy search fix suggestions',
      embStatus: isZh ? '用于检测语义重复与隐藏关联' : 'Enables semantic duplicate and hidden link detection',
      tip: isZh
        ? '🛡️ 建议在智能整理后或定期运行健康检查，保持卡片盒链接健康健壮。'
        : '🛡️ Recommended to run periodically or after organizing to maintain graph integrity.',
    },
    {
      id: 'canvas',
      icon: <IconCanvas size={18} />,
      title: isZh ? '导出知识图谱 (Export Canvas)' : 'Export Knowledge Canvas',
      badge: 'OBSIDIAN CANVAS · JSON',
      desc: isZh
        ? '将当前知识图谱结构导出为标准 Obsidian Canvas 格式（.canvas JSON），可在白板画布或 Obsidian 中直接探索。'
        : 'Exports knowledge graph into standard Obsidian Canvas format (.canvas JSON) for whiteboard exploration.',
      details: [
        isZh ? '内置力导向 (Force)、环形 (Circular)、网格 (Grid)、层级 (Tree) 4 种排版算法' : 'Supports 4 layout algorithms: Force-Directed, Circular, Grid, and Hierarchical',
        isZh ? '双向兼容：导出的 JSON 可直接在 ZettelAgent 无限白板或 Obsidian 打开' : '100% compatible with ZettelAgent Infinite Whiteboard and native Obsidian',
        isZh ? '自动将卡片双向链接映射为画布可视化连线' : 'Maps note wikilinks directly into visible directional canvas edges',
      ],
      ftsStatus: '—',
      embStatus: '—',
      tip: isZh
        ? '🎨 导出后可直接拖入白板进行多卡片空间归纳与视觉化推演。'
        : '🎨 Exported files can be dragged directly into the Whiteboard for spatial reasoning.',
    },
  ];

  const MATRIX = [
    {
      name: isZh ? 'FTS5 词法全文检索' : 'Lexical (FTS5)',
      engine: 'SQLite FTS5 (Unicode61)',
      mechanism: isZh ? '倒排索引 / BM25 词频统计 / 前缀匹配' : 'Inverted Index / BM25 / Prefix Match',
      cost: isZh ? '0 显存 · 毫秒级 · 0 网络' : '0 VRAM · <1ms · 100% Offline',
      scenario: isZh ? '精确词汇、代码片段、标签与专有名词定位' : 'Exact keyword search, code snippets, tags, identifiers',
      status: isZh ? '内置默认激活' : 'Always Active',
    },
    {
      name: isZh ? '稠密向量检索' : 'Dense Vector',
      engine: 'SQLite-Vec + ONNX Embedding',
      mechanism: isZh ? '384 维余弦相似度 / 语义邻近空间' : '384-dim Cosine Similarity / Semantic Space',
      cost: isZh ? 'WASM 本地离线 · 极低消耗 · 0 网络' : 'Local WASM / ONNX · Low Cost · 100% Offline',
      scenario: isZh ? '跨语言检索、意图理解、概念关联、模糊提问' : 'Cross-lingual, intent reasoning, concept association',
      status: isZh ? '构建索引后生效' : 'Active after Indexing',
    },
    {
      name: isZh ? '混合检索 (Hybrid RRF)' : 'Hybrid Search (RRF)',
      engine: 'Rust Rank Fusion (W_fts + W_vec)',
      mechanism: isZh ? '倒排索引与语义向量相互倒数排名融合' : 'Reciprocal Rank Fusion of Lexical & Vector',
      cost: isZh ? 'Rust 原生调度 · 极速计算' : 'Native Rust Orchestration · Instant',
      scenario: isZh ? 'AI 对话 RAG、智能整理候选召回、全局高精准搜索' : 'Chat RAG, Smart Organize context, precision search',
      status: isZh ? '自动动态融合' : 'Auto-Fused',
    },
    {
      name: isZh ? 'BCE 神经精排' : 'BCE Neural Reranker',
      engine: 'maidalun1020/bce-reranker-base_v1',
      mechanism: isZh ? 'Cross-Encoder 交叉注意力多维打分置换' : 'Cross-Encoder Full Attention Scoring & Reorder',
      cost: isZh ? '本地 ONNX int8 · 0 网络依赖' : 'Local ONNX int8 · 100% Offline',
      scenario: isZh ? '搜索结果重排、淘汰弱相关片段、精炼注入 Prompt' : 'Search re-ranking, pruning weak context for RAG',
      status: isZh ? '已打包内置 (设置中可开启)' : 'Bundled (Opt-in via Settings)',
    },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-container"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '780px',
          height: '86vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-lg, 8px)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-xl, 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1))',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--bg-secondary)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-sm, 4px)',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-primary)',
            }}>
              <IconBrain size={18} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--text-md, 15px)', fontWeight: 600, color: 'var(--text-primary)' }}>
                {isZh ? '快捷操作与检索架构指南' : 'Quick Actions & Search Architecture'}
              </h2>
              <p style={{ margin: '2px 0 0 0', fontSize: 'var(--text-xs, 12px)', color: 'var(--text-tertiary)' }}>
                {isZh
                  ? '深入了解卡片盒知识库的同步机制、多维检索矩阵与 AI 自进化工作流'
                  : 'Architecture guide for vault synchronization, multi-tier search, and AI workflows'}
              </p>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-icon-sm"
            onClick={onClose}
            style={{ borderRadius: 'var(--radius-sm, 4px)' }}
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* Sub-navigation tabs */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-primary)',
          padding: '0 var(--space-5)',
          gap: 'var(--space-2)',
          flexShrink: 0,
        }}>
          {[
            { id: 'actions', label: isZh ? '核心操作指南' : 'Action Guides', icon: <IconSync size={14} /> },
            { id: 'matrix', label: isZh ? '双引擎检索矩阵' : 'Search Matrix', icon: <IconDatabase size={14} /> },
            { id: 'workflow', label: isZh ? '最佳实践工作流' : 'Best Practices', icon: <IconChart size={14} /> },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              style={{
                padding: 'var(--space-3) var(--space-3)',
                border: 'none',
                background: 'none',
                borderBottom: activeTab === tab.id ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === tab.id ? 600 : 500,
                fontSize: 'var(--text-sm, 13px)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: 'all 0.15s ease',
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* TAB 1: ACTIONS */}
          {activeTab === 'actions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {ACTIONS.map((act) => (
                <div
                  key={act.id}
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md, 6px)',
                    padding: 'var(--space-4)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                  }}
                >
                  {/* Title Bar */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <div style={{
                        width: 26,
                        height: 26,
                        borderRadius: 'var(--radius-sm, 4px)',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--accent-primary)',
                      }}>
                        {act.icon}
                      </div>
                      <span style={{ fontSize: 'var(--text-sm, 14px)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {act.title}
                      </span>
                    </div>
                    <span style={{
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono, monospace)',
                      color: 'var(--text-tertiary)',
                      background: 'var(--bg-primary)',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-sm, 4px)',
                      border: '1px solid var(--border-subtle, var(--border))',
                    }}>
                      {act.badge}
                    </span>
                  </div>

                  {/* Description */}
                  <p style={{ margin: 0, fontSize: 'var(--text-xs, 12px)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    {act.desc}
                  </p>

                  {/* Bullet Points */}
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    background: 'var(--bg-primary)',
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius-sm, 4px)',
                    border: '1px solid var(--border-subtle, var(--border))',
                  }}>
                    {act.details.map((d, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        <span style={{ color: 'var(--accent-primary)', fontSize: '10px', marginTop: 2 }}>•</span>
                        <span>{d}</span>
                      </div>
                    ))}
                  </div>

                  {/* Engine Indicators */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 'var(--space-2)',
                  }}>
                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--bg-primary)',
                      borderRadius: 'var(--radius-sm, 4px)',
                      border: '1px solid var(--border-subtle, var(--border))',
                      fontSize: '11px',
                    }}>
                      <span style={{ color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', marginRight: 6 }}>FTS5</span>
                      <span style={{ color: 'var(--text-primary)' }}>{act.ftsStatus}</span>
                    </div>
                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--bg-primary)',
                      borderRadius: 'var(--radius-sm, 4px)',
                      border: '1px solid var(--border-subtle, var(--border))',
                      fontSize: '11px',
                    }}>
                      <span style={{ color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', marginRight: 6 }}>Vector</span>
                      <span style={{ color: 'var(--text-primary)' }}>{act.embStatus}</span>
                    </div>
                  </div>

                  {/* Tip */}
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                    borderLeft: '2px solid var(--accent-primary)',
                    paddingLeft: 'var(--space-2)',
                  }}>
                    {act.tip}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TAB 2: SEARCH MATRIX */}
          {activeTab === 'matrix' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <p style={{ margin: 0, fontSize: 'var(--text-xs, 12px)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {isZh
                  ? 'ZettelAgent 采用分层检索融合架构（Multi-Tier Retrieval & Ranking），结合 SQLite 本地倒排索引、稠密向量与神经重排模型，保障 100% 离线隐私与极速检索。'
                  : 'ZettelAgent utilizes a multi-tier retrieval architecture combining SQLite FTS5, dense embeddings, and cross-encoder reranking for 100% offline privacy and low-latency.'}
              </p>

              <div style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 6px)',
                overflow: 'hidden',
                background: 'var(--bg-secondary)',
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                      <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>{isZh ? '检索模式' : 'Mode'}</th>
                      <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>{isZh ? '底层引擎与原理' : 'Mechanism'}</th>
                      <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>{isZh ? '资源与延迟' : 'Cost & Speed'}</th>
                      <th style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>{isZh ? '最佳适用场景' : 'Primary Use Case'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MATRIX.map((m, i) => (
                      <tr key={i} style={{ borderBottom: i < MATRIX.length - 1 ? '1px solid var(--border-subtle, var(--border))' : 'none' }}>
                        <td style={{ padding: '10px 12px', verticalAlign: 'top', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                          <div>{m.name}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>{m.status}</div>
                        </td>
                        <td style={{ padding: '10px 12px', verticalAlign: 'top', color: 'var(--text-secondary)' }}>
                          <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{m.engine}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>{m.mechanism}</div>
                        </td>
                        <td style={{ padding: '10px 12px', verticalAlign: 'top', color: 'var(--text-secondary)', fontSize: '11px', whiteSpace: 'nowrap' }}>
                          {m.cost}
                        </td>
                        <td style={{ padding: '10px 12px', verticalAlign: 'top', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                          {m.scenario}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Reranker Note */}
              <div style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 6px)',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                fontSize: '12px',
                color: 'var(--text-secondary)',
              }}>
                <IconCheck size={16} />
                <span>
                  {isZh
                    ? '网易有道 BCE Reranker（ONNX int8 量化版）已内置随安装包打包，可在「设置 → 索引与整理 → 神经重排」中自由开启。'
                    : 'NetEase Youdao BCE Reranker (ONNX int8) is pre-bundled in the application package and can be toggled in Settings.'}
                </span>
              </div>
            </div>
          )}

          {/* TAB 3: WORKFLOW */}
          {activeTab === 'workflow' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <p style={{ margin: 0, fontSize: 'var(--text-xs, 12px)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {isZh
                  ? '为了让卡片盒笔记法（Zettelkasten）与 AI 代理发挥最大潜能，推荐遵循以下 4 步闭环工作流：'
                  : 'To maximize the synergy between Zettelkasten and AI Agents, follow this recommended 4-step workflow:'}
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {[
                  {
                    step: '01',
                    title: isZh ? '导入与同步知识库 (Sync)' : 'Import & Sync Vault',
                    desc: isZh
                      ? '创建或导入 Markdown 笔记，点击「同步知识库」建立初始文件拓扑与 FTS5 倒排索引。'
                      : 'Create or import Markdown notes, run Sync to establish file topology and FTS5 inverted index.',
                  },
                  {
                    step: '02',
                    title: isZh ? '构建向量索引 (Vector Indexing)' : 'Build Vector Index',
                    desc: isZh
                      ? '在 Dashboard 点击「构建向量索引」，利用本地神经网络为卡片生成语义坐标，解锁混合检索与图谱语义边。'
                      : 'Run Vector Indexing on Dashboard to generate semantic embeddings for all notes 100% offline.',
                  },
                  {
                    step: '03',
                    title: isZh ? '智能整理与图谱演化 (Smart Organize)' : 'Smart Organize & Mesh Evolution',
                    desc: isZh
                      ? '运行智能整理或在 AI 对话中调用 Agent，自动挖掘卡片间的隐藏双向链接，自底向上生长知识网络。'
                      : 'Run Smart Organize or interact with AI Agent to organically discover connections and evolve your knowledge graph.',
                  },
                  {
                    step: '04',
                    title: isZh ? '健康体检与白板推演 (Diagnostics & Canvas)' : 'Diagnostics & Canvas Reasoning',
                    desc: isZh
                      ? '定期运行「健康检查」一键修复断链并消除冗余，将图谱导出为 Canvas 在无限白板中进行空间深度构思。'
                      : 'Periodically run Health Diagnostics to fix broken links, and export graph to Whiteboard Canvas for deep visual reasoning.',
                  },
                ].map((st) => (
                  <div
                    key={st.step}
                    style={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md, 6px)',
                      padding: 'var(--space-3) var(--space-4)',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 'var(--space-3)',
                    }}
                  >
                    <span style={{
                      fontSize: '13px',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontWeight: 700,
                      color: 'var(--accent-primary)',
                      background: 'var(--bg-primary)',
                      padding: '2px 6px',
                      borderRadius: 'var(--radius-sm, 4px)',
                      border: '1px solid var(--border-subtle, var(--border))',
                      flexShrink: 0,
                    }}>
                      {st.step}
                    </span>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm, 13px)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {st.title}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs, 12px)', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>
                        {st.desc}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: 'var(--space-3) var(--space-5)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          background: 'var(--bg-secondary)',
          flexShrink: 0,
        }}>
          <button
            className="btn btn-sm btn-primary"
            onClick={onClose}
            style={{ borderRadius: 'var(--radius-sm, 4px)', padding: '4px 16px' }}
          >
            {isZh ? '我知道了' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}
