//! The bundled local embedding model (jina-embeddings-v2-base-zh, int8 ONNX),
//! run natively in Rust.
//!
//! The WebView embeds documents with transformers.js. Rust code (agent tools,
//! the stand-alone `--mcp-server`) needs to embed *queries* without a WebView,
//! so it loads the very same `model_quantized.onnx` + `tokenizer.json` here and
//! reproduces the frontend pipeline: same tokenizer (token ids are identical),
//! the model's `last_hidden_state`, attention-masked mean pooling, L2
//! normalisation.
//!
//! Inference runs on `tract` (pure Rust, already compiled in for OCR), so this
//! adds no native library and no download. Its int8 kernels are not bit-exact
//! with onnxruntime's: a native query vector has cosine ~0.95 with the WebView's
//! vector for the same text. What search needs is the same *ranking*, and on the
//! probe set (`ranks_documents_like_transformers_js`, 12 queries over 12 notes)
//! the best match is the same for 12/12 and the top three overlap 34/36, at
//! ~1 s per query on a laptop CPU. That is why this is a
//! fallback: inside the app the WebView bridge (exact) is asked first, and
//! results say which path produced the query vector.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

/// Hugging Face id of the bundled model. Must equal `LOCAL_EMBED_MODEL_ID` in
/// `src/lib/embeddingModel.ts` (the backend's model key is `local:<this>`).
pub const MODEL_ID: &str = "jinaai/jina-embeddings-v2-base-zh";

/// Files the embedder needs, relative to the model directory.
pub const TOKENIZER_FILE: &str = "tokenizer.json";
pub const ONNX_FILE: &str = "onnx/model_quantized.onnx";

type Plan = Arc<TypedRunnableModel<TypedModel>>;

/// tract cannot type this graph with a symbolic sequence length, so a plan is
/// built per fixed length and inputs are padded up to the next bucket (the
/// attention mask keeps padding out of attention and the mean). Each plan holds
/// its own optimised weights, so the buckets are few and stop at 128 tokens:
/// this embeds search queries, which are far shorter (the tokenizer truncates).
const BUCKETS: [usize; 4] = [16, 32, 64, 128];
const MAX_TOKENS: usize = 128;


#[derive(Clone, Copy, Debug, PartialEq)]
enum InputKind {
    Ids,
    Mask,
    TokenTypes,
}

pub struct NativeEmbedder {
    model: InferenceModel,
    plans: Mutex<std::collections::HashMap<usize, Plan>>,
    inputs: Vec<InputKind>,
    tokenizer: Tokenizer,
}

impl NativeEmbedder {
    /// Load from a directory laid out like `public/models/<MODEL_ID>/`.
    pub fn load_dir(dir: &Path) -> Result<Self, String> {
        let tok = std::fs::read(dir.join(TOKENIZER_FILE))
            .map_err(|e| format!("read {}: {e}", dir.join(TOKENIZER_FILE).display()))?;
        let onnx = std::fs::read(dir.join(ONNX_FILE))
            .map_err(|e| format!("read {}: {e}", dir.join(ONNX_FILE).display()))?;
        Self::load_bytes(&tok, &onnx)
    }

    /// Load from in-memory files (the GUI reads them from the embedded assets).
    pub fn load_bytes(tokenizer_json: &[u8], onnx: &[u8]) -> Result<Self, String> {
        let mut tokenizer =
            Tokenizer::from_bytes(tokenizer_json).map_err(|e| format!("tokenizer: {e}"))?;
        // Padding is never needed (one text per run) and a padding config baked
        // into tokenizer.json would add tokens the frontend does not see.
        tokenizer.with_padding(None);
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| format!("tokenizer truncation: {e}"))?;

        // The export declares shapes as `batch` / `sequence` symbols that clash
        // with the concrete facts set per bucket; let tract infer them instead.
        let mut model = tract_onnx::onnx()
            .with_ignore_output_shapes(true)
            .model_for_read(&mut std::io::Cursor::new(onnx))
            .map_err(|e| format!("onnx parse: {e}"))?;
        // Intermediate `value_info` entries carry the same symbols; drop them
        // all and let tract derive every shape from the inputs.
        let sources: Vec<usize> = model.input_outlets().map_err(|e| e.to_string())?.iter().map(|o| o.node).collect();
        for node in 0..model.nodes().len() {
            if sources.contains(&node) {
                continue;
            }
            for slot in 0..model.node(node).outputs.len() {
                model
                    .set_outlet_fact(OutletId::new(node, slot), InferenceFact::default())
                    .map_err(|e| format!("reset fact: {e}"))?;
            }
        }

