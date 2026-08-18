use tauri::State;
use crate::AppState;
use crate::chunker::{ChunkerConfig, chunk_markdown};
use crate::db::search;
use crate::db::search::rerank;
use crate::error::ZettelError;
use crate::pipeline_log;
use super::{ChunkResult, ChunkInfo, SearchQuery, EmbeddingStats};
use crate::db::search::SearchResult;

#[tauri::command]
pub fn chunk_document(content: String, max_chunk_size: Option<usize>) -> ChunkResult {
    let config = ChunkerConfig {
        max_chunk_size: max_chunk_size.unwrap_or(2000),
        ..Default::default()
    };

    let chunks = chunk_markdown(&content, &config);
    let total = chunks.len();

    ChunkResult {
        chunks: chunks
            .into_iter()
            .map(|c| ChunkInfo {
                content: c.content,
                heading_hierarchy: c.heading_hierarchy,
                marker_type: c.marker_type,
                chunk_index: c.chunk_index,
            })
            .collect(),
        total,
    }
}

#[tauri::command]
pub async fn search_chunks(
    state: State<'_, AppState>,
    query: SearchQuery,
) -> Result<Vec<SearchResult>, ZettelError> {
    let mode = query.mode.as_deref().unwrap_or("fts");
    let limit = query.limit.unwrap_or(20);
    // Process-global config, restored from `app_settings` at startup. Read once
    // per call so a mid-session settings change takes effect on the next search.
    let rerank_config = rerank::active_config();

    match mode {
        "hybrid" | "vector" => {
            let query_embedding = query.query_embedding.ok_or_else(|| ZettelError::Llm(
                "Missing pre-computed query embedding for hybrid/vector search".to_string()
            ))?;

            let conn = state.db.lock()?;
            match mode {
                // `external: None` = Tier 1 (lexical). Tiers 2/3 cannot be driven
                // from inside a command that must return synchronously to the
                // frontend that *hosts* the model; that path is `rerank_window`
                // below, and `rerank_results` already degrades CrossEncoder/Llm
                // to Tier 1 when no external reranker is supplied.
                "hybrid" => Ok(search::hybrid_search_reranked(
                    &conn,
                    &query.query,
                    &query_embedding,
                    limit,
                    &rerank_config,
                    None,
                )?),
                // Pure-vector mode is left unreranked on purpose: the user asked
                // for semantic-only ordering, and a lexical rerank is exactly the
                // signal they opted out of. (It would also be near-inert — a
                // paraphrase query scores ~0 lexically on every candidate, so the
                // stable sort would mostly return the vector order anyway.)
                _ => Ok(search::vector_search(&conn, &query_embedding, limit)?),
            }
        }
        _ => {
            let conn = state.db.lock()?;
            Ok(search::full_text_search_reranked(
                &conn,
                &query.query,
                limit,
                &rerank_config,
                None,
            )?)
        }
    }
}

