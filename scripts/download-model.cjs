/**
 * Build-time asset preparation for the RELEASE INSTALLER.
 *
 * Audience split:
 *   - Git repo  → source + small bundled assets (OCR in resources/ocr_models/)
 *   - GitHub Release installer → end users (everything bundled, zero downloads)
 *
 * This script runs in CI (`tauri build` / `build:prod`) and locally when a
 * developer wants to produce an installer. It populates:
 *   src-tauri/resources/ocr_models/   (PP-OCRv5 mobile — committed; skip if valid)
 *   src-tauri/resources/embed_models/  (embedding weights — build-time download)
 *   src-tauri/resources/webview/       (ORT WASM, fonts, KaTeX, PDF.js, …)
 * then syncs webview → public/ for the Vite frontend bundle.
 * MCP uses Remote SSE (URL + API Key) — no bundled Node runtime.
 *
 * End users never run this. They download the .exe / .msi from Releases.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const RESOURCES = path.join(ROOT, 'src-tauri', 'resources');
const WEBVIEW = path.join(RESOURCES, 'webview');
const PUBLIC_DIR = path.join(ROOT, 'public');
const EMBED_DIR = path.join(RESOURCES, 'embed_models', 'nomic-ai', 'nomic-embed-text-v1.5');
const EMBED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
];
const EMBED_BASE = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/';

const OCR_DIR = path.join(RESOURCES, 'ocr_models');
/** Bump when switching OCR pack so stale files are replaced. */
const OCR_PACK_VERSION = 'ppocrv5-mobile-meko';
const OCR_DICT = 'ppocrv5_dict.txt';
/**
 * PP-OCRv5 mobile (中英日通用).
 * MeKo-Christian exports are compatible with pure-onnx-ocr (tract); RapidOCR/ModelScope
 * v5 graphs fail at inference with dynamic-batch shape errors.
 */
const OCR_MODELS = [
  {
    dest: 'det.onnx',
    minBytes: 4_000_000,
    urls: [
      'https://ghfast.top/https://github.com/MeKo-Christian/paddleocr-onnx/releases/download/v1.0.0/PP-OCRv5_mobile_det.onnx',
      'https://github.com/MeKo-Christian/paddleocr-onnx/releases/download/v1.0.0/PP-OCRv5_mobile_det.onnx',
    ],
  },
  {
    dest: 'rec.onnx',
    minBytes: 14_000_000,
    urls: [
      'https://ghfast.top/https://github.com/MeKo-Christian/paddleocr-onnx/releases/download/v1.0.0/PP-OCRv5_mobile_rec.onnx',
      'https://github.com/MeKo-Christian/paddleocr-onnx/releases/download/v1.0.0/PP-OCRv5_mobile_rec.onnx',
    ],
  },
];
const OCR_DICT_URLS = [
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.0/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt',
  'https://raw.githubusercontent.com/jingsongliujing/OnnxOCR/main/onnxocr/models/ppocrv5/ppocrv5_dict.txt',
];

const WASM_FILES = [
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];
const WASM_SRC = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');

