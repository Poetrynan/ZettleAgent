/**
 * Verify assets required for a zero-download Release installer.
 *
 * Call AFTER `npm run download-model` and BEFORE/AFTER vite as needed:
 *   node scripts/verify-offline-assets.cjs          → checks public/ + resources/
 *   node scripts/verify-offline-assets.cjs dist     → checks dist/ + resources/ (post vite)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESOURCES = path.join(ROOT, 'src-tauri', 'resources');
const frontendRoot = process.argv[2] === 'dist' ? 'dist' : 'public';
const BASE = path.join(ROOT, frontendRoot);
const missing = [];

function check(full, label) {
  if (!fs.existsSync(full)) {
    console.error('✗', label);
    missing.push(label);
    return;
  }
  const mb = (fs.statSync(full).size / (1024 * 1024)).toFixed(1);
  console.log(`✓ ${label} (${mb} MB)`);
}

function assertValidOnnx(full, label, minBytes) {
  if (!fs.existsSync(full)) {
    console.error('✗', label, '(missing)');
    missing.push(label);
    return;
  }
  const size = fs.statSync(full).size;
  if (size < minBytes) {
    console.error('✗', label, `(too small: ${size} bytes)`);
    missing.push(label);
    return;
  }
  const head = fs.readFileSync(full, { encoding: 'utf8', start: 0, end: 128 });
  if (/^\s*</.test(head) || head.includes('<!DOCTYPE') || head.includes('<html')) {
    console.error('✗', label, '(HTML error page, not ONNX — run npm run download-model)');
    missing.push(label);
    return;
  }
  const mb = (size / (1024 * 1024)).toFixed(1);
  console.log(`✓ ${label} (${mb} MB, valid ONNX)`);
}

console.log(`=== Zero-download installer check (${frontendRoot}/ + resources/) ===\n`);
console.log('These ship INSIDE the Release installer. End users never download them.\n');

// Frontend bundle (embedding + ORT + fonts + pdf) — loaded by WebView at runtime
[
  'models/nomic-ai/nomic-embed-text-v1.5/onnx/model_quantized.onnx',
  'models/nomic-ai/nomic-embed-text-v1.5/config.json',
  'models/nomic-ai/nomic-embed-text-v1.5/tokenizer.json',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'fonts/local-fonts.css',
  'css/katex.min.css',
  'css/github.min.css',
  'pdf.min.mjs',
  'pdf.worker.min.mjs',
].forEach((rel) => check(path.join(BASE, rel), `${frontendRoot}/${rel}`));

const woff2 = fs.existsSync(path.join(BASE, 'fonts'))
  ? fs.readdirSync(path.join(BASE, 'fonts')).filter((f) => f.endsWith('.woff2')).length
  : 0;
if (woff2 < 10) {
  console.error(`✗ ${frontendRoot}/fonts: need >= 10 woff2, found ${woff2}`);
  missing.push('fonts');
} else {
  console.log(`✓ ${frontendRoot}/fonts (${woff2} woff2)`);
}

// Tauri resources (OCR, demo) + embed staging area
assertValidOnnx(path.join(RESOURCES, 'ocr_models/det.onnx'), 'resources/ocr_models/det.onnx', 4_000_000);
assertValidOnnx(path.join(RESOURCES, 'ocr_models/rec.onnx'), 'resources/ocr_models/rec.onnx', 14_000_000);
check(path.join(RESOURCES, 'ocr_models/ppocrv5_dict.txt'), 'resources/ocr_models/ppocrv5_dict.txt');
check(path.join(RESOURCES, 'embed_models/nomic-ai/nomic-embed-text-v1.5/onnx/model_quantized.onnx'), 'resources/embed_models/nomic-ai/nomic-embed-text-v1.5/onnx/model_quantized.onnx');

const demo = path.join(RESOURCES, 'demo-vault');
const n = fs.existsSync(demo) ? fs.readdirSync(demo).filter((f) => f.endsWith('.md')).length : 0;
if (n < 1) {
  console.error('✗ resources/demo-vault/*.md');
  missing.push('demo-vault');
} else {
  console.log(`✓ resources/demo-vault (${n} notes)`);
}

if (missing.length) {
  console.error(`\n✗ ${missing.length} missing — installer would NOT be OOB.`);
  console.error('Run: npm run download-model');
  process.exit(1);
}

console.log('\n✓ Release installer will be zero-download / out-of-the-box.');
