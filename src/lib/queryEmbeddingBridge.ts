/**
 * Answers query-embedding requests from Rust.
 *
 * The embedding model lives in this WebView, but agent tools (`search_notes`)
 * run in Rust. Without this bridge they had no query vector and fell back to
 * borrowing the vector of the first full-text hit, which is not semantic
 * search. Rust emits `zettel://embed-query` with `{id, text}`; we embed the text
 * with the same config that built the index and reply via
 * `resolve_query_embedding`.
 *
 * Rust asks here only for the bundled local model (this worker is already warm
 * and matches the stored vectors exactly). A custom API index is queried from
 * Rust directly, and when this bridge does not answer Rust runs the bundled
 * model itself (`db/native_embedder.rs`). The custom branch below stays for
 * callers inside the WebView.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getEmbedding } from './embeddings';
import { fetchCustomEmbeddings } from './tauri';

export const EMBED_QUERY_EVENT = 'zettel://embed-query';

interface EmbedQueryRequest {
  id: number;
  text: string;
}

/** Embed one query with the user's current embedding config. */
export async function embedQueryText(text: string): Promise<number[]> {
  let config: { mode?: string; apiUrl?: string; model?: string } = {};
  try {
    const raw = localStorage.getItem('zettelagent:embedding_config');
    if (raw) config = JSON.parse(raw);
  } catch { /* unreadable config = default (local) */ }

  if (config.mode === 'custom') {
    if (!config.apiUrl || !config.model) throw new Error('custom embedding API is not configured');
    const [vector] = await fetchCustomEmbeddings(config.apiUrl, config.model, [text]);
    if (!vector) throw new Error('custom embedding API returned no vector');
    return vector;
  }
  return getEmbedding(text, 'query');
}

/** Start answering requests. Returns the unlisten function. */
export async function startQueryEmbeddingBridge(): Promise<UnlistenFn> {
  return listen<EmbedQueryRequest>(EMBED_QUERY_EVENT, async ({ payload }) => {
    const { id, text } = payload;
    try {
      const embedding = await embedQueryText(text);
      await invoke('resolve_query_embedding', { id, embedding, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await invoke('resolve_query_embedding', { id, embedding: null, error }).catch(() => {});
    }
  });
}
