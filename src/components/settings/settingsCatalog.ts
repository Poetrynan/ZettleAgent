export type SettingsPage = 'general' | 'workspace' | 'models' | 'agent' | 'memory' | 'tools' | 'search' | 'permissions' | 'review' | 'storage' | 'shortcuts';
export type SettingsGroup = 'workbench' | 'agent' | 'system';
export interface SettingsCategory {
  id: SettingsPage; group: SettingsGroup; zh: string; en: string;
  descriptionZh: string; descriptionEn: string; keywords: string;
}
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'general', group: 'workbench', zh: '常规', en: 'General', descriptionZh: '界面语言、外观与应用信息。', descriptionEn: 'Language, appearance, and application information.', keywords: 'language theme dark light 主题 外观 语言 关于 about' },
  { id: 'workspace', group: 'workbench', zh: '知识库与笔记规则', en: 'Vaults & note rules', descriptionZh: '已打开的知识库、笔记组织方式与默认文件位置。', descriptionEn: 'Open vaults, note organization, and default file locations.', keywords: 'workspace folder daily note methodology PARA Zettelkasten GTD 知识库 工作区 文件夹 每日笔记 方法论 分类' },
  { id: 'review', group: 'workbench', zh: '复习', en: 'Review', descriptionZh: '记忆保持率、每日任务量与复习间隔。', descriptionEn: 'Retention, daily limits, and review intervals.', keywords: 'FSRS repetition spaced retention 复习 间隔 保持率 每日' },
  { id: 'models', group: 'agent', zh: '模型与连接', en: 'Models & connections', descriptionZh: 'Agent 使用的模型服务、接口、密钥和推理能力。', descriptionEn: 'Model provider, API endpoint, credential, and reasoning capability.', keywords: 'LLM provider API Key endpoint OpenAI Claude Gemini Ollama 模型 服务商 密钥 接口 推理' },
  { id: 'agent', group: 'agent', zh: 'Agent 行为', en: 'Agent behavior', descriptionZh: '自动整理的频率、范围、批量大小与上下文用量。', descriptionEn: 'Organization frequency, scope, batches, and context usage.', keywords: 'automation organize background batch interval context 自动 整理 后台 频率 日记 批量 截断' },
  { id: 'memory', group: 'agent', zh: '规则与记忆', en: 'Rules & memory', descriptionZh: 'Agent 的长期偏好、工作习惯和已记录知识。', descriptionEn: 'Long-term preferences, working habits, and remembered knowledge.', keywords: 'preferences rules memory instructions prompt 记忆 规则 偏好 提示词 核心记忆' },
  { id: 'tools', group: 'agent', zh: '工具与连接', en: 'Tools & integrations', descriptionZh: '连接外部 MCP 工具、配置技能，并让其他客户端读取知识库。', descriptionEn: 'Connect MCP tools, manage skills, and expose read-only vault access.', keywords: 'MCP server client skills extensions 插件 扩展 技能 工具 连接' },
  { id: 'search', group: 'system', zh: '索引与检索', en: 'Indexing & retrieval', descriptionZh: '语义索引、嵌入模型、搜索精排与失败重试。', descriptionEn: 'Semantic indexing, embedding models, reranking, and retries.', keywords: 'embedding vector semantic rerank dimensions WebGPU WASM index search 768 索引 搜索 向量 维度 精排 重试' },
  { id: 'permissions', group: 'system', zh: '权限与恢复', en: 'Permissions & recovery', descriptionZh: '决定 Agent 能做什么，查看审批规则、撤销记录和回收站。', descriptionEn: 'Agent permissions, approval rules, undo history, and trash.', keywords: 'security approval trusted read only undo trash retention 权限 安全 审批 信任 只读 撤销 回收站 恢复 保留天数' },
  { id: 'storage', group: 'system', zh: '数据与存储', en: 'Data & storage', descriptionZh: '数据库与文件位置、数据迁移及按类别清理。', descriptionEn: 'Data locations, migration, and selective cleanup.', keywords: 'database db path clear cache export migration backup 数据 存储 路径 清理 导出 迁移 缓存 备份' },
  { id: 'shortcuts', group: 'system', zh: '快捷键', en: 'Keyboard shortcuts', descriptionZh: '导航、编辑、检索与白板的键盘操作。', descriptionEn: 'Keyboard actions for navigation, editing, search, and canvas.', keywords: 'keyboard shortcut hotkey keybinding 快捷键 键盘 热键' },
];

export function searchSettings(query: string): SettingsCategory[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return SETTINGS_CATEGORIES;
  return SETTINGS_CATEGORIES.filter(item => {
    const text = [item.zh, item.en, item.descriptionZh, item.descriptionEn, item.keywords].join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