        let mut inputs = Vec::new();
        for outlet in model.input_outlets().map_err(|e| e.to_string())? {
            let name = model.node(outlet.node).name.clone();
            let kind = match name.as_str() {
                "input_ids" => InputKind::Ids,
                "attention_mask" => InputKind::Mask,
                "token_type_ids" => InputKind::TokenTypes,
                other => return Err(format!("unexpected model input `{other}`")),
            };
            inputs.push(kind);
        }
        if !inputs.contains(&InputKind::Ids) {
            return Err("model has no input_ids input".into());
        }

        let me = Self { model, plans: Mutex::new(Default::default()), inputs, tokenizer };
        // Build the smallest plan now: it serves almost every query, and it
        // surfaces an unsupported graph at load time rather than on first use.
        me.plan_for(BUCKETS[0])?;
        Ok(me)
    }

    fn plan_for(&self, len: usize) -> Result<Plan, String> {
        if let Some(p) = self.plans.lock().map_err(|_| "plans poisoned")?.get(&len) {
            return Ok(p.clone());
        }
        let mut model = self.model.clone();
        for ix in 0..self.inputs.len() {
            model
                .set_input_fact(ix, InferenceFact::dt_shape(i64::datum_type(), tvec![1.to_dim(), len.to_dim()]))
                .map_err(|e| format!("input fact: {e}"))?;
        }
        let plan: Plan = Arc::new(
            model
                .into_optimized()
                .map_err(|e| format!("optimize: {e:#}"))?
                .into_runnable()
                .map_err(|e| format!("plan: {e}"))?,
        );
        self.plans.lock().map_err(|_| "plans poisoned")?.insert(len, plan.clone());
        Ok(plan)
    }

    /// Embed one text: masked mean pooling + L2 normalisation, as the worker does.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let enc = self.tokenizer.encode(text, true).map_err(|e| format!("tokenize: {e}"))?;
        let mut ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        let mut mask: Vec<i64> = enc.get_attention_mask().iter().map(|&m| m as i64).collect();
        if ids.is_empty() {
            return Err("empty tokenization".into());
        }
        let n = BUCKETS.iter().copied().find(|&b| b >= ids.len()).unwrap_or(MAX_TOKENS);
        let pad_id = self.tokenizer.token_to_id("<pad>").unwrap_or(1) as i64;
        ids.resize(n, pad_id);
        mask.resize(n, 0);
        let plan = self.plan_for(n)?;

        let tensor = |v: &[i64]| -> Result<TValue, String> {
            Ok(tract_ndarray::Array2::from_shape_vec((1, n), v.to_vec())
                .map_err(|e| e.to_string())?
                .into_tensor()
                .into())
        };
        let mut feed: TVec<TValue> = tvec![];
        for kind in &self.inputs {
            feed.push(match kind {
                InputKind::Ids => tensor(&ids)?,
                InputKind::Mask => tensor(&mask)?,
                InputKind::TokenTypes => tensor(&vec![0; n])?,
            });
        }

        let out = plan.run(feed).map_err(|e| format!("inference: {e}"))?;
        let hidden = out[0].to_array_view::<f32>().map_err(|e| format!("output: {e}"))?;
        let shape = hidden.shape().to_vec();
        if shape.len() != 3 || shape[1] != n {
            return Err(format!("unexpected output shape {shape:?}"));
        }
        let dim = shape[2];

        let mut pooled = vec![0f32; dim];
        let mut count = 0f32;
        for t in 0..n {
            if mask[t] == 0 {
                continue;
            }
            count += 1.0;
            for d in 0..dim {
                pooled[d] += hidden[[0, t, d]];
            }
        }
        let count = count.max(1e-9);
        pooled.iter_mut().for_each(|x| *x /= count);
        let norm = pooled.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        pooled.iter_mut().for_each(|x| *x /= norm);
        Ok(pooled)
    }
}

// ── Where the model files are ─────────────────────────────────────────────

/// Overrides every other location (tests, unusual installs, the MCP server).
pub const MODEL_DIR_ENV: &str = "ZETTELAGENT_EMBED_MODEL_DIR";

