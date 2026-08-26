![ZettleAgent Banner](./screenshots/zettleagent-readme-swiss-banner.png)

<div align="center">

  # ZettelAgent

  ### ローカルファースト · 自律型 AI エージェント駆動のカードボックス知識 OS

  *考え、矛盾を検証し、ノートを自己進化させるセカンドブレイン。*  
  すべてローカルの Markdown フォルダで完結 — **Docker 不要、クラウド不要、テレメトリ 0。**

  <!-- Badges -->
  <p>
    <a href="https://poetrynan.github.io/zettelagent.org/"><img src="https://img.shields.io/badge/🌐_公式サイト-zettelagent.org-CF2711?style=for-the-badge" alt="公式サイト"></a>
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
    <a href="README.md">English</a> · <a href="README_CN.md">中文</a> · <strong>日本語</strong> · <a href="README_KR.md">한국어</a>
  </p>

</div>

---

> ### 🚀 [Releases からダウンロード](https://github.com/Poetrynan/ZettleAgent/releases) · 🌐 [公式Webサイト · zettelagent.org](https://poetrynan.github.io/zettelagent.org/)
> 
> Node.js も Docker も、追加のモデルダウンロードも不要。約 300MB のスタンドアロンインストーラーに nomic 埋め込みモデル・ONNX Runtime WASM・オフライン OCR が同梱、完全オフラインでローカルの Markdown フォルダを操作できます。

---

## 📑 目次

