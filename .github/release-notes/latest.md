<div align="center">

# 🚀 ZettelAgent v0.1.0

### AI-Powered Zettelkasten Desktop Agent

**下载 → 安装 → 直接使用。** 无需 Node.js、Docker、额外模型下载。

![version](https://img.shields.io/badge/version-v0.1.0-0EA5E9?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8B5CF6?style=flat-square)
![size](https://img.shields.io/badge/installer-~300MB-10B981?style=flat-square)
![offline](https://img.shields.io/badge/runtime-zero%20download-F59E0B?style=flat-square)

</div>

---

## 🌐 选择语言 / Select Language / 言語を選択 / 언어 선택

[**English**](#-english) · [**中文**](#-中文) · [**日本語**](#-日本語) · [**한국어**](#-한국어)

---

## ✨ 亮点速览

| | 内置内容 | 说明 |
|---|:---:|---|
| 🧠 | nomic-embed-text-v1.5 嵌入模型 | WASM 加速，可选 WebGPU |
| 👁️ | PP-OCR 文字识别 | 中 / 英 / 日 三语 OCR |
| 📚 | Demo 知识库 | 14 篇示例笔记 |
| 🎨 | 离线资源包 | UI 字体 + KaTeX + PDF.js |

---

## 🇬🇧 English

### 📥 Download

| Platform | File | Recommended |
|----------|------|:-----------:|
| Windows | `.msi` or `-setup.exe` | ✅ |
| macOS (Apple Silicon) | `.dmg` | ✅ |
| macOS (Intel) | `.dmg` | ✅ |
| Linux | `.AppImage` or `.deb` | ✅ |

### 🚀 Quick Start

1. Download the installer from Assets below
2. Install and launch — **no extra downloads needed**
3. Configure your LLM in **Settings → AI**
   - Ollama (local) / DeepSeek / OpenAI / Claude / Gemini / etc.

> **MCP:** Uses Remote SSE (paste URL + Key). No local Node.js required.

---

## 🇨🇳 中文

### 📥 下载

| 平台 | 文件 | 推荐 |
|------|------|:----:|
| Windows | `.msi` 或 `-setup.exe` | ✅ |
| macOS (Apple Silicon) | `.dmg` | ✅ |
| macOS (Intel) | `.dmg` | ✅ |
| Linux | `.AppImage` 或 `.deb` | ✅ |

### 🚀 快速开始

1. 从下方 Assets 下载安装包
2. 安装并启动 — **无需额外下载任何东西**
3. 进入 **设置 → AI** 配置你的 LLM
   - Ollama（本地）/ DeepSeek / OpenAI / Claude / Gemini 等

> **MCP：** 使用远程 SSE（粘贴 URL + Key），无需本地 Node.js。

---

## 🇯🇵 日本語

### 📥 ダウンロード

| プラットフォーム | ファイル | 推奨 |
|------------------|----------|:----:|
| Windows | `.msi` または `-setup.exe` | ✅ |
| macOS (Apple Silicon) | `.dmg` | ✅ |
| macOS (Intel) | `.dmg` | ✅ |
| Linux | `.AppImage` または `.deb` | ✅ |

### 🚀 クイックスタート

1. 下の Assets からインストーラーをダウンロード
2. インストールして起動 — **追加ダウンロード不要**
3. **設定 → AI** で LLM を構成
   - Ollama（ローカル）/ DeepSeek / OpenAI / Claude / Gemini など

> **MCP:** リモート SSE を使用（URL + Key）。ローカル Node.js 不要。

---

## 🇰🇷 한국어

### 📥 다운로드

| 플랫폼 | 파일 | 추천 |
|--------|------|:----:|
| Windows | `.msi` 또는 `-setup.exe` | ✅ |
| macOS (Apple Silicon) | `.dmg` | ✅ |
| macOS (Intel) | `.dmg` | ✅ |
| Linux | `.AppImage` 또는 `.deb` | ✅ |

### 🚀 빠른 시작

1. 하단 Assets에서 설치 파일 다운로드
2. 설치 후 실행 — **추가 다운로드 불필요**
3. **설정 → AI** 에서 LLM 구성
   - Ollama（로컬）/ DeepSeek / OpenAI / Claude / Gemini 등

> **MCP:** 원격 SSE를 사용（URL + Key）. 로컬 Node.js 불필요.

---

## ⚠️ 注意事项 / Notes / 注意 / 주의사항

| 项目 | 说明 |
|------|------|
| 首次索引 | 首次打开后，Dashboard 重建索引可能需要 1–5 分钟（取决于笔记数量） |
| LLM 未配置 | 应用仍可正常浏览、搜索，仅 AI 功能不可用 |
| 安装包体积 | Windows 约 280–330MB（含完整离线资源） |

---

## 🛠 开发者 / Developers / 開発者 / 개발자

```bash
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent
npm install
npm run tauri dev    # 开发模式
npm run tauri build  # 构建 Release 安装包
```

> 源码在此仓库；此 Release 为终端用户安装包。大体积资源由 `tauri build` 自动下载并内置。

---

## 🐛 反馈 / Feedback

- 报告问题：[GitHub Issues](https://github.com/Poetrynan/ZettleAgent/issues)
- 功能建议：欢迎提 PR！

---

<div align="center">

**Made with** ❤️ **using** Tauri · React · Rust

</div>