/// Directory the desktop app extracts the model to so the stand-alone MCP
/// process (which has no access to the app's embedded assets) can load it:
/// `<data dir>/com.zettelagent.app/embed_models/<MODEL_ID>`. Same base folder
/// Tauri's `app_data_dir()` resolves to, computed without an app handle.
pub fn extracted_model_dir() -> Option<PathBuf> {
    let mut p = dirs::data_dir()?.join(crate::APP_IDENTIFIER).join("embed_models");
    for part in MODEL_ID.split('/') {
        p.push(part);
    }
    Some(p)
}

fn is_complete(dir: &Path) -> bool {
    dir.join(TOKENIZER_FILE).is_file()
        && std::fs::metadata(dir.join(ONNX_FILE)).map(|m| m.len() > 1_000_000).unwrap_or(false)
}

/// First directory on disk that holds a complete copy of the model.
pub fn find_model_dir(extra: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env) = std::env::var(MODEL_DIR_ENV) {
        if !env.trim().is_empty() {
            candidates.push(PathBuf::from(env));
        }
    }
    if let Some(extra) = extra {
        candidates.push(extra.to_path_buf());
    }
    if let Some(d) = extracted_model_dir() {
        candidates.push(d);
    }
    // Development checkout: the build script puts the model here (and the dev
    // server serves it from public/). Compile-time path, only taken if present.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let rel: PathBuf = MODEL_ID.split('/').collect();
    candidates.push(manifest.join("..").join("public").join("models").join(&rel));
    candidates.push(manifest.join("resources").join("embed_models").join(&rel));

    candidates.into_iter().find(|d| is_complete(d))
}

// ── Process-wide instance ─────────────────────────────────────────────────

/// Loaded once, on first use (parsing + optimising the graph takes seconds).
/// A failed load is remembered so every later query does not retry it.
fn slot() -> &'static Mutex<Option<Result<Arc<NativeEmbedder>, String>>> {
    static SLOT: OnceLock<Mutex<Option<Result<Arc<NativeEmbedder>, String>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// How to get the model bytes when no directory on disk has them (GUI only:
/// the frontend's embedded assets).
pub type AssetLoader = dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync;

fn asset_loader() -> &'static OnceLock<Box<AssetLoader>> {
    static LOADER: OnceLock<Box<AssetLoader>> = OnceLock::new();
    &LOADER
}

/// Register the embedded-asset reader (called once from the app's `setup`).
/// `path` is relative to the frontend root, e.g. `models/<MODEL_ID>/tokenizer.json`.
pub fn set_asset_loader(f: Box<AssetLoader>) {
    let _ = asset_loader().set(f);
}

pub fn asset_path(file: &str) -> String {
    format!("models/{MODEL_ID}/{file}")
}

fn load_any() -> Result<NativeEmbedder, String> {
    if let Some(dir) = find_model_dir(None) {
        log::info!("native embedder: loading {}", dir.display());
        return NativeEmbedder::load_dir(&dir);
    }
    if let Some(loader) = asset_loader().get() {
        if let (Some(tok), Some(onnx)) = (loader(&asset_path(TOKENIZER_FILE)), loader(&asset_path(ONNX_FILE))) {
            log::info!("native embedder: loading from embedded assets");
            return NativeEmbedder::load_bytes(&tok, &onnx);
        }
    }
    Err("local_model_missing".into())
}

/// The shared embedder, loading it on first call. Blocking: call from
/// `spawn_blocking`.
pub fn shared() -> Result<Arc<NativeEmbedder>, String> {
    let mut guard = slot().lock().map_err(|_| "native_embedder_poisoned".to_string())?;
    if let Some(done) = guard.as_ref() {
        return done.clone();
    }
    let started = std::time::Instant::now();
    let result = load_any().map(Arc::new);
    match &result {
        Ok(_) => log::info!("native embedder ready in {:?}", started.elapsed()),
        Err(e) => log::warn!("native embedder unavailable: {e}"),
    }
    *guard = Some(result.clone());
    result
}

/// Embed a query on a blocking thread.
pub async fn embed_query(text: &str) -> Result<Vec<f32>, String> {
    let text = text.to_string();
    tokio::task::spawn_blocking(move || shared()?.embed(&text))
        .await
        .map_err(|e| format!("native_embedder_join: {e}"))?
}

