let workerInstance: Worker | null = null;
let workerInitPromise: Promise<void> | null = null;
let msgIdCounter = 0;
const pendingRequests = new Map<number, { resolve: (val: number[][]) => void; reject: (err: Error) => void }>();
let initResolve: (() => void) | null = null;
let initReject: ((err: Error) => void) | null = null;

// --- Download progress tracking ---
export interface EmbeddingProgress {
  file: string;
  progress: number;  // 0-100
  loaded: number;    // bytes
  total: number;     // bytes
}

type ProgressListener = (p: EmbeddingProgress) => void;
let progressListener: ProgressListener | null = null;

/** Register a listener for model download progress updates. */
export function onEmbeddingProgress(fn: ProgressListener | null) {
  progressListener = fn;
}

/** Current download progress state (null = not downloading / already loaded). */
let currentProgress: EmbeddingProgress | null = null;
export function getEmbeddingProgress() { return currentProgress; }

function getWorker(): Worker {
  if (!workerInstance) {
    // Vite worker loader syntax - resolves correctly in dev and production
    workerInstance = new Worker(new URL('./embeddings.worker.ts', import.meta.url), {
      type: 'module',
    });

    workerInstance.onmessage = (e: MessageEvent) => {
      const { type, payload } = e.data;
      if (type === 'init-ok') {
        currentProgress = null;
        if (initResolve) {
          initResolve();
          initResolve = null;
          initReject = null;
        }
      } else if (type === 'init-error') {
        currentProgress = null;
        if (initReject) {
          initReject(new Error(payload.error || 'Failed to initialize embedding worker'));
          initResolve = null;
          initReject = null;
        }
      } else if (type === 'progress') {
        currentProgress = payload as EmbeddingProgress;
        if (progressListener) progressListener(currentProgress);
      } else if (type === 'embeddings-ok') {
        const { id, embeddings } = payload;
        const pending = pendingRequests.get(id);
        if (pending) {
          pending.resolve(embeddings);
          pendingRequests.delete(id);
        }
      } else if (type === 'error') {
        const { id, error } = payload;
        const pending = pendingRequests.get(id);
        if (pending) {
          pending.reject(new Error(error || 'Worker embedding calculation error'));
          pendingRequests.delete(id);
        }
      }
    };
  }
  return workerInstance;
}

/**
 * Explicitly pre-load and initialize the Web Worker.
 */
export async function initEmbeddingWorker(): Promise<void> {
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = new Promise<void>((resolve, reject) => {
    const worker = getWorker();
    initResolve = resolve;
    initReject = reject;

    const assetBase = import.meta.env.BASE_URL;
    const modelPath = new URL(`${assetBase}models/`, window.location.href).href;
    const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    
    const wasmPaths = isSafari
      ? {
          wasm: new URL(`${assetBase}ort-wasm-simd-threaded.wasm`, window.location.href).href,
          mjs: new URL(`${assetBase}ort-wasm-simd-threaded.mjs`, window.location.href).href,
        }
      : {
          wasm: new URL(`${assetBase}ort-wasm-simd-threaded.asyncify.wasm`, window.location.href).href,
          mjs: new URL(`${assetBase}ort-wasm-simd-threaded.asyncify.mjs`, window.location.href).href,
        };

    worker.postMessage({
      type: 'init',
      payload: { modelPath, wasmPaths }
    });
  });

  return workerInitPromise;
}

/**
 * Generate embeddings for a batch of texts using Web Worker.
 */
export async function getEmbeddingsBatch(texts: string[], type: 'query' | 'document'): Promise<number[][]> {
  if (texts.length === 0) return [];
  
  // Auto-initialize worker if not already done
  await initEmbeddingWorker();

  const worker = getWorker();
  const id = ++msgIdCounter;

  return new Promise<number[][]>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({
      type: 'getEmbeddings',
      payload: { id, texts, taskType: type }
    });
  });
}

/**
 * Generate 768-dimensional embedding for a single text using Web Worker.
 */
export async function getEmbedding(text: string, type: 'query' | 'document'): Promise<number[]> {
  const result = await getEmbeddingsBatch([text], type);
  return result[0];
}