#[tauri::command]
pub fn get_unindexed_chunks(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<(i64, String)>, ZettelError> {
    let mut conn = state.db.lock()?;

    // ── Embedding Cache: backfill from cache first ──────────────────
    // Unchanged chunks that went through a sync_file DELETE+INSERT cycle
    // can be satisfied from the content-hash cache without any model call.
    let bf = crate::db::embedding_cache::backfill_null_embeddings(&mut conn, limit)
        .unwrap_or_default();
    if bf.filled > 0 {
        pipeline_log::log_embedding_info(&format!(
            "embedding_cache: backfilled {}/{} chunks from cache",
            bf.filled, bf.scanned
        ));
    }

    // Return whatever is still NULL (true cache misses).
    let mut stmt = conn.prepare("SELECT id, content FROM chunks WHERE embedding IS NULL LIMIT ?1")?;
    let rows = stmt.query_map([limit], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
    let chunks = rows.collect::<Result<Vec<_>, _>>()?;
    pipeline_log::log_embedding_info(&format!("get_unindexed_chunks: requested={}, returned={} (after cache backfill)", limit, chunks.len()));
    Ok(chunks)
}

#[tauri::command]
pub fn save_chunk_embeddings(
    state: State<'_, AppState>,
    embeddings: Vec<(i64, Vec<f32>)>,
) -> Result<(), ZettelError> {
    let count = embeddings.len();
    let mut conn = state.db.lock()?;

    // ── Resolve chunk text once so we can write-through the cache ───
    // Doing this before opening the transaction keeps the write path a single
    // batched writer rather than interleaving reads and writes.
    let id_to_text: std::collections::HashMap<i64, String> = {
        let ids: Vec<i64> = embeddings.iter().map(|(id, _)| *id).collect();
        if ids.is_empty() {
            std::collections::HashMap::new()
        } else {
            let placeholders: String =
                std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
            let sql = format!("SELECT id, content FROM chunks WHERE id IN ({})", placeholders);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(ids.iter()),
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )?;
            rows.filter_map(|r| r.ok()).collect()
        }
    };

    let tx = conn.transaction().map_err(|e| ZettelError::System(format!("Failed to start transaction: {}", e)))?;
    {
        let mut update_chunk_stmt = tx.prepare("UPDATE chunks SET embedding = ?1 WHERE id = ?2")?;
        let mut insert_vec_stmt = tx.prepare("INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?1, ?2)")?;
        // Write-through cache: key on SHA-256 of the source text so a future
        // resync of the same chunk (or a byte-identical chunk in another file)
        // is a zero-cost lookup.
        let mut cache_stmt = tx.prepare(
            "INSERT INTO embedding_cache (content_hash, embedding, dim, last_used_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(content_hash) DO UPDATE SET
               embedding = excluded.embedding,
               dim = excluded.dim,
               last_used_at = datetime('now')",
        )?;

        for (id, emb_vec) in embeddings {
            let emb_blob: Vec<u8> = emb_vec.iter().flat_map(|f| f.to_le_bytes()).collect();
            update_chunk_stmt.execute(rusqlite::params![emb_blob, id])?;
            insert_vec_stmt.execute(rusqlite::params![id, emb_blob])?;
            if let Some(text) = id_to_text.get(&id) {
                let hash = crate::db::embedding_cache::content_hash(text);
                cache_stmt.execute(rusqlite::params![
                    hash,
                    emb_blob,
                    crate::db::embedding_cache::EMBEDDING_DIM as i64
                ])?;
            }
        }
    }
    tx.commit().map_err(|e| ZettelError::System(format!("Failed to commit transaction: {}", e)))?;
    pipeline_log::log_embedding_info(&format!("save_chunk_embeddings: saved {} chunk embeddings + cache", count));
    Ok(())
}

#[tauri::command]
pub async fn finalize_embedding_index(
    state: State<'_, AppState>,
) -> Result<(), ZettelError> {
    pipeline_log::log_embedding_info("finalize_embedding_index: computing semantic edges...");
    let conn = state.db.lock()?;
    search::compute_and_store_semantic_edges(&conn, None)
        .map_err(|e| {
            pipeline_log::log_embedding_error(&format!("finalize_embedding_index failed: {}", e));
            ZettelError::System(format!("Rebuilding semantic edges failed: {}", e))
        })?;
    search::invalidate_graph_cache(&conn);
    pipeline_log::log_embedding_info("finalize_embedding_index: done, graph cache invalidated");
    Ok(())
}

#[tauri::command]
pub fn get_embedding_stats(state: State<'_, AppState>) -> Result<EmbeddingStats, ZettelError> {
    let conn = state.db.lock()?;
    let total_chunks: usize = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    let indexed_chunks: usize = conn.query_row("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL", [], |row| row.get(0))?;

    Ok(EmbeddingStats {
        total_chunks,
        indexed_chunks,
        has_index: indexed_chunks > 0,
    })
}

/// Backend proxy for the *custom* (self-hosted / OpenAI-compatible) embedding
/// endpoint.
///
/// Why this lives in Rust: the LLM API key now sits in the OS credential store
/// and `secrets.rs` exposes no getter — the raw value only exists backend-side.
/// A custom embedding endpoint that wants `Authorization: Bearer <key>` can
/// therefore no longer be called from the WebView: after migration the old
/// plaintext `zettelagent-llm.apiKey` is gone, the fetch would send an empty
/// bearer, and an authenticated endpoint answers 401. Issuing the request here
/// keeps the secret where it belongs: the key is read from the keyring and
/// attached to the header without ever crossing back into JS.
///
/// Scope: this is ONLY the custom-endpoint path. The default provider embeds in
/// the WebView (nomic-embed-text-v1.5 ONNX via WASM/WebGPU) and never touches
/// Rust — that path is intentionally left alone.
#[tauri::command]
pub async fn fetch_custom_embeddings(
    app: tauri::AppHandle,
    api_url: String,
    model: String,
    inputs: Vec<String>,
    // The caller's UI language, so the actionable errors below match the app.
    zh: bool,
) -> Result<Vec<Vec<f32>>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }

    // The single read of the key for this path. `resolve_api_key` is the
    // backend-only accessor; there is deliberately no command handing it to JS.
    // An absent key is not fatal here — some self-hosted endpoints need none, so
    // the request is attempted without the header and the endpoint decides.
    let api_key = crate::secrets::resolve_api_key(&app);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("build embedding client: {}", e))?;

    let body = serde_json::json!({
        "input": inputs,
        "model": model,
    });

    // Reuse the shared retry policy (3 attempts, jittered backoff, Retry-After
    // aware, retries only 408/425/429/5xx + transport errors) and its
    // Ollama-aware connection-refused guidance, rather than opening a second,
    // divergent HTTP path that would drift from the LLM one.
    let response = crate::llm::send_llm_request_with_retry("Embedding", zh, &app, || {
        let mut builder = client.post(&api_url).json(&body);
        if let Some(key) = &api_key {
            builder = builder.header("Authorization", format!("Bearer {}", key));
        }
        builder
    })
    .await
    .map_err(|e| {
        let msg = e.to_string();
        // A rejected credential is the whole reason this command exists: turn the
        // bare status code into a next step the user can actually take.
        if msg.contains("401") {
            if zh {
                "嵌入端点拒绝了凭据（401）——请在设置中重新填写 API Key".to_string()
            } else {
                "The embedding endpoint rejected the credentials (401) — re-enter your API Key in Settings.".to_string()
            }
        } else {
            msg
        }
    })?;

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("parse embedding response: {}", e))?;

    let items = data
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| {
            if zh {
                "嵌入接口返回格式不正确（缺少 data 字段）".to_string()
            } else {
                "Invalid embedding API response (missing `data`).".to_string()
            }
        })?;

    // Preserve request order: the OpenAI-compatible schema tags each item with
    // its input `index`, and providers do not promise response ordering.
    let mut indexed: Vec<(u64, Vec<f32>)> = Vec::with_capacity(items.len());
    for item in items {
        let index = item.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
        let embedding = item
            .get("embedding")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| n.as_f64().map(|f| f as f32))
                    .collect::<Vec<f32>>()
            })
            .unwrap_or_default();
        indexed.push((index, embedding));
    }
    indexed.sort_by_key(|(i, _)| *i);
    Ok(indexed.into_iter().map(|(_, e)| e).collect())
}

