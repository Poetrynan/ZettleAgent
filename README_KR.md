<p align="center">
  <img src="logo/ZettelAgent.png" alt="ZettelAgent Logo">
</p>

<h1 align="center">ZettelAgent</h1>

<p align="center">
  <strong>AI 기반 Zettelkasten 데스크톱 에이전트</strong><br>
  생각하고, 모순을 발견하고, 노트를 진화시키는 두 번째 두뇌.<br>
  모두 로컬 Markdown 폴더에서 완성됩니다. Docker 불필요, 클라우드 불필요, 계정 불필요.
</p>

<p align="center">
  <a href="https://github.com/Poetrynan/ZettleAgent/stargazers"><img src="https://img.shields.io/github/stars/Poetrynan/ZettleAgent?style=flat-square&color=10B981" alt="Stars"></a>
  <a href="https://github.com/Poetrynan/ZettleAgent/releases"><img src="https://img.shields.io/github/v/release/Poetrynan/ZettleAgent?style=flat-square&color=0EA5E9" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20primary-8B5CF6?style=flat-square" alt="Platform">
  <a href="https://github.com/Poetrynan/ZettleAgent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Poetrynan/ZettleAgent?style=flat-square&color=F59E0B" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-blue?style=flat-square" alt="Tauri 2.0">
  <img src="https://img.shields.io/badge/React-19-61dafb?style=flat-square" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-1.96-dea584?style=flat-square" alt="Rust 1.96">
  <img src="https://img.shields.io/badge/SQLite-FTS5%20+%20Vec-0EA5E9?style=flat-square" alt="SQLite">
  <img src="https://img.shields.io/badge/Embedding-nomic--v1.5%20WebGPU%2FWASM-10B981?style=flat-square" alt="Embedding">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_CN.md">中文</a> | <a href="README_JP.md">日本語</a> | <strong>한국어</strong>
</p>

---

## 목차

