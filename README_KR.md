![ZettleAgent Banner](./screenshots/zettleagent-readme-swiss-banner.png)

<div align="center">

  # ZettelAgent

  ### 로컬 우선 · 네이티브 AI 에이전트 기반 카드박스 지식 운영체제

  *생각하고, 모순을 검증하고, 노트를 스스로 진화시키는 두 번째 두뇌.*  
  순수 로컬 Markdown 폴더에서 완결 — **Docker 불필요, 클라우드 락인 없음, 원격 측정 0.**

  <!-- Badges -->
  <p>
    <a href="https://poetrynan.github.io/zettelagent.org/"><img src="https://img.shields.io/badge/🌐_공식_웹사이트-zettelagent.org-CF2711?style=for-the-badge" alt="공식 웹사이트"></a>
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
    <a href="README.md">English</a> · <a href="README_CN.md">中文</a> · <a href="README_JP.md">日本語</a> · <strong>한국어</strong>
  </p>

</div>

---

> ### 🚀 [Releases에서 다운로드](https://github.com/Poetrynan/ZettleAgent/releases) · 🌐 [공식 웹사이트 · zettelagent.org](https://poetrynan.github.io/zettelagent.org/)
> 
> Node.js, Docker, 추가 모델 다운로드 불필요. 약 300MB 독립형 설치 패키지에 nomic 임베딩 모델, ONNX Runtime WASM, 오프라인 OCR이 내장되어 있어 설치 후 완전한 오프라인 환경에서 로컬 Markdown 노트를 관리할 수 있습니다.

---

## 📑 목차

