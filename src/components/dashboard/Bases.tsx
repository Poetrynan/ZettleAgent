import { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getBasesData, BasesEntry } from '../../lib/tauri';
import { t } from '../../lib/i18n';
import { parseQuery } from '../../lib/basesQuery';

type SortField = 'title' | 'noteType' | 'linkCount' | 'createdAt' | 'lastSynced' | 'confidence';
type SortDir = 'asc' | 'desc';

export function Bases() {
  const { state, setCurrentFile, setView, showToast } = useApp();

  const [entries, setEntries] = useState<BasesEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allTypes, setAllTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedTag, setSelectedTag] = useState('');

  // Sort
  const [sortField, setSortField] = useState<SortField>('lastSynced');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Query Help Toggle
  const [showHelp, setShowHelp] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getBasesData(state.vaultPath || '');
      setEntries(data.entries);
      setFolders(data.folders);
      setAllTags(data.allTags);
      setAllTypes(data.allTypes);
    } catch (err) {
      console.error('Failed to load bases data:', err);
    } finally {
      setLoading(false);
    }
  }, [state.vaultPath]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Parse SQL-like search queries
  const parsedQuery = useMemo(() => {
    return parseQuery(searchQuery);
  }, [searchQuery]);

  // Handle removing a specific query pill/rule
  const handleRemovePill = (token: string) => {
    setSearchQuery(prev => {
      // Escape special characters in the token to prevent regex errors
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\s*${escaped}\\s*|^\\s*${escaped}\\s*$`);
      return prev.replace(regex, ' ').trim();
    });
  };

  // Filtered + sorted entries
  const filteredEntries = useMemo(() => {
    let result = [...entries];

    // 1. Dropdown Filters (override query if selected)
    if (selectedFolder) {
      result = result.filter(e => e.folder === selectedFolder);
    }
    if (selectedType) {
      result = result.filter(e => e.noteType === selectedType);
    }
    if (selectedTag) {
      result = result.filter(e => e.tags.includes(selectedTag));
    }

    // 2. Structured SQL-like Rules
    const { rules, keywords } = parsedQuery;
    for (const rule of rules) {
      const valLower = rule.value.toLowerCase();
      result = result.filter(e => {
        switch (rule.field) {
          case 'title':
            return e.title.toLowerCase().includes(valLower);
          case 'noteType':
            return e.noteType.toLowerCase().includes(valLower);
          case 'tag':
            return e.tags.some(t => t.toLowerCase().includes(valLower));
          case 'folder':
            return e.folder.toLowerCase().includes(valLower);
          case 'linkCount': {
            const num = parseInt(rule.value, 10);
            if (isNaN(num)) return true;
            if (rule.operator === 'greater') return e.linkCount > num;
            if (rule.operator === 'less') return e.linkCount < num;
            if (rule.operator === 'greaterEqual') return e.linkCount >= num;
            if (rule.operator === 'lessEqual') return e.linkCount <= num;
            return e.linkCount === num;
          }
          case 'confidence': {
            const num = parseFloat(rule.value);
            if (isNaN(num)) return true;
            // Handle both percentage (0-100) and fraction (0-1.0)
            const target = num > 1 ? num / 100 : num;
            const entryConf = e.confidence ?? 0;
            if (rule.operator === 'greater') return entryConf > target;
            if (rule.operator === 'less') return entryConf < target;
            if (rule.operator === 'greaterEqual') return entryConf >= target;
            if (rule.operator === 'lessEqual') return entryConf <= target;
            return Math.abs(entryConf - target) < 0.01;
          }
          case 'createdAt':
            if (rule.operator === 'greater') return e.createdAt > rule.value;
            if (rule.operator === 'less') return e.createdAt < rule.value;
            if (rule.operator === 'greaterEqual') return e.createdAt >= rule.value;
            if (rule.operator === 'lessEqual') return e.createdAt <= rule.value;
            return e.createdAt.startsWith(rule.value);
          case 'lastSynced':
            if (rule.operator === 'greater') return e.lastSynced > rule.value;
            if (rule.operator === 'less') return e.lastSynced < rule.value;
            if (rule.operator === 'greaterEqual') return e.lastSynced >= rule.value;
            if (rule.operator === 'lessEqual') return e.lastSynced <= rule.value;
            return e.lastSynced.startsWith(rule.value);
          default:
            return true;
        }
      });
    }

    // 3. Regular keywords
    if (keywords.length > 0) {
      result = result.filter(e => {
        return keywords.every(kw =>
          e.title.toLowerCase().includes(kw) ||
          e.noteType.toLowerCase().includes(kw) ||
          e.tags.some(t => t.toLowerCase().includes(kw)) ||
          e.folder.toLowerCase().includes(kw)
        );
      });
    }

    // 4. Sort
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title': cmp = a.title.localeCompare(b.title); break;
        case 'noteType': cmp = a.noteType.localeCompare(b.noteType); break;
        case 'linkCount': cmp = a.linkCount - b.linkCount; break;
        case 'createdAt': cmp = a.createdAt.localeCompare(b.createdAt); break;
        case 'lastSynced': cmp = a.lastSynced.localeCompare(b.lastSynced); break;
        case 'confidence': cmp = (a.confidence ?? 0) - (b.confidence ?? 0); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [entries, selectedFolder, selectedType, selectedTag, parsedQuery, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const handleRowClick = (entry: BasesEntry) => {
    setCurrentFile(entry.path);
    setView('note');
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
      return d.toLocaleDateString(state.lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    } catch {
      return dateStr.substring(0, 10);
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.3 }}>
          <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
        </svg>
      );
    }
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 1 }}>
        {sortDir === 'asc' ? <path d="M7 14l5-5 5 5" /> : <path d="M7 10l5 5 5-5" />}
      </svg>
    );
  };

  const noteTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      permanent: '#10B981',
      literature: '#3B82F6',
      fleeting: '#F59E0B',
      index: '#8B5CF6',
      hub: '#EC4899',
      journal: '#06B6D4',
      reference: '#6366F1',
      project: '#F97316',
    };
    return colors[type.toLowerCase()] || '#64748B';
  };

  const handleApplyHelpQuery = (query: string) => {
    setSearchQuery(prev => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed} ${query}` : query;
    });
    showToast(state.lang === 'zh' ? '已应用查询模板' : 'Applied query template', 'success');
  };

  const isZh = state.lang === 'zh';

  if (loading) {
    return (
      <div className="bases-container">
        <div className="bases-loading">
          <div className="bases-spinner" />
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bases-container">
        <div className="bases-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
          <h3>{t('bases.empty')}</h3>
          <p>{t('bases.emptyDesc')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bases-container">
      {/* Filter Bar */}
      <div className="bases-toolbar">
        <div className="bases-toolbar-left">
          <div className="bases-search-wrap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="bases-search"
              placeholder={isZh ? '高级 SQL-like 过滤...' : 'Advanced SQL-like filter...'}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {/* SQL Query Help Toggle Button */}
          <button
            className={`bases-query-help-btn ${showHelp ? 'active' : ''}`}
            onClick={() => setShowHelp(!showHelp)}
            title={isZh ? '查询帮助' : 'Query Guide'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
              <path d="M9 18h6" />
              <path d="M10 22h4" />
            </svg>
            <span>{isZh ? 'SQL 帮助' : 'Query Helper'}</span>
          </button>

          <select
            className="bases-filter-select"
            value={selectedFolder}
            onChange={e => setSelectedFolder(e.target.value)}
          >
            <option value="">{t('bases.allFolders')}</option>
            {folders.map(f => (
              <option key={f} value={f}>{f || '/'}</option>
            ))}
          </select>

          <select
            className="bases-filter-select"
            value={selectedType}
            onChange={e => setSelectedType(e.target.value)}
          >
            <option value="">{t('bases.allTypes')}</option>
            {allTypes.map(tp => (
              <option key={tp} value={tp}>{tp}</option>
            ))}
          </select>

          <select
            className="bases-filter-select"
            value={selectedTag}
            onChange={e => setSelectedTag(e.target.value)}
          >
            <option value="">{t('bases.allTags')}</option>
            {allTags.map(tag => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
        </div>

        <div className="bases-toolbar-right">
          <span className="bases-count">
            {t('bases.totalNotes').replace('{count}', String(filteredEntries.length))}
          </span>
          <button 
            className={`btn btn-ghost btn-icon-sm ${showIntro ? 'active' : ''}`}
            onClick={() => setShowIntro(!showIntro)} 
            title={isZh ? '什么是数据库？' : 'What is Bases?'}
            style={{ marginRight: 4 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </button>
          <button className="btn btn-ghost btn-icon-sm" onClick={loadData} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Database (Bases) Explanation Panel */}
      {showIntro && (
        <div 
          className="bases-query-help-card"
          style={{ 
            marginBottom: 12, 
            padding: '14px 16px', 
            background: 'var(--bg-elevated)', 
            border: '1px dashed var(--accent-primary)',
            borderRadius: 'var(--radius-lg)',
            animation: 'fadeIn 0.2s ease-out'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              {isZh ? '什么是数据库视图？' : 'What is Database View?'}
            </div>
            <button 
              onClick={() => setShowIntro(false)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1 }}
            >
              ×
            </button>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {isZh ? (
              <>
                <p style={{ margin: '0 0 6px 0' }}>
                  <strong>数据库视图 (Bases)</strong> 会自动将所有笔记提取为结构化的表格。您可以在此以类似 Notion 数据库的方式查阅并管理所有笔记。
                </p>
                <p style={{ margin: 0 }}>
                  通过 <strong>AI 整理</strong>，系统会自动更新笔记的 <strong>类型</strong> (Permanent 永久/Literature 文献/Fleeting 闪念)、<strong>标签</strong>以及<strong>关联双链</strong>。「置信度」栏显示了 AI 的分类可信度（默认为空，只有图谱连接等细化规则会带上置信值）。您可使用下拉菜单，或使用 <strong>SQL 帮助</strong> 里的高级语法来进行强大的筛选！
                </p>
              </>
            ) : (
              <>
                <p style={{ margin: '0 0 6px 0' }}>
                  <strong>Database View (Bases)</strong> automatically scans your knowledge vault and extracts all notes into a structured table. You can browse and manage your notes here just like a Notion database.
                </p>
                <p style={{ margin: 0 }}>
                  With <strong>AI Organize</strong>, the system automatically curates each note's <strong>Type</strong> (Permanent/Literature/Fleeting), <strong>Tags</strong>, and <strong>Links</strong>. Confidence column indicates AI classification certainty. Use the filter dropdowns or click <strong>Query Helper</strong> to query notes with advanced syntax!
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* SQL Query Helper Interactive Card */}
      {showHelp && (
        <div className="bases-query-help-card">
          <div className="bases-query-help-title">
            {isZh ? '💡 ZettelAgent 高级 SQL-like 查询指南 (Dataview)' : '💡 ZettelAgent SQL-like Query Guide (Dataview)'}
          </div>
          <div className="bases-query-help-grid">
            <div className="bases-query-help-item">
              <div className="bases-query-help-code" onClick={() => handleApplyHelpQuery('type:permanent')}>type:permanent</div>
              <div className="bases-query-help-desc">{isZh ? '按类型过滤' : 'Filter by note type'}</div>
            </div>
            <div className="bases-query-help-item">
              <div className="bases-query-help-code" onClick={() => handleApplyHelpQuery('#ai')}>#ai</div>
              <div className="bases-query-help-desc">{isZh ? '按标签过滤 (如 #tag)' : 'Filter by tag shorthand'}</div>
            </div>
            <div className="bases-query-help-item">
              <div className="bases-query-help-code" onClick={() => handleApplyHelpQuery('links>=3')}>links&gt;=3</div>
              <div className="bases-query-help-desc">{isZh ? '按双链数过滤 (支持 >, <, >=, <=, =)' : 'Filter by link count'}</div>
            </div>
            <div className="bases-query-help-item">
              <div className="bases-query-help-code" onClick={() => handleApplyHelpQuery('conf>80')}>conf&gt;80</div>
              <div className="bases-query-help-desc">{isZh ? '按 AI 置信度过滤 (百分比或 0-1 小数)' : 'Filter by AI confidence %'}</div>
            </div>
            <div className="bases-query-help-item">
              <div className="bases-query-help-code" onClick={() => handleApplyHelpQuery('folder:daily')}>folder:daily</div>
              <div className="bases-query-help-desc">{isZh ? '按所在文件夹路径搜索' : 'Search by path folder name'}</div>
            </div>
            <div className="bases-query-help-item">
              <div className="bases-query-help-code" onClick={() => handleApplyHelpQuery('created>2026-06-25')}>created&gt;2026-06-25</div>
              <div className="bases-query-help-desc">{isZh ? '按创建时间过滤' : 'Filter by creation date'}</div>
            </div>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            {isZh ? '提示：你可以输入多个过滤项，用空格隔开。点击上方的绿色代码即可一键填入输入框！' : 'Tip: Combine multiple terms separated by spaces. Click any green query above to apply!'}
          </div>
        </div>
      )}

      {/* Query Filter Pills / Chips */}
      {parsedQuery.rules.length > 0 && (
        <div className="bases-query-pills">
          {parsedQuery.rules.map((rule, idx) => (
            <div key={idx} className="bases-query-pill">
              <span>
                {rule.field === 'tag' ? '#' : `${rule.field}:`}
                {rule.operator !== 'contains' && rule.operator !== 'equals' ? ` ${rule.token.replace(/^[a-zA-Z]+/, '')}` : ` ${rule.value}`}
              </span>
              <span className="bases-query-pill-close" onClick={() => handleRemovePill(rule.token)}>×</span>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="bases-table-wrap">
        <table className="bases-table">
          <thead>
            <tr>
              <th className="bases-th bases-th-title" onClick={() => handleSort('title')}>
                <span>{t('bases.noteTitle')}</span> <SortIcon field="title" />
              </th>
              <th className="bases-th" onClick={() => handleSort('noteType')}>
                <span>{t('bases.noteType')}</span> <SortIcon field="noteType" />
              </th>
              <th className="bases-th bases-th-tags">
                <span>{t('bases.noteTags')}</span>
              </th>
              <th className="bases-th" onClick={() => handleSort('linkCount')}>
                <span>{t('bases.noteLinks')}</span> <SortIcon field="linkCount" />
              </th>
              <th className="bases-th" onClick={() => handleSort('createdAt')}>
                <span>{t('bases.noteCreated')}</span> <SortIcon field="createdAt" />
              </th>
              <th className="bases-th" onClick={() => handleSort('lastSynced')}>
                <span>{t('bases.noteModified')}</span> <SortIcon field="lastSynced" />
              </th>
              <th className="bases-th" onClick={() => handleSort('confidence')}>
                <span>{t('bases.noteConfidence')}</span> <SortIcon field="confidence" />
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map(entry => (
              <tr
                key={entry.path}
                className="bases-row"
                onClick={() => handleRowClick(entry)}
              >
                <td className="bases-td bases-td-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <span className="bases-title-text">{entry.title}</span>
                </td>
                <td className="bases-td">
                  <span
                    className="bases-type-badge"
                    style={{ '--badge-color': noteTypeColor(entry.noteType) } as React.CSSProperties}
                  >
                    {entry.noteType}
                  </span>
                </td>
                <td className="bases-td bases-td-tags">
                  {entry.tags.slice(0, 3).map(tag => (
                    <span key={tag} className="bases-tag">{tag}</span>
                  ))}
                  {entry.tags.length > 3 && (
                    <span className="bases-tag bases-tag-more">+{entry.tags.length - 3}</span>
                  )}
                </td>
                <td className="bases-td bases-td-num">{entry.linkCount}</td>
                <td className="bases-td bases-td-date">{formatDate(entry.createdAt)}</td>
                <td className="bases-td bases-td-date">{formatDate(entry.lastSynced)}</td>
                <td className="bases-td bases-td-confidence">
                  {entry.confidence !== null ? (
                    <div className="bases-confidence-bar-wrap">
                      <div
                        className="bases-confidence-bar"
                        style={{ width: `${Math.round((entry.confidence) * 100)}%` }}
                      />
                      <span>{Math.round((entry.confidence) * 100)}%</span>
                    </div>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
