<div align="center">

# 🚀 ZettelAgent v0.1.1

### AI-Powered Zettelkasten Desktop Agent

**下载 → 安装 → 直接使用。** 无需 Node.js、Docker、额外模型下载。

![version](https://img.shields.io/badge/version-v0.1.1-0EA5E9?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8B5CF6?style=flat-square)
![size](https://img.shields.io/badge/installer-~300MB-10B981?style=flat-square)
![offline](https://img.shields.io/badge/runtime-zero%20download-F59E0B?style=flat-square)

</div>

---

## 🌐 选择语言 / Select Language / 言語を選択 / 언어 선택

[**🇨🇳 中文**](#-中文) · [**🇬🇧 English**](#-english) · [**🇯🇵 日本語**](#-日本語) · [**🇰🇷 한국어**](#-한국어)

---

## 🇨🇳 中文

### 🌟 亮点与重磅更新

#### 1. 🎨 3D 知识图谱自研 Three.js 引擎大升级
- **原生 Three.js 渲染管线**：彻底解耦第三方 `react-force-graph-3d` 黑盒，实现基于原生 WebGL 的掌控与显存安全回收（`.dispose()` 级联销毁）。
- **360° 全向飞行视角**：引入 `TrackballControls` 轨迹球控制器，解除视角极角限制，搭配动态惯性缓动，提供如同置身星系深空探索般的飞行交互体验。
- **2D/3D 切视角冷启动修复**：将切视角初始空间坐标平滑限制在相机剪裁锥体核心区（`[-100, 100]`），彻底解决“切 3D 视角黑屏”问题。
- **Fly-to 漫游与 3D Arrow 连线**：支持 3.2s 插值平滑聚焦动画，并引入 3D 锥体箭头姿态对齐（Quaternion 换算），清晰指明笔记间的双向引用关系。
- **渐进式温启动力学优化**：在物理引擎 Worker (`forceWorker.ts`) 内置历史坐标与速度缓存 Map，降低 reheat alpha 抖动，彻底解决切换与调整节点时的“图谱洗牌与晃动”问题。

#### 2. 🗂️ 侧边栏交互重构（Obsidian / VSCode 风格）
- **无模态 Inline 行内新建**：新建文件/文件夹不再弹出模态框，支持在文件树节点直接出现 inline 输入框，回车确认、ESC 取消，创建后自动打开。
- **悬停快捷按钮**：目录节点在悬停时显示 VSCode 风格的“新建文件”和“新建文件夹”快捷按钮。
- **智能活动 Vault 识别**：重构 `getActiveVaultPath()`，能够根据当前打开的文件智能推断其所属 Vault，无选中时自动在桌面创建新 Vault；同时移除了强制“主文件夹”概念，多 Vault 更加平权灵活。

#### 3. 🤖 白板 ↔ Chat 双向 AI 链路全闭环
- **白板数据流接通**：修复“讨论选中节点”时仅传递空壳 prompt 的缺陷，全面通过 `zettel:canvas-selection` 传递完整的节点上下文与元数据。
- **Agent 工具与 Prompt 指导**：策略层增加 `read_canvas` 等只读画布工具访问权限，System Prompt 中增加 Canvas Discussion 指导规则。

#### 4. 📅 Daily Note 日记系统独立化与轻量体验
- **解耦 Vault 限制**：即使没有打开任何 demo-vault，也能在桌面自动初始化 Daily Note 目录。
- **文件树空状态优化**：空目录区域直接提供“创建今日日记”快捷入口。
- **二次确认保护**：在清空目录、删除日记文件夹、移除工作区等危险操作上补充了 Modal 确认提示。

---

### 🐛 Bug 修复与细节优化

- **3D 图谱手势与指针泄漏修复**：在 capture 阶段精确拦截 `pointerdown`/`pointerup`，解决拖拽释放视角抽动、误放大问题及动态光标状态机分发（`default` / `pointer` / `grabbing`）。
- **知识图谱“空气墙”截断修复**：修正 CSS 视图堆叠（`position: absolute; inset: 0`），增加 PixiJS 对聊天面板展开/收起的延迟 resize 重新测量。
- **HUD 暗黑模式反色 Bug 修复**：图例圆点与关系 Chip 标签样式重构为 `span`，避开全局 Dark Mode CSS 暴力反色污染；修复时间旅行进度轴拖拽到最右端时的闪跳与复位问题。

---

### 📥 下载与快速开始

| 平台 | 推荐文件 |
|------|:----:|
| **Windows** | `.msi` 或 `-setup.exe` |
| **macOS (Apple Silicon)** | `.dmg` |
| **macOS (Intel)** | `.dmg` |
| **Linux** | `.AppImage` 或 `.deb` |

1. 从下方 **Assets** 下载对应平台的安装包。
2. 安装并启动应用 — **离线资源全部内置，无需二次下载**。
3. 进入 **设置 → AI** 配置你的 LLM 秘钥（支持 Ollama 本地 / DeepSeek / OpenAI / Claude / Gemini 等）。

---

## 🇬🇧 English

### 🌟 Major Highlights

#### 1. 🎨 3D Knowledge Graph: Native Three.js Engine Upgrade
- **Custom WebGL Pipeline**: Completely decoupled third-party `react-force-graph-3d`, establishing full control via native Three.js + WebGL and safe cascading GPU memory disposal (`.dispose()`).
- **360° Free Flight Controls**: Integrated `TrackballControls` to eliminate polar angle limits with dynamic inertia easing, delivering a galactic exploration feel.
- **Cold-Start Viewport Fix**: Initial 2D-to-3D coordinates are bounded within `[-100, 100]`, resolving the black-screen issue during view transitions.
- **Smooth Fly-to & 3D Directional Arrows**: Added 3.2s smooth camera focus interpolations and Quaternion-aligned 3D cone arrows to clearly illustrate bidirectional link directions.
- **Warm-Start Force Physics Optimization**: Built position/velocity cache Maps into the force engine Worker (`forceWorker.ts`), preventing graph reshuffling and violent jitter.

#### 2. 🗂️ File Explorer UI Overhaul (Obsidian / VSCode Style)
- **Modal-less Inline Creation**: No modal dialogs for creating files/folders; type directly in inline input fields in the file tree (Enter to confirm, ESC to cancel).
- **Hover Quick Action Buttons**: Folder rows display VSCode-style hover buttons for "New File" and "New Folder".
- **Smart Active Vault Resolution**: Refactored `getActiveVaultPath()` to infer the active Vault from selected files, with automatic desktop fallback. Removed mandatory "Primary Vault" restrictions for multi-vault parity.

#### 3. 🤖 Canvas ↔ Chat AI Sync
- **Full Context Handshake**: Resolved payload truncation on canvas selection discussions via `zettel:canvas-selection`.
- **Agent Strategy & Prompt Enhancements**: Granted Agent strategies access to `read_canvas` tools and introduced dedicated Canvas Discussion guidelines in system prompts.

#### 4. 📅 Standalone Daily Note System
- **Decoupled Vault Requirement**: Automatically initializes Daily Note directories on Desktop without requiring a pre-loaded Vault.
- **Empty State UX & Safety Modals**: Added "Create Today's Note" action for empty file trees and added double-confirmation modals for destructive file actions.

---

### 🐛 Bug Fixes & Improvements

- **3D Graph Pointer Leak Fix**: Intercepted `pointerdown`/`pointerup` during capture phase to prevent post-drag viewport jumps and accidental zoom; implemented dynamic cursor states (`default` / `pointer` / `grabbing`).
- **Graph Clipping Fix**: Corrected CSS absolute stacking (`position: absolute; inset: 0`) and added delayed PixiJS resize re-measurements during Chat panel toggles.
- **HUD Dark Mode Inversion Fix**: Replaced div legend elements with `span` tags to prevent unintended dark mode CSS color inversion. Resolved timeline scrubber jump glitches.

---

### 📥 Download & Quick Start

| Platform | Recommended Asset |
|----------|:-----------------:|
| **Windows** | `.msi` or `-setup.exe` |
| **macOS (Apple Silicon)** | `.dmg` |
| **macOS (Intel)** | `.dmg` |
| **Linux** | `.AppImage` or `.deb` |

1. Download the installer from **Assets** below.
2. Launch ZettelAgent — **Fully offline ready, zero downloads required**.
3. Configure your LLM providers in **Settings → AI** (Ollama, DeepSeek, OpenAI, Claude, Gemini, etc.).

---

## 🇯🇵 日本語

### 🌟 主な新機能とハイライト

#### 1. 🎨 3Dナレッジグラフ：自社開発Three.jsエンジンの大刷新
- **ネイティブ Three.js レンダリングパイプライン**：サードパーティ製 `react-force-graph-3d` を完全排除し、原生 WebGL ベースのコントロールと安全な VRAM メモリ解放（`.dispose()`）を実現。
- **360° 全方向フライト視点**：`TrackballControls` トラックボールコントローラーを導入。極角制限を撤廃し、動的慣性アニメーションにより宇宙を探索するような快適な操作感を提供。
- **2D/3D 視点切替時のブラックアウト修復**：切替初期座標をカメラ視錐体のコア領域（`[-100, 100]`）に制限し、「3D視点切替時に画面が暗転する」バグを完全解消。
- **Fly-to スムーズフォーカス & 3D矢印**：3.2秒の滑らかなカメラ移動と、クォータニオン姿勢変換による 3D コーン矢印で、ノート間の双方向リンク関係を視覚化。
- **ウォームスタート物理挙動最適化**：物理エンジン Worker (`forceWorker.ts`) に位置・速度キャッシュ Map を内蔵。ノード調整時の「グラフのシャッフルや激しい揺れ」を解消。

#### 2. 🗂️ サイドバー UI の刷新（Obsidian / VSCode スタイル）
- **モーダルレス・インライン作成**：ファイル/フォルダ作成時にモーダルを出さず、ツリー内でインライン入力（Enterで確定、ESCでキャンセル）。
- **ホバー・クイックボタン**：フォルダにマウスを合わせると、VSCode スタイルの「新規ファイル」「新規フォルダ」ボタンを表示。
- **スマート Active Vault 認識**：選択中ファイルから所属 Vault を自動推定する `getActiveVaultPath()` を実装。非選択時は自動でデスクトップに Vault を生成。「主フォルダ」固定概念を排除。

#### 3. 🤖 ホワイトボード ↔ Chat 双方向 AI 連携の完全閉環
- **キャンバス選択データ連携修復**：選択ノードのデータ脱落バグを修復し、`zettel:canvas-selection` で完全なコンテキストを送信。
- **Agent ツール & プロンプト強化**：Agent 戦略に `read_canvas` などの読み取りツール権限を追加、System Prompt にキャンバス討論用ガイドラインを追加。

#### 4. 📅 Daily Note 日記システムの独立化
- **Vault 依存の解除**：Demo Vault を開いていなくても、デスクトップ上に自動で Daily Note ディレクトリを初期化。
- **空状態 UI & 確認モーダル**：空ツリー領域の「今日のノート作成」ボタンを追加。フォルダ消去・削除時の二重確認モーダル保護を実装。

---

### 🐛 バグ修正と詳細改善

- **3D グラフのポインターリーク修復**：キャプチャ段階で `pointerdown`/`pointerup` を補足し、ドラッグ解除後の視点ブレや誤拡大を防止。カーソル状態（`default` / `pointer` / `grabbing`）の動的分配を実装。
- **ナレッジグラフの画面切れ修復**：CSS 配置を修正（`position: absolute; inset: 0`）し、Chat パネル開閉時の PixiJS リサイズ再計測を実装。
- **HUD ダークモード色反転修復**：凡例要素を `span` に変更し、グローバル暗色モード CSS の意図しない反色汚染を回避。タイムラインスライダーの右端復帰バグを修正。

---

### 📥 ダウンロードとクイックスタート

| プラットフォーム | 推奨ファイル |
|------------------|:------------:|
| **Windows** | `.msi` または `-setup.exe` |
| **macOS (Apple Silicon)** | `.dmg` |
| **macOS (Intel)** | `.dmg` |
| **Linux** | `.AppImage` または `.deb` |

1. 下の **Assets** からお使いの OS に適したインストーラーをダウンロード。
2. アプリを起動 — **オフラインリソース完全内蔵、追加ダウンロード不要**。
3. **設定 → AI** で LLM API キーを構成（Ollama ローカル / DeepSeek / OpenAI / Claude / Gemini など対応）。

---

## 🇰🇷 한국어

### 🌟 주요 변경 사항 및 하이라이트

#### 1. 🎨 3D 지식 그래프: 자체 개발 Three.js 렌더링 엔진 대폭 업그레이드
- **네이티브 Three.js 렌더링 파이프라인**: 서드파티 `react-force-graph-3d` 라이브러리를 완전히 제거하고, 순수 WebGL/Three.js 기반으로 비동기 안전 메모리 해제(`.dispose()`)를 구현했습니다.
- **360° 전방위 비행 시점**: `TrackballControls` 트랙볼 컨트롤러를 도입하여 극각 제한을 제거하고 우주 공간을 탐험하는 듯한 매끄러운 관성 비행을 제공합니다.
- **2D/3D 시점 전환 블랙스크린 해결**: 전환 초기 공간 좌표를 카메라 가시 영역(`[-100, 100]`)으로 제한하여 시점 전환 시 화면이 검게 변하는 현상을 완치했습니다.
- **Fly-to 부드러운 애니메이션 & 3D 화살표**: 3.2초 부드러운 포커스 애니메이션과 쿼터니언(Quaternion) 3D 콘 화살표로 노트 간 양방향 참조 관계를 직관적으로 표시합니다.
- **웜스타트 물리 엔진 최적화**: 물리 엔진 Worker(`forceWorker.ts`) 내 위치 및 속도 캐시 Map을 도입하여 노드 이동 시 그래프가 셔플되거나 심하게 흔들리는 현상을 방지했습니다.

#### 2. 🗂️ 사이드바 UI 재구성 (Obsidian / VSCode 스타일)
- **모달 없는 인라인 생성**: 파일/폴더 생성 시 팝업 모달 대신 파일 트리 내에서 직접 인라인 입력 창을 제공합니다 (Enter 확정, ESC 취소).
- **호버 퀵 액션 버튼**: 폴더 노드에 마우스를 올리면 VSCode 스타일의 '새 파일', '새 폴더' 버튼이 표시됩니다.
- **스마트 Active Vault 인식**: 선택된 파일에서 Vault 경로를 자동으로 추론하는 `getActiveVaultPath()`를 구현하고, 강제 메인 폴더 제약을 제거하여 다중 Vault 평권 관리를 지원합니다.

#### 3. 🤖 화이트보드 ↔ Chat 양방향 AI 연동 연동 완성
- **화이트보드 컨텍스트 전달 보장**: 노드 선택 논의 시 데이터가 유실되던 문제를 수정하고 `zettel:canvas-selection`을 통해 완전한 노드 데이터를 전달합니다.
- **Agent 도구 및 프롬프트 강화**: Agent 전략에 `read_canvas` 도구 접근 권한을 추가하고 시스템 프롬프트에 Canvas Discussion 전용 규칙을 반영했습니다.

#### 4. 📅 Standalone Daily Note 일기 시스템
- **Vault 의존성 제거**: 데모 Vault가 없이도 바탕화면에 Daily Note 폴더를 자동으로 생성합니다.
- **빈 상태 UX 및 안전 모달**: 빈 파일 트리 영역에 '오늘 일기 작성' 버튼을 제공하며, 삭제/초기화 시 2차 확인 모달 보호 메커니즘을 적용했습니다.

---

### 🐛 버그 수정 및 개선 사항

- **3D 그래프 포인터 상태 수정**: 캡처 단계에서 `pointerdown`/`pointerup`을 가로채 드래그 해제 후의 시점 튀림 및 오작동을 해결하고 동적 커서 상태(`default` / `pointer` / `grabbing`)를 정확히 분파합니다.
- **지식 그래프 화면 잘림 버그 수정**: CSS 레이아웃 수정을 통한 `position: absolute; inset: 0` 적용 및 Chat 드로어 열림/닫힘 시 PixiJS 리사이즈 재측정을 구현했습니다.
- **HUD 다크 모드 반전 버그 수정**: 범례 요소를 `span`으로 변경하여 전역 CSS 다크 모드 강제 반전을 방지했습니다. 타임라인 슬라이더 오른쪽 끝 위치 튀김 버그를 수정했습니다.

---

### 📥 다운로드 및 빠른 시작

| 플랫폼 | 추천 파일 |
|--------|:---------:|
| **Windows** | `.msi` 또는 `-setup.exe` |
| **macOS (Apple Silicon)** | `.dmg` |
| **macOS (Intel)** | `.dmg` |
| **Linux** | `.AppImage` 또는 `.deb` |

1. 하단 **Assets**에서 해당 OS용 설치 파일을 다운로드합니다.
2. 앱을 실행합니다 — **임베딩 모델 및 WASM이 완벽 내장되어 있어 추가 다운로드가 필요 없습니다**.
3. **설정 → AI**에서 LLM API 키를 설정합니다 (Ollama 로컬 / DeepSeek / OpenAI / Claude / Gemini 등 지원).

---

<div align="center">

**Made with** ❤️ **using** Tauri 2.0 · React 19 · Rust

</div>
