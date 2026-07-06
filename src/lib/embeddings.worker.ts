import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;
env.allowRemoteModels = true;

let extractorPromise: Promise<any> | null = null;
let extractorFailed = false;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Forward download progress from transformers.js to the main thread. */
function progressCallback(data: any) {
  if (data.status === 'progress' || data.status === 'download') {
    self.postMessage({
      type: 'progress',
      payload: {
        file: data.file || data.name || 'model',
        progress: data.progress ?? 0,
        loaded: data.loaded ?? 0,
        total: data.total ?? 0,
      },
    });
  } else if (data.status === 'done' || data.status === 'ready') {
    self.postMessage({
      type: 'progress',
      payload: { file: data.file || data.name || 'model', progress: 100, loaded: data.total ?? 0, total: data.total ?? 0 },
    });
  }
}

async function getExtractor() {
  if (extractorFailed) {
    extractorPromise = null;
    extractorFailed = false;
  }

  if (!extractorPromise) {
    extractorPromise = withTimeout(
      pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: progressCallback,
      }),
      300000,
      'WASM model loading',
    ).catch((err) => {
      console.warn('WASM embedding failed, trying WebGPU:', err);
      return withTimeout(
        pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', {
          device: 'webgpu',
          dtype: 'q8',
          progress_callback: progressCallback,
        }),
        300000,
        'WebGPU model loading',
      );
    }).catch((err) => {
      console.error('All embedding backends failed:', err);
      extractorFailed = true;
      throw err;
    });
  }
  return extractorPromise;
}

async function getEmbeddingsBatch(texts: string[], type: 'query' | 'document'): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const prefix = type === 'query' ? 'search_query: ' : 'search_document: ';
  const formattedTexts = texts.map((t) => `${prefix}${t}`);

  const output = await extractor(formattedTexts, {
    pooling: 'mean',
    normalize: true,
  });

  const flatData = output.data as Float32Array;
  const dim = output.dims[1]; // 768
  const result: number[][] = [];

  for (let i = 0; i < texts.length; i++) {
    const start = i * dim;
    const end = start + dim;
    result.push(Array.from(flatData.subarray(start, end)));
  }

  return result;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'init') {
    const { modelPath, wasmPaths } = payload;
    env.localModelPath = modelPath;
    
    if (env.backends?.onnx?.wasm && wasmPaths) {
      env.backends.onnx.wasm.wasmPaths = wasmPaths;
    }

    try {
      await getExtractor();
      self.postMessage({ type: 'init-ok' });
    } catch (err: any) {
      self.postMessage({ type: 'init-error', payload: { error: err.message || String(err) } });
    }
  } else if (type === 'getEmbeddings') {
    const { id, texts, taskType } = payload;
    try {
      const embeddings = await getEmbeddingsBatch(texts, taskType);
      self.postMessage({ type: 'embeddings-ok', payload: { id, embeddings } });
    } catch (err: any) {
      self.postMessage({ type: 'error', payload: { id, error: err.message || String(err) } });
    }
  }
};
