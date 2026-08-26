![ZettleAgent Banner](./screenshots/zettleagent-readme-swiss-banner.png)

<div align="center">

  # ZettelAgent

  ### Local-First, Agent-Native Knowledge Operating System

  *Your second brain that thinks, audits contradictions, and evolves your local notes.*  
  All from a pure Markdown folder — **No Docker, no cloud lock-in, no telemetry.**

  <!-- Badges -->
  <p>
    <a href="https://poetrynan.github.io/zettelagent.org/"><img src="https://img.shields.io/badge/🌐_Website-zettelagent.org-CF2711?style=for-the-badge" alt="Website"></a>
    <a href="https://github.com/Poetrynan/ZettleAgent/stargazers"><img src="https://img.shields.io/github/stars/Poetrynan/ZettleAgent?style=for-the-badge&color=0EA5E9&logo=github&cacheSeconds=60" alt="Stars"></a>
    <a href="https://github.com/Poetrynan/ZettleAgent/releases"><img src="https://img.shields.io/github/v/release/Poetrynan/ZettleAgent?style=for-the-badge&color=10B981" alt="Release"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-8B5CF6?style=for-the-badge" alt="Platform">
    <a href="https://github.com/Poetrynan/ZettleAgent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Poetrynan/ZettleAgent?style=for-the-badge&color=F59E0B" alt="License"></a>
  </p>

  <!-- Tech stack -->
  <p>
    <img src="https://img.shields.io/badge/Tauri-2.0-FFC107?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2.0">
    <img src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=white" alt="React 19">
    <img src="https://img.shields.io/badge/Rust-1.96-dea584?style=flat-square&logo=rust&logoColor=white" alt="Rust 1.96">
    <img src="https://img.shields.io/badge/SQLite-FTS5%20+%20Vec-0EA5E9?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
    <img src="https://img.shields.io/badge/Embedding-nomic--v1.5%20WebGPU%2FWASM-10B981?style=flat-square" alt="Embedding">
    <img src="https://img.shields.io/badge/Algorithm-FSRS--4.5-8B5CF6?style=flat-square" alt="FSRS-4.5">
  </p>

  <!-- Language switcher -->
  <p>
    <strong>English</strong> · <a href="README_CN.md">中文</a> · <a href="README_JP.md">日本語</a> · <a href="README_KR.md">한국어</a>
  </p>

</div>

---

> ### 🚀 [Download from Releases](https://github.com/Poetrynan/ZettleAgent/releases) · 🌐 [Live Showcase · zettelagent.org](https://poetrynan.github.io/zettelagent.org/)
> 
> No Node.js, no Docker, no extra model downloads. The standalone installer already includes the bundled nomic embedding engine, ONNX Runtime WASM, and offline OCR — fully private on your local Markdown files.

---

## 📑 Table of Contents