const PDF_FILES = {
  'pdf.min.mjs': 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
  'pdf.worker.min.mjs': 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** Reject GitHub/HuggingFace HTML error pages masquerading as .onnx files. */
function assertValidOnnx(filePath, label, minBytes) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} missing`);
  }
  const size = fs.statSync(filePath).size;
  if (size < minBytes) {
    throw new Error(`${label} too small (${size} bytes, need >= ${minBytes})`);
  }
  const head = fs.readFileSync(filePath, { encoding: 'utf8', start: 0, end: 128 });
  if (/^\s*</.test(head) || head.includes('<!DOCTYPE') || head.includes('<html')) {
    throw new Error(`${label} looks like HTML, not ONNX`);
  }
}

function download(url, dest, { force = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  ✓ exists: ${path.basename(dest)}`);
      return resolve();
    }
    ensureDir(path.dirname(dest));
    console.log(`  ↓ ${path.basename(dest)}...`);
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        file.close();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        return fetchText(res.headers.location, headers).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function safeUnlink(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

async function downloadFirst(urls, dest) {
  let lastErr;
  for (const url of urls) {
    try {
      safeUnlink(dest);
      await download(url, dest, { force: true });
      return;
    } catch (e) {
      lastErr = e;
      safeUnlink(dest);
      console.warn(`  ⚠ ${path.basename(dest)} from ${new URL(url).host}: ${e.message}`);
    }
  }
  throw lastErr || new Error(`All mirrors failed for ${path.basename(dest)}`);
}

async function prepareOcrModels() {
  console.log('=== OCR models (PP-OCRv5 mobile) → resources/ocr_models/ ===\n');
  ensureDir(OCR_DIR);

  const marker = path.join(OCR_DIR, '.pack-version');
  const prev = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (prev !== OCR_PACK_VERSION) {
    console.log(`  ↻ OCR pack ${prev || '(none)'} → ${OCR_PACK_VERSION}`);
    for (const name of ['det.onnx', 'rec.onnx', 'ppocr_keys_v1.txt', OCR_DICT]) {
      const p = path.join(OCR_DIR, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.writeFileSync(marker, OCR_PACK_VERSION);
  }

  for (const { dest, minBytes, urls } of OCR_MODELS) {
    const out = path.join(OCR_DIR, dest);
    let valid = false;
    if (fs.existsSync(out)) {
      try {
        assertValidOnnx(out, dest, minBytes);
        valid = true;
        console.log(`  ✓ exists: ${dest}`);
      } catch (e) {
        console.warn(`  ⚠ invalid ${dest}, re-downloading: ${e.message}`);
        fs.unlinkSync(out);
      }
    }
    if (!valid) {
      await downloadFirst(urls, out);
      assertValidOnnx(out, dest, minBytes);
      const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
      console.log(`  ✓ ${dest} (${mb} MB)`);
    }
  }

  const dict = path.join(OCR_DIR, OCR_DICT);
  let dictOk = fs.existsSync(dict) && fs.statSync(dict).size >= 50_000;
  if (dictOk) {
    const head = fs.readFileSync(dict, { encoding: 'utf8', start: 0, end: 64 });
    if (/^\s*</.test(head) || head.includes('<!DOCTYPE')) dictOk = false;
  }
  if (!dictOk) {
    if (fs.existsSync(dict)) fs.unlinkSync(dict);
    await downloadFirst(OCR_DICT_URLS, dict);
    if (!fs.existsSync(dict) || fs.statSync(dict).size < 50_000) {
      console.error(`✗ ${OCR_DICT} too small or missing after download`);
      process.exit(1);
    }
    console.log(`  ✓ ${OCR_DICT}`);
  } else {
    console.log(`  ✓ ${OCR_DICT}`);
  }

  console.log('\n✓ OCR models ready\n');
}

async function prepareEmbedModel() {
  console.log('=== Embedding model → resources/embed_models/ ===\n');
  for (const file of EMBED_FILES) {
    await download(EMBED_BASE + file, path.join(EMBED_DIR, file));
  }
  console.log('\n✓ Embedding model ready (installer resources)\n');
}

async function prepareWebviewRuntime() {
  console.log('=== Webview runtime → resources/webview/ ===\n');
  ensureDir(WEBVIEW);

  // ORT WASM from node_modules
  if (!fs.existsSync(WASM_SRC)) {
    console.error('✗ node_modules/onnxruntime-web missing — run npm ci first');
    process.exit(1);
  }
  for (const f of WASM_FILES) {
    const src = path.join(WASM_SRC, f);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ skip missing ${f}`);
      continue;
    }
    const dest = path.join(WEBVIEW, f);
    if (!fs.existsSync(dest)) copyFile(src, dest);
    console.log(`  ✓ ${f}`);
  }

  // PDF.js (build-time only; ships inside installer)
  for (const [name, url] of Object.entries(PDF_FILES)) {
    await download(url, path.join(WEBVIEW, name));
  }

  // KaTeX CSS + fonts
  const katexCssSrc = path.join(ROOT, 'node_modules', 'katex', 'dist', 'katex.min.css');
  const katexFontsSrc = path.join(ROOT, 'node_modules', 'katex', 'dist', 'fonts');
  if (!fs.existsSync(katexCssSrc)) {
    console.error('✗ node_modules/katex missing — run npm ci first');
    process.exit(1);
  }
  copyFile(katexCssSrc, path.join(WEBVIEW, 'css', 'katex.min.css'));
  copyDir(katexFontsSrc, path.join(WEBVIEW, 'css', 'fonts'));
  console.log('  ✓ css/katex.min.css + fonts');

  // highlight.js
  const hljsSrc = path.join(ROOT, 'node_modules', 'highlight.js', 'styles', 'github.min.css');
  if (!fs.existsSync(hljsSrc)) {
    console.error('✗ highlight.js missing — run npm ci first');
    process.exit(1);
  }
  copyFile(hljsSrc, path.join(WEBVIEW, 'css', 'github.min.css'));
  console.log('  ✓ css/github.min.css');

  // UI fonts (skip network if already present)
  await prepareUiFonts();

  console.log('\n✓ Webview runtime ready\n');
}

async function prepareUiFonts() {
  const fontsDir = path.join(WEBVIEW, 'fonts');
  ensureDir(fontsDir);
  const cssPath = path.join(fontsDir, 'local-fonts.css');
  const existing = fs.existsSync(fontsDir)
    ? fs.readdirSync(fontsDir).filter((f) => f.endsWith('.woff2')).length
    : 0;
  if (fs.existsSync(cssPath) && existing >= 10) {
    const css = fs.readFileSync(cssPath, 'utf-8').replace(/url\(\/fonts\//g, 'url(./');
    fs.writeFileSync(cssPath, css, 'utf-8');
    console.log(`  ✓ fonts/ (${existing} woff2)`);
    return;
  }

  const familyUrl =
    'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700' +
    '&family=Fira+Sans:wght@300;400;500;600;700' +
    '&family=Outfit:wght@500;600' +
    '&family=Space+Grotesk:wght@700&display=swap';
  const css = await fetchText(familyUrl, {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  let localCss = css;
  const urls = new Set();
  const re = /url\((https:[^)]+)\)/g;
  let m;
  while ((m = re.exec(css)) !== null) urls.add(m[1]);
  for (const url of urls) {
    const filename = url.split('/').pop().split('?')[0];
    await download(url, path.join(fontsDir, filename));
    localCss = localCss.split(url).join(`./${filename}`);
  }
  fs.writeFileSync(cssPath, localCss, 'utf-8');
  console.log(`  ✓ fonts/ (downloaded ${urls.size})`);
}

function syncIntoPublic() {
  console.log('=== Sync into public/ (ships in installer via Vite dist/) ===\n');

  // Embedding model — must be in public/models so transformers.js loads it offline
  const publicModels = path.join(PUBLIC_DIR, 'models', 'nomic-ai', 'nomic-embed-text-v1.5');
  copyDir(EMBED_DIR, publicModels);
  console.log('  → models/nomic-ai/nomic-embed-text-v1.5/');

  for (const f of [
    ...WASM_FILES,
    'pdf.min.mjs',
    'pdf.worker.min.mjs',
  ]) {
    const src = path.join(WEBVIEW, f);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(PUBLIC_DIR, f));
      console.log(`  → ${f}`);
    }
  }
  copyDir(path.join(WEBVIEW, 'fonts'), path.join(PUBLIC_DIR, 'fonts'));
  copyDir(path.join(WEBVIEW, 'css'), path.join(PUBLIC_DIR, 'css'));
  console.log('  → fonts/ + css/');

  try {
    require('./inline-katex-css.cjs');
  } catch (e) {
    console.warn('  ⚠ inline-katex-css:', e.message);
  }
  console.log('\n✓ Frontend assets ready for installer (zero runtime downloads)\n');
}

function verifyInstallerAssets() {
  // Everything the installed app needs — must exist BEFORE `vite build` / `tauri build`
  const required = [
    // Embedding (frontend bundle path used at runtime)
    path.join(PUBLIC_DIR, 'models', 'nomic-ai', 'nomic-embed-text-v1.5', 'onnx', 'model_quantized.onnx'),
    path.join(PUBLIC_DIR, 'models', 'nomic-ai', 'nomic-embed-text-v1.5', 'config.json'),
    path.join(PUBLIC_DIR, 'models', 'nomic-ai', 'nomic-embed-text-v1.5', 'tokenizer.json'),
    // ORT WASM (frontend)
    path.join(PUBLIC_DIR, 'ort-wasm-simd-threaded.asyncify.wasm'),
    path.join(PUBLIC_DIR, 'ort-wasm-simd-threaded.asyncify.mjs'),
    path.join(PUBLIC_DIR, 'ort-wasm-simd-threaded.wasm'),
    path.join(PUBLIC_DIR, 'ort-wasm-simd-threaded.mjs'),
    path.join(PUBLIC_DIR, 'fonts', 'local-fonts.css'),
    path.join(PUBLIC_DIR, 'css', 'katex.min.css'),
    path.join(PUBLIC_DIR, 'css', 'github.min.css'),
    path.join(PUBLIC_DIR, 'pdf.min.mjs'),
    path.join(PUBLIC_DIR, 'pdf.worker.min.mjs'),
    // OCR + demo (Tauri resources)
    path.join(RESOURCES, 'ocr_models', 'det.onnx'),
    path.join(RESOURCES, 'ocr_models', 'rec.onnx'),
    path.join(RESOURCES, 'ocr_models', 'ppocrv5_dict.txt'),
    // Embed model staging area (synced to public/models/ by syncIntoPublic)
    path.join(EMBED_DIR, 'onnx', 'model_quantized.onnx'),
  ];
  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error('✗ Missing installer assets:');
    missing.forEach((p) => console.error('  -', path.relative(ROOT, p)));
    process.exit(1);
  }

  const demo = path.join(RESOURCES, 'demo-vault');
  const demoN = fs.existsSync(demo) ? fs.readdirSync(demo).filter((f) => f.endsWith('.md')).length : 0;
  if (demoN < 1) {
    console.error('✗ Missing demo-vault notes');
    process.exit(1);
  }

  for (const { dest, minBytes } of OCR_MODELS) {
    try {
      assertValidOnnx(path.join(OCR_DIR, dest), `resources/ocr_models/${dest}`, minBytes);
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  }

  console.log('✓ Installer assets verified — user will get zero-download OOB experience\n');
}

async function main() {
  console.log('Preparing RELEASE installer assets (build-time only).\n');
  console.log('End users download the installer from GitHub Releases — they never run this.\n');

  await prepareOcrModels();
  await prepareEmbedModel();
  await prepareWebviewRuntime();
  syncIntoPublic();
  verifyInstallerAssets();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