/// Copy the model out of the embedded assets to [`extracted_model_dir`], so the
/// stand-alone MCP server can load it. No-op when a complete copy is there.
pub fn extract_for_headless_use() -> Result<PathBuf, String> {
    let dir = extracted_model_dir().ok_or("no data dir")?;
    if is_complete(&dir) {
        return Ok(dir);
    }
    let loader = asset_loader().get().ok_or("no asset loader")?;
    for file in [TOKENIZER_FILE, ONNX_FILE] {
        let bytes = loader(&asset_path(file)).ok_or_else(|| format!("asset {file} not embedded"))?;
        let dest = dir.join(file);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Write-then-rename so a crash never leaves a truncated model that
        // `is_complete` would accept.
        let tmp = dest.with_extension("partial");
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &dest).map_err(|e| format!("rename {}: {e}", dest.display()))?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same tokens as transformers.js, and a vector close to its. Needs the
    /// model on disk and a reference dump; run with
    /// `ZETTELAGENT_EMBED_MODEL_DIR=... ZETTELAGENT_EMBED_REF=ref.json cargo test native_embedder -- --ignored`.
    #[test]
    #[ignore]
    fn matches_transformers_js() {
        let dir = find_model_dir(None).expect("model dir");
        let started = std::time::Instant::now();
        let emb = NativeEmbedder::load_dir(&dir).expect("load");
        eprintln!("load {:?}", started.elapsed());

        let reference: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var("ZETTELAGENT_EMBED_REF").expect("ZETTELAGENT_EMBED_REF")).unwrap(),
        )
        .unwrap();
        for case in reference.as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let want_ids: Vec<u32> =
                case["ids"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
            let got_ids = emb.tokenizer.encode(text, true).unwrap().get_ids().to_vec();
            assert_eq!(got_ids, want_ids, "token ids for {text}");

            let want: Vec<f32> =
                case["vector"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
            let t = std::time::Instant::now();
            let got = emb.embed(text).unwrap();
            let cos: f32 = got.iter().zip(&want).map(|(a, b)| a * b).sum();
            eprintln!("{text}: cos={cos:.6} in {:?}", t.elapsed());
            assert_eq!(got.len(), want.len());
            assert!(cos > 0.9, "{text}: cosine {cos}");
        }
    }

    /// What matters for search: native query vectors must rank the
    /// (transformers.js, batch-embedded) documents like the WebView's own
    /// query vectors do. Reference from `jina_rank_ref.mjs` in ZETTELAGENT_RANK_REF.
    #[test]
    #[ignore]
    fn ranks_documents_like_transformers_js() {
        let dir = find_model_dir(None).expect("model dir");
        let emb = NativeEmbedder::load_dir(&dir).expect("load");
        let r: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var("ZETTELAGENT_RANK_REF").expect("ZETTELAGENT_RANK_REF")).unwrap(),
        )
        .unwrap();
        let vecs = |v: &serde_json::Value| -> Vec<Vec<f32>> {
            v.as_array().unwrap().iter()
                .map(|x| x.as_array().unwrap().iter().map(|f| f.as_f64().unwrap() as f32).collect())
                .collect()
        };
        let docs = vecs(&r["docVecs"]);
        let refq = vecs(&r["queryVecs"]);
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let rank = |q: &[f32]| {
            let mut ix: Vec<usize> = (0..docs.len()).collect();
            ix.sort_by(|&a, &b| dot(q, &docs[b]).partial_cmp(&dot(q, &docs[a])).unwrap());
            ix
        };
        let (mut top1, mut top3_overlap, mut cos_sum) = (0, 0, 0.0);
        let mut total_time = std::time::Duration::ZERO;
        for (i, q) in r["queries"].as_array().unwrap().iter().enumerate() {
            let t = std::time::Instant::now();
            let native = emb.embed(q.as_str().unwrap()).unwrap();
            total_time += t.elapsed();
            let (a, b) = (rank(&refq[i]), rank(&native));
            top1 += (a[0] == b[0]) as usize;
            top3_overlap += a[..3].iter().filter(|x| b[..3].contains(x)).count();
            cos_sum += dot(&native, &refq[i]);
            eprintln!("{}: ref {:?} native {:?}", q, &a[..3], &b[..3]);
        }
        let n = refq.len();
        eprintln!(
            "top1 {top1}/{n}, top3 overlap {top3_overlap}/{}, mean cos {:.4}, mean query {:?}",
            n * 3,
            cos_sum / n as f32,
            total_time / n as u32
        );
        // One near-tie may flip; more than that means the pipeline broke.
        assert!(top1 + 1 >= n, "top-1 agreement {top1}/{n}");
        assert!(top3_overlap * 10 >= n * 3 * 9, "top-3 overlap {top3_overlap}/{}", n * 3);
    }
}
