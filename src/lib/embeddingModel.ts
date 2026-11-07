/**
 * Single source of truth for the bundled local embedding model.
 *
 * `jina-embeddings-v2-base-zh` replaced `nomic-embed-text-v1.5`: nomic is
 * English-centric, and most vaults here are Chinese or mixed Chinese/English.
 * It stays 768-dimensional, so the `chunks_vec` / `files_vec` schema is
 * unchanged. Mean pooling + L2 normalisation, and no task prefixes (nomic needed
 * `search_query:` / `search_document:`; jina v2 does not).
 *
 * The build script (`scripts/download-model.cjs`) and the offline-asset check
 * (`scripts/verify-offline-assets.cjs`) bundle this same id; keep them in sync.
 */
export const LOCAL_EMBED_MODEL_ID = 'jinaai/jina-embeddings-v2-base-zh';

/** Vector size of the index (`chunks_vec` / `files_vec`, `EMBEDDING_DIM` in Rust). */
export const EMBEDDING_DIM = 768;

/** transformers.js dtype; `q8` loads `onnx/model_quantized.onnx` (~154 MB). */
export const LOCAL_EMBED_DTYPE = 'q8' as const;

/** Text actually fed to the model. jina v2 takes raw text for queries and documents. */
export function formatForEmbedding(text: string, _type: 'query' | 'document'): string {
  return text;
}

/** Shape of `localStorage['zettelagent:embedding_config']` that matters here. */
interface EmbeddingConfigLike {
  mode?: string;
  apiUrl?: string;
  model?: string;
}

/**
 * Identity of the model that will produce vectors under `config`, as recorded by
 * the backend (`embedding_model_key`). Changing it makes the backend discard
 * vectors from the previous model; see `sync_embedding_model`.
 */
export function embeddingModelKey(config: EmbeddingConfigLike | null | undefined): {
  key: string;
  /** Pre-existing vectors with no recorded key are kept (custom APIs cost money to re-run). */
  adoptIfUnset: boolean;
} {
  if (config?.mode === 'custom') {
    return { key: `custom:${config.apiUrl ?? ''}|${config.model ?? ''}`, adoptIfUnset: true };
  }
  return { key: `local:${LOCAL_EMBED_MODEL_ID}`, adoptIfUnset: false };
}
