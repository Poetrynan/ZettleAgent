# ZettelAgent 打包、开源与 Release Q&A

> 本文档整理自项目维护过程中的问答，原文保留，便于团队与贡献者查阅。  
> 第一句疑问：**什么意思？public 到 dist 是什么意思？**

---

## Q1：什么意思？public 到 dist 是什么意思？

**简要说：`public/` 是构建前的静态资源目录，`dist/` 是 Vite 打包后、最终打进安装包的前端产物目录。**

### 两个目录分别是什么

| 目录 | 谁用 | 什么时候存在 |
|------|------|-------------|
| **`public/`** | 开发者 / CI 在构建前放文件 | `npm run download-model` 之后 |
| **`dist/`** | Tauri 安装包里的前端 | `npm run build` / `build:prod` 之后 |

开发时，`download-model.cjs` 会把嵌入模型、WASM、字体等同步到 `public/`：

```209:229:scripts/download-model.cjs
function syncIntoPublic() {
  console.log('=== Sync into public/ (ships in installer via Vite dist/) ===\n');

  // Embedding model — must be in public/models so transformers.js loads it offline
  const publicModels = path.join(PUBLIC_DIR, 'models', 'nomic-ai', 'nomic-embed-text-v1.5');
  copyDir(EMBED_DIR, publicModels);
  // ...
  copyFile(src, path.join(PUBLIC_DIR, f));
  copyDir(path.join(WEBVIEW, 'fonts'), path.join(PUBLIC_DIR, 'fonts'));
  copyDir(path.join(WEBVIEW, 'css'), path.join(PUBLIC_DIR, 'css'));
```

Vite 打包时会把 `public/` **原样复制**到 `dist/`（和 React 编译后的 JS/CSS 一起）：

```6:12:src-tauri/tauri.conf.json
  "build": {
    "beforeBuildCommand": "npm run build:prod",
    "frontendDist": "../dist"
  },
```

所以链路是：

```text
download-model
    ↓
public/models/          ← 嵌入模型
public/ort-wasm-*.wasm  ← ONNX Runtime
public/fonts/           ← 字体
    ↓  npm run build:prod (tsc + vite build)
dist/models/            ← 同上，只是换了个目录名
dist/ort-wasm-*.wasm
dist/assets/*.js        ← React 应用代码
    ↓  tauri build
安装包里的 WebView 加载 dist/
```

### 为什么不是全放在 `resources/`？

Tauri 里其实有**两条**打包路径：

1. **`dist/`** — 前端 WebView 用的（嵌入、WASM、字体、PDF.js 等）
2. **`resources/`** — Rust 后端直接读的（OCR 模型、`demo-vault`）

```39:42:src-tauri/tauri.conf.json
    "resources": {
      "resources/ocr_models/*": "ocr_models/",
      "resources/demo-vault/*.md": "demo-vault/"
    },
```

前端在浏览器/WebView 里跑，通过 `./models/...` 这类 URL 加载文件，这些文件必须在 **`dist/`** 里；Rust 的 OCR 则在磁盘上读 **`$RESOURCE/ocr_models/`**，所以放在 `resources/`。

### 对用户意味着什么

- **Release 安装包**：两种资源都会被打进去，用户不需要再下载
- **Git 仓库**：大文件（嵌入模型、WASM）通常不在 Git 里，CI 构建时用 `download-model` 生成到 `public/`，再打包进 `dist/`
- **`public → dist`** 只是构建流水线的一步，不是让用户手动拷贝

---

## Q2：帮我查看一下，当前的项目文件，所需要的东西是否全部放进了 resource 里面，因为我要 Push 到 github 仓库开源，代码是给开发者看的，但是用户可以直接下载 release 里的安装包，安装后开箱即用，不用下载任何东西和依赖。

已把项目的资源打包链路完整查了一遍。结论先说：**Release 安装包的设计是「构建时凑齐、运行时零下载」**，但**并不是所有东西都放在 `src-tauri/resources/` 里**；而且当前仓库里有几处会在 Push / CI 打 Release 时出问题。

---

### 安装包里实际包含什么

Release 安装包 = **Vite 前端 `dist/`** + **Tauri 额外资源 `resources/`**（见 `tauri.conf.json`）：

| 资源 | 构建时来源 | 打进安装包的路径 | 是否在 Git |
|------|-----------|-----------------|-----------|
| 嵌入模型 nomic-v1.5 (~131MB) | `download-model` → `public/models/` | `dist/models/` | ❌ gitignore |
| ONNX Runtime WASM (~35MB) | `download-model` → `public/` | `dist/ort-wasm-*` | ❌ gitignore |
| UI 字体 / KaTeX / highlight CSS | `download-model` → `public/` | `dist/fonts/` `dist/css/` | ❌ gitignore |
| PDF.js | `download-model` → `public/` | `dist/pdf*.mjs` | ⚠️ 部分在 Git |
| PP-OCR 模型 | `resources/ocr_models/` | `$RESOURCE/ocr_models/` | ⚠️ **文件损坏** |
| Demo 知识库 | `resources/demo-vault/` | `$RESOURCE/demo-vault/` | ❌ **未提交** |
| KaTeX 导出 CSS | `build:prod` 生成 | 编译进 JS | stub 在 Git |

前端嵌入路径在 `embeddings.ts` 里写死了本地加载，不会连 HuggingFace：

```10:15:src/lib/embeddings.ts
env.allowLocalModels = true;
env.allowRemoteModels = false;

// Vite `base: './'` → works with Tauri asset protocol in installed apps
const assetBase = import.meta.env.BASE_URL;
env.localModelPath = `${assetBase}models/`;
```

**CI Release 流程是对的**：`npm run download-model` → `verify-offline` → `tauri build`（`beforeBuildCommand: build:prod`）。你本机跑 `verify-offline` 已通过，说明**本地构建出来的安装包**在嵌入/WASM/字体方面是齐的。

---

### 当前 Git 仓库里 `resources/` 的真实状态

