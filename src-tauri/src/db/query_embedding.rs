//! Real query embeddings for searches that run inside Rust (agent tools, MCP).
//!
//! ## The problem this fixes
//! The embedding model runs in the WebView (transformers.js), so Rust code had no
//! way to embed a query. The agent's `search_notes` therefore took the vector of
//! the *first full-text hit* and used it as the "query" vector. That is lexical
//! search with a nearest-neighbour expansion, not semantic search: a query with
//! no lexical hit got no semantic results at all, and a misleading first hit
//! steered the whole result set.
//!
//! ## The bridge
//! [`embed_query`] emits [`EVENT`] with `{id, text}` to the WebView. The frontend
//! embeds the text with the *same* model the index was built with (the user's
//! local or custom-API config; see `src/lib/queryEmbeddingBridge.ts`) and answers
//! through the `resolve_query_embedding` command, which calls [`resolve`]. The
//! awaiting call gets the vector or a reason it is unavailable.
//!
//! When there is no window (the stand-alone `--mcp-server` process) or the
//! frontend does not answer in time, the caller gets an error *reason* and must
//! report the degradation honestly rather than claim a semantic search.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::oneshot;

/// Event the frontend listens on.
pub const EVENT: &str = "zettel://embed-query";

/// Long enough for a cold model load in the worker (it can take tens of seconds
/// the first time), short enough that a dead listener does not hang a tool call.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(45);

type Reply = Result<Vec<f32>, String>;

#[derive(serde::Serialize, Clone, Debug)]
pub struct EmbedRequest {
    pub id: u64,
    pub text: String,
}

fn pending() -> &'static Mutex<HashMap<u64, oneshot::Sender<Reply>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Embed `text` as a search query through the WebView.
///
/// `Err` carries a short machine-readable reason (`no_window`, `timeout`,
/// `frontend_error: ...`, `dimension_mismatch: ...`) suitable for a tool's
/// `degradation_reason` field.
pub async fn embed_query(text: &str) -> Result<Vec<f32>, String> {
    use tauri::Emitter;
    let app = crate::llm::tool_hooks::active_app_handle().ok_or_else(|| "no_window".to_string())?;
    request_with(
        text,
        DEFAULT_TIMEOUT,
        |req| app.emit(EVENT, req).map_err(|e| format!("emit_failed: {e}")),
    )
    .await
}

/// Transport-independent core of [`embed_query`], so tests can stand in for the
/// WebView with a closure.
pub async fn request_with(
    text: &str,
    timeout: Duration,
    emit: impl FnOnce(&EmbedRequest) -> Result<(), String>,
) -> Result<Vec<f32>, String> {
    let id = next_id();
    let (tx, rx) = oneshot::channel();
    pending().lock().map_err(|_| "bridge_poisoned".to_string())?.insert(id, tx);

    let req = EmbedRequest { id, text: text.to_string() };
    if let Err(e) = emit(&req) {
        forget(id);
        return Err(e);
    }

    let vector = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(vector))) => vector,
        // The frontend answered, with an error of its own (model failed to load...).
        Ok(Ok(Err(e))) => return Err(format!("frontend_error: {e}")),
        Ok(Err(_)) => return Err("bridge_dropped".to_string()),
        Err(_) => {
            forget(id);
            return Err("timeout".to_string());
        }
    };

    // A vector of another size cannot be compared with the index (e.g. a custom
    // API model whose dimension differs from the 768-dim vec0 tables).
    let want = crate::db::embedding_cache::EMBEDDING_DIM;
    if vector.len() != want {
        return Err(format!("dimension_mismatch: got {}, index is {}", vector.len(), want));
    }
    Ok(vector)
}

/// Deliver the frontend's answer for request `id`. Returns `false` if nobody is
/// waiting any more (timed out, or an unknown id).
pub fn resolve(id: u64, reply: Reply) -> bool {
    let sender = pending().lock().ok().and_then(|mut p| p.remove(&id));
    match sender {
        Some(tx) => tx.send(reply).is_ok(),
        None => false,
    }
}

fn forget(id: u64) {
    if let Ok(mut p) = pending().lock() {
        p.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vec768() -> Vec<f32> {
        vec![0.01; crate::db::embedding_cache::EMBEDDING_DIM]
    }

    #[tokio::test]
    async fn answered_request_returns_the_vector() {
        let got = request_with("知识图谱", Duration::from_secs(5), |req| {
            let id = req.id;
            assert_eq!(req.text, "知识图谱");
            // Answer from "the frontend" on another task, as the real bridge does.
            tokio::spawn(async move { assert!(resolve(id, Ok(vec768()))) });
            Ok(())
        })
        .await;
        assert_eq!(got.unwrap().len(), crate::db::embedding_cache::EMBEDDING_DIM);
    }

    #[tokio::test]
    async fn silence_times_out_and_cleans_up() {
        let mut seen = 0;
        let got = request_with("q", Duration::from_millis(30), |req| {
            seen = req.id;
            Ok(())
        })
        .await;
        assert_eq!(got.unwrap_err(), "timeout");
        assert!(!resolve(seen, Ok(vec768())), "a late answer must find nobody waiting");
    }

    #[tokio::test]
    async fn frontend_error_and_wrong_dimension_are_reported() {
        let err = request_with("q", Duration::from_secs(5), |req| {
            let id = req.id;
            tokio::spawn(async move { resolve(id, Err("model not loaded".into())) });
            Ok(())
        })
        .await
        .unwrap_err();
        assert!(err.starts_with("frontend_error"), "{err}");

        let err = request_with("q", Duration::from_secs(5), |req| {
            let id = req.id;
            tokio::spawn(async move { resolve(id, Ok(vec![0.0; 1536])) });
            Ok(())
        })
        .await
        .unwrap_err();
        assert!(err.starts_with("dimension_mismatch"), "{err}");
    }

    #[tokio::test]
    async fn emit_failure_is_returned_immediately() {
        let err = request_with("q", Duration::from_secs(5), |_| Err("emit_failed: x".into()))
            .await
            .unwrap_err();
        assert_eq!(err, "emit_failed: x");
    }
}
