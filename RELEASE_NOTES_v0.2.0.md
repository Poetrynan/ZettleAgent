# 🇨🇭 ZettelAgent v0.2.0 Release Notes

<div align="center">

**Local-First, Autonomous Agent-Native Knowledge Operating System**

[![English](https://img.shields.io/badge/Language-English-blue.svg)](#-english)
[![简体中文](https://img.shields.io/badge/语言-简体中文-red.svg)](#-简体中文)
[![日本語](https://img.shields.io/badge/言語-日本語-green.svg)](#-日本語)
[![한국어](https://img.shields.io/badge/언어-한국어-orange.svg)](#-한국어)

<br/>

[English](#-english) | [简体中文](#-简体中文) | [日本語](#-日本語) | [한국어](#-한국어)

</div>

---

## 📥 Downloads / 下载 / ダウンロード / 다운로드

<div align="center">

| Platform / 平台 / プラットフォーム / 플랫폼 | Architecture / 架构 | Package Format / 安装包格式 | Direct Link / 下载链接 |
| :--- | :--- | :--- | :--- |
| **🪟 Windows** | `x64` (64-bit) | `.msi` (Windows Installer) | [⬇️ **Download .msi**](https://github.com/Poetrynan/ZettleAgent/releases/download/v0.2.0/ZettelAgent_0.2.0_x64_en-US.msi) |
| **🪟 Windows** | `x64` (64-bit) | `.exe` (Setup Executable) | [⬇️ **Download .exe**](https://github.com/Poetrynan/ZettleAgent/releases/download/v0.2.0/ZettelAgent_0.2.0_x64-setup.exe) |
| **🍎 macOS** | `Apple Silicon` (M1/M2/M3/M4) | `.dmg` (Disk Image) | [⬇️ **Download .dmg (ARM64)**](https://github.com/Poetrynan/ZettleAgent/releases/download/v0.2.0/ZettelAgent_0.2.0_aarch64.dmg) |
| **🍎 macOS** | `Intel` (x64) | `.dmg` (Disk Image) | [⬇️ **Download .dmg (x64)**](https://github.com/Poetrynan/ZettleAgent/releases/download/v0.2.0/ZettelAgent_0.2.0_x64.dmg) |
| **🐧 Linux** | `x64` (amd64) | `.AppImage` (Universal Linux) | [⬇️ **Download .AppImage**](https://github.com/Poetrynan/ZettleAgent/releases/download/v0.2.0/ZettelAgent_0.2.0_amd64.AppImage) |
| **🐧 Linux** | `x64` (amd64) | `.deb` (Debian / Ubuntu) | [⬇️ **Download .deb**](https://github.com/Poetrynan/ZettleAgent/releases/download/v0.2.0/zettelagent_0.2.0_amd64.deb) |
| **📦 Source Code** | Universal | `.zip` / `.tar.gz` | [⬇️ **Source Archive**](https://github.com/Poetrynan/ZettleAgent/archive/refs/tags/v0.2.0.zip) |

</div>

> 💡 **Quick Release Hub**: You can also browse all raw build assets directly on the [GitHub Releases v0.2.0 Page](https://github.com/Poetrynan/ZettleAgent/releases/tag/v0.2.0).

---

## 🌐 English

> **ZettelAgent v0.2.0** represents a major evolutionary leap from **v0.1.2**, transforming from an AI-assisted Markdown editor into a fully autonomous, local-first, **Agent-Native Knowledge Operating System**.

### 🌟 What's New Since v0.1.2

#### 1. 🤖 Agent-Native Action Protocol & Cross-Surface Hydration
- **Unified `AgentAction` Protocol**: Tool execution results now emit structured interactive action buttons (`open_canvas`, `open_knowledge_center`, `open_note`) directly in the chat stream.
- **Deep-Link State Machine & Plan Hydration**: Seamlessly transition from conversational planning in Chat to spatial execution in Canvas or graph governance in Knowledge Center with zero mounting race conditions.
- **Trusted ChangeSet & Write-Guard Pipeline**: Every destructive write, relation mutation, and canvas change is gated through cryptographic ChangeSet IDs with honest diff previews, selective batch approvals, and 100% symmetric one-click rollbacks.

#### 2. 🏛️ Dedicated Knowledge Center (7 Core Workspaces)
- Extracted long-lived cognitive artifacts out of ephemeral chat sessions into a standalone workspace:
  - **Inbox**: Central triage for pending memory proposals, file modifications, and action items.
  - **Memory**: Structured associative memory, Core Memory facts, and two-way `memory.md` synchronization.
  - **Changes**: High-fidelity line diffs with single-turn transactional rollback.
  - **Tasks**: Commitment tracking extracted from notes with evidence-based resolution.
  - **Health**: Real-time vector index coverage, orphan detection, and broken-link repair.
  - **Graph Gaps**: Autonomous knowledge gap detection, structural link proposals, and confidence-filtered Auto-Fix.
  - **Activity**: Comprehensive audit logs written in plain human language.

#### 3. 🎨 Spatial Reasoning Canvas & Multi-Modal Planning
- **AI Spatial Layout**: Auto-organize cards into logical topological clusters, concept maps, and causal chains.
- **Bidirectional Compilation**: Synchronize visual canvas mindmaps with underlying markdown wikilinks and SQLite relations.
- **Reasoning Canvas Plans**: Generate, inspect, and approve multi-step canvas restructuring workflows before applying changes.

#### 4. 🧠 Local-First AI & Hybrid Retrieval Engine
- **Bundled Offline BCE Reranker**: Integrated NetEase Youdao BCE Reranker (`bce-reranker-base_v1`) via ONNX WebAssembly with dynamic fallback to lexical ranking.
- **GraphRAG & PageRank Synergy**: Combines dense vector search (`sqlite-vec`), lexical search (FTS5), and graph centrality signals in Bases.
- **Spaced Repetition (FSRS)**: Free Spaced Repetition Scheduler module for long-term active recall.

#### 5. 🇨🇭 Swiss International Typographic Design System & Taskbar Clarity
- **Pure Swiss White Paper Aesthetic**: Clean typography, ivory paper tones (`#F9F6EE`), onyx text (`#0F141A`), and vermillion red accents (`#E82521`).
- **Cursor-Grade Composer Switcher**: Micro-pill mode selector with smooth popovers, leftmost web search toggle, and uncluttered bottom bar.
- **Multi-Tier Pixel-Fitted Icon Matrix**: 100% full-bleed, razor-sharp Swiss Graph 'Z' branding with dedicated 16~48px high-contrast micro-frames to ensure crystalline taskbar sharpness on Windows, macOS, and Linux.

---

## 🇨🇳 简体中文

> **ZettelAgent v0.2.0** 是自 **v0.1.2** 以来最重要的里程碑升级。本项目已正式从传统的“AI 辅助 Markdown 笔记软件”跃迁为**全自洽、本地优先的 Agent-Native 知识操作系统**。

### 🌟 核心升级亮点（对比 v0.1.2）

#### 1. 🤖 Agent 动作协议与跨 Surface 深度水合
- **统一 `AgentAction` 动作协议**：工具执行结果不再只是静态文本，而是直接在对话流中输出可点击、强类型的动作卡片（`打开白板计划`、`审查图谱盲区`、`查看笔记`）。
- **深层链接状态机（Deep-Link State Machine）**：基于强同步 Ref 实现 Chat 跨页面直达 Canvas 与知识中心，彻底消除 React 并发调度导致的组件挂载竞态与 PlanId 丢失。
- **信任写守卫与 ChangeSet 治理**：所有破坏性修改（笔记写入、图谱删改、白板连线）均强制注入全局 ChangeSet ID，具备行级高精 Diff 审查与 100% 对称保真回滚。

#### 2. 🏛️ 独立知识中心（7 大第一类工作台）
- 将原本堆叠在对话侧栏中的长期认知状态全部解耦至独立工作台：
  - **收件箱 (Inbox)**：待确认事实与跨模块建议的统一分流中心；
  - **长期记忆 (Memory)**：联想记忆、核心事实与 `memory.md` 双向自动回流；
  - **变更审查 (Changes)**：高精行级 Diff 审查与基于 Journal 的单轮事务撤销；
  - **任务承诺 (Tasks)**：基于笔记事实提炼的承诺跟踪与实证闭环；
  - **健康诊断 (Health)**：向量索引覆盖率、孤岛笔记与坏链自动修复；
  - **图谱盲区 (Graph Gaps)**：全库拓扑漏洞探测、置信度阈值过滤与一键 Auto-Fix；
  - **操作审计 (Activity)**：采用大白话记录的全局 Agent 决策流水。

#### 3. 🎨 推理白板（Reasoning Canvas）与多模态空间规划
- **AI 拓扑自动布局**：将散落的笔记卡片智能归纳为概念簇、因果链与空间分类板；
- **白板与图谱双向编译**：白板中的连线与卡片实时双向同步至 Markdown Wikilink 与底层 SQLite 关系图谱；
- **交互式重构计划**：在画布应用改动前，先生成可审查、可单步勾选执行的 Canvas Plan。

#### 4. 🧠 纯本地 AI 与混合检索内核
- **内置离线网易有道 BCE Reranker**：基于 ONNX WebAssembly 运行 `bce-reranker-base_v1` 跨编码器，支持 Cross-Encoder → Lexical → Raw 三级动态降级；
- **GraphRAG 与 PageRank 协同**：融合 SQLite-Vec 稠密向量、FTS5 全文检索与图中心度权重；
- **间隔重复复习（FSRS）**：自由间隔重复算法驱动的长期主动回忆卡片系统。

#### 5. 🇨🇭 瑞士现代国际设计系统与任务栏抗糊点阵
- **瑞士温润白纸质感**：极简排版、象牙白纸色（`#F9F6EE`）、黑曜石（`#0F141A`）与朱砂红（`#E82521`）视觉基准；
- **Cursor 级极简输入框（Composer）**：最左侧联网开关、二级 RAG 检索策略微型下拉菜单、纯净无噪底栏；
- **分阶像素贴合图标矩阵**：100% Full-Bleed 瑞士网格 Z 图标，专供 16~48px 小尺寸高对比微观帧，彻底解决 Windows 任务栏发虚、发灰问题。

---

## 🇯🇵 日本語

> **ZettelAgent v0.2.0** は、**v0.1.2** からの最大規模のメジャーアップデートです。AIアシスト付きMarkdownエディタから、ローカルファーストで自律動作する **Agent-Native ナレッジオペレーティングシステム** へと進化を遂げました。

### 🌟 主な新機能と改善点

#### 1. 🤖 Agent アクションプロトコルとクロスサーフェス水和
- **統合 `AgentAction` プロトコル**: ツール実行結果から、チャットストリーム内に構造化されたインタラクティブアクションボタン（`Canvasプランを開く`、`知識ギャップを審査`、`ノートを開く`）を直接生成。
- **ディープリンク状態マシン**: ChatからCanvasや知識センターへの遷移時に、Reactのコンポーネントマウント競合によるPlanIdの喪失を完全に解消。
- **ChangeSet による書き込みガードとロールバック**: ノート編集・グラフリレーション変更・キャンバス接続のすべてに変更セットIDを付与し、完全に対称的なワンクリック復元を実現。

#### 2. 🏛️ 専用ナレッジセンター (7つの独立ワークスペース)
- チャットサイドバーから永続的な認知アーティファクトを切り離し、専用ワークスペースを構築:
  - **インボックス (Inbox)**: 提案された事実や未処理タスクのトリアージセンター;
  - **長期記憶 (Memory)**: 連想記憶、コアメモリ、および `memory.md` との双方向同期;
  - **変更履歴 (Changes)**: 行レベルの高精度Diffプレビューと単一ターントランザクションロールバック;
  - **タスク管理 (Tasks)**: ノートから抽出されたコミットメント追跡;
  - **ヘルスチェック (Health)**: ベクトルインデックスカバレッジ、孤立ノート、破損リンクの修復;
  - **グラフギャップ分析 (Graph Gaps)**: ナレッジの盲点検知、構造的リンク提案、信頼度フィルタ付きAuto-Fix;
  - **アクティビティログ (Activity)**: 自然言語で記録されるAgent監査ログ。

#### 3. 🎨 空間推論キャンバス (Reasoning Canvas)
- **AI 空間自動レイアウト**: カード群をトポロジカルなクラスタや因果関係マップに自動整理。
- **双方向コンパイル**: キャンバス上の接続とMarkdown Wikilink / SQLiteグラフのリアルタイム双方向同期。

#### 4. 🧠 ローカルファースト AI & ハイブリッド検索エンジン
- **オフライン BCE リランカー搭載**: ONNX WebAssembly による NetEase Youdao BCE Reranker 統合と3段階のフォールバック。
- **GraphRAG & FSRS**: ベクトル検索 + 全文検索 + グラフ中心性シグナルの統合、および間隔反復学習モジュール。

#### 5. 🇨🇭 スイス・タイポグラフィデザイン & タスクバー鮮明化
- **スイス・ホワイトペーパーデザイン**: 洗練されたタイポグラフィと象牙色ペーパー基調（`#F9F6EE`）。
- **ピクセルフィット多階層アイコン**: Windowsタスクバー（16〜48px）専用の高コントラストフレームを備えたマルチDPI点陣。

---

## 🇰🇷 한국어

> **ZettelAgent v0.2.0**은 **v0.1.2** 이후 가장 중대한 진화적 도약으로, 단순한 AI 보조 마크다운 에디터에서 완전 자율형 로컬 퍼스트 **Agent-Native 지식 운영 체제(Knowledge OS)**로 탈바꿈했습니다.

### 🌟 주요 업데이트 요약

#### 1. 🤖 Agent 액션 프로토콜 및 크로스 서피스 수화(Hydration)
- **통합 `AgentAction` 프로토콜**: 도구 실행 결과가 채팅 스트림 내에 구조화된 대화형 액션 버튼(`캔버스 플랜 열기`, `지식 갭 검토`, `노트 열기`)으로 직접 렌더링됩니다.
- **딥링크 상태 머신**: Chat에서 Canvas 또는 지식 센터로 이동할 때 컴포넌트 마운트 레이스 컨디션으로 인한 PlanId 유실 문제를 완벽히 해결했습니다.
- **ChangeSet 쓰기 가드 및 대칭 롤백**: 모든 파괴적 수정 작업에 고유 ChangeSet ID를 주입하여 100% 대칭형 원클릭 롤백을 지원합니다.

#### 2. 🏛️ 독립 지식 센터 (7개 핵심 워크스페이스)
- 임시 채팅 세션에서 장기 인지 상태를 분리하여 독립적인 지식 관리 작업 공간을 구축했습니다:
  - **수신함 (Inbox)**: 제안된 기억 및 변경 사항의 중앙 분류 센터;
  - **장기 기억 (Memory)**: 구조화된 연상 기억 및 `memory.md` 양방향 자동 동기화;
  - **변경 검토 (Changes)**: 정밀 라인 Diff 미리보기 및 트랜잭션 롤백;
  - **작업 관리 (Tasks)**: 노트 기반 실행 약속 추적;
  - **건강 진단 (Health)**: 벡터 인덱스 커버리지, 고립 노트 및 끊어진 링크 복구;
  - **지식 갭 분석 (Graph Gaps)**: 지식 공백 자동 탐지 및 신뢰도 기반 Auto-Fix;
  - **활동 기록 (Activity)**: 자연어로 작성된 투명한 Agent 감사 로그.

#### 3. 🎨 공간 추론 캔버스 (Reasoning Canvas)
- **AI 공간 자동 레이아웃**: 노트를 논리적 클러스터와 개념 맵으로 자동 정렬;
- **양방향 컴파일**: 시각적 캔버스와 마크다운 위키링크 / SQLite 그래프 간의 실시간 양방향 동기화.

#### 4. 🧠 로컬 퍼스트 AI 및 하이브리드 검색
- **오프라인 BCE 리랭커 탑재**: ONNX WASM 기반 NetEase Youdao BCE Reranker 내장 및 동적 폴백;
- **GraphRAG 및 FSRS**: 벡터 + FTS5 + 그래프 결합 검색 및 FSRS 간격 반복 학습 지원.

#### 5. 🇨🇭 스위스 모던 디자인 & 작업 표시줄 선명도 최적화
- **스위스 화이트 페이퍼 디자인**: 세련된 서체와 미색 페이퍼 톤(`#F9F6EE`);
- **픽셀 피팅 멀티 DPI 아이콘**: 16~48px 전용 고대비 마이크로 프레임 적용으로 Windows 작업 표시줄 흐림 현상 완벽 해결.

---

<div align="center">

**ZettelAgent Team** · Crafted with precision for thinkers and researchers.

</div>