// ══════════════════════════════════════════════════════════════════════
//  Rerank stage — configuration + Tier 2/3 transport
// ══════════════════════════════════════════════════════════════════════

/// Current rerank config. Read from process state, not the DB: this is the same
/// value the search path uses, so the UI can never show a mode that is not the
/// one actually in force.
#[tauri::command]
pub fn get_rerank_config() -> Result<rerank::RerankConfig, ZettelError> {
    Ok(rerank::active_config())
}

/// Update + persist the rerank config.
///
/// Every field is optional so the UI can PATCH one knob without having to echo
/// back the rest (and without a read-modify-write race between two settings
/// panes). Unspecified fields keep their current value.
///
/// Validation is strict here — unlike the startup restore path, which clamps —
/// because a rejected setting is a bug the user can see and fix, while a silently
/// clamped one is a support ticket. Messages are bilingual to match the rest of
/// the settings surface.
#[tauri::command]
pub fn set_rerank_config(
    state: State<'_, AppState>,
    mode: Option<String>,
    top_k: Option<usize>,
    llm_max_candidates: Option<usize>,
    llm_max_snippet_chars: Option<usize>,
    llm_timeout_ms: Option<u64>,
) -> Result<rerank::RerankConfig, ZettelError> {
    let mut config = rerank::active_config();

    if let Some(ref m) = mode {
        config.mode = rerank::parse_mode_strict(m).ok_or_else(|| {
            ZettelError::System(format!(
                "无效的重排模式 `{}`（可选：off | lexical | crossEncoder | llm） / \
invalid rerank mode `{}` (expected: off | lexical | crossEncoder | llm)",
                m, m
            ))
        })?;
    }
    if let Some(v) = top_k {
        config.top_k = check_range(v, rerank::TOP_K_RANGE, "topK")?;
    }
    if let Some(v) = llm_max_candidates {
        config.llm_max_candidates =
            check_range(v, rerank::LLM_MAX_CANDIDATES_RANGE, "llmMaxCandidates")?;
    }
    if let Some(v) = llm_max_snippet_chars {
        config.llm_max_snippet_chars =
            check_range(v, rerank::LLM_MAX_SNIPPET_CHARS_RANGE, "llmMaxSnippetChars")?;
    }
    if let Some(v) = llm_timeout_ms {
        config.llm_timeout_ms = check_range(v, rerank::LLM_TIMEOUT_MS_RANGE, "llmTimeoutMs")?;
    }

    // Persist before publishing: if the write fails the user keeps the config
    // they can actually see in the DB, rather than a process-only setting that
    // silently disappears on restart.
    {
        let conn = state.db.lock()?;
        rerank::save_config(&conn, &config).map_err(|e| ZettelError::System(e.to_string()))?;
    }
    rerank::store_config(config.clone());
    Ok(config)
}

