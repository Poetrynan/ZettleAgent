# ZettelAgent 首次开源发布指南

> **适用对象：** 项目维护者（你本人）  
> **目标：** 把源码 Push 到 GitHub → 在本地打出安装包 → 上传到 GitHub Releases，让普通用户「下载 → 安装 → 即用」。  
> **平台说明：** 下文以 **Windows** 为主（你当前环境）；macOS / Linux 步骤会单独标注。

如果你是第一次发布开源桌面应用，按本文 **从头到尾顺序做一遍** 即可。

---

## 目录

1. [先理解两件事：Git 仓库 vs Release 安装包](#1-先理解两件事git-仓库-vs-release-安装包)
2. [发布前需要准备的工具](#2-发布前需要准备的工具)
3. [在 GitHub 创建仓库](#3-在-github-创建仓库)
4. [Push 代码到 GitHub（第一次）](#4-push-代码到-github第一次)
5. [Push 前必做检查清单](#5-push-前必做检查清单)
6. [本地构建安装包（Windows）](#6-本地构建安装包windows)
7. [构建完成后本地自测](#7-构建完成后本地自测)
8. [上传安装包到 GitHub Release](#8-上传安装包到-github-release)
9. [（可选）用 Git Tag 让 CI 自动打多平台包](#9-可选用-git-tag-让-ci-自动打多平台包)
10. [以后每次发新版本的标准流程](#10-以后每次发新版本的标准流程)
11. [千万不要上传的东西](#11-千万不要上传的东西)
12. [常见问题 FAQ](#12-常见问题-faq)
13. [快速命令速查表](#13-快速命令速查表)

---

## 1. 先理解两件事：Git 仓库 vs Release 安装包

| | **Git 仓库（给开发者）** | **GitHub Release（给普通用户）** |
|---|---|---|
| 内容 | 源码、小资源（OCR、demo 笔记） | `.msi` / `.exe` 安装包（约 300MB） |
| 谁用 | 开发者 clone、提 Issue/PR | 用户下载安装，**不需要** Node / Rust |
| 嵌入模型 ~131MB | ❌ **不进 Git**（太大） | ✅ **已打进安装包** |
| 用户 API Key、聊天记录 | ❌ 永远不进 Git / Release | 存在用户本机 `%APPDATA%` |

**数据流：**

```text
【你（维护者）】
  改代码 → git push 到 GitHub
         → 本地 npm run tauri build（构建时自动 download-model）
         → 得到 setup.exe / .msi
         → 上传到 GitHub Releases

【普通用户】
  打开 Releases 页面 → 下载 .msi 或 .exe → 安装 → 打开即用
  （安装过程中不会再从 HuggingFace 下载任何东西）
```

`scripts/download-model.cjs` 里的 HuggingFace 链接是 **给你打安装包时用的**，不是让用户自己去下载。

---

## 2. 发布前需要准备的工具

### 2.1 账号与软件

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| [GitHub 账号](https://github.com/signup) | 托管代码、发 Release | 注册即可 |
| [Git for Windows](https://git-scm.com/download/win) | 版本控制、push 代码 | 安装时选「Git from the command line」 |
| [Node.js 20 LTS](https://nodejs.org/) | 前端构建、`download-model` | 选 LTS 版本 |
| [Rust stable](https://rustup.rs/) | Tauri 后端编译 | Windows 上运行 `rustup-init.exe` |
| **Visual Studio Build Tools** | Windows 上编译 Rust 需要 MSVC | 见下方 2.2 |
| **WebView2** | Tauri 运行时（Win10/11 通常已有） | [官方安装包](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |

### 2.2 Windows：安装 Visual Studio Build Tools

1. 下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. 安装时勾选：**「使用 C++ 的桌面开发」**（Desktop development with C++）
3. 右侧确保包含：**MSVC v143**、**Windows 10/11 SDK**

### 2.3 验证环境

打开 **PowerShell** 或 **Git Bash**，依次运行：

```powershell
git --version          # 应显示 git version 2.x
node --version         # 应显示 v20.x
npm --version          # 应显示 10.x
rustc --version        # 应显示 rustc 1.x
cargo --version        # 应显示 cargo 1.x
```

若 `rustc` 找不到，安装 Rust 后 **重新打开终端** 再试。

### 2.4 （推荐）安装 GitHub CLI

可选，但上传 Release 时很方便：

```powershell
winget install GitHub.cli
gh auth login
```

按提示选择 GitHub.com → HTTPS → 浏览器登录。

---

## 3. 在 GitHub 创建仓库

### 3.1 新建空仓库

1. 登录 GitHub → 右上角 **+** → **New repository**
2. 填写：
   - **Repository name：** 例如 `ZettleAgent`（公开项目名，README 里已用这个）
   - **Description：** `Local-first AI knowledge agent & second brain`
   - **Public**（开源选公开）
   - **不要**勾选 "Add a README" / "Add .gitignore"（本地已有，避免冲突）
3. 点 **Create repository**

创建后会看到类似：

```text
https://github.com/你的用户名/ZettleAgent.git
```

### 3.2 仓库名与代码里链接保持一致

项目里多处写死了 GitHub 地址，Push 前确认 **owner / repo** 一致：

| 文件 | 改什么 |
|------|--------|
| `src/lib/releaseConfig.ts` | `owner`、`repo`（About 页、检查更新） |
| `README.md` / `README_CN.md` 等 | 徽章和 Releases 链接 |
| `landing-page/index_original.html` | GitHub / Releases 链接 |

例如仓库是 `https://github.com/Poetrynan/ZettleAgent`：

```typescript
// src/lib/releaseConfig.ts
export const GITHUB_RELEASE = {
  owner: 'Poetrynan',
  repo: 'ZettleAgent',
} as const;
```

---

## 4. Push 代码到 GitHub（第一次）

假设你的项目在本机路径：

```text
C:\Users\你的用户名\Desktop\Zettle\ZettleAgent_experiment
```

以下命令在 **项目根目录**（有 `package.json` 的那一层）执行。

### 4.1 情况 A：本地还没有 git 仓库

```powershell
cd C:\Users\你的用户名\Desktop\Zettle\ZettleAgent_experiment

git init
git branch -M main
git remote add origin https://github.com/你的用户名/ZettleAgent.git
```

### 4.2 情况 B：已有 git，只是换远程地址

```powershell
cd C:\Users\你的用户名\Desktop\Zettle\ZettleAgent_experiment

git remote -v
# 若 origin 不对：
git remote set-url origin https://github.com/你的用户名/ZettleAgent.git
```

若当前分支叫 `master` 想改成 `main`：

```powershell
git branch -M main
```

### 4.3 第一次提交

```powershell
# 查看哪些文件会被提交（建议先看一眼）
git status

# 添加所有应跟踪的文件
git add .

# 再次确认：不应出现 .env、node_modules、target、你的 .db 文件
git status

# 第一次 commit
git commit -m "chore: initial open-source release"
```

### 4.4 Push 到 GitHub

```powershell
git push -u origin main
```

首次 push 可能弹出 GitHub 登录窗口；或用 Personal Access Token 作为密码。

**Push 成功后：** 打开 `https://github.com/你的用户名/ZettleAgent`，应能看到源码、README、LICENSE。

---

## 5. Push 前必做检查清单

在 `git add` 之前，逐项确认：

### 5.1 敏感信息（必查）

```powershell
# 在项目根目录搜索常见泄露（PowerShell）
Select-String -Path "src\*","src-tauri\src\*" -Pattern "sk-[a-zA-Z0-9]{20,}" -Recurse -ErrorAction SilentlyContinue
```

- [ ] 没有 `.env` / `.env.local` 被 `git add`（已在 `.gitignore`）
- [ ] 没有 API Key、Token、密码写死在源码里
- [ ] 没有 `chat-history-*.json`、个人笔记、截图等开发垃圾文件
- [ ] 没有 `%APPDATA%` 下的 `settings.json` 被误拷进项目

### 5.2 必须进 Git 的小资源

- [ ] `src-tauri/resources/demo-vault/*.md`（demo 示例笔记，约 14 篇）**已 add**
- [ ] `src-tauri/resources/ocr_models/det.onnx`、`rec.onnx` 是**真实模型**（各约 4–10MB），不是 HTML 404 页面
- [ ] `scripts/download-model.cjs`、`scripts/verify-offline-assets.cjs` 已 add

### 5.3 不应进 Git 的大文件（已在 .gitignore）

- [ ] `node_modules/`
- [ ] `dist/`
- [ ] `src-tauri/target/`
- [ ] `src-tauri/resources/embed_models/`（嵌入模型，构建时下载）
- [ ] `public/models/`、`public/ort-wasm-*` 等（构建时生成）
- [ ] 构建后变大的 `src/lib/katex-inlined.css.ts`（~1.4MB 版本不要 commit）

### 5.4 版本号

发 **v0.1.0** 前，两处版本号保持一致：

| 文件 | 字段 |
|------|------|
| `package.json` | `"version": "0.1.0"` |
| `src-tauri/tauri.conf.json` | `"version": "0.1.0"` |

---

## 6. 本地构建安装包（Windows）

### 6.1 安装依赖（只需第一次，或 package.json 变更后）

```powershell
cd C:\Users\你的用户名\Desktop\Zettle\ZettleAgent_experiment

npm install
```

### 6.2 准备离线资源（构建时自动跑，也可手动预检）

`npm run tauri build` 会通过 `beforeBuildCommand` 自动执行 `npm run build:prod`，其中包含 `download-model`。

**首次建议手动跑一遍**，方便看下载是否成功（需能访问 HuggingFace；国内可能走脚本里的 hf-mirror 备用链接）：

```powershell
npm run download-model
```

成功末尾应类似：

```text
✓ Installer assets verified — user will get zero-download OOB experience
```

再跑校验：

```powershell
npm run verify-offline
npm run verify-offline:dist   # 若已有 dist/ 目录
```

### 6.3 正式打 Release 安装包

```powershell
npm run tauri build
```

**这一步会：**

1. 运行 `download-model`（嵌入模型、WASM、字体、PDF.js、OCR 校验）
2. TypeScript 编译 + Vite 打包 → `dist/`
3. Rust Release 编译 + Tauri 打包

**耗时：** 首次约 **15–40 分钟**（取决于网络和机器；Rust 首次编译较慢）。

### 6.4 安装包输出位置

构建成功后，在：

```text
src-tauri\target\release\bundle\
```

Windows 常见文件：

| 路径 | 说明 | 推荐给用户的 |
|------|------|--------------|
| `bundle\msi\ZettelAgent_0.1.0_x64_en-US.msi` | Windows Installer | ✅ **首选** |
| `bundle\nsis\ZettelAgent_0.1.0_x64-setup.exe` | NSIS 安装程序 | ✅ 备选 |

用 PowerShell 查看：

```powershell
Get-ChildItem -Recurse "src-tauri\target\release\bundle" -Include *.msi,*.exe | Select-Object FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,1)}}
```

正常安装包体积大约 **250–350 MB**（含嵌入模型）。若只有几 MB，说明打包失败或资源缺失。

### 6.5 macOS / Linux（若你以后在本机打）

| 平台 | 前置依赖 | 命令 | 输出 |
|------|----------|------|------|
| macOS | Xcode Command Line Tools | `npm run tauri build` | `bundle/dmg/*.dmg` |
| Linux | `libwebkit2gtk` 等，见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/) | `npm run tauri build` | `bundle/appimage/*.AppImage`、`bundle/deb/*.deb` |

Windows 维护者通常 **只本机打 Windows 包**；macOS / Linux 可交给 CI（见第 9 节）。

---

## 7. 构建完成后本地自测

在 upload Release **之前**，务必在本机安装测试：

1. 双击 `.msi` 或 `-setup.exe` 安装
2. 启动 ZettelAgent
3. 检查：
   - [ ] 首次打开有 demo 知识库（来自 `demo-vault`）
   - [ ] 设置 → 关于，版本号正确
   - [ ] Dashboard → 重建索引 / 向量搜索能跑（说明嵌入模型已打进包）
   - [ ] 导入带文字的图片，OCR 可用
   - [ ] **断网**后仍能打开应用、浏览笔记（本地优先）

测试通过后，再上传 Release。不要上传「没装过自己机器」的安装包。

---

## 8. 上传安装包到 GitHub Release

有两种方式：**网页手动上传**（最直观）和 **GitHub CLI**（适合重复发版）。

### 8.1 方式一：GitHub 网页（推荐第一次）

1. 打开 `https://github.com/你的用户名/ZettleAgent/releases`
2. 点击 **Draft a new release**（或 **Create a new release**）
3. 填写：

| 字段 | 示例 |
|------|------|
| **Choose a tag** | 输入 `v0.1.0` → 选 **Create new tag: v0.1.0 on publish** |
| **Target** | `main` |
| **Release title** | `ZettelAgent v0.1.0` |
| **Description** | 见下方模板 |

4. **Attach binaries：** 把 `bundle\msi\*.msi` 和/或 `bundle\nsis\*-setup.exe` **拖进** Assets 区域  
   ⚠️ **只上传 `bundle` 里的安装包**，不要拖整个 `target` 文件夹。

5. 若还不确定，可先勾选 **Set as a pre-release** 做内测；确认无误后 Edit → 取消 pre-release → **Publish release**。

#### Release 说明模板（可复制）

```markdown
## ZettelAgent v0.1.0

本地优先的 AI 知识库 Agent — 下载安装即可使用，无需 Node.js、Docker 或额外模型下载。

### 安装

| 平台 | 文件 |
|------|------|
| **Windows** | `ZettelAgent_0.1.0_x64_en-US.msi`（推荐）或 `*-setup.exe` |

### 安装包已内置（运行时零下载）

- nomic-embed-text-v1.5 嵌入模型 + ONNX Runtime WASM
- PP-OCR 文字识别模型
- UI 字体、KaTeX、PDF.js
- Demo 示例知识库

### 使用前

1. 安装后打开应用
2. 在引导页或 **设置 → AI** 配置 LLM（Ollama 本地或 DeepSeek / OpenAI 等 API Key）
3. 选择你的 Markdown 笔记文件夹，或先用内置 Demo 库体验

### 开发者

源码在本仓库；此 Release 面向**终端用户**安装包。开发环境见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
```

### 8.2 方式二：GitHub CLI

```powershell
# 在项目根目录
gh release create v0.1.0 `
  "src-tauri\target\release\bundle\msi\ZettelAgent_0.1.0_x64_en-US.msi" `
  "src-tauri\target\release\bundle\nsis\ZettelAgent_0.1.0_x64-setup.exe" `
  --title "ZettelAgent v0.1.0" `
  --notes-file release-notes-v0.1.0.md `
  --draft
```

把说明存为 `release-notes-v0.1.0.md`，检查 Draft 无误后：

```powershell
gh release edit v0.1.0 --draft=false
```

### 8.3 发布后

- 打开 README 里的 Releases 链接，确认能下载
- 在另一台干净 Windows 机器（或虚拟机）再装一次（可选但强烈建议）
- 若用了 GitHub Pages 放 landing page，更新下载链接指向最新 Release

---

## 9. （可选）用 Git Tag 让 CI 自动打多平台包

仓库已包含 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。当你 push 形如 `v*` 的 tag 时，GitHub Actions 会在 **Windows / macOS / Linux** 上自动构建，并创建 **Draft Release**。

### 9.1 触发 CI Release

```powershell
# 确保 main 已 push，且版本号已改好
git push origin main

git tag v0.1.0
git push origin v0.1.0
```

### 9.2 查看构建进度

GitHub 仓库 → **Actions** → 选 **Release** workflow → 看各平台是否绿色 ✅

### 9.3 发布 Draft

CI 成功后：

1. **Releases** 页会出现 Draft：`ZettelAgent v0.1.0`
2. 检查各平台 Assets（`.msi`、`.dmg`、`.AppImage` 等）
3. 编辑说明 → **Publish release**

**注意：** CI 机器从 Git clone 后也会跑 `npm run download-model`，因此 **demo-vault 和 OCR 必须在 Git 里**，否则 CI 会失败。

### 9.4 本地打 Windows + CI 打 macOS/Linux

很多 solo 维护者采用：

- **Windows 安装包：** 本机 `tauri build`，手动上传（或覆盖 CI 的 Windows artifact）
- **macOS / Linux：** 交给 CI

两种方式可以并存。

---

## 10. 以后每次发新版本的标准流程

```text
1. 开发、自测（npm run tauri dev）
2. 改版本号：package.json + tauri.conf.json（如 0.1.0 → 0.2.0）
3. git add → commit → push main
4. 本地：npm run tauri build
5. 本机安装 smoke test
6. GitHub Releases 新建 v0.2.0，上传新安装包
   （或：git tag v0.2.0 && git push origin v0.2.0 走 CI）
7. 写 Release Notes：新功能、修复、已知问题
```

用户升级安装包 **不会丢失** 笔记和 API 配置（存在 `%APPDATA%\com.zettelagent.app\`），但 major 升级前仍建议在 Release 里提醒「重要数据请备份」。

---

## 11. 千万不要上传的东西

| 数据 | 实际位置 | 会进 Git？ | 会进 Release 安装包？ |
|------|----------|------------|------------------------|
| API Key / LLM 配置 | `%APPDATA%\com.zettelagent.app\settings.json` | ❌ | ❌ |
| 聊天记录、AI 记忆 | 本机 SQLite `zettelagent.db` | ❌ | ❌ |
| 你的私人笔记库 | 用户自选的文件夹 | ❌ | ❌ |
| 应用日志 | `%APPDATA%\com.zettelagent.app\logs\` | ❌ | ❌ |
| 嵌入模型 ~131MB | 构建时 download-model 生成 | ❌（gitignore） | ✅（打进 exe） |
| demo-vault 示例 | `src-tauri/resources/demo-vault/` | ✅ | ✅（示例，非私人数据） |

**上传 Release 时只选：**

```text
src-tauri\target\release\bundle\msi\*.msi
src-tauri\target\release\bundle\nsis\*-setup.exe
```

**不要上传：** 整个 `target/`、`node_modules/`、`.db` 文件、`.env`、开发机上的 `settings.json`。

---

## 12. 常见问题 FAQ

### Q1：`npm run download-model` 失败 / HuggingFace 超时

- 检查网络；脚本内含 `hf-mirror.com` 备用 URL
- 多试几次；成功后会缓存到 `src-tauri/resources/embed_models/` 和 `public/`
- 确认 OCR 的 `det.onnx`、`rec.onnx` 体积正常（不是 300KB 的 HTML）

### Q2：`tauri build` Rust 编译报错 link.exe not found

未安装 **Visual Studio Build Tools** 的 C++  workload。见 [第 2.2 节](#22-windows安装-visual-studio-build-tools)。

### Q3：安装包只有几 MB，没有模型

说明 `build:prod` / `download-model` 未成功执行。先单独跑：

```powershell
npm run download-model
npm run verify-offline
npm run tauri build
```

### Q4：Push 时提示文件太大

- 嵌入模型 **不应** commit；检查是否误 add 了 `embed_models/` 或 `*.onnx`（OCR 除外）
- GitHub 单文件限制 100MB；大模型只能构建时下载

### Q5：用户装完还要自己下模型吗？

**不需要。** 用户只下你的 Release 安装包。HuggingFace 只在 **你构建时** 使用。

### Q6：仓库叫 `ZettleAgent_experiment` 还是 `ZettleAgent`？

名字随意，但需统一改 `releaseConfig.ts`、README、landing page 里的链接。对用户来说，**Release 页 URL** 才是下载入口。

### Q7：第一次必须 push 才能 build 吗？

**不必。** 可以本地先 `tauri build` 测通，再 push。顺序推荐：本地 build 成功 → push 代码 → 上传 Release。

### Q8：CI Release 是 Draft，要手动 Publish 吗？

是的。`release.yml` 里 `releaseDraft: true`，防止未检查就自动公开。CI 绿了之后去 Releases 页 Publish。

---

## 13. 快速命令速查表

```powershell
# ── 环境 ──
node --version && rustc --version

# ── 日常开发 ──
npm install
npm run download-model      # 首次 / 清理后
npm run tauri dev

# ── 打安装包 ──
npm run verify-offline
npm run tauri build
Get-ChildItem -Recurse src-tauri\target\release\bundle -Include *.msi,*.exe

# ── Git 首次 push ──
git add .
git commit -m "chore: prepare v0.1.0 release"
git push -u origin main

# ── 发版 tag（触发 CI，可选）──
git tag v0.1.0
git push origin v0.1.0

# ── CLI 创建 Draft Release（可选）──
gh release create v0.1.0 `
  "src-tauri\target\release\bundle\msi\*.msi" `
  --title "ZettelAgent v0.1.0" `
  --notes "See FIRST_RELEASE_GUIDE.md" `
  --draft
```

---

## 相关文档

- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献者开发环境
- [PACKAGING_RELEASE_QA.md](./PACKAGING_RELEASE_QA.md) — 打包与 Release 细节 Q&A
- [Tauri 官方打包文档](https://v2.tauri.app/distribute/)

---

**祝你第一次开源发布顺利。** 若某一步报错，把完整终端输出贴到 Issue 里（不要贴 API Key），便于排查。
