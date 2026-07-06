import { getLang } from '../../lib/i18n';
import { IconClose } from '../icons';

interface QuickActionsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const ACTIONS_ZH = [
  {
    icon: '🔄',
    title: '同步知识库',
    desc: '扫描 Vault 文件夹，将新增/修改的 Markdown 笔记导入数据库。',
    details: [
      '自动计算文件 SHA-256 哈希，仅更新变化的文件',
      '将笔记分块（chunk），建立 FTS5 全文索引',
      '解析 YAML frontmatter（标签、类型等）写入 card_meta',
    ],
    fts: '✅ 自动建立（FTS5 触发器）',
    embedding: '❌ 不生成 — 需在设置中手动生成 Embedding',
    tip: '每次添加/修改笔记后都应执行一次同步',
  },
  {
    icon: '📥',
    title: '导出知识图谱',
    desc: '将当前知识图谱导出为 Obsidian Canvas 格式（.canvas JSON），可在 Obsidian 中直接打开。',
    details: [
      '支持 4 种布局算法：力导向、环形、网格、层级',
      '导出的画布包含所有节点和连接关系',
      '可导入到白板画布中继续编辑',
    ],
    fts: '—',
    embedding: '—',
    tip: '先同步知识库并确保有笔记数据后再导出',
  },
  {
    icon: '⚠️',
    title: '健康检查',
    desc: '全面扫描知识库，检测三类问题：断链、孤立笔记、缺失元数据。',
    details: [
      '断链检测：找出指向不存在笔记的 [[wikilink]]，支持一键修复',
      '孤立笔记：找出没有任何入链的笔记，帮助你发现被遗忘的知识',
      '缺失元数据：找出未经 AI 整理的笔记',
    ],
    fts: '✅ 用于链接匹配（模糊搜索修复建议）',
    embedding: '✅ 语义重复/隐藏关联分析需先构建向量索引',
    tip: '建议在智能整理后运行，确保整理结果没有引入问题。构建向量索引后可检测语义重复和隐藏关联。',
  },
  {
    icon: '🧠',
    title: '立即智能整理',
    desc: '调用 AI 对笔记进行批量整理：提取标签、建议链接、发现矛盾、分类笔记类型。',
    details: [
      '为每篇笔记搜索相关笔记作为上下文，发送给 LLM 分析',
      '自动在笔记末尾插入 AI 生成的 Suggested Connections 和 Note Type',
      '将提取的事实和矛盾记录到时间线数据库',
      '结果写入 card_meta 表（标签、链接、矛盾、类型）',
    ],
    fts: '✅ 用于搜索相关笔记（默认方式）',
    embedding: '✅ 配置后自动启用 hybrid_search（FTS + 语义搜索），找到的相关笔记更精准',
    tip: '⚡ 开启 Embedding 后效果更好！在设置中启用 Embedding 并生成向量后，智能整理会使用混合搜索',
  },
];

const ACTIONS_EN = [
  {
    icon: '🔄',
    title: 'Sync Vault',
    desc: 'Scan the Vault folder and import new/modified Markdown notes into the database.',
    details: [
      'Calculates SHA-256 hash to only update changed files',
      'Chunks notes and builds FTS5 full-text index',
      'Parses YAML frontmatter (tags, type) into card_meta',
    ],
    fts: '✅ Auto-built (FTS5 triggers)',
    embedding: '❌ Not generated — manually generate in Settings',
    tip: 'Run after adding or modifying notes',
  },
  {
    icon: '📥',
    title: 'Export Graph',
    desc: 'Export the current knowledge graph as Obsidian Canvas format (.canvas JSON), openable directly in Obsidian.',
    details: [
      'Supports 4 layout algorithms: Force-Directed, Circular, Grid, Hierarchical',
      'Exports all nodes and connections',
      'Can be imported into the whiteboard canvas for further editing',
    ],
    fts: '—',
    embedding: '—',
    tip: 'Sync vault and ensure notes exist before exporting',
  },
  {
    icon: '⚠️',
    title: 'Health Check',
    desc: 'Scan the vault for broken links, orphan notes, and missing metadata.',
    details: [
      'Broken links: finds [[wikilinks]] pointing to non-existent notes, with auto-fix',
      'Orphan notes: finds notes with no incoming links',
      'Missing metadata: finds notes not yet processed by AI',
    ],
    fts: '✅ Used for link matching (fuzzy search for fix suggestions)',
    embedding: '✅ Semantic duplicate / hidden connection analysis requires vector index',
    tip: 'Run after Smart Organize to verify results. Build vector index first for semantic analysis.',
  },
  {
    icon: '🧠',
    title: 'Smart Organize',
    desc: 'AI-powered batch organization: extract tags, suggest links, detect contradictions, classify note types.',
    details: [
      'Searches for related notes as context, sends to LLM for analysis',
      'Inserts AI-generated Suggested Connections and Note Type into notes',
      'Records extracted facts and contradictions to timeline DB',
      'Writes to card_meta table (tags, links, contradictions, type)',
    ],
    fts: '✅ Used to find related notes (default)',
    embedding: '✅ When configured, enables hybrid_search (FTS + semantic), more accurate results',
    tip: '⚡ Better with Embedding! Enable in Settings and generate vectors for hybrid search',
  },
];