- [✨ Core Architecture & Capabilities](#-core-architecture--capabilities)
- [📸 Interface Showcase](#-interface-showcase)
- [⚔️ Architectural Comparison](#️-architectural-comparison)
- [🏁 Quick Start (End Users)](#-quick-start-end-users)
- [🛠 Build from Source (Developers)](#-build-from-source-developers)
- [💻 System Requirements](#-system-requirements)
- [🤝 Contributing](#-contributing)
- [🙏 Acknowledgments](#-acknowledgments)
- [📜 License](#-license)

---

## ✨ Core Architecture & Capabilities

### 🛡️ WriteGuard & Reversible ChangeSet (100% Data Sovereignty)
- **Human-in-the-Loop Write Gate**: The Agent never silently overwrites your files. Every modification requires a `READYWRITE` token and presents an interactive line-by-line Diff preview for you to inspect and approve.
- **100% Reversible ChangeSet Ledger**: Every operation stores its exact mathematical reverse patch. Modified lines can be restored, deleted nodes recreated, and disconnected edges returned to their coordinates with a single click.

### 🤖 Native Autonomous Agent (6 Domain Toolkits)
- **Domain Tool Packs**: Note Mutation, Hybrid Search & Retrieval, Graph Topology Diagnostics, Canvas Spatial Reasoning, Workspace Health Audit, and Web Deep Search.
- **3-Layer Intent Routing (L0/L1/L2)**: High-confidence commands execute deterministically (0ms, 0 Token); only ambiguous tasks trigger model planning.
- **Local Small Model Optimization (7B/14B)**: Dynamically loads domain schemas to save 4,000+ Tokens per turn, eliminating tool hallucinations on local Ollama/vLLM models.

### 🧠 Mathematical Graph Topology & Blind Spot Diagnosis
- **Graph Algorithms**: Calculates **PageRank centrality scores**, runs **Louvain community clustering**, and discovers shortest conceptual paths.
- **GraphPlan**: Automatically diagnoses orphan subgraphs, dead links, and knowledge blind spots, generating actionable bridging plans.

### 🎨 Spatial Reasoning Infinite Canvas (Obsidian Compatible)
- **4 Spatial Reasoning Goals**: `explain` (hierarchical breakdown), `compare` (matrix juxtaposition), `trace` (chronological causal lineage), and `cluster` (thematic clustering).
- **Bi-directional Compilation**: Seamlessly translates canvas nodes into SQLite database entries and vice versa.

### 🔐 OS Keyring Security Substrate
- **Hardware-Level Encryption**: API keys and model credentials are encrypted via Windows DPAPI and macOS Keychain. 0 plain-text tokens in WebView or settings JSON.
- **100% Offline Vector Store**: SQLite-vec + FTS5 running purely locally with zero cloud telemetry.

### 📈 Scientific Spaced Repetition (FSRS-4.5)
- **Modern Memory Retention**: Built-in modern FSRS-4.5 spaced repetition algorithm with strict monotonic invariant guards and episodic memory store.

---

## 📸 Interface Showcase (Redesigned Desktop Workspace)

<div align="center">

### 1. The 3-Column Desktop OS & 3D Topology Atlas
*Interactive PageRank centrality graph, collapsible file explorer, and autonomous Agent Desk.*

![ZettleAgent 3-Column Desktop OS Workspace](./screenshots/showcase-workspace-atlas.png)

<br>

| 2. WriteGuard™ Line Diff & ChangeSet Ledger | 3. Spatial Reasoning Infinite Canvas |
|:---:|:---:|
| <img src="./screenshots/showcase-writeguard-diff.png" alt="WriteGuard Line Diff" width="100%"> | <img src="./screenshots/showcase-canvas-spatial.png" alt="Spatial Reasoning Canvas" width="100%"> |
| *ReadyWrite gate, line-by-line Diff approval & 1-click undo* | *4 spatial goals (explain, compare, trace, cluster) + SQLite sync* |

<br>

### 4. Scientific Spaced Repetition (FSRS-4.5 Engine)
*Modern memory retention with strict monotonic invariants and episodic memory store.*

![FSRS-4.5 Spaced Repetition Review Engine](./screenshots/showcase-fsrs-review.png)

</div>

---

## ⚔️ Architectural Comparison

| Capability & Dimension | **ZETTLEAGENT** | **OBSIDIAN** | **LOGSEQ** | **NOTION / MEM** |
| :--- | :--- | :--- | :--- | :--- |
| **AI Operating Model** | 🚀 **Native Autonomous Agent** (6 toolkits, L0-L2 routing, CoT stream) | ⚠️ **Fragmented 3rd-party plugins** (no unified state machine) | ⚠️ **Experimental plugins only** (no tool loop) | ☁️ **Cloud text assistant** (simple completion, no tool orchestration) |
| **Local 7B/14B Models** | ⚡ **Deeply optimized** (schema pruning, saves 4000+ tokens, 0% hallucination) | ⚠️ **Assumes cloud APIs** (local small models often hallucinate) | ❌ **No small model optimizations** | ❌ **Cloud proprietary only** (cannot connect Ollama) |
| **Write Safety Guard** | 🛡️ **WriteGuard Gate** (Line Diff approval, ReadyWrite tokens) | ⚠️ **Direct file writes** (relies on basic file history) | ⚠️ **Direct file writes** (relies on Git plugin) | ☁️ **Replaces cloud blocks** (whole-page revert only) |
| **Reversible Undo** | 🔄 **100% Reversible ChangeSet ledger** (1-click rollback across notes & canvas) | ❌ **No reverse patch ledger** | ❌ **Manual git revert only** | ❌ **No fine-grained AI rollback** |
| **Graph Topology** | 🧠 **PageRank centrality + Louvain clustering + GraphPlan** | ⚠️ **Visual view only** (no topology algorithms) | ⚠️ **Basic 2D graph** (no metrics) | ❌ **No graph view** (hierarchical tree only) |
| **Spatial Canvas** | 🎨 **4 Reasoning Goals + Auto-layout + SQLite sync** | ⚠️ **Manual drag-and-drop** (plugins append text boxes) | ⚠️ **Basic whiteboard** (no reasoning goals) | ❌ **No infinite canvas** |
| **Security Substrate** | 🔐 **OS Hardware Keyring (DPAPI/Keychain) + 0 telemetry** | ⚠️ **Plaintext API keys in plugin .json** | ⚠️ **Plaintext configs** | ☁️ **Commercial cloud hosted** (data exposed to SaaS) |
| **Spaced Repetition** | 📈 **Built-in FSRS-4.5 (monotonic guards) + Episodic memory** | ⚠️ **Requires plugin (legacy SM-2)** | ⚠️ **Basic flashcards (legacy)** | ❌ **No spaced repetition** |

---

## 🏁 Quick Start (End Users)

1. Download the installer from [Releases](https://github.com/Poetrynan/ZettleAgent/releases) (`.exe` for Windows, `.dmg` for macOS).
2. Install and open the app — **zero extra downloads required**.
3. Select your local Markdown folder as your vault.
4. (Optional) Configure your LLM API in Settings (DeepSeek / OpenAI / Claude / Gemini / Ollama and more).

---

## 🛠 Build from Source (Developers)

```bash
# 1. Clone repository
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent

# 2. Install dependencies
npm install

# 3. Start development server (Tauri 2.0 + Vite + React 19)
npm run tauri dev
```

> **Note:** `src-tauri/gen/` is auto-generated by Tauri. The first `npm run tauri dev` run creates the schema files referenced by `capabilities/default.json`.

To produce a production Release installer:

```bash
npm run tauri build  # Bundles offline models and builds release binary
```

---

## 💻 System Requirements

| Platform | Installer Size | Recommended RAM |
| :--- | :--- | :--- |
| **Windows 10/11 x64** (Fully Supported) | ~300MB (Bundled models) | 8GB+ (Local embedding & graph rendering) |
| **macOS (Apple Silicon & Intel)** (Supported) | ~280MB | 8GB+ |
| **Linux (AppImage / deb)** (Experimental) | ~280MB | 8GB+ |

---

## 🤝 Contributing

We welcome contributions from the community! Whether you're fixing bugs, improving documentation, or optimizing Agent tool schemas, your help is appreciated.

Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting a pull request.

---

## 🙏 Acknowledgments

Built on the shoulders of: [Zettelkasten](https://luhmann.surge.sh/communicating-with-slip-boxes) · [Obsidian](https://obsidian.md/) · [sqlite-vec](https://github.com/asg017/sqlite-vec) · [Tauri](https://tauri.app/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [DeepSeek](https://www.deepseek.com/)

---

## 📜 License

Apache License 2.0 — Free to use and modify. **Credit the original author in commercial products.** See [LICENSE](LICENSE).
