# ZettelAgent v0.3.0

知识管理 Agent 工作台升级 / Knowledge-management Agent workbench update

发布日期 / Release date: 2026-11-09

[下载与安装包 / Downloads](https://github.com/Poetrynan/ZettleAgent/releases/tag/v0.3.0) · [完整变更 / Full changelog](https://github.com/Poetrynan/ZettleAgent/compare/v0.2.0...v0.3.0)

## 简体中文

本次发布汇总自 v0.2.0 以来的更新，围绕知识管理 AI Agent / IDE 的日常工作流，改进工作台、白板、检索、笔记历史与配置体验。

### 工作台与 Dashboard

- 更新整体布局、对话界面、应用图标与启动画面，统一主题配色和交互控件。
- Dashboard 按知识库状态、下一步操作、索引任务、自动整理、最近变化与诊断组织内容；维护操作收起显示。
- 最近变化支持筛选、展开、失败重试与打开笔记，并修正本地日期分组和混合时间戳排序。
- 知识盲区计划按置信度预选建议，保留审查与确认步骤；空结果显示具体状态。
- 帮助和确认弹窗补齐键盘操作、焦点管理及可访问性语义。

### 面向知识管理 Agent 的设置

- 将设置重组为工作台、Agent、系统三组，共 11 个可搜索分区，覆盖知识库与笔记规则、复习、模型连接、Agent 行为、规则记忆、工具、检索、权限恢复、存储和快捷键。
- 新增分类描述与配置适用范围说明，窄窗口提供分类选择器。
- 模型连接采用显式保存，支持自定义模型 ID、连接测试、撤销草稿与真实错误反馈。
- 模型、整理参数与检索配置的草稿在切换设置分区时保留，离开设置前提醒未保存的改动。
- 仅修改模型等非密钥字段时保留已有凭据；移除密钥需要显式操作；更换需要凭据的服务时要求填写新密钥。
- 保留系统凭据库保护状态和降级存储提示，并修复旧版降级存储中仅修改模型可能丢失密钥的问题。

### 白板、图谱与笔记关联

- 重新设计白板卡片、工具栏、右键菜单和 Agent 面板，改善内容预览与操作层级。
- 改进拖拽连线、吸附与对齐参考线。
- 调整知识图谱物理布局与帧同步，使布局更容易稳定。
- 新增未链接提及的一键关联与安全撤销。

### 搜索、索引与可靠性

- 修复中文全文检索，并支持简繁体互相匹配。
- 查询向量在 Rust 后端生成，Agent 搜索使用实际查询向量。
- 单个分块失败不再阻塞整个索引任务；支持失败重试和 `.zettelignore` 排除规则。
- 明确区分增量“更新索引”与确认后的“全部重建向量”。重建以事务清理派生向量及缓存，保留笔记、分块正文、全文检索和手动关联。
- 加固笔记历史读取与恢复流程、Agent 重复探索和进度判断，以及撤销时对后续编辑的保护。
- 改进数据库读取隔离、嵌入迁移与内容安全策略。

### 升级说明

- 当前语义索引固定为 **768 维**，自定义嵌入服务需返回对应维度。
- 更新索引用于补齐待处理内容；需要重新生成已有向量时，请选择“全部重建向量”。远程嵌入服务会产生新的请求，后台整理运行时需先暂停。
- 本地嵌入模型按需加载，首次使用可能需要等待。
- 安装包由 GitHub Actions 构建并上传到本页，目标平台为 Windows x64、macOS Apple Silicon / Intel 和 Linux x64。请以本页实际附件为准。

## English

This release brings together the changes since v0.2.0, improving the everyday workflows of a knowledge-management AI Agent / IDE across the workbench, canvas, retrieval, note history, and configuration.

### Workbench and Dashboard

- Refresh the application layout, chat interface, icon, splash screen, theme colors, and shared controls.
- Organize the Dashboard around vault status, next actions, indexing, background organization, recent changes, and diagnostics, with maintenance actions tucked away.
- Add filtering, expansion, retry, and note navigation to recent changes; correct local-day grouping and mixed-format timestamp ordering.
- Preselect knowledge-gap suggestions by confidence while keeping review and approval explicit; show concrete empty states.
- Improve keyboard support, focus management, and accessibility semantics in help and confirmation dialogs.

### Knowledge-management Agent settings

- Introduce 11 searchable settings sections under Workbench, Agent, and System, covering vaults and note rules, review, model connections, Agent behavior, rules and memory, tools, retrieval, permissions and recovery, storage, and shortcuts.
- Add category descriptions, truthful scope labels, and a category selector for narrow windows.
- Make model connection edits explicit drafts, with custom model IDs, connection testing, discard actions, and real save errors.
- Preserve connection, organization, and retrieval drafts across category switches; warn before leaving with unsaved changes.
- Preserve credentials when editing non-secret fields, require an explicit removal action, and request a new credential when changing to a service that needs one.
- Retain OS credential-store protection and fallback warnings; prevent model-only edits from losing credentials in legacy fallback storage.

### Canvas, graph, and note connections

- Redesign canvas cards, toolbar, context menus, and Agent panel, improving previews and action organization.
- Improve drag-to-connect behavior, snapping, and alignment guides.
- Tune graph physics and frame synchronization so layouts settle more reliably.
- Add one-click linking for unlinked mentions with safe undo.

### Search, indexing, and reliability

- Fix Chinese full-text matching and support matching between Traditional and Simplified Chinese.
- Generate query embeddings in Rust and use real query vectors for Agent search.
- Keep a bad chunk from blocking the entire index; support failure retries and `.zettelignore` exclusions.
- Separate incremental index updates from explicitly confirmed full vector rebuilds. Rebuilds clear derived vectors and caches transactionally while preserving notes, chunk text, keyword search, and manual relations.
- Harden note-history reads and restoration, repeated-exploration and progress detection, and undo protection for later edits.
- Improve database read isolation, embedding migration, and the content security policy.

### Upgrade notes

- The current semantic index uses **768 dimensions**. Custom embedding services must return vectors of that size.
- Update the index to process pending content. Choose a full vector rebuild to regenerate existing vectors; remote services incur new requests. Pause background organization before rebuilding.
- Local embedding models load on demand; first use may take a moment.
- GitHub Actions builds and uploads installers here for Windows x64, macOS Apple Silicon / Intel, and Linux x64. The actual attached assets are the authoritative list.