- [✨ 핵심 아키텍처 및 기능](#-핵심-아키텍처-및-기능)
- [📸 인터페이스 소개 (새롭게 단장된 데스크톱 UI)](#-인터페이스-소개-새롭게-단장된-데스크톱-ui)
- [⚔️ 심층 아키텍처 및 경쟁 비교](#️-심층-아키텍처-및-경쟁-비교)
- [🏁 빠른 시작 (최종 사용자)](#-빠른-시작-최종-사용자)
- [🛠 소스에서 빌드 (개발자)](#-소스에서-빌드-개발자)
- [💻 시스템 요구 사항](#-시스템-요구-사항)
- [🤝 기여하기](#-기여하기)
- [🙏 감사의 말](#-감사의-말)
- [📜 라이선스](#-라이선스)

---

## ✨ 핵심 아키텍처 및 기능

### 🛡️ WriteGuard 쓰기 보호 및 100% 가역 ChangeSet (데이터 주권 보호)
- **Human-in-the-Loop 승인 게이트**: 에이전트가 사용자의 파일을 무단으로 덮어쓰지 않습니다. 모든 수정 제안은 `READYWRITE` 토큰을 받아야 하며, 행 단위 Diff(Line Diff) 미리보기를 통해 사용자가 직접 검토하고 개별 승인할 수 있습니다.
- **100% 가역 ChangeSet 원장**: 모든 변경 작업에 대해 완전한 역방향 패치를 SQLite에 저장합니다. 수정된 텍스트, 삭제된 노드, 끊어진 연결선을 클릭 한 번으로 원래 좌표로 복원할 수 있습니다.

### 🤖 네이티브 자율형 Multi-Agent (6대 전용 도메인 툴킷)
- **도메인 툴 팩 (Packs)**: 노트 원자 작업, 벡터 및 하이브리드 검색, 그래프 구조 진단, 화이트보드 공간 추론, 워크스페이스 상태 감사, Web 심층 검색.
- **3단계 하이브리드 의도 라우팅 (L0/L1/L2)**: 명확한 명령은 L0 규칙 직통(0ms, 0 Token), 복잡한 작업만 L2 거대 모델 계획으로 승격.
- **로컬 7B/14B 소형 모델 심층 최적화**: 툴 스키마를 동적으로 정리하여 턴당 4,000+ 토큰을 절약하고, 로컬 Ollama/vLLM에서 도구 호출 환각률 0%를 달성합니다.

### 🧠 수학적 그래프 위상 및 사각지대 진단 (GraphPlan)
- **그래프 이론 알고리즘**: **PageRank 중심성 점수**, **Louvain 커뮤니티 탐지 군집화**, 최단 개념 경로를 실시간 계산.
- **GraphPlan 사각지대 복구**: 고립된 노트, 깨진 링크, 의미론적 사각지대를 자동 탐지하고 구조적 복구 계획을 일괄 생성합니다.

### 🎨 공간 추론 무한 화이트보드 (Obsidian Canvas 호환)
- **4가지 공간 추론 목표**: `explain` (계층 분해), `compare` (비교 매트릭스), `trace` (인과/시계열 추적), `cluster` (주제별 군집).
- **양방향 컴파일**: 무한 화이트보드 연결선과 SQLite 데이터베이스가 실시간으로 양방향 동기화 및 컴파일됩니다.

### 🔐 OS 하드웨어 키링 보안 기반 (OS Keyring Substrate)
- **하드웨어 레벨 암호화**: API 키와 모델 자격 증명은 Windows DPAPI 및 macOS Keychain으로 안전하게 암호화되며, WebView나 로컬 JSON 설정 파일에 평문 토큰이 전혀 남지 않습니다.
- **순수 오프라인 벡터 스토어**: SQLite-vec + FTS5 로컬 임베딩으로 클라우드 텔레메트리가 전혀 없습니다.

### 📈 과학적 간격 반복 시스템 (FSRS-4.5)
- **최신 기억 유지 알고리즘**: 엄격한 단조성 불변 가드를 갖춘 FSRS-4.5 현대적 간격 반복 알고리즘 및 에피소드 기억 저장소를 내장했습니다.

---

## 📸 인터페이스 소개 (새롭게 단장된 데스크톱 UI)

<div align="center">

### 1. 3열 데스크톱 지식 OS & 3D 위상 아틀라스
*인터랙티브 PageRank 그래프, 접이식 탐색기, 자율형 Agent Desk.*

![ZettleAgent 3열 데스크톱 지식 운영체제](./screenshots/showcase-workspace-atlas.png)

<br>

| 2. WriteGuard™ 행 단위 Diff 승인 & 원장 | 3. 공간 추론 화이트보드 (Obsidian 호환) |
|:---:|:---:|
| <img src="./screenshots/showcase-writeguard-diff.png" alt="WriteGuard 행 단위 Diff 승인" width="100%" /> | <img src="./screenshots/showcase-canvas-spatial.png" alt="공간 추론 화이트보드" width="100%" /> |
| *ReadyWrite 게이트, 행 단위 체크 승인 & 원클릭 Undo* | *4대 추론 목표 (분해/비교/추적/군집) + SQLite 동기화* |

<br>

### 4. 과학적 간격 반복 시스템 (FSRS-4.5 엔진)
*최신 FSRS 기억 모델, 엄격한 단조성 가드, 장기 에피소드 기억 저장소.*

<p align="center">
  <img src="./screenshots/showcase-fsrs-review.png" alt="FSRS-4.5 복습 엔진" width="75%" />
</p>

</div>

---

## ⚔️ 심층 아키텍처 및 경쟁 비교

| 비교 항목 | **ZETTLEAGENT (추천)** | **OBSIDIAN** | **LOGSEQ** | **NOTION / MEM** |
| :--- | :--- | :--- | :--- | :--- |
| **AI 작동 모델** | 🚀 **네이티브 자율형 Agent** (6대 툴팩, L0-L2 라우팅, CoT 스트림) | ⚠️ **서드파티 플러그인 의존** (통일된 상태 머신 없음) | ⚠️ **실험적 플러그인만 지원** (자율 루프 없음) | ☁️ **클라우드 텍스트 도우미** (단순 완성, 도구 연동 불가) |
| **로컬 7B/14B 최적화** | ⚡ **스키마 경량화 최적화** (4000+ 토큰 절약, 환각 0%) | ⚠️ **클라우드 API 전제** (소형 모델 호출 시 잦은 오류) | ❌ **소형 모델 최적화 없음** | ❌ **로컬 Ollama 연결 불가** |
| **파일 변경 안전성** | 🛡️ **WriteGuard 게이트** (행 단위 Diff 승인, ReadyWrite 토큰) | ⚠️ **파일 직접 덮어쓰기** (단순 파일 이력 의존) | ⚠️ **파일 직접 덮어쓰기** (Git 플러그인 의존) | ☁️ **클라우드 블록 교체** (전체 페이지 복원만 가능) |
| **완전 가역 Undo** | 🔄 **100% 가역 ChangeSet 원장** (노트 및 캔버스 원클릭 복원) | ❌ **역방향 패치 원장 없음** | ❌ **수동 git revert만 가능** | ❌ **세부적인 AI 취소 원장 없음** |
| **그래프 이론 위상** | 🧠 **PageRank 중심성 + Louvain 군집 + GraphPlan 진단** | ⚠️ **단순 시각화만 지원** (알고리즘 분석 없음) | ⚠️ **기본 2D 관계도** | ❌ **그래프 미지원** (계층형 트리만 지원) |
| **공간 추론 캔버스** | 🎨 **4대 추론 목표 + 자동 배치 + SQLite 양방향 동기화** | ⚠️ **수동 드래그 앤 드롭** (플러그인은 단순 텍스트 추가) | ⚠️ **기본 화이트보드** (추론 목표 없음) | ❌ **무한 화이트보드 미지원** |
| **보안 기반** | 🔐 **OS 하드웨어 키링 (DPAPI/Keychain) + 텔레메트리 0** | ⚠️ **플러그인 평문 JSON에 API 키 저장** | ⚠️ **평문 설정** | ☁️ **상업용 클라우드 호스팅** (모든 데이터가 SaaS에 노출) |
| **간격 반복 시스템** | 📈 **내장 FSRS-4.5 (단조성 가드) + 에피소드 기억** | ⚠️ **플러그인 필수 (레거시 SM-2)** | ⚠️ **기본 플래시카드 (구형)** | ❌ **간격 반복 미지원** |

---

## 🏁 빠른 시작 (최종 사용자)

1. [Releases 페이지](https://github.com/Poetrynan/ZettleAgent/releases) 에서 사용 중인 OS에 맞는 설치 파일(Windows `.exe`, macOS `.dmg`)을 다운로드합니다.
2. 설치 후 실행 — **추가적인 환경 설정이나 다운로드가 전혀 필요 없습니다**.
3. 로컬 Markdown 폴더를 보관소(Vault)로 지정합니다.
4. (선택 사항) 「설정」에서 LLM API 키(DeepSeek / OpenAI / Claude / Gemini / Ollama 등)를 설정합니다.

---

## 🛠 소스에서 빌드 (개발자)

```bash
# 1. 저장소 클론
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent

# 2. 의존성 설치
npm install

# 3. 개발 서버 실행 (Tauri 2.0 + Vite + React 19)
npm run tauri dev
```

> **참고:** `src-tauri/gen/` 은 Tauri에 의해 자동 생성됩니다. 최초 `npm run tauri dev` 실행 시 `capabilities/default.json` 이 참조하는 스키마 파일이 생성됩니다.

릴리스 설치 프로그램 생성:

```bash
npm run tauri build  # 오프라인 모델을 번들링하여 바이너리 빌드
```

---

## 💻 시스템 요구 사항

| 플랫폼 | 설치 파일 크기 | 권장 RAM |
| :--- | :--- | :--- |
| **Windows 10/11 x64** (완벽 지원) | 약 300MB (모델 내장) | 8GB+ (로컬 벡터 및 그래프 연산) |
| **macOS (Apple Silicon & Intel)** | 약 280MB | 8GB+ |
| **Linux (AppImage / deb)** (실험적) | 약 280MB | 8GB+ |

---

## 🤝 기여하기

커뮤니티의 기여를 진심으로 환영합니다! 버그 수정, 문서 개선, 새로운 도메인 툴 스키마 설계 등 언제든지 참여해 주세요.

Pull Request를 제출하기 전에 [기여 가이드라인](CONTRIBUTING.md) 을 확인해 주세요.

---

## 🙏 감사의 말

이 프로젝트는 거인들의 어깨 위에서 탄생했습니다: [Zettelkasten](https://luhmann.surge.sh/communicating-with-slip-boxes) · [Obsidian](https://obsidian.md/) · [sqlite-vec](https://github.com/asg017/sqlite-vec) · [Tauri](https://tauri.app/) · [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) · [DeepSeek](https://www.deepseek.com/)

---

## 📜 라이선스

Apache License 2.0 — 자유롭게 상업적 이용 및 수정이 가능합니다. **상업적 제품에 사용할 경우 원저작자의 저작권 표기를 유지해야 합니다.** 자세한 내용은 [LICENSE](LICENSE) 를 참조하세요.