/// Range check shared by every numeric knob. Generic over the integer type so
/// `usize` and `u64` knobs get the identical bilingual message.
fn check_range<T: PartialOrd + std::fmt::Display + Copy>(
    value: T,
    range: (T, T),
    field: &str,
) -> Result<T, ZettelError> {
    if value < range.0 || value > range.1 {
        return Err(ZettelError::System(format!(
            "{} = {} 超出允许范围 [{}, {}] / {} = {} is outside the allowed range [{}, {}]",
            field, value, range.0, range.1, field, value, range.0, range.1
        )));
    }
    Ok(value)
}

/// The recall window plus the payload an external reranker needs, in one shot.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankWindow {
    /// The window, **already Tier-1 reranked**. Use as-is when the external model
    /// declines; this is what makes the fallback a no-op for the caller.
    pub results: Vec<SearchResult>,
    /// `results` projected into scoring payloads. `candidates[i].index == i`.
    pub candidates: Vec<rerank::RerankCandidate>,
    /// How many rows the caller should keep after reordering. The window is
    /// intentionally wider than this — that width is the whole point of a rerank.
    pub limit: usize,
}

/// Tier 2 transport: hand the frontend a rerank window so the ONNX cross-encoder
/// in the webview can score it.
///
/// **One call, no server-side state.** The alternative shape — "give me
/// candidates" then "here is the order" — needs Rust to park the window between
/// the two calls, which means a keyed cache, an eviction policy, and a race as
/// soon as the user types a second query before the first model run finishes.
/// Returning the window itself sidesteps all of it: the caller already has
/// `applyIndexOrder` (`src/lib/reranker.ts`), a mirror of `apply_index_order`
/// here, so it can reorder locally and truncate to `limit`.
///
/// Degradation is structural rather than handled: `results` comes back Tier-1
/// reranked, so `rerank()` returning `null` means the caller simply keeps what it
/// was given. There is no error path for "the model was not available".
///
/// ## Ordering ownership
///
/// The **caller** owns the final ordering. It already holds `results`, so handing
/// the model's index order back for Rust to apply would buy nothing and cost a
/// second round trip — plus the very server-side parked window this single-round
/// shape exists to avoid. `src/lib/rerankSearch.ts` is the consumer.
///
/// ## `vector` mode
///
/// `search_chunks` leaves `vector` mode unreranked because a *lexical* rerank is
/// exactly the signal the user opted out of by asking for semantic-only ordering.
/// A cross-encoder is different in kind: it is a deeper model of the same
/// (query, passage) semantic relation the bi-encoder only approximates, so
/// bi-encoder recall → cross-encoder precision is *more* of what that user asked
/// for, not less. So `vector` gets a window here — but an **unreranked** one, so
/// that when the model declines, the fallback is the pure vector order and no
/// lexical signal ever enters this mode.
#[tauri::command]
pub async fn rerank_search_window(
    state: State<'_, AppState>,
    query: SearchQuery,
) -> Result<RerankWindow, ZettelError> {
    let mode = query.mode.as_deref().unwrap_or("fts");
    let limit = query.limit.unwrap_or(20);

    // Force Tier 1 for the Rust-side pass regardless of the persisted mode: the
    // caller *is* the external tier, so consulting `active_config().mode` here
    // would only risk `Off` handing back an unreranked, unscored window.
    let mut config = rerank::active_config();
    config.mode = rerank::RerankMode::Lexical;
    let window_limit = limit.max(config.effective_top_k());

    let results = {
        let conn = state.db.lock()?;
        match mode {
            "hybrid" => {
                let emb = query.query_embedding.as_deref().ok_or_else(|| {
                    ZettelError::Llm(
                        "Missing pre-computed query embedding for hybrid search".to_string(),
                    )
                })?;
                search::hybrid_search_reranked(
                    &conn,
                    &query.query,
                    emb,
                    window_limit,
                    &config,
                    None,
                )?
            }
            // Pure-vector mode gets a window too — a cross-encoder is *more*
            // semantic ordering, not the lexical signal this mode opted out of
            // (see the ordering-ownership note above) — but the window itself is
            // deliberately **unreranked**: no `*_reranked` wrapper, so when the
            // model declines the fallback is the raw vector order and no lexical
            // feature ever touches this mode.
            "vector" => {
                let emb = query.query_embedding.as_deref().ok_or_else(|| {
                    ZettelError::Llm(
                        "Missing pre-computed query embedding for vector search".to_string(),
                    )
                })?;
                search::vector_search(&conn, emb, window_limit)?
            }
            _ => search::full_text_search_reranked(
                &conn,
                &query.query,
                window_limit,
                &config,
                None,
            )?,
        }
    };

    // Snippet budget belongs to the consumer (a cross-encoder truncates at its own
    // 512-token window anyway), so use the same ~1000 chars `reranker.ts` defaults
    // to rather than the tighter LLM budget.
    let candidates = rerank::build_candidates(&results, 1_000);
    Ok(RerankWindow { results, candidates, limit })
}

