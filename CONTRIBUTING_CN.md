# 贡献指南

感谢你对 ZettelAgent 的关注！本文说明如何提交 Issue、发起 Pull Request，以及如何与其他贡献者协作开发新功能。

> **English:** See [CONTRIBUTING.md](CONTRIBUTING.md) for the English version.

---

## 两种受众

| | **Git 仓库（开发者）** | **GitHub Releases（终端用户）** |
|---|------------------------|----------------------------------|
| 用途 | 阅读源码、提 Issue/PR、本地构建 | 下载 `.exe` / `.msi` 安装使用 |
| 需要 Node / Rust | ✅ | ❌ |
| 需要下载嵌入模型 | 构建安装包时自动准备 | ❌ 安装包已内置 |

普通用户请从 [Releases](https://github.com/Poetrynan/ZettleAgent/releases) 下载，**无需 clone 本仓库**。

---

## 行为准则

- 尊重他人，就事论事
- 欢迎新手提问；描述问题时尽量提供版本、系统、复现步骤
- 大型改动（新 Agent、数据库迁移、UI 大改）建议**先开 Issue 讨论**，再写代码，避免白做

---

## 报告 Bug（Issue）

### 入口

1. 打开 [Issues · Poetrynan/ZettleAgent](https://github.com/Poetrynan/ZettleAgent/issues)
2. 点击 **New issue**
3. 选择 **Bug Report** 模板

应用内也可：**设置 → About → Report an issue**（会打开同一页面）。

### 请尽量提供

| 信息 | 说明 |
|------|------|
| 版本号 | 设置 → About 中的 `v0.x.x` |
| 操作系统 | Windows 10/11、macOS、Linux |
| LLM 提供商 | Ollama / DeepSeek / OpenAI 等（若与 Bug 相关） |
| 复现步骤 | 1、2、3… 越具体越好 |
| 期望 vs 实际 | 你期望发生什么，实际发生了什么 |
| 日志 / 截图 | F12 打开 DevTools → Console；或附上截图 |

### 好 Issue 示例

> **标题：** `[Bug]: 索引笔记时嵌入失败，控制台报 WASM 超时`  
> **内容：** 版本 0.1.0 / Windows 11 / 本地嵌入模式。步骤：打开 Dashboard → 点击「重建索引」→ 30 秒后失败。期望：索引完成。实际：Toast 报错。附 Console 截图。

### 不适合发 Issue 的情况

- 「怎么配置 API Key？」→ 先看 README 快速开始
- 「能不能加个 XX 功能？」→ 用 **Feature Request** 模板
- 只发一句「用不了」且无复现步骤

---

## 功能建议（Feature Request）

### 入口

Issues → **New issue** → **Feature Request**

### 请说明

1. **动机**：解决什么问题？典型使用场景？
2. **方案设想**：你希望怎么用？（不必写实现细节）
3. **功能区域**：Agent / 知识图谱 / 画布 / 编辑器 / 搜索 等（模板里有下拉选项）
4. **备选方案**（可选）：还考虑过哪些做法？

维护者会根据 Issue 讨论是否纳入路线图、优先级，以及是否适合拆成多个 PR。

---

## 开发环境

### 前置依赖

| 工具 | 版本建议 |
|------|----------|
| [Node.js](https://nodejs.org/) | 20 LTS |
| [Rust](https://rustup.rs/) | stable（Tauri 2） |
| Windows 构建 | Visual Studio Build Tools、WebView2 |
| macOS / Linux | 见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/) |

### 克隆与运行

```bash
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent
npm install

# 首次开发建议先准备离线资源（嵌入模型、WASM、字体等）
npm run download-model

npm run tauri dev      # 开发模式（热更新）
```

### 常用命令

```bash
npm run tauri dev           # 开发
npm run tauri build         # 打 Release 安装包（含 build:prod）
npm run build:prod          # 仅前端：准备资源 + tsc + vite build
npm run verify-offline      # 检查 public/ + resources/ 离线资源是否齐全
npm run verify-offline:dist # 检查 dist/ + resources/
npm test                    # Vitest 单元测试
npx tsc --noEmit            # TypeScript 检查
cd src-tauri && cargo check # Rust 检查
cd src-tauri && cargo clippy -- -D warnings
```

### 大文件说明

嵌入模型、ORT WASM、UI 字体等**不在 Git 里**，由 `scripts/download-model.cjs` 在构建时下载/同步。  
clone 后若只跑 `npm run build`（不含 `download-model`），可能缺少部分资源；完整打包请用 `npm run build:prod` 或 `npm run tauri build`。

`src/lib/katex-inlined.css.ts` 仓库内是**小 stub**；`build:prod` 会生成本地大文件，**请勿把生成后的 ~1.4MB 版本 commit 进 Git**。

---

## 项目结构（改代码前先看）

```
ZettleAgent/
├── src/                    # React 前端（TypeScript）
│   ├── components/         # UI 组件（settings、chat、canvas、dashboard…）
│   ├── contexts/           # React 上下文（AppContext、ChatContext…）
│   ├── hooks/              # 自定义 React Hooks（useSearch、useFileTree…）
│   ├── lib/                # 工具库（embeddings、i18n、tauri 封装、releaseConfig…）
│   │   └── i18n/           # 语言文件（en.ts、zh.ts…）
│   ├── styles/             # CSS（theme-tokens、各模块样式）
│   ├── test/               # 测试配置（setup.ts）
│   └── types/              # TypeScript 类型声明
├── src-tauri/              # Rust 后端（Tauri）
│   ├── src/
│   │   ├── agents/         # 多 Agent 编排
│   │   ├── commands/       # Tauri 命令（前后端桥接）
│   │   ├── db/             # SQLite、向量搜索
│   │   ├── import/         # 多格式导入（PDF、DOCX、CSV、OCR…）
│   │   ├── llm/            # LLM 调用、Prompt、推理
│   │   ├── scheduler/      # 后台任务调度
│   │   └── tools/          # 内置工具（internal_tools/）+ MCP 客户端
│   └── resources/          # 打进安装包的资源（OCR、demo-vault、embed_models）
├── scripts/                # 构建脚本（download-model、verify-offline…）
├── .github/                # CI、Issue/PR 模板
└── public/                 # Vite 打包的静态资源（字体、模型、css…）
```

**前后端分工简要：**

- 纯 UI、交互、i18n → `src/`
- 文件读写、搜索、Agent、数据库 → `src-tauri/`
- 前后端通信用 Tauri `invoke`（见 `src/lib/tauri.ts` 与各 `commands/`）

---

## 提交 Pull Request

### 1. Fork 与分支

```bash
# 在 GitHub 上 Fork Poetrynan/ZettleAgent 到你的账号
git clone https://github.com/<你的用户名>/ZettleAgent.git
cd ZettleAgent
git remote add upstream https://github.com/Poetrynan/ZettleAgent.git

git checkout -b feat/my-feature   # 或 fix/issue-123-xxx
```

分支命名建议：

| 类型 | 前缀 | 示例 |
|------|------|------|
| 新功能 | `feat/` | `feat/canvas-export-png` |
| Bug 修复 | `fix/` | `fix/embedding-timeout` |
| 文档 | `docs/` | `docs/contributing-zh` |
| 重构 | `refactor/` | `refactor/search-module` |

### 2. 开发与自测

- [ ] `npx tsc --noEmit` 通过
- [ ] `cd src-tauri && cargo check` 通过
- [ ] 在 `npm run tauri dev` 下手动验证改动的功能
- [ ] 若改 UI：浅色 / 深色主题都看一眼
- [ ] 若改用户可见文案：更新 `src/lib/i18n/en.ts` 与 `zh.ts`（及其他语言若适用）
- [ ] 若改 GitHub 链接：只改 [`src/lib/releaseConfig.ts`](src/lib/releaseConfig.ts) 的 `owner` / `repo`

### 3. 提交信息

使用清晰的中文或英文均可，推荐：

```
feat(dashboard): 添加图谱导出 PNG 按钮

- 新增 exportGraphPng 命令
- 补充 en/zh i18n
```

### 4. 推送并开 PR

```bash
git push origin feat/my-feature
```

在 GitHub 上对你的 Fork 点 **Compare & pull request**，目标分支为 `Poetrynan/ZettleAgent` 的 `main`。

PR 会自动带上 [Pull Request 模板](.github/pull_request_template.md)，请填写：

- 改动说明
- 类型（Bug fix / Feature / …）
- 关联 Issue：`Fixes #123` 或 `Closes #456`
- Checklist 逐项确认

### 5. Code Review 之后

- 根据 Review 意见修改并 push 到同一分支即可
- 合并由维护者完成；合并后可在本地：

```bash
git checkout main
git pull upstream main
```

---

## 协作开发新功能（推荐流程）

适合多人一起做、或改动较大的功能。

```
讨论 Issue → 分工 / 认领 → 各开分支 → 小步 PR → Review → 合并
```

### Step 1：先开 Issue

在 Feature Request 里写清需求。维护者或你可以在评论里：

- 确认范围（做 / 不做）
- 拆分子任务（例如：后端 API + 前端 UI + i18n 分三个 PR）
- 认领：`我来负责后端部分`

### Step 2：对齐设计（大功能）

涉及以下情况时，**先讨论再写代码**：

- 新增数据库表或迁移（`src-tauri/src/db/schema.rs`）
- 新增 Agent 或内置工具（`src-tauri/src/tools/`、`agents/`）
- 修改嵌入维度或模型（影响已有用户索引）
- 安装包体积显著增加的新资源

Comment 里可贴：接口草图、UI 草图、伪代码。

### Step 3：小步提交

- 一个 PR 只做一件事，便于 Review
- 例如「图谱导出」可拆为：
  1. `feat: 添加 Rust 导出命令`
  2. `feat: Dashboard 导出按钮 + i18n`

### Step 4：保持与 main 同步

长期分支建议定期：

```bash
git fetch upstream
git rebase upstream/main   # 或 merge upstream/main
```

---

## 代码规范（摘要）

与 [PR 模板](.github/pull_request_template.md) 一致：

| 项 | 要求 |
|----|------|
| 用户可见字符串 | 使用 `t('key')`，键写入 `src/lib/i18n/en.ts`、`zh.ts` 等 |
| 样式 | 使用 `theme-tokens.css` / CSS 变量，避免硬编码颜色 |
| TypeScript | `strict` 模式，避免 `any` 泛滥 |
| Rust | 通过 `cargo clippy`；错误用 `crate::error` 体系 |
| 写入用户笔记 | AI 生成内容应放在 `<!-- @generated -->` 块内，不覆盖用户原文 |
| 新依赖 | 说明理由；注意安装包体积（本地优先、少联网） |

---

## 发布与 CI（维护者参考）

贡献者一般**不需要**自己发 Release：

- Push 到 `main` → CI 跑 TypeScript + Rust 检查（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）
- 打 tag `v*` → 自动构建多平台安装包（[`.github/workflows/release.yml`](.github/workflows/release.yml)）

---

## 获取帮助

| 渠道 | 链接 |
|------|------|
| Bug / 功能建议 | [Issues](https://github.com/Poetrynan/ZettleAgent/issues) |
| 讨论实现方案 | 在具体 Issue 下评论 |
| 仓库首页 | [github.com/Poetrynan/ZettleAgent](https://github.com/Poetrynan/ZettleAgent) |

再次感谢你的贡献！
