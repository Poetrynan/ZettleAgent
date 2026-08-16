<div align="center">

# 🚀 ZettelAgent v0.1.2

### AI-Powered Zettelkasten Desktop Agent

**下载 → 安装 → 直接使用。** 无需 Node.js、Docker、额外模型下载。

![version](https://img.shields.io/badge/version-v0.1.2-0EA5E9?style=flat-square)
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

#### 1. 🧠 AI Agent 核心能力全面升级
- **Mem0 风格长期记忆**：全新自研双层记忆架构（Core Memory 每轮全量注入 + Archival 无界归档按相关性召回），支持 `search_memory` 工具主动检索、TTL 自动过期、CJK 分词打分（`overlap × weight × time_decay`），让 Agent 真正"记得住"跨会话的事实。
- **Token 精细计量**：四路 Token 会计（input / output / cache_read / cache_write），trace 头部实时展示用量与耗时。
- **工具钩子风控**：工具调用预算熔断、参数幂等拦截防重复、瞬态错误重试宽限（Retry Grace），Agent 执行更稳更省。
- **响应提速**：移除全链路冗余动画延迟（每轮回收约 850ms），合成重试 2→1，MCP 工具集与 Skill 目录扫描加缓存，Agent / RAG 双模式明显更快。
- **进度诚实化**：RAG 进度条只展示真实等待阶段（Searching → Generating），去除亚毫秒内存操作的"瞬间打勾"假步骤。

#### 2. 🎨 3D 知识图谱自研 Three.js 引擎大升级
- **原生 Three.js 渲染管线**：彻底解耦第三方 `react-force-graph-3d` 黑盒，实现基于原生 WebGL 的掌控与显存安全回收（`.dispose()` 级联销毁）。
- **360° 全向飞行视角**：引入 `TrackballControls` 轨迹球控制器，解除视角极角限制，搭配动态惯性缓动，提供如同置身星系深空探索般的飞行交互体验。
- **2D/3D 切视角冷启动修复**：将切视角初始空间坐标平滑限制在相机剪裁锥体核心区（`[-100, 100]`），彻底解决“切 3D 视角黑屏”问题。
- **Fly-to 漫游与 3D Arrow 连线**：支持 3.2s 插值平滑聚焦动画，并引入 3D 锥体箭头姿态对齐（Quaternion 换算），清晰指明笔记间的双向引用关系。
- **渐进式温启动力学优化**：在物理引擎 Worker (`forceWorker.ts`) 内置历史坐标与速度缓存 Map，降低 reheat alpha 抖动，彻底解决切换与调整节点时的“图谱洗牌与晃动”问题。

#### 3. 🗂️ 侧边栏交互重构（Obsidian / VSCode 风格）
- **无模态 Inline 行内新建**：新建文件/文件夹不再弹出模态框，支持在文件树节点直接出现 inline 输入框，回车确认、ESC 取消，创建后自动打开。
- **悬停快捷按钮**：目录节点在悬停时显示 VSCode 风格的“新建文件”和“新建文件夹”快捷按钮。
- **智能活动 Vault 识别**：重构 `getActiveVaultPath()`，能够根据当前打开的文件智能推断其所属 Vault，无选中时自动在桌面创建新 Vault；同时移除了强制“主文件夹”概念，多 Vault 更加平权灵活。

#### 4. 🤖 白板 ↔ Chat 双向 AI 链路全闭环
- **白板数据流接通**：修复“讨论选中节点”时仅传递空壳 prompt 的缺陷，全面通过 `zettel:canvas-selection` 传递完整的节点上下文与元数据。
- **Agent 工具与 Prompt 指导**：策略层增加 `read_canvas` 等只读画布工具访问权限，System Prompt 中增加 Canvas Discussion 指导规则。

#### 5. 📅 Daily Note 日记系统独立化与轻量体验
- **解耦 Vault 限制**：即使没有打开任何 demo-vault，也能在桌面自动初始化 Daily Note 目录。
- **文件树空状态优化**：空目录区域直接提供“创建今日日记”快捷入口。
- **二次确认保护**：在清空目录、删除日记文件夹、移除工作区等危险操作上补充了 Modal 确认提示。

---

### 🐛 Bug 修复与细节优化

- **聊天气泡操作按钮外移**：复制 / 重新生成 / 编辑按钮移出气泡、置于气泡下方，hover 时浮现，彻底解决短回复时按钮压住文字的重叠问题（对齐 ChatGPT / Claude 布局）。
- **消息级操作补齐**：AI 消息支持一键复制与重新生成，用户消息支持编辑重发，出错消息支持重试。
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

#### 1. 🧠 AI Agent Core Upgrade
- **Mem0-style Long-term Memory**: New two-layer memory architecture (Core Memory injected every turn + unbounded Archival recalled by relevance), with a `search_memory` tool for active retrieval, automatic TTL expiration, and CJK-aware scoring (`overlap × weight × time_decay`) — the Agent now genuinely remembers cross-session facts.
- **Fine-grained Token Accounting**: Four-way token metering (input / output / cache_read / cache_write) surfaced live in the trace header alongside wall-clock time.
- **Tool Hook Risk Control**: Tool-call budget circuit breaker, idempotent argument interception against duplicates, and Retry Grace for transient tool errors.
- **Faster Responses**: Removed redundant animation delays across the pipeline (~850ms reclaimed per turn), reduced synthesis retries 2→1, and cached MCP tool collection + Skill directory scans — both Agent and RAG modes are noticeably faster.
- **Honest Progress**: The RAG progress bar now shows only real wait stages (Searching → Generating), dropping the instant-checkmark "theater" step for sub-millisecond in-memory work.

#### 2. 🎨 3D Knowledge Graph: Native Three.js Engine Upgrade
- **Custom WebGL Pipeline**: Completely decoupled third-party `react-force-graph-3d`, establishing full control via native Three.js + WebGL and safe cascading GPU memory disposal (`.dispose()`).
- **360° Free Flight Controls**: Integrated `TrackballControls` to eliminate polar angle limits with dynamic inertia easing, delivering a galactic exploration feel.
- **Cold-Start Viewport Fix**: Initial 2D-to-3D coordinates are bounded within `[-100, 100]`, resolving the black-screen issue during view transitions.
- **Smooth Fly-to & 3D Directional Arrows**: Added 3.2s smooth camera focus interpolations and Quaternion-aligned 3D cone arrows to clearly illustrate bidirectional link directions.
- **Warm-Start Force Physics Optimization**: Built position/velocity cache Maps into the force engine Worker (`forceWorker.ts`), preventing graph reshuffling and violent jitter.

#### 3. 🗂️ File Explorer UI Overhaul (Obsidian / VSCode Style)
- **Modal-less Inline Creation**: No modal dialogs for creating files/folders; type directly in inline input fields in the file tree (Enter to confirm, ESC to cancel).
- **Hover Quick Action Buttons**: Folder rows display VSCode-style hover buttons for "New File" and "New Folder".
- **Smart Active Vault Resolution**: Refactored `getActiveVaultPath()` to infer the active Vault from selected files, with automatic desktop fallback. Removed mandatory "Primary Vault" restrictions for multi-vault parity.

#### 4. 🤖 Canvas ↔ Chat AI Sync
- **Full Context Handshake**: Resolved payload truncation on canvas selection discussions via `zettel:canvas-selection`.
- **Agent Strategy & Prompt Enhancements**: Granted Agent strategies access to `read_canvas` tools and introduced dedicated Canvas Discussion guidelines in system prompts.

#### 5. 📅 Standalone Daily Note System
- **Decoupled Vault Requirement**: Automatically initializes Daily Note directories on Desktop without requiring a pre-loaded Vault.
- **Empty State UX & Safety Modals**: Added "Create Today's Note" action for empty file trees and added double-confirmation modals for destructive file actions.

---

### 🐛 Bug Fixes & Improvements

- **Chat Action Buttons Moved Outside Bubble**: Copy / Regenerate / Edit buttons now sit below the bubble and reveal on hover, eliminating the overlap where buttons covered text in short replies (matches the ChatGPT / Claude layout).
- **Message-level Actions**: One-click copy and regenerate on AI messages, edit-and-resend on user messages, retry on error messages.
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

#### 1. 🧠 AI Agent コア機能の全面強化
- **Mem0 スタイルの長期記憶**：自社開発の二層記憶アーキテクチャ（毎ターン全量注入する Core Memory＋関連度で呼び出す無制限 Archival）を実装。`search_memory` ツールによる能動的検索、TTL 自動失効、CJK 対応スコアリング（`overlap × weight × time_decay`）に対応し、セッションを越えて事実を「覚えている」Agent を実現。
- **トークン精密計測**：4 系統のトークン会計（input / output / cache_read / cache_write）をトレースヘッダーで実時間表示。
- **ツールフック・リスク制御**：ツール呼び出し予算のサーキットブレーカー、引数の冪等インターセプトによる重複防止、一時的エラーへの Retry Grace を追加。
- **応答速度の向上**：全経路の冗長なアニメーション遅延を撤去（1 ターンあたり約 850ms 回収）、合成リトライを 2→1 に削減、MCP ツール収集と Skill ディレクトリ走査をキャッシュ化。Agent / RAG 両モードで体感速度が向上。
- **進捗表示の誠実化**：RAG 進捗バーは実際に待つ段階（Searching → Generating）のみを表示し、ミリ秒未満のメモリ処理を「瞬間チェック」で見せる演出を廃止。

#### 2. 🎨 3Dナレッジグラフ：自社開発Three.jsエンジンの大刷新
- **ネイティブ Three.js レンダリングパイプライン**：サードパーティ製 `react-force-graph-3d` を完全排除し、原生 WebGL ベースのコントロールと安全な VRAM メモリ解放（`.dispose()`）を実現。
- **360° 全方向フライト視点**：`TrackballControls` トラックボールコントローラーを導入。極角制限を撤廃し、動的慣性アニメーションにより宇宙を探索するような快適な操作感を提供。
- **2D/3D 視点切替時のブラックアウト修復**：切替初期座標をカメラ視錐体のコア領域（`[-100, 100]`）に制限し、「3D視点切替時に画面が暗転する」バグを完全解消。
- **Fly-to スムーズフォーカス & 3D矢印**：3.2秒の滑らかなカメラ移動と、クォータニオン姿勢変換による 3D コーン矢印で、ノート間の双方向リンク関係を視覚化。
- **ウォームスタート物理挙動最適化**：物理エンジン Worker (`forceWorker.ts`) に位置・速度キャッシュ Map を内蔵。ノード調整時の「グラフのシャッフルや激しい揺れ」を解消。

#### 3. 🗂️ サイドバー UI の刷新（Obsidian / VSCode スタイル）
- **モーダルレス・インライン作成**：ファイル/フォルダ作成時にモーダルを出さず、ツリー内でインライン入力（Enterで確定、ESCでキャンセル）。
- **ホバー・クイックボタン**：フォルダにマウスを合わせると、VSCode スタイルの「新規ファイル」「新規フォルダ」ボタンを表示。
- **スマート Active Vault 認識**：選択中ファイルから所属 Vault を自動推定する `getActiveVaultPath()` を実装。非選択時は自動でデスクトップに Vault を生成。「主フォルダ」固定概念を排除。

#### 4. 🤖 ホワイトボード ↔ Chat 双方向 AI 連携の完全閉環
- **キャンバス選択データ連携修復**：選択ノードのデータ脱落バグを修復し、`zettel:canvas-selection` で完全なコンテキストを送信。
- **Agent ツール & プロンプト強化**：Agent 戦略に `read_canvas` などの読み取りツール権限を追加、System Prompt にキャンバス討論用ガイドラインを追加。

#### 5. 📅 Daily Note 日記システムの独立化
- **Vault 依存の解除**：Demo Vault を開いていなくても、デスクトップ上に自動で Daily Note ディレクトリを初期化。
- **空状態 UI & 確認モーダル**：空ツリー領域の「今日のノート作成」ボタンを追加。フォルダ消去・削除時の二重確認モーダル保護を実装。

---

### 🐛 バグ修正と詳細改善

- **チャット操作ボタンをバブル外へ移動**：コピー / 再生成 / 編集ボタンをバブルの下に配置し、ホバー時に表示。短い返信でボタンが本文に重なる問題を解消（ChatGPT / Claude のレイアウトに準拠）。
- **メッセージ単位の操作追加**：AI メッセージのワンクリックコピーと再生成、ユーザーメッセージの編集・再送信、エラーメッセージの再試行に対応。
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

#### 1. 🧠 AI Agent 코어 기능 전면 강화
- **Mem0 스타일 장기 기억**: 자체 개발 2계층 기억 아키텍처(매 턴 전량 주입되는 Core Memory + 관련도로 호출되는 무제한 Archival)를 구현했습니다. `search_memory` 도구를 통한 능동 검색, TTL 자동 만료, CJK 대응 스코어링(`overlap × weight × time_decay`)을 지원하여 세션을 넘어 사실을 '기억하는' Agent를 실현했습니다.
- **토큰 정밀 계측**: 4종 토큰 회계(input / output / cache_read / cache_write)를 트레이스 헤더에서 실시간으로 표시합니다.
- **툴 훅 리스크 제어**: 도구 호출 예산 서킷 브레이커, 인자 멱등 인터셉트를 통한 중복 방지, 일시적 오류에 대한 Retry Grace를 추가했습니다.
- **응답 속도 향상**: 전 경로의 불필요한 애니메이션 지연을 제거(턴당 약 850ms 회수)하고, 합성 재시도를 2→1로 축소, MCP 도구 수집과 Skill 디렉터리 스캔을 캐싱했습니다. Agent / RAG 두 모드 모두 체감 속도가 향상되었습니다.
- **진행 표시의 정직화**: RAG 진행 바는 실제로 기다리는 단계(Searching → Generating)만 표시하고, 밀리초 미만의 메모리 작업을 '즉시 체크'로 보여주는 연출을 제거했습니다.

#### 2. 🎨 3D 지식 그래프: 자체 개발 Three.js 렌더링 엔진 대폭 업그레이드
- **네이티브 Three.js 렌더링 파이프라인**: 서드파티 `react-force-graph-3d` 라이브러리를 완전히 제거하고, 순수 WebGL/Three.js 기반으로 비동기 안전 메모리 해제(`.dispose()`)를 구현했습니다.
- **360° 전방위 비행 시점**: `TrackballControls` 트랙볼 컨트롤러를 도입하여 극각 제한을 제거하고 우주 공간을 탐험하는 듯한 매끄러운 관성 비행을 제공합니다.
- **2D/3D 시점 전환 블랙스크린 해결**: 전환 초기 공간 좌표를 카메라 가시 영역(`[-100, 100]`)으로 제한하여 시점 전환 시 화면이 검게 변하는 현상을 완치했습니다.
- **Fly-to 부드러운 애니메이션 & 3D 화살표**: 3.2초 부드러운 포커스 애니메이션과 쿼터니언(Quaternion) 3D 콘 화살표로 노트 간 양방향 참조 관계를 직관적으로 표시합니다.
- **웜스타트 물리 엔진 최적화**: 물리 엔진 Worker(`forceWorker.ts`) 내 위치 및 속도 캐시 Map을 도입하여 노드 이동 시 그래프가 셔플되거나 심하게 흔들리는 현상을 방지했습니다.

#### 3. 🗂️ 사이드바 UI 재구성 (Obsidian / VSCode 스타일)
- **모달 없는 인라인 생성**: 파일/폴더 생성 시 팝업 모달 대신 파일 트리 내에서 직접 인라인 입력 창을 제공합니다 (Enter 확정, ESC 취소).
- **호버 퀵 액션 버튼**: 폴더 노드에 마우스를 올리면 VSCode 스타일의 '새 파일', '새 폴더' 버튼이 표시됩니다.
- **스마트 Active Vault 인식**: 선택된 파일에서 Vault 경로를 자동으로 추론하는 `getActiveVaultPath()`를 구현하고, 강제 메인 폴더 제약을 제거하여 다중 Vault 평권 관리를 지원합니다.

#### 4. 🤖 화이트보드 ↔ Chat 양방향 AI 연동 완성
- **화이트보드 컨텍스트 전달 보장**: 노드 선택 논의 시 데이터가 유실되던 문제를 수정하고 `zettel:canvas-selection`을 통해 완전한 노드 데이터를 전달합니다.
- **Agent 도구 및 프롬프트 강화**: Agent 전략에 `read_canvas` 도구 접근 권한을 추가하고 시스템 프롬프트에 Canvas Discussion 전용 규칙을 반영했습니다.

#### 5. 📅 Standalone Daily Note 일기 시스템
- **Vault 의존성 제거**: 데모 Vault가 없이도 바탕화면에 Daily Note 폴더를 자동으로 생성합니다.
- **빈 상태 UX 및 안전 모달**: 빈 파일 트리 영역에 '오늘 일기 작성' 버튼을 제공하며, 삭제/초기화 시 2차 확인 모달 보호 메커니즘을 적용했습니다.

---

### 🐛 버그 수정 및 개선 사항

- **채팅 액션 버튼을 버블 외부로 이동**: 복사 / 재생성 / 편집 버튼을 버블 아래에 배치하고 호버 시 표시하도록 변경하여, 짧은 답변에서 버튼이 본문 텍스트를 가리는 문제를 해결했습니다 (ChatGPT / Claude 레이아웃 준수).
- **메시지 단위 액션 추가**: AI 메시지의 원클릭 복사 및 재생성, 사용자 메시지의 편집 후 재전송, 오류 메시지의 재시도를 지원합니다.
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