#[cfg(test)]
mod rerank_config_command_tests {
    use super::*;

    /// `set_rerank_config` needs a `State<AppState>`, which cannot be built
    /// outside a running Tauri app, so the validation it delegates to is tested
    /// directly here. The command itself is a thin
    /// validate → persist → publish sequence over these two primitives.
    #[test]
    fn out_of_range_knobs_are_rejected_with_a_bilingual_message() {
        assert!(check_range(1, rerank::TOP_K_RANGE, "topK").is_err());
        assert!(check_range(201, rerank::TOP_K_RANGE, "topK").is_err());
        assert!(check_range(2, rerank::TOP_K_RANGE, "topK").is_ok());
        assert!(check_range(200, rerank::TOP_K_RANGE, "topK").is_ok());

        assert!(check_range(1_usize, rerank::LLM_MAX_CANDIDATES_RANGE, "llmMaxCandidates").is_err());
        assert!(check_range(79_usize, rerank::LLM_MAX_SNIPPET_CHARS_RANGE, "x").is_err());
        assert!(check_range(499_u64, rerank::LLM_TIMEOUT_MS_RANGE, "llmTimeoutMs").is_err());

        let err = check_range(0_usize, rerank::TOP_K_RANGE, "topK").unwrap_err();
        let msg = err.to_string();
        // Both halves must be present: the settings surface is bilingual.
        assert!(msg.contains("超出允许范围"), "missing zh half: {}", msg);
        assert!(msg.contains("outside the allowed range"), "missing en half: {}", msg);
    }

    #[test]
    fn invalid_mode_string_is_rejected() {
        assert!(rerank::parse_mode_strict("lexical").is_some());
        assert!(rerank::parse_mode_strict("bm25").is_none());
    }
}
