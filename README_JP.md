<div align="center">

  <a href="https://github.com/Poetrynan/ZettleAgent">
    <img src="logo/ZettelAgent.png" alt="ZettelAgent Logo" width="120">
  </a>

  # ZettelAgent

  ### AI 駆動の Zettelkasten デスクトップエージェント

  *考え、矛盾を発見し、ノートを進化させるセカンドブレイン。*  
  すべてローカルの Markdown フォルダで完結 — **Docker 不要、クラウド不要、アカウント不要。**

  <!-- Badges -->
  <p>
    <a href="https://github.com/Poetrynan/ZettleAgent/stargazers"><img src="https://img.shields.io/github/stars/Poetrynan/ZettleAgent?style=for-the-badge&color=10B981" alt="Stars"></a>
    <a href="https://github.com/Poetrynan/ZettleAgent/releases"><img src="https://img.shields.io/github/v/release/Poetrynan/ZettleAgent?style=for-the-badge&color=0EA5E9" alt="Release"></a>
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
  </p>

  <!-- Language switcher -->
  <p>
    <a href="README.md">English</a> · <a href="README_CN.md">中文</a> · <strong>日本語</strong> · <a href="README_KR.md">한국어</a>
  </p>

</div>

---

> ### 🚀 [Releases からダウンロード](https://github.com/Poetrynan/ZettleAgent/releases) → インストール → すぐに使用
> 
> Node.js も Docker も、追加のモデルダウンロードも不要。約 300MB のインストーラーに nomic 埋め込みモデル・ONNX Runtime WASM・PP-OCR が同梱、インストール後は完全オフラインでローカルの Markdown フォルダを操作できます。

---

## 📑 目次