- [✨ コアアーキテクチャと機能](#-コアアーキテクチャと機能)
- [📸 インターフェース紹介（刷新されたデスクトップ UI）](#-インターフェース紹介刷新されたデスクトップ-ui)
- [⚔️ 競合・アーキテクチャ比較](#️-競合アーキテクチャ比較)
- [🏁 クイックスタート（エンドユーザー）](#-クイックスタートエンドユーザー)
- [🛠 ソースからビルド（開発者）](#-ソースからビルド開発者)
- [💻 システム要件](#-システム要件)
- [🤝 貢献](#-貢献)
- [🙏 謝辞](#-謝辞)
- [📜 ライセンス](#-ライセンス)

---

## ✨ コアアーキテクチャと機能

### 🛡️ WriteGuard 書き込みガードと完全可逆 ChangeSet（100% データ主権）
- **Human-in-the-Loop 承認ゲート**: エージェントが勝手にファイルを上書きすることはありません。すべての変更提案には `READYWRITE` トークンが必要で、行単位の差分（Line Diff）をプレビューして個別にチェック・承認できます。
- **100% 可逆な ChangeSet 台帳**: すべての変更操作に対して完全な逆パッチを保存。変更されたテキスト、削除されたノード、切断された接続線をワンクリックで元の座標に復元できます。

### 🤖 ネイティブ自律型 Multi-Agent（6 大専用ドメインツールキット）
- **ドメインツールパック (Packs)**: ノート原子操作、ベクトル＆ハイブリッド検索、グラフ構造診断、ホワイトボード空間推論、ワークスペース健全性監査、Web ディープ検索。
- **3 層ハイブリッド意図ルーティング (L0/L1/L2)**: 確信度の高い操作は L0 ルール直通（0ms、0 Token）、複雑なタスクのみ L2 大規模モデル計画にエスカレーション。
- **ローカル 7B/14B 小規模モデル最適化**: ツールスキーマを動的に剪定・ロードし、1 ターンあたり 4,000+ Tokens を削減。ローカル Ollama/vLLM でツール呼び出し幻覚率 0% を実現。

### 🧠 数理グラフ理論とブラインドスポット診断 (GraphPlan)
- **グラフ理論アルゴリズム**: **PageRank 中心性スコア**、**Louvain コミュニティ検出クラスタリング**、最短概念経路探索をリアルタイム計算。
- **GraphPlan ブラインドスポット修復**: 孤立ノート、リンク切れ、意味的盲点を自動検出し、構造的な架け橋計画を一括生成。

### 🎨 空間推論ホワイトボード (Obsidian Canvas 互換)
- **4 つの空間推論目標**: `explain` (階層分解)、`compare` (マトリクス比較)、`trace` (因果・時系列追跡)、`cluster` (テーマ別クラスタリング)。
- **双方向コンパイル**: 無限ホワイトボードの接続線と SQLite データベースが双方向に同期・コンパイルされます。

### 🔐 OS ハードウェアキーリング保護 (OS Keyring Substrate)
- **ハードウェア暗号化**: API キーと資格情報は Windows DPAPI および macOS Keychain でハードウェアレベルで暗号化。WebView やローカル設定 JSON に平文トークンは一切残りません。
- **純粋なオフラインベクトル検索**: SQLite-vec + FTS5 による完全ローカル埋め込み、クラウドテレメトリ 0。

### 📈 科学的間隔反復システム (FSRS-4.5)
- **最新の記憶保持アルゴリズム**: 厳格な単調性不変条件ガードを備えた FSRS-4.5 現代間隔反復モデルとエピソード記憶ストアを内蔵。

---

## 📸 インターフェース紹介（刷新されたデスクトップ UI）

<div align="center">

### 1. 3 カラム型デスクトップ知識 OS & 3D トポロジーアトラス
*インタラクティブな PageRank グラフ、折りたたみ式エクスプローラー、自律型 Agent Desk。*

![ZettleAgent 3 カラム型デスクトップ知識 OS](./screenshots/showcase-workspace-atlas.png)

<br>

| 2. WriteGuard™ 行単位 Diff 承認＆台帳 | 3. 空間推論ホワイトボード (Obsidian 互換) |
|:---:|:---:|
| <img src="./screenshots/showcase-writeguard-diff.png" alt="WriteGuard 行単位 Diff 承認" width="100%" /> | <img src="./screenshots/showcase-canvas-spatial.png" alt="空間推論ホワイトボード" width="100%" /> |
| *ReadyWrite ゲート、行単位チェック承認＆ワンクリック Undo* | *4 つの推論目標 (分解/比較/追跡/クラスタ) + SQLite 同期* |

<br>

### 4. 科学的間隔反復システム (FSRS-4.5 エンジン)
*最新の FSRS 記憶モデル、厳格な単調性ガード、エピソード記憶ストア。*

<p align="center">
  <img src="./screenshots/showcase-fsrs-review.png" alt="FSRS-4.5 復習エンジン" width="75%" />
</p>

</div>

---

## ⚔️ 競合・アーキテクチャ比較

| 比較項目 | **ZETTLEAGENT (推奨)** | **OBSIDIAN** | **LOGSEQ** | **NOTION / MEM** |
| :--- | :--- | :--- | :--- | :--- |
| **AI 動作モデル** | 🚀 **ネイティブ自律型 Agent**（6 ツールパック、L0-L2 ルーティング、CoT ストリーム） | ⚠️ **サードパーティ製プラグイン依存**（状態機械の統一なし） | ⚠️ **実験的プラグインのみ**（自律ループなし） | ☁️ **クラウド型テキスト補助**（単なる補完、ツール連携なし） |
| **ローカル 7B/14B 最適化** | ⚡ **高度なスキーマ剪定**（4000+ Tokens 削減、幻覚 0%） | ⚠️ **クラウド API 前提**（小規模モデルは幻覚やエラー多発） | ❌ **小規模モデル最適化なし** | ❌ **ローカル Ollama 接続不可** |
| **ファイル変更の安全性** | 🛡️ **WriteGuard ゲート**（行単位 Diff 承認、ReadyWrite トークン） | ⚠️ **ファイル直接上書き**（簡易履歴のみ） | ⚠️ **ファイル直接上書き**（Git プラグイン依存） | ☁️ **クラウドブロック置換**（ページ全体の復元のみ） |
| **完全可逆 Undo** | 🔄 **100% 可逆な ChangeSet 台帳**（ノート・ボードの 1 クリック復元） | ❌ **逆パッチ台帳なし** | ❌ **手動 git revert のみ** | ❌ **きめ細かい AI 取消台帳なし** |
| **グラフ理論トポロジー** | 🧠 **PageRank 中心性 + Louvain クラスタ + GraphPlan 診断** | ⚠️ **単純な可視化のみ**（アルゴリズム分析なし） | ⚠️ **基本的な 2D グラフ** | ❌ **グラフ非対応**（階層ツリーのみ） |
| **空間推論ホワイトボード** | 🎨 **4 つの推論目標 + 自動配置 + SQLite 双方向同期** | ⚠️ **手動ドラッグ＆ドロップ**（プラグインは単なるテキスト追加） | ⚠️ **基本ホワイトボード**（推論目標なし） | ❌ **無限ホワイトボードなし** |
| **セキュリティ基盤** | 🔐 **OS ハードウェアキーリング (DPAPI/Keychain) + テレメトリ 0** | ⚠️ **プラグインの平文 JSON に API キー保存** | ⚠️ **平文設定** | ☁️ **商業クラウド保管**（全データが SaaS に露出） |
| **間隔反復システム** | 📈 **内蔵 FSRS-4.5 (単調性ガード) + エピソード記憶** | ⚠️ **プラグイン必須 (旧 SM-2)** | ⚠️ **基本フラッシュカード (旧式)** | ❌ **間隔反復なし** |

---

## 🏁 クイックスタート（エンドユーザー）

1. [Releases ページ](https://github.com/Poetrynan/ZettleAgent/releases) からお使いの OS に適したインストーラー（Windows `.exe`、macOS `.dmg`）をダウンロード。
2. インストールして起動 — **追加の環境構築やダウンロードは一切不要**。
3. ローカルの Markdown フォルダを保管庫（Vault）として選択。
4. （任意）「設定」で LLM API キー（DeepSeek / OpenAI / Claude / Gemini / Ollama など）を設定。

---

## 🛠 ソースからビルド（開発者）

```bash
# 1. リポジトリをクローン
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent

# 2. 依存関係のインストール
npm install

# 3. 開発サーバーの起動 (Tauri 2.0 + Vite + React 19)
npm run tauri dev
```

> **注意:** `src-tauri/gen/` は Tauri によって自動生成されます。初回の `npm run tauri dev` 実行時に `capabilities/default.json` が参照するスキーマファイルが生成されます。

リリースインストーラーの作成:

```bash
npm run tauri build  # オフラインモデルをバンドルしバイナリをビルド
```

---

## 💻 システム要件

| プラットフォーム | インストーラー容量 | 推奨メモリ (RAM) |
| :--- | :--- | :--- |
| **Windows 10/11 x64**（完全対応） | 約 300MB（モデル内蔵） | 8GB+（ローカルベクトル＆グラフ計算） |
| **macOS (Apple Silicon & Intel)** | 約 280MB | 8GB+ |
| **Linux (AppImage / deb)**（実験的） | 約 280MB | 8GB+ |

---

## 🤝 貢献

コミュニティからの貢献を歓迎します！バグ修正、ドキュメントの改善、新しいツールスキーマの設計など、お気軽にご参加ください。

Pull Request を送信する前に、[貢献ガイドライン](CONTRIBUTING.md) をご確認ください。

---

## 🙏 謝辞

本プロジェクトは先人たちの偉大な成果の上に成り立っています: [Zettelkasten](https://luhmann.surge.sh/communicating-with-slip-boxes) · [Obsidian](https://obsidian.md/) · [sqlite-vec](https://github.com/asg017/sqlite-vec) · [Tauri](https://tauri.app/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [DeepSeek](https://www.deepseek.com/)

---

## 📜 ライセンス

Apache License 2.0 — 無料で商用利用および改変が可能です。**商用製品で使用する場合は原著作者の著作権表示を保持してください。** 詳細は [LICENSE](LICENSE) をご覧ください。