- [핵심 기능](#핵심-기능)
- [인터페이스 소개](#인터페이스-소개)
- [빠른 시작 (최종 사용자)](#빠른-시작-최종-사용자)
- [소스에서 빌드 (개발자)](#소스에서-빌드-개발자)
- [시스템 요구 사항](#시스템-요구-사항)
- [경쟁 비교](#경쟁-비교)
- [기여하기](#기여하기)
- [감사의 말](#감사의-말)
- [라이선스](#라이선스)

---

> **[Releases](https://github.com/Poetrynan/ZettleAgent/releases)에서 설치 파일 다운로드 → 설치 → 바로 사용.** Node.js, Docker, 추가 모델 다운로드 불필요. 약 300MB 설치 패키지에 nomic 임베딩 모델, ONNX Runtime WASM, PP-OCR이 포함되어 있으며, 설치 후 완전 오프라인으로 로컬 Markdown 폴더에서 작동합니다.

## 핵심 기능

### 🔍 하이브리드 검색

전문 검색 + 시맨틱 벡터 검색, 3가지 모드 원클릭 전환. 자연어로 질문하면 노트 컨텍스트 기반으로 AI가 답변합니다.

### 🤖 AI 에이전트

60개 내장 도구, 3개 전문화 에이전트 협업. 노트 자동 정리, 모순 감지, 연결 생성 제안, 일괄 작업. 쓰기 작업은 사용자 승인 필요.

### 📈 지식 그래프

노트 간 숨겨진 시맨틱 연결 자동 발견. PageRank 중요도 스코어링, 커뮤니티 클러스터링, 로컬 그래프, 최단 경로 발견.

### 🎨 인텔리전트 캔버스

Obsidian 호환 화이트보드, 베지에 곡선, PDF/웹 임베드, 스마트 그룹. AI 자동 레이아웃, 에이전트 직접 제어.

### 🧠 내장 임베딩 엔진

nomic-embed-text-v1.5는 **설치 패키지에 포함**(WASM, WebGPU 선택). 제로 구성, API 키 불필요, 설치 후 추가 다운로드 없음.

### 🔒 로컬 우선

모든 데이터는 사용자 머신에 저장. AI는 `<!-- @generated -->` 블록에만 작성, 원본 콘텐츠 변경 없음. Zettelkasten, PARA, CODE, GTD 등 8가지 방법론 지원.

---

## 인터페이스 소개

![ZettelAgent 지식 그래프](scrennshot1.png)

![ZettelAgent 대시보드](scrennshot2.png)

---

## 빠른 시작 (최종 사용자)

1. [Releases](https://github.com/Poetrynan/ZettleAgent/releases)에서 설치 파일 다운로드
2. 설치 후 실행 — **추가 다운로드 없음**
3. 설정에서 LLM API 구성 (OpenAI / Claude / Gemini / Ollama 등)

### 소스에서 빌드 (개발자)

```bash
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent
npm install
npm run tauri dev    # 개발 모드 (첫 실행 시 src-tauri/gen/schemas/ 자동 생성)
```

> **참고:** `src-tauri/gen/` 은 Tauri가 자동 생성하므로 git 관리 대상이 아닙니다.
> 첫 `npm run tauri dev` 실행 시 `capabilities/default.json` 이 참조하는 스키마 파일이 생성됩니다. 수동 조작은 필요하지 않습니다.

Release 설치 패키지 빌드:

```bash
npm run tauri build  # build:prod 실행 (모델 다운로드 · 모든 에셋 번들링)
```

대용량 에셋(임베딩 모델, ORT WASM, 폰트)은 git 저장소에 **포함되지 않습니다**. `tauri build` 가 설치 패키지용으로 자동 다운로드 및 번들링합니다. 최종 사용자는 이 단계를 실행하지 않습니다.

### 시스템 요구 사항

| 플랫폼 | 설치 패키지 크기 | 권장 메모리 |
|--------|------------------|------------|
| **Windows**(정식 지원); macOS / Linux(CI 빌드, 실험적) | 약 300MB (모델 포함) | 8GB+ (로컬 임베딩) |

---

## 경쟁 비교

| | ZettelAgent | Obsidian + 플러그인 | Notion AI | Logseq |
|---|:---:|:---:|:---:|:---:|
| 로컬 우선, 클라우드 없음 | ✅ | ✅ | ❌ | ✅ |
| 내장 AI 에이전트 (60 도구 + 3 에이전트) | ✅ | ⚠️ 타사 | ⚠️ 제한적 | ❌ |
| 하이브리드 검색 (FTS + 벡터 RRF) | ✅ | ⚠️ 플러그인 | ❌ | ❌ |
| 자동 모순 감지 및 조정 | ✅ | ❌ | ❌ | ❌ |
| AI 인텔리전트 캔버스 (그룹 + 레이아웃) | ✅ | ✅ | ❌ | ✅ |
| 내장 임베딩 (설치 패키지 포함, 추가 DL 없음) | ✅ | ❌ | ❌ | ❌ |
| AI 장기 기억 (세션 간 유지) | ✅ | ❌ | ⚠️ | ❌ |
| 선택 텍스트 AI (재작성/요약/번역) | ✅ | ⚠️ 플러그인 | ✅ | ❌ |
| 웹 검색 (DuckDuckGo) | ✅ | ⚠️ 플러그인 | ⚠️ | ❌ |
| 멀티포맷 가져오기 (PDF/DOCX/OCR) | ✅ | ⚠️ 플러그인 | ⚠️ | ❌ |
| 데이터베이스 뷰 (Notion 스타일 테이블) | ✅ | ⚠️ Dataview | ✅ | ❌ |
| 채팅 기록 영속화 | ✅ | ❌ | ✅ 클라우드 | ❌ |
| 승인 게이트 (쓰기 안전) | ✅ | ❌ | ❌ | ❌ |
| 시간 차원의 지식 진화 | ✅ | ❌ | ❌ | ❌ |
| 지식 격차 분석 | ✅ | ❌ | ❌ | ❌ |
| 8가지 방법론 지원 | ✅ | ⚠️ 플러그인 | ❌ | ❌ |
| MCP 프로토콜 (SSE + stdio) | ✅ | ❌ | ❌ | ❌ |
| 설치 패키지 하나, 런타임 의존성 없음 | ✅ | ⚠️ Electron | ❌ Web | ⚠️ Electron |

---

## 기여하기

커뮤니티의 기여를 환영합니다! 버그 수정, 문서 개선, 새로운 기능 추가 등 어떤 도움도 감사합니다.

Pull Request를 제출하기 전에 [기여 가이드라인](CONTRIBUTING.md)을 읽어주세요.

## 감사의 말

다음 오픈 소스 프로젝트 위에 구축되었습니다: [Zettelkasten](https://luhmann.surge.sh/communicating-with-slip-boxes) · [Obsidian](https://obsidian.md/) · [sqlite-vec](https://github.com/asg017/sqlite-vec) · [Tauri](https://tauri.app/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [DeepSeek](https://www.deepseek.com/)

---

## 라이선스

Apache License 2.0 — 자유롭게 사용 및 수정 가능. **상업적 사용 시 원저작자에게 저작권 표시 필수.** [LICENSE](LICENSE) 참조.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Poetrynan/ZettleAgent&type=Date)](https://star-history.com/#Poetrynan/ZettleAgent&Date)