export function QuickActionsHelp({ isOpen, onClose }: QuickActionsHelpProps) {
  if (!isOpen) return null;

  const isZh = getLang() === 'zh';
  const actions = isZh ? ACTIONS_ZH : ACTIONS_EN;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-container"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '720px', height: '85vh' }}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ fontSize: '20px' }}>📖</span>
            <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600 }}>
              {isZh ? '快捷操作说明' : 'Quick Actions Guide'}
            </h2>
          </div>
          <button className="btn btn-ghost btn-icon-sm" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="modal-content" style={{ overflowY: 'auto', padding: 'var(--space-5)' }}>
          {/* Intro */}
          <p style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-sm)',
            margin: '0 0 var(--space-5) 0',
            lineHeight: 1.6,
          }}>
            {isZh
              ? '以下是每个快捷操作的详细说明，以及它们与 FTS（全文搜索）和 Embedding（语义向量）的关系。'
              : 'Below is a detailed guide for each quick action and how they relate to FTS (full-text search) and Embedding (semantic vectors).'}
          </p>

          {/* Action Cards */}
          {actions.map((action, i) => (
            <div
              key={i}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: 'var(--space-4)',
                overflow: 'hidden',
              }}
            >
              {/* Action Header */}
              <div style={{
                background: 'var(--bg-secondary)',
                padding: 'var(--space-4) var(--space-5)',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
              }}>
                <span style={{ fontSize: '20px' }}>{action.icon}</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {action.title}
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    {action.desc}
                  </p>
                </div>
              </div>

              {/* Action Details */}
              <div style={{ padding: 'var(--space-4) var(--space-5)' }}>
                {/* What it does */}
                <ul style={{
                  margin: '0 0 var(--space-4) 0',
                  paddingLeft: 'var(--space-5)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                  lineHeight: 1.8,
                }}>
                  {action.details.map((d, j) => (
                    <li key={j}>{d}</li>
                  ))}
                </ul>

                {/* FTS / Embedding status */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 'var(--space-3)',
                  marginBottom: 'var(--space-3)',
                }}>
                  <div style={{
                    background: 'var(--bg-secondary)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3)',
                  }}>
                    <div style={{
                      fontSize: 'var(--text-xs)',
                      fontWeight: 600,
                      color: 'var(--text-tertiary)',
                      marginBottom: '4px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}>
                      FTS {isZh ? '全文索引' : 'Full-text'}
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                      {action.fts}
                    </div>
                  </div>
                  <div style={{
                    background: 'var(--bg-secondary)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3)',
                  }}>
                    <div style={{
                      fontSize: 'var(--text-xs)',
                      fontWeight: 600,
                      color: 'var(--text-tertiary)',
                      marginBottom: '4px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}>
                      Embedding {isZh ? '语义向量' : 'Semantic'}
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                      {action.embedding}
                    </div>
                  </div>
                </div>

                {/* Tip */}
                <div style={{
                  background: action.tip.startsWith('⚡')
                    ? 'rgba(59, 130, 246, 0.08)'
                    : 'rgba(245, 158, 11, 0.08)',
                  border: `1px solid ${action.tip.startsWith('⚡') ? 'rgba(59, 130, 246, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-3) var(--space-4)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                  lineHeight: 1.5,
                }}>
                  💡 {action.tip}
                </div>
              </div>
            </div>
          ))}

          {/* Summary Table */}
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            marginTop: 'var(--space-4)',
          }}>
            <div style={{
              background: 'var(--bg-secondary)',
              padding: 'var(--space-3) var(--space-5)',
              fontWeight: 600,
              fontSize: 'var(--text-md)',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              {isZh ? '📊 总览对照表' : '📊 Summary Table'}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 'var(--text-sm)',
              }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>
                      {isZh ? '功能' : 'Feature'}
                    </th>
                    <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>
                      FTS
                    </th>
                    <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>
                      Embedding
                    </th>
                    <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600 }}>
                      {isZh ? '建议' : 'Recommendation'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      name: isZh ? '同步知识库' : 'Sync Vault',
                      fts: '✅',
                      emb: '❌',
                      rec: isZh ? '同步后手动生成 Embedding' : 'Generate Embedding manually after sync',
                    },
                    {
                      name: isZh ? '健康检查' : 'Health Check',
                      fts: '✅',
                      emb: '✅',
                      rec: isZh ? '向量索引后可检测语义重复/隐藏关联' : 'Vector index enables semantic duplicates / hidden connections',
                    },
                    {
                      name: isZh ? '智能整理' : 'Smart Organize',
                      fts: '✅',
                      emb: '✅',
                      rec: isZh ? '开启 Embedding 后效果更佳' : 'Better with Embedding enabled',
                    },
                    {
                      name: isZh ? '知识盲区分析' : 'Gap Analysis',
                      fts: '❌',
                      emb: '✅',
                      rec: isZh ? '必须有 Embedding 才有语义边' : 'Requires Embedding for semantic edges',
                    },
                    {
                      name: isZh ? '聊天 RAG' : 'Chat RAG',
                      fts: '✅',
                      emb: '✅',
                      rec: isZh ? '开启 Embedding 后搜索更精准' : 'More accurate search with Embedding',
                    },
                    {
                      name: isZh ? 'Agent 模式' : 'Agent Mode',
                      fts: '✅',
                      emb: '✅',
                      rec: isZh ? '多 Agent 架构，58 个内置工具，自动使用混合搜索（FTS + 向量）' : 'Multi-Agent architecture, 58 built-in tools, auto hybrid search (FTS + Vector)',
                    },
                    {
                      name: isZh ? '数据库视图' : 'Database View',
                      fts: '❌',
                      emb: '❌',
                      rec: isZh ? '直接使用，纯 SQL 查询，无需索引' : 'Use directly, pure SQL query, no index needed',
                    },
                  ].map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 500 }}>{row.name}</td>
                      <td style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'center' }}>{row.fts}</td>
                      <td style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'center' }}>{row.emb}</td>
                      <td style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>{row.rec}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Workflow suggestion */}
          <div style={{
            marginTop: 'var(--space-5)',
            padding: 'var(--space-4) var(--space-5)',
            background: 'rgba(59, 130, 246, 0.06)',
            border: '1px solid rgba(59, 130, 246, 0.15)',
            borderRadius: 'var(--radius-lg)',
            lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--text-md)', marginBottom: 'var(--space-2)' }}>
              {isZh ? '🚀 推荐工作流' : '🚀 Recommended Workflow'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
              {isZh ? (
                <>
                  <strong>1.</strong> 同步知识库 → <strong>2.</strong> 生成 Embedding（设置页） → <strong>3.</strong> 立即智能整理 → <strong>4.</strong> 健康检查
                </>
              ) : (
                <>
                  <strong>1.</strong> Sync Vault → <strong>2.</strong> Generate Embedding (Settings) → <strong>3.</strong> Smart Organize → <strong>4.</strong> Health Check
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