```text
src-tauri/resources/
├── node/           ← Git 里有 node.exe (~85MB)，但 tauri.conf 未打包，本地磁盘上也不存在
├── ocr_models/     ← Git 里有，但 det.onnx / rec.onnx 是 GitHub HTML 404 页，不是 ONNX
└── demo-vault/     ← 磁盘上有 14 篇笔记，但是 ?? 未跟踪
```

**embed_models/** 和 **webview/** 被 `.gitignore` 排除——这是刻意的，由 `scripts/download-model.cjs` 在 CI 构建时拉取。

---

### 发现的问题（按严重程度）

#### 1. 🔴 OCR 模型无效（会直接影响「开箱即用」）

`det.onnx` 和 `rec.onnx` 各 305KB，大小完全相同，内容是 GitHub 登录/404 HTML，不是 ONNX 二进制。  
来源像是有人用浏览器「另存为」了 `hpc203/paddleocr-onnxrun` 的 raw 链接。

- 验证脚本只检查**文件是否存在**，不校验格式
- CI 的 `test -f det.onnx` 会通过
- 用户离线 OCR（图片导入、PDF 扫描页）会失败；有 Vision LLM 时会走 API 兜底

#### 2. 🔴 `demo-vault` 未提交 Git

首次启动会复制 demo 知识库（`file_commands.rs`）。  
Push 后 CI 跑 `download-model` 会在 `verifyInstallerAssets()` 里因缺少 demo 而**构建失败**。

#### 3. 🟡 大资源 intentionally 不在 Git（设计 OK，文档要对）

嵌入模型、WASM、字体等**不应**进 Git（体积 ~200MB+）。  
开发者 clone 后需 `npm run download-model`；Release CI 会自动跑。  
这和 CONTRIBUTING 里的说明一致。

#### 4. 🟡 `resources/node/node.exe` 是遗留物

Git 里跟踪了 ~85MB 的 node.exe，但：
- `tauri.conf.json` 没有打包它
- 代码里也没有引用
- `download-model.cjs` 注释写 MCP 用 Remote SSE，不需要本地 Node

Push 开源会让 clone 体积虚增，建议删除或改用 Git LFS + 明确用途。

#### 5. 🟢 用户仍需自行配置（合理，不算缺失）

| 能力 | 是否需要用户额外准备 |
|------|---------------------|
| LLM 对话 / Agent | ✅ 需 API Key 或本地 Ollama |
| MCP 扩展 | ✅ 需远程 SSE URL + Key |
| 联网搜索 | ✅ 需网络 |
| 向量嵌入 / FTS / OCR（修复后）| ❌ 安装包自带 |

---

### 推 GitHub 开源 + 发 Release 前建议清单

**必须做：**

1. **替换 OCR 模型** — 下载真正的 `ch_PP-OCRv4_det_infer.onnx` / `ch_PP-OCRv4_rec_infer.onnx`（各约 4–10MB），替换 `resources/ocr_models/` 里现在的 HTML 文件  
2. **提交 `demo-vault/`** — 14 篇 demo 笔记应进 Git  
3. **在 `download-model.cjs` 里增加 OCR 下载 + ONNX 魔数校验**（例如文件头不是 `<!DOCTYPE` / 大小 > 1MB），避免以后再误提交 HTML

**建议做：**

4. 删除或移出 `resources/node/`（若确认不再用本地 MCP Node）  
5. Push 前在干净环境跑一遍完整链路：
   ```bash
   npm ci
   npm run download-model
   npm run verify-offline
   npm run verify-offline:dist   # 需在 vite build 之后
   npm run tauri build
   ```
6. 安装 Release 包后实测：向量索引、图片 OCR、PDF 导入、无网络下能否打开

**不必做：**

- 不必把 131MB 嵌入模型 commit 进 Git — CI `download-model` 已覆盖  
- 不必把所有东西塞进 `resources/` — 前端资源走 `public/` → `dist/` 是正确设计

---

### 总结

| 问题 | 答案 |
|------|------|
| 是否全部放在 `resources/`？ | **否**。大约 70% 离线资源走 `public/` → `dist/`，只有 OCR + demo-vault 走 Tauri `resources/` |
| Release 能否零下载开箱即用？ | **架构上可以**，CI 链路完整；但 **OCR 模型损坏 + demo-vault 未提交** 会阻断或削弱实际体验 |
| 开发者 clone 后能否直接 build？ | 需 `npm run download-model`；OCR 和 demo 需先修复/提交 |

如果你愿意，我可以下一步直接帮你：**修复 OCR 下载脚本、加 ONNX 校验、并把 demo-vault 纳入 Git 跟踪**。

---

## Q3：resources/node/node.exe 是遗留物那就删了啊

已从 Git 中移除遗留的 `resources/node/` 目录，包含：

- `src-tauri/resources/node/node.exe`（约 85MB）
- `src-tauri/resources/node/npm.cmd`
- `src-tauri/resources/node/npx.cmd`

代码里没有引用这些文件，`tauri.conf.json` 也未打包它们；MCP 仍走 Remote SSE，不依赖本地 Node。

删除已暂存（`git status` 会显示 3 个 `D`）。需要提交时可以说一声，我帮你写 commit message。

---

## Q4：我本来就不打算把嵌入模型 commit 进 git 啊！你是不是没理解我的意思？我是要把本项目开源，所以代码我会完全上传，方便开发者和其余开发者来贡献。但是针对用户，我需要他们下载 setup.exe 打开后，安装后，直接就能用，什么都不用管，所以我才问你需不需要全部放进 resource

理解了，之前那句「不必 commit 嵌入模型」是在重复你已经定好的策略，不是没听懂你的目标。

你的目标可以拆成两条线：

| 受众 | 要什么 |
|------|--------|
| **GitHub 开源** | 代码全上传，方便 clone、贡献、自己 build |
| **Release 用户** | 下 `setup.exe` → 安装 → 直接用，**不再下载模型/依赖** |

这两件事**不冲突**，也**不需要**把所有东西都塞进 `resources/`。

### 直接回答：要不要全部放进 `resources/`？

**不需要。**  
用户装完就能用，靠的是 **Release 安装包本身已经打包了所有离线资源**，不是 Git 里有没有这些文件。

当前设计已经是「安装包内自带、运行时零下载」：

```text
CI / 本地打 Release：
  npm run download-model     ← 构建时拉嵌入模型、WASM、字体（不进 Git，没问题）
  npm run build:prod         ← public/ → dist/
  tauri build                ← 打 setup.exe

安装包内容 ≈
  dist/          ← 嵌入模型、ORT WASM、字体、PDF.js、React 前端
  resources/     ← OCR、demo-vault（Rust 后端直接读）
```

用户装完后，WebView 从安装目录里的 `dist/models/` 读嵌入模型，Rust 从 `$RESOURCE/ocr_models/` 读 OCR——**都在 exe 旁边，不用再下任何东西**。

所以：

- **Git**：只放源码 + 小资源（OCR、demo-vault 等），**不放** 131MB 嵌入模型 —— 这完全符合你的开源策略  
- **setup.exe**：CI 在 build 时 `download-model`，把大文件**打进安装包** —— 这才是用户「开箱即用」的来源  

**`public → dist`** 只是 Vite 打包步骤：构建时把离线资源复制进前端产物，再和 Tauri 一起打进 exe。用户永远看不到这两个目录。

### 你需要保证的只有一件事

**Release 流水线必须跑完整 build**，不能只用 `npm run build`（会缺模型）：

```bash
npm ci
npm run download-model   # 或 tauri build（会触发 build:prod，里面含这步）
npm run tauri build
```

你的 `.github/workflows/release.yml` 已经这么做了，架构是对的。

### 和用户「什么都不用管」还差什么？

**打包层面**（装完 offline 能用）还缺两处要修，否则即使用户下了 setup.exe，部分功能也会坏：

1. **OCR 模型** — Git 里当时是 GitHub 404 的 HTML，不是真 ONNX，要换成真实文件（可 commit 进 Git，体积不大）
2. **demo-vault** — 还没 commit，CI 打 Release 可能直接失败

**产品层面**（合理、不算打包问题）：

- 对话 / Agent 仍要配 **LLM API Key** 或本地 Ollama  
- MCP、联网搜索要网络  

这些没法也不该打进安装包。

### 一句话总结

你不是要把嵌入模型 commit 进 Git；你是要确保 **Release 安装包**里已经包含一切离线资源。  
**不用全部放进 `resources/`**——前端大资源走 `dist/`，后端小资源走 `resources/`，两条路最后都进 setup.exe 就行。

---

## Q5：我明白了，第一次发包，不用 Git，但是后面更新项目，有什么新功能了，就是跟 git 有关？

你的理解**大体对**，可以再精确一点：

### 第一次发包

**可以完全不依赖 GitHub 上的 Git。**

你在本机只要有：

- 完整源码
- `npm run download-model` 拉好的嵌入模型 / WASM
- 磁盘上的 `demo-vault`、OCR 等资源
- 跑通 `npm run tauri build`

就能打出 `setup.exe`，手动上传到 Release。**第一次不必先 push 仓库。**

---

### 后面更新项目

**如果你用 Git + CI 自动打 Release，就跟 Git 强相关了。**

典型流程：

```text
改代码 / 加功能
    ↓
commit + push 到 GitHub
    ↓
打 tag（如 v0.2.0）
    ↓
GitHub Actions 从 Git 拉代码 → build → 上传新 setup.exe
    ↓
用户下载新版本
```

这时 CI **只能用到 Git 里有的东西**：

| Git 里有 | CI 能打出来的包 |
|---------|----------------|
| 新功能代码 | ✅ 有 |
| `demo-vault/` | ✅ 安装包带 demo |
| Git 里没有 demo-vault | ❌ 构建失败或安装包缺 demo |
| 嵌入模型（不 commit） | ✅ 没问题，CI 会 `download-model` |

所以：**后面每次更新，安装包内容 = 那次 push/tag 对应的 Git 快照 + CI 构建脚本。**

---

### 两种发版方式对比

| | 第一次 / 手动发版 | 后面常规更新（推荐） |
|--|------------------|---------------------|
| 要不要 Git | 可选 | 要（至少 CI 要从仓库拉代码） |
| 谁 build | 你本机 | 本机 或 GitHub Actions |
| 资源从哪来 | 你本机磁盘 | Git 里的代码 + `download-model` 下载大文件 |
| 协作 | 无 Git 很难多人贡献 | push / PR / tag 自动发版 |

---

### 一句话

- **第一次**：本机能 build 就能发包，Git 不是硬性要求。  
- **后面更新**：代码、demo-vault、OCR 等小资源最好在 **Git 里**；大模型继续 **构建时下载**；用户始终只下 **setup.exe**，不用管 Git。

Git 管的是**开发者和 CI 怎么 reproducible 地打出同一个安装包**，不是让用户去 clone 仓库。

---

## Q6：那嵌入模型咋办？又没法上传到 github 仓库

**嵌入模型不用进 GitHub 仓库**，你们项目里已经有一套标准做法：**构建时下载，打进安装包**。

### 实际流程

```text
Git 仓库（只有源码，没有 131MB 模型）
        ↓
CI 或本机执行 npm run download-model
        ↓
从 HuggingFace 下载 nomic-embed-text-v1.5
        ↓
写到 public/models/  →  vite build  →  dist/models/
        ↓
tauri build 把 dist/ 打进 setup.exe
        ↓
用户安装后，模型已在本地，不再联网下载
```

脚本里已经写死了来源和路径：

```27:33:scripts/download-model.cjs
const EMBED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
];
const EMBED_BASE = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/';
```

`.gitignore` 也排除了这些大文件，避免误 commit：

```54:62:.gitignore
# Large RELEASE assets (build-time only, NOT for git)
src-tauri/resources/embed_models/
src-tauri/resources/webview/
public/models/
public/ort-wasm-simd-threaded*.wasm
```

Release CI 会在打安装包前自动跑这一步：

```71:72:.github/workflows/release.yml
      - name: Prepare installer assets (build-time)
        run: npm run download-model
```

---

### 三方各自要什么

| 角色 | 要不要碰嵌入模型文件 |
|------|---------------------|
| **GitHub 仓库** | ❌ 不放（太大，也无需放） |
| **CI / 你本机 build** | ✅ 构建时 `download-model` 拉一次 |
| **用户 setup.exe** | ✅ 已内置，装完即用 |

---

### 和 demo-vault 的区别

| 资源 | 大小 | 放 Git？ | 怎么进安装包 |
|------|------|---------|-------------|
| demo-vault | ~几十 KB | ✅ 建议 commit | `resources/` 直接打包 |
| 嵌入模型 | ~131 MB | ❌ 不放 | **构建时下载** → `dist/` |
| ORT WASM | ~35 MB | ❌ 不放 | 从 `node_modules` 复制 + 同上 |

小文件适合进 Git；大文件适合 **build 时拉，release 时打进 exe**。

---

### 你需要做的

1. **仓库里保留** `scripts/download-model.cjs`（已在）
2. **Release 前确保 CI 跑** `download-model`（`release.yml` 已在）
3. **不要**把 `public/models/` commit 进 Git

第一次本机发包：

```bash
npm ci
npm run download-model   # 本机拉模型，只需一次（有缓存可复用）
npm run tauri build      # 打出 setup.exe
```

之后每次发版：push 代码 → 打 tag → CI 自动下载模型并打包，**仍然不用把模型 upload 到 GitHub**。

---

### 唯一要注意的

- **打 Release 的机器要能访问 HuggingFace**（GitHub Actions 一般可以）
- 若 HuggingFace 不稳定，可以以后把模型放到 **GitHub Release Assets / 自建镜像**，改 `download-model.cjs` 的 URL，逻辑不变：**构建时下载，不进 Git 源码仓库**

总结：**嵌入模型不进 Git 是对的；进的是安装包，不是仓库。**

---

## Q7：所以我 git 不 git demo-vault 有什么影响吗？他也是要和安装包一起的啊

**不 commit `demo-vault` 不影响「用户装完有没有 demo」的逻辑，但会影响「你能不能稳定打出带 demo 的安装包」。**

### 两件事要分开看

| | Git 仓库 | Release 安装包 |
|--|---------|----------------|
| **给谁用** | 开发者 clone、CI 构建 | 最终用户下载 setup.exe |
| **demo-vault 要不要有** | 构建时机器上要有 | 安装包里要有 |

用户只关心安装包里有没有，**不关心** Git 里有没有。  
但 **CI 是从 Git clone 的**——Git 里没有，`release.yml` 那台机器上就没有，构建会挂或装包缺 demo。

---

### 不 commit 的具体影响

**1. GitHub Actions 打 Release 会失败或缺 demo**

CI 会检查 demo 是否存在：

```65:67:.github/workflows/release.yml
          test -f src-tauri/resources/ocr_models/det.onnx
          test -f src-tauri/resources/ocr_models/rec.onnx
          ls src-tauri/resources/demo-vault/*.md | head -1
```

`download-model` 也会校验：

```271:276:scripts/download-model.cjs
  const demo = path.join(RESOURCES, 'demo-vault');
  const demoN = fs.existsSync(demo) ? fs.readdirSync(demo).filter((f) => f.endsWith('.md')).length : 0;
  if (demoN < 1) {
    console.error('✗ Missing demo-vault notes');
    process.exit(1);
  }
```

Git 里没有 → clone 后没有 → **Release 构建失败**。

**2. 其他开发者 clone 后本地打安装包也会缺 demo**

和你不 commit 嵌入模型一样：clone 后本地没有，除非自己补或脚本生成。

**3. 已经发出去的 setup.exe 不受影响**

如果某次是在「本机有 demo-vault」时打出来的包，用户装完照样有 demo。问题在 **以后** 每次从 Git 自动打 Release。

---

### 和嵌入模型的对比

| 资源 | 是否 commit Git | 怎么进安装包 |
|------|----------------|-------------|
| 嵌入模型 (~131MB) | ❌ 不 commit | CI 里 `download-model` 构建时下载 → 打进 `dist/` |
| demo-vault (~14 篇 md) | 目前 ❌ 未 commit | 只能依赖「构建时磁盘上已有」→ **应 commit 或 build 脚本生成** |
| OCR | ✅ commit（但要修成真 ONNX） | `tauri.conf` 打进 `resources/` |

嵌入模型太大，适合 **构建时下载**。  
demo-vault 很小，**直接 commit 进 Git 最简单**，和 OCR 一样。

---

### 结论

- **必须进安装包** → 对，已通过 `tauri.conf.json` 的 `resources/demo-vault/*.md` 打包。  
- **是否必须进 Git** → 不是绝对必须，但 **要么 commit，要么在 `download-model` 里生成/下载**；否则 CI 从空仓库 clone 后打不出带 demo 的包。

**推荐：把 `demo-vault/` commit 进 Git**（14 个 md，体积小，和 OCR 同一套路）。  
若坚持不进 Git，就要在 `download-model.cjs` 里加一步「构建时创建/拉取 demo-vault」，效果和 commit 一样，只是多维护一段脚本。

---

## Q8：我明白了，那既然这样，我完全可以把 vault 也打进安装包啊？

对，**完全可以**，而且你们**本来就是这么设计的**——demo 知识库会打进安装包，只是和嵌入模型走的路径不同。

### 先分清两件事

| | 要不要进 **Git** | 要不要进 **setup.exe** |
|--|------------------|------------------------|
| 嵌入模型 | ❌ 不必 | ✅ 要 |
| demo-vault | 可选 | ✅ 要 |

**进不进 Git** 和 **进不进安装包** 是两回事。  
嵌入模型是：**不进 Git，但进安装包**（构建时下载再打包）。  
demo-vault **同样可以**：**不进 Git，也进安装包**——只要构建时机器上能拿到那 14 篇 md。

---

### demo-vault 现在怎么进安装包？

`tauri.conf.json` 已经配置了：

```json
"resources": {
  "resources/ocr_models/*": "ocr_models/",
  "resources/demo-vault/*.md": "demo-vault/"
}
```

用户装完后，demo 在 `$RESOURCE/demo-vault/`，首次打开会复制到用户文档目录。  
**和 Git 有没有 commit 无关**，只和 **打 setup.exe 时** `resources/demo-vault/` 里有没有文件有关。

---

### 和嵌入模型对比（同一套逻辑）

```text
嵌入模型：
  Git ❌  →  build 时 download-model 从 HuggingFace 拉  →  进 dist/  →  进 setup.exe ✅

demo-vault（两种做法都行）：
  做法 A：Git ✅ commit 14 篇 md  →  CI clone 就有  →  进 resources/  →  进 setup.exe ✅
  做法 B：Git ❌  →  build 脚本里 copy/下载 demo  →  进 resources/  →  进 setup.exe ✅
```

所以你的理解是对的：**既然嵌入模型可以「不进 Git、只进安装包」，demo-vault 也可以。**

---

### 那为什么之前说 demo-vault 最好 commit？

不是因为「必须进 Git 才能进安装包」，而是因为：

| | 嵌入模型 ~131MB | demo-vault ~14 个 md |
|--|----------------|----------------------|
| 体积 | 大 | 很小 |
| 构建时从哪来 | 必须从 HuggingFace 拉 | 放 Git 最简单，不必再写下载脚本 |
| CI clone 后 | `download-model` 会拉 | 若不在 Git、脚本也不生成 → **CI 没有文件，打不出包** |

**问题不在「能不能打进安装包」，而在「CI 构建时文件从哪来」。**

---

### 一句话

- ✅ demo-vault **应该**和安装包一起给用户（已配置好）
- ✅ **不必**为了进安装包而 commit 进 Git
- ⚠️ 若不 commit，就要像嵌入模型一样：**在 `download-model.cjs` 或 CI 里保证构建前 `resources/demo-vault/` 有内容**

demo-vault 很小，commit 进 Git 最省事；若你坚持 Git 只放代码，加几行 build 脚本 copy demo 也行，效果和嵌入模型一样。

（这里说的是 **demo-vault** 示例库，不是用户自己的笔记库——用户数据存在本机 AppData，不会也不该打进安装包。）

---

## Q9：我以后每次更新了新功能，是不是都要重新打包？

**是的。** 桌面应用（Tauri）发新功能，通常都要 **重新 build → 打出新的 setup.exe → 用户装新版本**。这和「嵌入模型不进 Git」不矛盾——每次打包时 CI 会再跑一遍 `download-model`，把模型重新打进新安装包。

### 为什么每次都要重新打包？

用户装的是 **编译好的 exe + 前端 dist + resources**，不是从你的 Git 拉代码。  
你改了 React 界面、Rust 逻辑、Agent 行为，旧安装包里的二进制不会自己变，只能发新包。

```text
你：改代码 → push → 打 tag（如 v0.2.0）→ CI 重新 tauri build
用户：设置里看到有新版本 → 去 GitHub Releases 下新的 setup.exe → 安装覆盖/升级
```

你们已有 **检查更新 + 跳转下载**（`UpdateChecker`），**不是**安装后自动静默升级；用户要自己下新安装包。

---

### 每次打包会自动带上什么？

| 内容 | 每次 build 怎么处理 |
|------|---------------------|
| 新功能代码 | ✅ 重新编译进 exe / dist |
| 嵌入模型、WASM | ✅ CI 再跑 `download-model`（不必在 Git 里） |
| demo-vault、OCR | ✅ 从 `resources/` 再打进包（构建时磁盘/Git 里要有） |
| 用户笔记、API Key、聊天历史 | ❌ **不会**打进包，留在本机 AppData |

用户升级安装包 **不会丢笔记和配置**，那些存在应用数据目录，和安装包是分开的。

---

### 你需要做的节奏（常规）

1. 开发、测试功能  
2. 改 `package.json` / `tauri.conf.json` 里的 **version**（如 `0.1.0` → `0.2.0`）  
3. commit + push  
4. 打 tag：`v0.2.0` → 触发 `release.yml` 自动 build  
5. 在 GitHub Releases 发布新的 `.msi` / `.exe`  

**不是**改一行代码就手动打包；可以攒一批功能，发一个版本。

---

### 以后能不能不让用户每次手动下安装包？

可以，但要额外做 **Tauri Updater**（差分更新、后台下载替换）。你们现在是「提示有新版本 → 打开 Releases 下载」，对开源桌面软件很常见，也够用。

---

**一句话：** 新功能 = 新版本 = 重新打包发 Release；用户下新 setup 即可。嵌入模型每次 build 时自动下载打进包，不用 upload 到 GitHub 源码仓库。

---

## Q10：替换 OCR 模型 — 下载真正的 ch_PP-OCRv4_det_infer.onnx / ch_PP-OCRv4_rec_infer.onnx（各约 4–10MB），替换 resources/ocr_models/ 里现在的 HTML 文件

已完成 OCR 模型替换，并更新了构建校验逻辑。

### 已替换的文件

| 文件 | 之前 | 现在 |
|------|------|------|
| `det.onnx` | 305KB（GitHub HTML） | **4.5 MB** 真实 PP-OCRv4 det |
| `rec.onnx` | 305KB（GitHub HTML） | **10.4 MB** 真实 PP-OCRv4 rec |

来源：[SWHL/RapidOCR](https://huggingface.co/SWHL/RapidOCR)（Apache 2.0）

### 脚本更新

**`scripts/download-model.cjs`**
- 新增 `prepareOcrModels()`：构建时自动下载 OCR（HuggingFace + `hf-mirror.com` 备用）
- 增加 ONNX 校验：拒绝 HTML 误提交、检查最小体积

**`scripts/verify-offline-assets.cjs`**
- OCR 检查改为「存在 + 有效 ONNX」，不再只检查文件在不在

`verify-offline` 已通过。

### 关于 Git

OCR 两个文件合计约 **15MB**，可以：
- **commit 进 Git** — CI 不用每次重新下载（推荐，和 demo-vault 一样）
- **不 commit** — CI 跑 `download-model` 时会自动拉取

两种方式安装包都能带上 OCR。需要 commit 时告诉我一声。

---

## Q11：scripts/download-model.cjs 我没懂这个有什么用，我们不是会本地打包好后上传 git release，然后用户下载我们的安装包安装后就能用吗？为什么这里面还有 hugging face 的链接，看起来好像是要用户去自己下载？

**不是给用户用的。** `download-model.cjs` 只在**你们打安装包时**跑，用户装完 `setup.exe` 之后**永远不会**碰到 HuggingFace，也**不会**运行这个脚本。

---

### 两条完全不同的链路

```text
【开发者 / CI 打 Release】                    【终端用户】
        │                                          │
        │  npm run download-model                  │  从 GitHub Releases
        │       ↓                                  │  下载 setup.exe
        │  从 HuggingFace 拉模型（构建机联网）      │       ↓
        │       ↓                                  │  安装
        │  写入 public/ + resources/               │       ↓
        │       ↓                                  │  打开即用（模型已在包内）
        │  vite build → dist/                     │
        │       ↓                                  │
        │  tauri build → setup.exe                 │
        │       ↓                                  │
        └──── 上传到 GitHub Release ──────────────→ 用户下载
```

HuggingFace 链接是给**打包那台电脑**（或 GitHub Actions）用的，不是给用户点的。

---

### 为什么要有这个脚本？

| 问题 | 做法 |
|------|------|
| 嵌入模型 ~131MB，不想 commit 进 Git | 构建时从 HuggingFace **下载一次** |
| 用户安装后要离线能用 | 下载结果 **打进 setup.exe** |
| 用户 clone 源码自己 build | 同样跑这个脚本，本地准备资源 |

所以：

- **Git 仓库**：源码 + 小文件（OCR、demo-vault 等）  
- **安装包**：源码编译结果 + 模型 + WASM + 字体（全在里面）  
- **`download-model.cjs`**：把「大文件从网上下到本地，以便打进安装包」这一步自动化  

---

### 和用户的关系

用户流程始终是：

```text
Releases 下载 setup.exe → 安装 → 打开就用
```

用户**不需要**：

- 运行 `npm run download-model`  
- 访问 HuggingFace  
- 装 Node.js / 自己下模型  

脚本里的 URL 只是写明了：**构建时模型从哪拉**。就像 Dockerfile 里的 `apt install`——是构建镜像的人用，不是最终用户用。

---

### 和你们 workflow 的对应关系

`tauri.conf.json` 里：

```json
"beforeBuildCommand": "npm run build:prod"
```

而 `build:prod` = `download-model` + 编译前端。  
所以无论是你本机 `npm run tauri build`，还是 CI 打 tag，都会**先**跑这个脚本，**再**打出含模型的安装包。

---

### 一句话

**`download-model.cjs` = 打包流水线上的「进料」步骤，不是用户安装后的「补料」步骤。**  
HuggingFace 链接存在，是因为大模型不进 Git，只能在**打 Release 时**由脚本下载并封进安装包；用户只下你们的 `setup.exe` 就行。

---

## Q12：可是我们本地已经下载好了啊，放进 resource 里了，为什么还要构建时从 hugging face 下载呢？

你的理解有一半对：**本地已经有了，构建时通常不会再从 HuggingFace 拉**。脚本里的 URL 是给「本地还没有文件」的情况准备的（比如 CI、新电脑 clone）。

---

### 1. 本地已有 → 会跳过下载

`download()` 里有这段逻辑：

```105:109:scripts/download-model.cjs
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  ✓ exists: ${path.basename(dest)}`);
      return resolve();
    }
```

你本机 `resources/embed_models/` 或 `public/models/` 里已经有模型时，跑 `download-model` 会打印 `✓ exists`，**不会联网**。  
HuggingFace 链接只是：**文件不存在时的备用来源**，不是每次构建都下。

---

### 2. 嵌入模型并不只靠 `resources/` 进安装包

这里容易误会。`tauri.conf.json` 里 **只**打包了：

```39:42:src-tauri/tauri.conf.json
    "resources": {
      "resources/ocr_models/*": "ocr_models/",
      "resources/demo-vault/*.md": "demo-vault/"
    },
```

**没有** `embed_models/`。

嵌入模型实际路径是：

```text
resources/embed_models/     ← 你本地放的地方（暂存）
        ↓  syncIntoPublic()（脚本里复制，不是下载）
public/models/              ← 前端要读的路径
        ↓  vite build
dist/models/                ← 打进 setup.exe 的前端部分
```

所以脚本除了「缺了就从网上下」，还要做 **`embed_models` → `public/models` 的同步**，以及 WASM/字体等复制。  
即使你从不联网，这一步仍然需要。

---

### 3. 为什么还留着 HuggingFace 链接？

| 场景 | 本地有文件？ | 脚本行为 |
|------|-------------|----------|
| 你本机第二次打包 | ✅ 有 | 跳过下载，只 copy + 校验 |
| GitHub Actions 打 Release | ❌ clone 后没有（被 gitignore） | 必须从 HuggingFace 拉 |
| 新同事 clone 仓库 | ❌ 没有 | 第一次跑脚本会拉 |
| 你删了 `public/models` 再 build | ❌ 缺 | 从 `embed_models` 复制或重新拉 |

链接是给 **Git 里没有大模型、但 CI/新人要能 reproducible 打出安装包** 用的，不是给用户用的。

---

### 4. 和你说的流程怎么对应

```text
你：本地已有模型 → npm run tauri build
         ↓
    download-model：看到文件存在 → 不访问 HuggingFace
         ↓
    复制到 public/ → vite → dist/ → 打进 setup.exe
         ↓
    上传 GitHub Release
         ↓
用户：只下 setup.exe，完全离线
```

**用户永远不需要 HuggingFace。**  
**你本地已有文件时，通常也不需要再下。**

---

### 一句话

脚本 = **「缺了就从网上补 + 不管从哪来的都复制到 public 再打包」**。  
URL 不是「每次构建都要用户/开发者手动去 HuggingFace 下」，而是 **CI 和首次 clone 的自动补货**；你本地已经下好放进 `resources/embed_models/` 的话，构建时只会看到 `✓ exists`，然后 copy 进安装包。

---

## Q13：假如开源后只有我一个人在维护，所以你现在保证，我每次本地修改好，在我不删除任何模型和依赖的情况下，是不是每次打包好后直接上传安装包就行，用户下载后就直接用就行，什么都不用管？

可以，**在你不删模型和依赖、且本地 build 成功的前提下**，每次改完代码 → 本地打包 → 上传 Release 安装包，用户装完就能用，**不用再下模型、不用装 Node/Docker**。

下面把「你能保证的」和「用户仍要配置的」分开说清楚。

---

### 你能保证的（安装包层面）

只要你本地打包前这些还在：

| 本地要有 | 作用 |
|---------|------|
| `resources/embed_models/` 或 `public/models/`（嵌入模型） | 打进 `dist/`，离线向量 |
| `public/ort-wasm-*` 等 | 打进 `dist/`，WASM 推理 |
| `resources/ocr_models/det.onnx`、`rec.onnx` | 打进安装包，离线 OCR |
| `resources/demo-vault/` | 首次启动 demo 库 |
| `node_modules/`（`npm ci` 过） | 构建用，不进安装包 |

然后跑：

```bash
npm run tauri build
```

（会自动跑 `build:prod` → `download-model`：有文件就 **✓ exists 跳过下载**，只做复制和校验 → 再 vite → 再 tauri）

打出来的 **setup.exe / msi** 里已经包含：嵌入模型、ORT WASM、字体、KaTeX、PDF.js、OCR、demo-vault、应用代码。

**用户：下载 → 安装 → 打开**，不需要 HuggingFace、不需要再跑任何脚本。

你一个人维护、不用 GitHub Actions 也行：**本机 build + 手动上传 Release** 完全够用。

---

### 用户仍要「管」的（产品本身，不是打包问题）

这些**没法也不该**打进安装包：

| 项目 | 说明 |
|------|------|
| **LLM API Key** | 对话/Agent 要配 OpenAI、Claude、Ollama 等 |
| **自己的笔记库** | 用户数据在 AppData，不在安装包里 |
| **联网搜索 / MCP** | 可选，需要网络和 URL |

所以更准确的说法是：

> 用户装完 **离线能力**（搜索索引、OCR、demo）开箱即用；**AI 对话**还要在设置里配一次 API。

---

### 你每次发版建议固定做 3 步

1. 改版本号（`package.json` / `tauri.conf.json` 里的 `version`）  
2. `npm run tauri build`（看到成功、体积大概 ~300MB 量级）  
3. 把 `src-tauri/target/release/bundle/` 里的安装包上传到 GitHub Releases  

可选：跑 `npm run verify-offline` 确认模型没坏（比如 OCR 不是 HTML）。

---

### 什么情况会打破「用户零下载」

只有你这边出问题才会，例如：

- 删了 `public/models/` 且 `resources/embed_models/` 也空了 → build 失败或装包缺模型  
- OCR 又换成坏文件 → OCR 功能挂（嵌入仍可用）  
- 只跑 `npm run build` 不跑完整 `tauri build` → 可能缺资源  
- 上传了旧/错的安装包  

**不删模型、走 `tauri build`、build 成功再上传** → 对用户就是零额外下载。

---

### 一句话承诺

**是：** 你本地维护、不删模型和依赖、每次 `tauri build` 成功再上传 Release，用户只下你的安装包就能用，不用再下任何模型或依赖。  
**唯一例外：** 用 AI 对话要在设置里配 LLM API（一次配置，和打包无关）。

---

## Q14：但对于其他开发者呢？假如有很多人维护呢？他们怎样做呢？首先我是第一个创始人，所以其余开发者最开始肯定是用户，他们要下载安装包后安装，然后对着源码改，添加新功能，最终又 push 到仓库 我来审核，审核后合并到 main，对吧？那对于他们呢？

你的大方向对，但有一个关键点需要纠正：**其他开发者一般不是「先装 Release 再改源码」**，而是 **clone 仓库 + 配开发环境**。安装包主要是给**纯用户**用的。

---

### 三种角色

| 角色 | 要什么 | 怎么做 |
|------|--------|--------|
| **普通用户** | 会用就行 | 只下 Releases 安装包，不碰 Git |
| **贡献者（开发者）** | 改代码、提 PR | clone 源码、装 Node/Rust、本地 dev/build |
| **你（维护者）** | 审 PR、发版 | merge main → 本地或 CI 打 Release → 上传安装包 |

---

### 贡献者的典型流程（不是先装 setup.exe）

```text
1. GitHub 上 Fork（或直接 clone，看你们协作方式）
2. git clone https://github.com/.../ZettleAgent.git
3. npm install
4. npm run download-model    ← 第一次必做（拉嵌入模型、WASM 等，不进 Git）
5. npm run tauri dev         ← 开发调试
6. 改代码、自测
7. git push → 开 Pull Request
8. 你 review → merge 到 main
```

他们**不必**为了开发去下 Release 安装包。  
安装包和源码是两条线：安装包 = 给用户；源码 = 给开发者。

有人可能**同时**是用户和开发者（自己先用安装包体验，再在另一台机器/目录 clone 开发），但开发工作靠的是 **clone + dev 环境**，不是对着已安装的应用改。

---

### 和你（创始人）的区别

| | 你 | 其他开发者 |
|--|-----|-----------|
| 第一次准备 | 已有模型、熟悉项目 | `npm ci` + `download-model`（各下约 200MB 一次） |
| 日常开发 | `tauri dev` | 一样 |
| 打 Release 安装包 | 你 merge 后 `tauri build` 上传 | **通常不用**（除非你也让他们发版） |
| Push 到 main | 可以直接（若你是 owner） | 走 **PR**，你来审 |
| Git 里的大模型 | 不进 Git | 同样不进，各自本地 `download-model` |

多人维护时，**每个人本地都要有一份模型**（或跑一遍 `download-model`），因为 Git 里故意不 commit 嵌入模型。这和你的打包逻辑一致，不是重复劳动。

---

### 审核合并之后（发版）

```text
你 merge PR 到 main
    ↓
（可选）打 git tag v0.x.x
    ↓
你或 CI：npm run tauri build
    ↓
上传 setup.exe 到 GitHub Releases
    ↓
用户 / 贡献者（当用户时）下载新版本
```

**发 Release 通常只有你（或 CI）做**，贡献者只负责把功能合进 main。

---

### 建议在仓库里写清楚的（CONTRIBUTING 已有部分）

新开发者 clone 后：

```bash
git clone ...
cd ZettleAgent
npm install
npm run download-model   # 首次必须
npm run tauri dev
```

并说明：

- 大模型 **不在 Git**，每人本地准备一次  
- OCR、demo-vault **在 Git**（小文件，clone 就有）  
- 不要 commit `public/models/`、`node_modules/` 等  
- 功能 PR 即可，不必附带安装包  

---

### 纠正一下你的那句话

> 「其余开发者最开始是用户，要下载安装包安装，然后对着源码改」

更准确是：

- **当用户时**：可以装 Release 体验产品  
- **当贡献者时**：clone 源码 + 开发环境，**不需要**为了改代码而装 Release  
- 改完 push 分支 → 你 review → merge main → **你再**打包发 Release  

---

### 一句话

- **用户**：只下安装包。  
- **开发者**：clone + `download-model` + `tauri dev`，提 PR 给你审。  
- **你**：审 merge + 打 Release；用户和开发者都不用再管 HuggingFace。  

多人维护时，多的是「每人本地跑一次 `download-model`」，不是「每人都要先装 setup.exe 再开发」。

---

## Q15：我每次本地打包后上传到 GitHub 的 Release，我的数据会被上传吗？比如 API Key、聊天记录还有各种数据缓存等等。

**正常流程下：不会。**  
你上传的是 **安装包**（`.msi` / `.exe`），不是本机运行数据。

### 安装包里有什么（`tauri build` 产出）

```text
src-tauri/target/release/bundle/
  ├── msi/ 或 nsis/   ← 只上传这里的 .msi / .exe
  └── ...

内容 ≈
  • 编译后的程序（Rust exe）
  • dist/（前端 JS/CSS + 模型 + WASM + 字体）
  • resources/ocr_models/、resources/demo-vault/（demo 示例笔记，非你的私人库）
```

### 不会打进安装包的数据

| 数据 | 实际存放位置 | 会进 Release？ |
|------|-------------|----------------|
| **API Key / LLM 配置** | `%APPDATA%\com.zettelagent.app\` 下的 `settings.json`（Tauri Store）+ 运行时 WebView | ❌ |
| **聊天记录** | 同上目录的 `zettelagent.db`（SQLite） | ❌ |
| **向量索引 / FTS** | 同上 DB 或 vault 相关缓存 | ❌ |
| **你的笔记库** | 你选的 vault 文件夹（如 `Documents/...`） | ❌ |
| **agent.log / rag.log** | `%APPDATA%\...\logs\` 或开发时项目 `logs/` | ❌ |
| **`.env`** | 项目根目录，且已在 `.gitignore` | ❌（除非误拷进 dist） |

用户数据在 **App 数据目录**，和 **打包目录** 是分开的：

```text
打包读的是：  项目里的 dist/ + src-tauri/resources/（OCR、demo-vault）
运行时才写：  %APPDATA%\com.zettelagent.app\  （Windows）
```

### 你需要注意的少数情况

1. **只上传安装包**  
   上传 `bundle/msi/*.msi` 或 `bundle/nsis/*.exe`，不要整包 zip `target/` 或整个项目文件夹。

2. **不要把密钥写进源码**  
   若 API Key 硬编码在 `.ts`/`.rs` 里，会进 `dist` 并打进 exe。应只存在运行时 Store。

3. **发版前可快速确认**  
   ```powershell
   # 看安装包体积是否合理（约 300MB 量级，不是几 GB）
   Get-Item "src-tauri\target\release\bundle\nsis\*.exe"
   ```

4. **demo-vault 会进包**  
   那是仓库里的 **14 篇示例笔记**，不是你的私人 vault。

5. **项目根目录 `logs/`**  
   开发日志镜像，**不会**被 Tauri 打进安装包（也不在 `frontendDist` / `resources` 配置里）。

### 一句话

只要从 `bundle/` 里拿 **安装包** 上传，而不是误传整个开发目录，**你的 API Key、聊天记录、笔记库、本机缓存都不会进 Release**。安装包里只有应用本身 + 公共资源（模型、demo 示例）。

---

## 文档索引

| 相关文件 | 说明 |
|---------|------|
| `scripts/download-model.cjs` | 构建时准备大资源（嵌入、WASM、OCR 等） |
| `scripts/verify-offline-assets.cjs` | 校验安装包所需离线资源 |
| `src-tauri/tauri.conf.json` | `dist/` + `resources/` 打包配置 |
| `CONTRIBUTING.md` / `CONTRIBUTING_CN.md` | 开发者 clone 与构建说明 |
| `.github/workflows/release.yml` | CI 自动 Release（可选） |