- [✨ コア機能](#-コア機能)
- [📸 インターフェース紹介](#-インターフェース紹介)
- [🏁 クイックスタート（エンドユーザー）](#-クイックスタートエンドユーザー)
- [🛠 ソースからビルド（開発者）](#-ソースからビルド開発者)
- [💻 システム要件](#-システム要件)
- [⚔️ 競合比較](#️-競合比較)
- [🤝 貢献](#-貢献)
- [🙏 謝辞](#-謝辞)
- [📜 ライセンス](#-ライセンス)

---

## ✨ コア機能

### 🔍 ハイブリッド検索
全文検索 + セマンティックベクトル検索、3 つのモードをワンクリック切替。自然言語で質問すると、ノートのコンテキストに基づいて AI が回答します。

### 🤖 AI エージェント
60 個の内蔵ツール、3 つの専門化エージェントが協業。ノート自動整理、矛盾検出、接続生成提案、一括操作。書き込み操作はユーザー承認が必要。

### 📈 知識グラフ
ノート間の隠れたセマンティック接続を自動発見。PageRank 重要度スコアリング、コミュニティクラスタリング、ローカルグラフ、最短経路発見。

### 🎨 インテリジェントキャンバス
Obsidian 互換ホワイトボード、ベジェ曲線、PDF/ウェブ埋め込み、スマートグループ。AI 自動レイアウト、エージェント直接操作。

### 🧠 内蔵埋め込みエンジン
nomic-embed-text-v1.5 は**インストーラーに同梱**（WASM、WebGPU は任意）。ゼロコンフィグ、API キー不要、インストール後の追加ダウンロードなし。

### 🔒 ローカル優先
すべてのデータはユーザーのマシンに保存。AI は `<!-- @generated -->` ブロックにのみ書き込み、元のコンテンツは変更しません。Zettelkasten、PARA、CODE、GTD など 8 つのメソドロジーをサポート。

---

## 📸 インターフェース紹介

<div align="center">

| 知識グラフ | ダッシュボード |
|:---:|:---:|
| ![Graph View](scrennshot1.png) | ![Dashboard](scrennshot2.png) |

</div>

---

## 🏁 クイックスタート（エンドユーザー）

1. [Releases](https://github.com/Poetrynan/ZettleAgent/releases) からインストーラーをダウンロード
2. インストールして起動 — **追加ダウンロード不要**
3. 設定で LLM API を構成（OpenAI / Claude / Gemini / Ollama など）

---

## 🛠 ソースからビルド（開発者）

```bash
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent
npm install
npm run tauri dev    # 開発モード（初回実行時に src-tauri/gen/schemas/ を自動生成）
```

> **メモ：** `src-tauri/gen/` は Tauri が自動生成するため、git 管理対象外です。  
> 初回の `npm run tauri dev` 実行時に `capabilities/default.json` が参照するスキーマファイルが作成されます。手動操作は不要です。

Release インストーラーをビルド：

```bash
npm run tauri build  # build:prod を実行（モデル取得・全アセット同梱）
```

大きなアセット（埋め込みモデル、ORT WASM、フォント）は git リポジトリに**含まれません**。`tauri build` がインストーラー用に自動でダウンロード・同梱します。エンドユーザーはこの手順を実行しません。

---

## 💻 システム要件

| プラットフォーム | インストーラーサイズ | 推奨メモリ |
|------------------|----------------------|------------|
| **Windows**（正式サポート）· macOS / Linux（CI ビルド、実験的） | 約 300MB（モデル同梱） | 8GB+（ローカル埋め込み） |

---

## ⚔️ 競合比較

| | ZettelAgent | Obsidian + プラグイン | Notion AI | Logseq |
|---|:---:|:---:|:---:|:---:|
| ローカル優先、クラウド不要 | ✅ | ✅ | ❌ | ✅ |
| 内蔵 AI エージェント (60 ツール + 3 エージェント) | ✅ | ⚠️ サードパーティ | ⚠️ 限定的 | ❌ |
| ハイブリッド検索 (FTS + ベクトル RRF) | ✅ | ⚠️ プラグイン | ❌ | ❌ |
| 自動矛盾検出・調停 | ✅ | ❌ | ❌ | ❌ |
| AI インテリジェントキャンバス (グループ + レイアウト) | ✅ | ✅ | ❌ | ✅ |
| 内蔵埋め込み（インストーラー同梱、追加 DL なし） | ✅ | ❌ | ❌ | ❌ |
| AI 長期記憶（セッション横断） | ✅ | ❌ | ⚠️ | ❌ |
| 選択テキスト AI（書き換え/要約/翻訳） | ✅ | ⚠️ プラグイン | ✅ | ❌ |
| ウェブ検索（DuckDuckGo） | ✅ | ⚠️ プラグイン | ⚠️ | ❌ |
| マルチフォーマットインポート（PDF/DOCX/OCR） | ✅ | ⚠️ プラグイン | ⚠️ | ❌ |
| データベースビュー（Notion スタイルテーブル） | ✅ | ⚠️ Dataview | ✅ | ❌ |
| チャット履歴永続化 | ✅ | ❌ | ✅ クラウド | ❌ |
| 承認ゲート（書き込み安全性） | ✅ | ❌ | ❌ | ❌ |
| 時間次元の知識進化 | ✅ | ❌ | ❌ | ❌ |
| 知識ギャップ分析 | ✅ | ❌ | ❌ | ❌ |
| 8 つのメソドロジー対応 | ✅ | ⚠️ プラグイン | ❌ | ❌ |
| MCP プロトコル（SSE + stdio） | ✅ | ❌ | ❌ | ❌ |
| インストーラー 1 つ、実行時依存なし | ✅ | ⚠️ Electron | ❌ Web | ⚠️ Electron |

---

## 🤝 貢献

コミュニティからの貢献を歓迎します！バグ修正、ドキュメント改善、新機能追加など、どのような助けも感謝いたします。

Pull Request を提出する前に、[コントリビューション ガイドライン](CONTRIBUTING.md)をお読みください。

---

## 🙏 謝辞

次のオープンソースプロジェクト上に構築されています: [Zettelkasten](https://luhmann.surge.sh/communicating-with-slip-boxes) · [Obsidian](https://obsidian.md/) · [sqlite-vec](https://github.com/asg017/sqlite-vec) · [Tauri](https://tauri.app/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [DeepSeek](https://www.deepseek.com/)

---

## 📜 ライセンス

Apache License 2.0 — 使用と改変は自由。**商用利用時には原著作者への帰属表示が必須。** [LICENSE](LICENSE) をご覧ください。

---

<!-- Star History -->
<div align="center">

  ## ⭐ Star History

  [![Star History Chart](https://api.star-history.com/svg?repos=Poetrynan/ZettleAgent&type=Date)](https://star-history.com/#Poetrynan/ZettleAgent&Date)

</div>
