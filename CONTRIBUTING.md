# Contributing Guide

Thank you for your interest in ZettelAgent! This guide explains how to file issues, open pull requests, and collaborate on new features.

> **中文：** See [CONTRIBUTING_CN.md](CONTRIBUTING_CN.md) for the Chinese version.

---

## Two Audiences

| | **Git repo (developers)** | **GitHub Releases (end users)** |
|---|---------------------------|----------------------------------|
| Purpose | Read source, file issues/PRs, build locally | Download `.exe` / `.msi` and install |
| Node / Rust required | ✅ | ❌ |
| Embedding model download | Prepared automatically at build time | ❌ Bundled in the installer |

End users should download from [Releases](https://github.com/Poetrynan/ZettleAgent/releases). **No need to clone this repo.**

---

## Code of Conduct

- Be respectful and stay on topic
- Beginners are welcome — include version, OS, and repro steps when reporting issues
- For large changes (new agents, DB migrations, major UI work), **open an Issue first** to align before coding

---

## Reporting Bugs (Issues)

### Where to go

1. Open [Issues · Poetrynan/ZettleAgent](https://github.com/Poetrynan/ZettleAgent/issues)
2. Click **New issue**
3. Choose the **Bug Report** template

In the app: **Settings → About → Report an issue** (same page).

### Please include

| Field | Notes |
|-------|-------|
| Version | `v0.x.x` from Settings → About |
| OS | Windows 10/11, macOS, Linux |
| LLM provider | Ollama / DeepSeek / OpenAI, etc. (if relevant) |
| Steps to reproduce | Numbered, as specific as possible |
| Expected vs actual | What you expected vs what happened |
| Logs / screenshots | F12 → DevTools → Console, or attach screenshots |

### Good issue example

> **Title:** `[Bug]: Embedding fails during indexing, WASM timeout in console`  
> **Body:** v0.1.0 / Windows 11 / local embedding. Steps: Dashboard → Rebuild index → fails after ~30s. Expected: indexing completes. Actual: error toast. Console screenshot attached.

### When not to file a bug issue

- “How do I set up an API key?” → see README Quick Start
- “Can you add feature X?” → use **Feature Request**
- “It doesn’t work” with no repro steps

---

## Feature Requests

### Where to go

Issues → **New issue** → **Feature Request**

### Please describe

1. **Motivation:** What problem does this solve? Typical use case?
2. **Proposed solution:** How would you use it? (implementation details optional)
3. **Feature area:** Agent / Knowledge Graph / Canvas / Editor / Search, etc. (dropdown in template)
4. **Alternatives** (optional): Other approaches you considered

Maintainers will discuss roadmap fit, priority, and whether to split work across multiple PRs.

---

## Development Setup

### Prerequisites

| Tool | Recommended |
|------|-------------|
| [Node.js](https://nodejs.org/) | 20 LTS |
| [Rust](https://rustup.rs/) | stable (Tauri 2) |
| Windows build | Visual Studio Build Tools, WebView2 |
| macOS / Linux | See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

### Clone and run

```bash
git clone https://github.com/Poetrynan/ZettleAgent.git
cd ZettleAgent
npm install

# First-time setup: prepare offline assets (embedding model, WASM, fonts, …)
npm run download-model

npm run tauri dev      # Dev mode with hot reload
```

### Common commands

```bash
npm run tauri dev           # Development
npm run tauri build         # Release installer (includes build:prod)
npm run build:prod          # Frontend only: prepare assets + tsc + vite build
npm run verify-offline      # Check public/ + resources/ offline assets
npm run verify-offline:dist # Check dist/ + resources/
npm test                    # Vitest unit tests
npx tsc --noEmit            # TypeScript check
cd src-tauri && cargo check # Rust check
cd src-tauri && cargo clippy -- -D warnings
```

### Large assets

Embedding models, ORT WASM, UI fonts, etc. are **not in Git**. They are fetched/synced at build time by `scripts/download-model.cjs`.  
Running `npm run build` alone (without `download-model`) may miss assets; use `npm run build:prod` or `npm run tauri build` for a full build.

`src/lib/katex-inlined.css.ts` is a **small stub** in the repo. `build:prod` generates a ~1.4 MB local file — **do not commit the generated version**.

---

## Project Layout

```
ZettleAgent/
├── src/                    # React frontend (TypeScript)
│   ├── components/         # UI (settings, chat, canvas, dashboard, …)
│   ├── contexts/           # React contexts (AppContext, ChatContext, …)
│   ├── hooks/              # Custom React hooks (useSearch, useFileTree, …)
│   ├── lib/                # Utilities (embeddings, i18n, tauri wrappers, releaseConfig, …)
│   │   └── i18n/           # Language files (en.ts, zh.ts, …)
│   ├── styles/             # CSS (theme-tokens, module styles)
│   ├── test/               # Test setup (setup.ts)
│   └── types/              # TypeScript type declarations
├── src-tauri/              # Rust backend (Tauri)
│   ├── src/
│   │   ├── agents/         # Multi-agent orchestration
│   │   ├── commands/       # Tauri commands (frontend ↔ backend)
│   │   ├── db/             # SQLite, vector search
│   │   ├── import/         # Multi-format import (PDF, DOCX, CSV, OCR, …)
│   │   ├── llm/            # LLM calls, prompts, reasoning
│   │   ├── scheduler/      # Background task scheduling
│   │   └── tools/          # Built-in tools (internal_tools/) + MCP client
│   └── resources/          # Bundled installer assets (OCR, demo-vault, embed_models)
├── scripts/                # Build scripts (download-model, verify-offline, …)
├── .github/                # CI, issue/PR templates
└── public/                 # Static assets bundled by Vite (fonts, models, css, …)
```

**Rough split:**

- UI, interaction, i18n → `src/`
- File I/O, search, agents, database → `src-tauri/`
- Frontend ↔ backend via Tauri `invoke` (see `src/lib/tauri.ts` and `commands/`)

---

## Submitting a Pull Request

### 1. Fork and branch

```bash
# Fork Poetrynan/ZettleAgent on GitHub, then:
git clone https://github.com/<your-username>/ZettleAgent.git
cd ZettleAgent
git remote add upstream https://github.com/Poetrynan/ZettleAgent.git

git checkout -b feat/my-feature   # or fix/issue-123-xxx
```

Branch naming:

| Type | Prefix | Example |
|------|--------|---------|
| Feature | `feat/` | `feat/canvas-export-png` |
| Bug fix | `fix/` | `fix/embedding-timeout` |
| Docs | `docs/` | `docs/contributing-en` |
| Refactor | `refactor/` | `refactor/search-module` |

### 2. Develop and self-test

- [ ] `npx tsc --noEmit` passes
- [ ] `cd src-tauri && cargo check` passes
- [ ] Manually verify in `npm run tauri dev`
- [ ] UI changes: check light and dark themes
- [ ] User-facing strings: update `src/lib/i18n/en.ts` and `zh.ts` (and other locales if applicable)
- [ ] GitHub links: change only `owner` / `repo` in [`src/lib/releaseConfig.ts`](src/lib/releaseConfig.ts)

### 3. Commit messages

Clear English or Chinese is fine. Example:

```
feat(dashboard): add graph export PNG button

- Add exportGraphPng command
- Add en/zh i18n keys
```

### 4. Push and open PR

```bash
git push origin feat/my-feature
```

On GitHub, open **Compare & pull request** against `Poetrynan/ZettleAgent` → `main`.

The [Pull Request template](.github/pull_request_template.md) will appear — fill in:

- Description
- Change type (Bug fix / Feature / …)
- Related issues: `Fixes #123` or `Closes #456`
- Checklist items

### 5. After review

- Address feedback and push to the same branch
- Maintainers merge; then locally:

```bash
git checkout main
git pull upstream main
```

---

## Collaborating on New Features

Recommended for multi-person or large work:

```
Discuss Issue → divide / claim tasks → branch → small PRs → review → merge
```

### Step 1: Open an issue first

Use Feature Request and describe the need. In comments, maintainers and contributors can:

- Confirm scope (in / out)
- Split tasks (e.g. backend API + frontend UI + i18n as separate PRs)
- Claim work: “I’ll handle the backend”

### Step 2: Align on design (large features)

**Discuss before coding** when touching:

- New DB tables or migrations (`src-tauri/src/db/schema.rs`)
- New agents or built-in tools (`src-tauri/src/tools/`, `agents/`)
- Embedding dimensions or models (affects existing user indexes)
- New bundled assets that significantly increase installer size

Share API sketches, UI mockups, or pseudocode in the issue.

### Step 3: Small, focused PRs

- One PR, one concern — easier to review
- Example “graph export” split:
  1. `feat: add Rust export command`
  2. `feat: Dashboard export button + i18n`

### Step 4: Stay synced with main

For long-lived branches:

```bash
git fetch upstream
git rebase upstream/main   # or merge upstream/main
```

---

## Code Guidelines (summary)

Aligned with the [PR template](.github/pull_request_template.md):

| Area | Requirement |
|------|-------------|
| User-visible strings | Use `t('key')`; add keys in `src/lib/i18n/en.ts`, `zh.ts`, etc. |
| Styles | Use `theme-tokens.css` / CSS variables; avoid hardcoded colors |
| TypeScript | `strict` mode; avoid excessive `any` |
| Rust | Pass `cargo clippy`; use `crate::error` for errors |
| Writing to user notes | AI output in `<!-- @generated -->` blocks; never overwrite user content |
| New dependencies | Justify additions; mind installer size (local-first, minimal network) |

---

## Releases & CI (maintainers)

Contributors usually **do not** publish releases themselves:

- Push to `main` → CI runs TypeScript + Rust checks ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
- Tag `v*` → multi-platform installer build ([`.github/workflows/release.yml`](.github/workflows/release.yml))

---

## Getting Help

| Channel | Link |
|---------|------|
| Bugs / features | [Issues](https://github.com/Poetrynan/ZettleAgent/issues) |
| Design discussion | Comment on the relevant issue |
| Repository | [github.com/Poetrynan/ZettleAgent](https://github.com/Poetrynan/ZettleAgent) |

Thank you for contributing!
