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
//! ## Without the WebView
//! [`embed_for_search`] picks the path from the model that built the index
//! (`embedding_model_key`), so it also works in the stand-alone `--mcp-server`
//! process, which has no window:
//! - `custom:<url>|<model>` → Rust calls the OpenAI-compatible endpoint itself
//!   (same request as the app's `fetch_custom_embeddings`).
//! - `local:<id>` → the WebView bridge when a window answers (exact match with
//!   the stored vectors), else the bundled model run natively in Rust
//!   ([`crate::db::native_embedder`]).
//!
//! Every success says which path produced it (`origin`); when all paths fail
//! the caller gets the reasons and must report the degradation honestly rather
//! than claim a semantic search.

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

/// Which model built the vector index, from its `embedding_model_key`.
#[derive(Debug, Clone, PartialEq)]
pub enum IndexModel {
    /// The bundled model (also assumed when no key is recorded: the default).
    Local,
    /// An OpenAI-compatible endpoint.
    Custom { api_url: String, model: String },
}

impl IndexModel {
    pub fn from_key(key: Option<&str>) -> Self {
        match key.and_then(|k| k.strip_prefix("custom:")).and_then(|rest| rest.rsplit_once('|')) {
            Some((url, model)) if !url.is_empty() && !model.is_empty() => {
                IndexModel::Custom { api_url: url.to_string(), model: model.to_string() }
            }
            _ => IndexModel::Local,
        }
    }

    /// Read the key from the database the search will run against.
    pub fn of_db(conn: &rusqlite::Connection) -> Self {
        let key = crate::db::schema::get_setting(conn, crate::db::embedding_cache::MODEL_KEY_SETTING)
            .ok()
            .flatten();
        Self::from_key(key.as_deref())
    }
}

/// A query vector and the path that produced it.
#[derive(Debug)]
pub struct QueryEmbedding {
    pub vector: Vec<f32>,
    /// `webview` | `native_local` | `custom_api`
    pub origin: &'static str,
}

/// Embed `text` as a search query with the model that built the index.
///
/// `Err` carries short machine-readable reasons (`no_window`, `timeout`,
/// `local_model_missing`, `custom_api: ...`, `dimension_mismatch: ...`; several
/// joined by `; ` when the native fallback failed too), suitable for a tool's
/// `degradation_reason` field.
pub async fn embed_for_search(model: &IndexModel, text: &str) -> Result<QueryEmbedding, String> {
    let (vector, origin) = match model {
        IndexModel::Custom { api_url, model } => {
            let app = crate::llm::tool_hooks::active_app_handle();
            let mut out = crate::commands::search_commands::request_custom_embeddings(
                app.as_ref(),
                api_url,
                model,
                &[text.to_string()],
                false,
            )
            .await
            .map_err(|e| format!("custom_api: {e}"))?;
            (out.pop().filter(|v| !v.is_empty()).ok_or("custom_api: no vector returned")?, "custom_api")
        }
        IndexModel::Local => match embed_via_webview(text).await {
            Ok(v) => (v, "webview"),
            Err(bridge) => match crate::db::native_embedder::embed_query(text).await {
                Ok(v) => {
                    if bridge != "no_window" {
                        log::info!("query embedding: WebView unavailable ({bridge}), used native model");
                    }
                    (v, "native_local")
                }
                Err(native) if bridge == "no_window" => return Err(native),
                Err(native) => return Err(format!("{bridge}; native: {native}")),
            },
        },
    };
    check_dimension(&vector)?;
    Ok(QueryEmbedding { vector, origin })
}

/// A vector of another size cannot be compared with the index (e.g. a custom
/// API model whose dimension differs from the 768-dim vec0 tables).
fn check_dimension(vector: &[f32]) -> Result<(), String> {
    let want = crate::db::embedding_cache::EMBEDDING_DIM;
    if vector.len() != want {
        return Err(format!("dimension_mismatch: got {}, index is {}", vector.len(), want));
    }
    Ok(())
}

/// Embed `text` as a search query through the WebView.
pub async fn embed_via_webview(text: &str) -> Result<Vec<f32>, String> {
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
    check_dimension(&vector)?;
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

    #[test]
    fn index_model_is_read_from_the_model_key() {
        assert_eq!(IndexModel::from_key(None), IndexModel::Local);
        assert_eq!(IndexModel::from_key(Some("local:jinaai/jina-embeddings-v2-base-zh")), IndexModel::Local);
        assert_eq!(
            IndexModel::from_key(Some("custom:http://localhost:11434/v1/embeddings|bge-m3")),
            IndexModel::Custom {
                api_url: "http://localhost:11434/v1/embeddings".into(),
                model: "bge-m3".into()
            }
        );
        // A half-configured custom key cannot be called; treat as the default.
        assert_eq!(IndexModel::from_key(Some("custom:|")), IndexModel::Local);
    }

    #[tokio::test]
    async fn custom_api_is_called_from_rust_without_a_window() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/embeddings", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 16 * 1024];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.contains("\"model\":\"m\""), "{req}");
            let vec: Vec<String> = (0..crate::db::embedding_cache::EMBEDDING_DIM).map(|_| "0.5".into()).collect();
            let body = format!(r#"{{"data":[{{"index":0,"embedding":[{}]}}]}}"#, vec.join(","));
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        let got = embed_for_search(&IndexModel::Custom { api_url: url, model: "m".into() }, "q")
            .await
            .unwrap();
        assert_eq!(got.origin, "custom_api");
        assert_eq!(got.vector.len(), crate::db::embedding_cache::EMBEDDING_DIM);
    }

    #[tokio::test]
    async fn emit_failure_is_returned_immediately() {
        let err = request_with("q", Duration::from_secs(5), |_| Err("emit_failed: x".into()))
            .await
            .unwrap_err();
        assert_eq!(err, "emit_failed: x");
    }
}
