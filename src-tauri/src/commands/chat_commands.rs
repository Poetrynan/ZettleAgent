use tauri::{Emitter, State};
use crate::AppState;
use crate::llm::{self, ChatMessage, LlmConfig};
use crate::db::search;
use crate::error::ZettelError;
use super::{ChatRequest, ChatResponse, RagChatRequest, CardMetadataRequest};

#[tauri::command]
pub async fn chat_with_llm(
    // Injected by Tauri, not sent by the caller — needed to read the key out of
    // the OS credential store for users who have migrated.
    app: tauri::AppHandle,
    request: ChatRequest,
) -> Result<ChatResponse, ZettelError> {
    // Cloned rather than moved out of `request`: the whole struct is handed to
    // `run_agent_turn` below, which still needs `vault_path`, `messages`, etc.
    let config = LlmConfig {
        api_url: request.api_url.clone().unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key.clone()),
        model: request.model.clone().unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id.clone(),
        supports_thinking: request.supports_thinking,
        ..Default::default()
    };

    let content = llm::chat_completion(&config, &request.messages)
        .await
        .map_err(|e| ZettelError::Llm(llm::format_llm_user_error(&e.to_string())))?;

    Ok(ChatResponse {
        content,
        model: config.model,
    })
}

#[tauri::command]
pub async fn chat_with_llm_stream(
    app: tauri::AppHandle,
    request: ChatRequest,
) -> Result<(), ZettelError> {
    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key),
        model: request.model.unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id,
        supports_thinking: request.supports_thinking,
        ..Default::default()
    };

    let mut rx = llm::chat_completion_stream(&config, &request.messages)
        .await
        .map_err(|e| ZettelError::Llm(llm::format_llm_user_error(&e.to_string())))?;

    while let Some(chunk) = rx.recv().await {
        let _ = app.emit("llm-stream-chunk", serde_json::json!({
            "content": chunk.content,
            "done": chunk.done,
        }));
        if chunk.done {
            break;
        }
    }

    Ok(())
}

/// Helper: format search results into structured context chunks with rich source metadata.
/// R-5: Upgraded format helps LLM cite sources more precisely.
fn format_rag_chunks(results: &[search::SearchResult]) -> Vec<String> {
    results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let note_name = std::path::Path::new(&r.file_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| r.file_path.clone());
            let section = r.heading_hierarchy.as_deref().unwrap_or("");
            let section_line = if section.is_empty() {
                String::new()
            } else {
                format!("\n📍 Section: {}", section)
            };
            format!(
                "--- Source #{} ---\n📄 Note: [[{}]]{}\n🔗 Path: {}\n📊 Relevance: {:.0}%\n\n{}",
                i + 1,
                note_name,
                section_line,
                r.file_path,
                r.score * 100.0,
                r.content
            )
        })
        .collect()
}

/// Helper: build the full context block from chunks, current file hint, and attached notes.
fn build_rag_context(
    chunks: &[String],
    current_file: Option<&str>,
    attached_context: Option<&str>,
) -> String {
    let mut parts = Vec::new();

    if let Some(cf) = current_file {
        if !cf.is_empty() {
            parts.push(format!(
                "The user currently has this note open: \"{}\". When they say \"this note\" or \"this file\", they mean this one.",
                cf
            ));
        }
    }

    if let Some(ac) = attached_context {
        if !ac.is_empty() {
            parts.push(ac.to_string());
        }
    }

    if chunks.is_empty() {
        parts.push("No relevant notes found in the knowledge base. (知识库中未找到相关笔记)".to_string());
    } else {
        parts.push(format!(
            "Below are relevant snippets from the knowledge base:\n\n{}",
            chunks.join("\n\n---\n\n")
        ));
    }

    parts.join("\n\n")
}

/// Helper: trim chat history to fit within a rough token budget.
fn trim_history(history: &[ChatMessage], max_chars: usize) -> Vec<ChatMessage> {
    let mut total_chars = 0usize;
    let mut result = Vec::new();
    // Take from the end (most recent first), up to budget
    for msg in history.iter().rev() {
        let msg_chars = msg.content.len();
        if total_chars + msg_chars > max_chars {
            break;
        }
        total_chars += msg_chars;
        result.push(msg.clone());
    }
    result.reverse();
    result
}

/// R-3: Rewrite ambiguous queries into standalone search queries using LLM.
/// Only triggers when the query is genuinely short or carries an unresolved
/// deictic reference.
///
/// The gate used to be `chars().count() < 30 || [...pronouns].contains(p)`,
/// which fired on nearly every turn and cost a full blocking LLM round-trip
/// before the answer could start streaming:
///   - 30 *characters* is a complete sentence in Chinese ("帮我总结这周的笔记要点"
///     is 11 chars), so the length test almost always passed.
///   - the pronoun list was matched with a bare `contains`, so `"it"` matched
///     inside `with` / `item` / `limit` / `write` / `position` — almost every
///     English query hit too.
/// Now: a much lower length floor, and word-boundary matching for the Latin
/// pronouns so only a real standalone pronoun counts.
async fn rewrite_query_for_search(
    config: &LlmConfig,
    original_query: &str,
    chat_history: Option<&[ChatMessage]>,
) -> String {
    /// A genuinely context-dependent query is very short — anything longer
    /// normally carries its own subject and searches fine as-is.
    const SHORT_QUERY_CHARS: usize = 12;

    let lower = original_query.to_lowercase();

    // CJK deictics have no word boundaries, so substring matching is correct here.
    let cjk_deictic = ["这个", "那个", "上面", "刚才", "之前", "上述", "他们", "它们"]
        .iter()
        .any(|p| original_query.contains(p));

    // Latin pronouns must match as whole words, otherwise "it" swallows
    // "with"/"item"/"limit" and the gate degenerates to "always rewrite".
    let latin_deictic = lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| matches!(w, "this" | "that" | "these" | "those" | "it" | "they" | "them" | "above" | "earlier"));

    let needs_rewrite =
        original_query.chars().count() < SHORT_QUERY_CHARS || cjk_deictic || latin_deictic;

    let history = match chat_history {
        Some(h) if !h.is_empty() && needs_rewrite => h,
        _ => return original_query.to_string(),
    };

    // Build a minimal context from last 3 messages
    let recent: Vec<String> = history.iter().rev().take(3).rev().map(|m| {
        // Slice on a char boundary — `&s[..200]` panics mid-codepoint on CJK.
        let preview: String = m.content.chars().take(200).collect();
        format!("{}: {}", m.role, preview)
    }).collect();

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "Given the conversation context, rewrite the user's latest query into a standalone search query suitable for searching a note database. Output ONLY the rewritten query text, nothing else. Keep the same language.".to_string(),
            ..Default::default()
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!(
                "Conversation:\n{}\n\nLatest query to rewrite: \"{}\"",
                recent.join("\n"),
                original_query
            ),
            ..Default::default()
        },
    ];

    match llm::chat_completion(config, &messages).await {
        Ok(rewritten) => {
            let trimmed = rewritten.trim().trim_matches('"').to_string();
            if !trimmed.is_empty() && trimmed.len() < 200 {
                log::info!("R-3 Query rewrite: \"{}\" → \"{}\"", original_query, trimmed);
                trimmed
            } else {
                original_query.to_string()
            }
        }
        Err(e) => {
            log::warn!("R-3 Query rewrite failed: {}", e);
            original_query.to_string()
        }
    }
}

/// R-4: Lightweight LLM-based reranking of search results.
/// Uses a listwise approach: asks LLM to rank passage indices by relevance.
/// Only used when we have more results than needed (over-fetch then rerank).
async fn rerank_chunks(
    config: &LlmConfig,
    query: &str,
    results: &[search::SearchResult],
    top_k: usize,
) -> Vec<search::SearchResult> {
    // Don't rerank if we have few results already
    if results.len() <= top_k {
        return results.to_vec();
    }

    // Build compact passage list for LLM
    let passage_list: String = results.iter().enumerate().map(|(i, r)| {
        let preview: String = r.content.chars().take(150).collect();
        format!("[{}] {}", i, preview.replace('\n', " "))
    }).collect::<Vec<_>>().join("\n");

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Given the query: \"{}\"\nRank these passages by relevance to the query. Output ONLY a comma-separated list of passage numbers (e.g. \"2,0,4,1,3\"), most relevant first. Output {} numbers.",
                query, top_k.min(results.len())
            ),
            ..Default::default()
        },
        ChatMessage {
            role: "user".to_string(),
            content: passage_list,
            ..Default::default()
        },
    ];

    match llm::chat_completion(config, &messages).await {
        Ok(ranking_text) => {
            // Parse comma-separated indices
            let indices: Vec<usize> = ranking_text
                .trim()
                .split(|c: char| c == ',' || c.is_whitespace())
                .filter_map(|s| s.trim().parse::<usize>().ok())
                .filter(|&idx| idx < results.len())
                .collect();

            if indices.is_empty() {
                log::warn!("R-4 Reranking: failed to parse LLM ranking, using original order");
                return results[..top_k.min(results.len())].to_vec();
            }

            // Deduplicate while preserving order
            let mut seen = std::collections::HashSet::new();
            let mut reranked: Vec<search::SearchResult> = Vec::new();
            for idx in &indices {
                if seen.insert(*idx) {
                    reranked.push(results[*idx].clone());
                }
                if reranked.len() >= top_k { break; }
            }
            // Fill remaining slots with unranked results
            for (i, r) in results.iter().enumerate() {
                if reranked.len() >= top_k { break; }
                if !seen.contains(&i) {
                    reranked.push(r.clone());
                }
            }

            log::info!("R-4 Reranked {} → {} results for query: {}", results.len(), reranked.len(), query);
            reranked
        }
        Err(e) => {
            log::warn!("R-4 Reranking failed: {}, using original order", e);
            results[..top_k.min(results.len())].to_vec()
        }
    }
}

/// Downgrade hybrid/vector → fts when the vault has no vector index.
fn rag_effective_search_mode(conn: &rusqlite::Connection, requested: &str) -> String {
    if requested != "hybrid" && requested != "vector" {
        return requested.to_string();
    }
    let has_index: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM chunks_vec LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap_or(false);
    if has_index {
        requested.to_string()
    } else {
        log::info!(
            "[RAG] Vector index empty — falling back to FTS (requested={})",
            requested
        );
        "fts".to_string()
    }
}

fn rag_run_search(
    conn: &rusqlite::Connection,
    search_mode: &str,
    query: &str,
    query_embedding: Option<&[f32]>,
    limit: usize,
) -> Result<Vec<search::SearchResult>, ZettelError> {
    // Relevance rerank config comes from process state (restored from
    // `app_settings` at startup), so RAG retrieval honours the same user setting
    // as the search panel without threading it through every RAG entry point.
    //
    // `external: None` ⇒ Tier 1 (lexical). Tiers 2/3 need either the webview's
    // ONNX model or an awaited LLM call; this function is sync and runs while the
    // caller holds the DB lock, so neither can happen here. `rerank_results`
    // already degrades CrossEncoder/Llm to Tier 1 when no external reranker is
    // supplied, so a user on mode=crossEncoder still gets a reranked RAG context.
    //
    // This is **not** a pending TODO. Tier 2 lives in the webview, and an agent
    // turn has no webview in the loop: bridging it would mean suspending the turn
    // mid-tool-call on a frontend round trip and resuming it — a pending-
    // continuation registry, not a wiring change. The honest alternative is for
    // the *caller* to pre-rank via `rerank_search_window` and pass an explicit
    // chunk order into the RAG command, which changes this command's contract.
    // Until then, agent RAG is Tier 1 and says so.
    let config = crate::db::search::rerank::active_config();
    match search_mode {
        "hybrid" => {
            let emb = query_embedding.ok_or_else(|| {
                ZettelError::Llm("Missing query embedding for hybrid search".to_string())
            })?;
            Ok(search::hybrid_search_reranked(conn, query, emb, limit, &config, None)?)
        }
        "vector" => {
            let emb = query_embedding.ok_or_else(|| {
                ZettelError::Llm("Missing query embedding for vector search".to_string())
            })?;
            // Left unreranked: see the note in `search_commands::search_chunks`.
            Ok(search::vector_search(conn, emb, limit)?)
        }
        _ => Ok(search::full_text_search_reranked(conn, query, limit, &config, None)?),
    }
}

#[tauri::command]
pub async fn rag_search_and_chat(
    // Injected by Tauri — see `chat_with_llm`.
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: RagChatRequest,
) -> Result<ChatResponse, ZettelError> {
    let search_mode = request.search_mode.as_deref().unwrap_or("fts");
    let limit = request.search_limit.unwrap_or(5);

    let context_chunks = {
        let conn = state.db.lock()?;
        let effective_mode = rag_effective_search_mode(&conn, search_mode);
        let query_embedding = request.query_embedding.as_deref();
        let search_results = rag_run_search(
            &conn,
            &effective_mode,
            &request.query,
            query_embedding,
            limit,
        )?;
        format_rag_chunks(&search_results)
    };

    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key),
        model: request.model.unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id,
        ..Default::default()
    };

    let methodology = request.methodology.as_deref().unwrap_or("zettelkasten");
    let context_block = build_rag_context(
        &context_chunks,
        request.current_file.as_deref(),
        request.attached_context.as_deref(),
    );

    let system_prompt = crate::llm::prompts::rag_system_prompt(methodology);
    let rag_prompt = crate::llm::prompts::rag_answer_prompt(&context_block, &request.query);

    let messages = vec![
        ChatMessage { role: "system".to_string(), content: system_prompt, ..Default::default() },
        ChatMessage { role: "user".to_string(), content: rag_prompt, ..Default::default() },
    ];

    let content = llm::chat_completion(&config, &messages)
        .await
        .map_err(|e| ZettelError::Llm(llm::format_llm_user_error(&e.to_string())))?;

    Ok(ChatResponse {
        content,
        model: config.model,
    })
}

#[tauri::command]
pub async fn rag_search_and_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: RagChatRequest,
) -> Result<(), ZettelError> {
    let search_mode = request.search_mode.as_deref().unwrap_or("fts");
    let limit = request.search_limit.unwrap_or(5);

    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key.clone()),
        model: request.model.clone().unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id.clone(),
        ..Default::default()
    };

    crate::chat_file_log::log_rag(&format!(
        "turn_start query={} mode={} limit={} model={}",
        crate::chat_file_log::trunc(&request.query, 240),
        search_mode,
        limit,
        config.model
    ));

    // R-3: Rewrite ambiguous queries for better search results
    let search_query = rewrite_query_for_search(
        &config,
        &request.query,
        request.chat_history.as_deref(),
    ).await;

    if search_query != request.query {
        crate::chat_file_log::log_rag(&format!(
            "query_rewrite {} -> {}",
            crate::chat_file_log::trunc(&request.query, 120),
            crate::chat_file_log::trunc(&search_query, 120)
        ));
    }

    // Stage 1: Searching knowledge base
    let _ = app.emit("rag-progress", serde_json::json!({
        "stage": "searching",
        "mode": search_mode,
    }));

    // R-4: Over-fetch 2x for reranking (only for hybrid/vector modes)
    let fetch_limit = if search_mode == "hybrid" || search_mode == "vector" {
        limit * 2
    } else {
        limit
    };

    let raw_results = {
        let conn = state.db.lock()?;
        let effective_mode = rag_effective_search_mode(&conn, search_mode);
        let query_embedding = request.query_embedding.as_deref();
        rag_run_search(
            &conn,
            &effective_mode,
            &search_query,
            query_embedding,
            fetch_limit,
        )?
    };

    // R-4: Rerank over-fetched results (only when we have more than needed)
    let reranked_results = if raw_results.len() > limit && (search_mode == "hybrid" || search_mode == "vector") {
        rerank_chunks(&config, &search_query, &raw_results, limit).await
    } else {
        raw_results
    };

    // R-6: Exclude previously returned file paths to avoid repeating the same sources
    let search_results = if let Some(ref exclude) = request.exclude_paths {
        if !exclude.is_empty() {
            let filtered: Vec<_> = reranked_results.iter()
                .filter(|r| !exclude.iter().any(|ex| r.file_path == *ex))
                .cloned()
                .collect();
            log::info!("R-6: Excluded {} previously seen paths, {} results remain",
                exclude.len(), filtered.len());
            filtered
        } else {
            reranked_results
        }
    } else {
        reranked_results
    };

    let source_results = search_results.clone();
    let context_chunks = format_rag_chunks(&search_results);

    let source_summary: String = source_results
        .iter()
        .take(8)
        .map(|r| format!("{} (score={:.3})", r.file_path, r.score))
        .collect::<Vec<_>>()
        .join("; ");
    crate::chat_file_log::log_rag(&format!(
        "search_done hits={} context_chunks={} sources={}",
        source_results.len(),
        context_chunks.len(),
        if source_summary.is_empty() {
            "none".to_string()
        } else {
            crate::chat_file_log::trunc(&source_summary, 480)
        }
    ));

    // No progress event between search and generation: building the prompt from
    // the retrieved chunks is in-memory string work that finishes in well under
    // a millisecond, so the retrieval stage simply stays lit until the LLM call
    // actually starts. `search_done` above is the audit trail for chunk counts.

    let methodology = request.methodology.as_deref().unwrap_or("zettelkasten");
    let system_prompt = crate::llm::prompts::rag_system_prompt(methodology);
    let context_block = build_rag_context(
        &context_chunks,
        request.current_file.as_deref(),
        request.attached_context.as_deref(),
    );
    let rag_prompt = crate::llm::prompts::rag_answer_prompt(&context_block, &request.query);

    let mut messages = vec![
        ChatMessage { role: "system".to_string(), content: system_prompt, ..Default::default() },
    ];
    // Insert chat history for multi-turn context (if provided), with token budget
    if let Some(history) = &request.chat_history {
        let trimmed = trim_history(history, 12000); // ~3000 tokens budget for history
        for msg in &trimmed {
            messages.push(ChatMessage {
                role: msg.role.clone(),
                content: msg.content.clone(),
                ..Default::default()
            });
        }
    }
    messages.push(ChatMessage { role: "user".to_string(), content: rag_prompt, ..Default::default() });

    // Stage 3: Calling LLM
    let _ = app.emit("rag-progress", serde_json::json!({
        "stage": "generating",
    }));

    crate::chat_file_log::log_rag("llm_stream_start");

    let mut rx = llm::chat_completion_stream(&config, &messages)
        .await
        .map_err(|e| {
            crate::chat_file_log::log_rag(&format!("error stream_start {}", e));
            ZettelError::Llm(llm::format_llm_user_error(&e.to_string()))
        })?;

    let mut streamed_chars = 0usize;
    while let Some(chunk) = rx.recv().await {
        streamed_chars += chunk.content.len();
        let _ = app.emit("llm-stream-chunk", serde_json::json!({
            "content": chunk.content,
            "done": chunk.done,
        }));
        if chunk.done { break; }
    }

    crate::chat_file_log::log_rag(&format!("llm_stream_done chars={}", streamed_chars));

    let _ = app.emit("rag-sources", serde_json::json!({
        "sources": source_results.iter().map(|r| {
            serde_json::json!({
                "file_path": r.file_path,
                "chunk_id": r.chunk_id,
                "content": r.content,
                "heading_hierarchy": r.heading_hierarchy,
                "score": r.score,
            })
        }).collect::<Vec<_>>(),
    }));

    crate::chat_file_log::log_rag("turn_complete");

    Ok(())
}

#[tauri::command]
pub async fn generate_card_metadata(
    // Injected by Tauri — see `chat_with_llm`.
    app: tauri::AppHandle,
    request: CardMetadataRequest,
) -> Result<String, ZettelError> {
    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key),
        model: request.model.unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id,
        ..Default::default()
    };

    let methodology = request.methodology.as_deref().unwrap_or("zettelkasten");
    let prompt = llm::prompts::card_metadata_prompt(&request.note_content, methodology);

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: prompt,
        ..Default::default()
    }];

    let response = llm::chat_completion(&config, &messages)
        .await
        .map_err(|e| ZettelError::Llm(llm::format_llm_user_error(&e.to_string())))?;

    Ok(response)
}

// ── ChangeSet 守卫的两个薄封装 / thin wrappers around the write guard ────────
//
// 单独抽出来只为一件事：`db.lock()` 拿到的 `MutexGuard` 不能跨 `.await` 活着。
// 把它关在这两个同步函数里，锁在函数返回时就释放了，工具执行的 await 完全在锁外。

/// 守卫放行与否 / whether the tool call may proceed.
enum GuardOutcome {
    /// 可以执行。`Some` 表示执行后要记账，`None` 表示这个工具不写知识内容。
    Proceed(Option<crate::knowledge::write_guard::ReadyWrite>),
    /// 不执行，把这段话回给模型。
    Stop(String),
}

fn open_write_guard(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    vault: &str,
    all_vaults: &[String],
    name: &str,
    args: &str,
) -> Result<GuardOutcome, String> {
    use crate::knowledge::write_guard::{self, Guarded, WriteContext};

    let ctx = WriteContext {
        actor: "agent".to_string(),
        session_id: None,
        run_id: crate::llm::tool_hooks::current_run_id(),
        primary_vault: vault.to_string(),
        vaults: all_vaults.to_vec(),
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    match write_guard::open(&conn, &ctx, name, args).map_err(|e| e.to_string())? {
        Guarded::Unguarded => Ok(GuardOutcome::Proceed(None)),
        Guarded::Ready(ready) => {
            crate::chat_file_log::log_agent(&format!(
                "changeset_ready tool={} id={} paths={}",
                name,
                ready.changeset_id,
                ready.paths.len()
            ));
            Ok(GuardOutcome::Proceed(Some(ready)))
        }
        Guarded::Refused { refusal, .. } => Ok(GuardOutcome::Stop(format!(
            "Refused: {}. Nothing was written.",
            refusal.message()
        ))),
        Guarded::Conflicted { report, .. } => {
            // 把冲突原文回给模型，让它知道该重新读一遍而不是重试同一份内容。
            let detail = report
                .ops
                .iter()
                .filter_map(|op| op.conflict.as_ref().map(|c| c.message()))
                .collect::<Vec<_>>()
                .join("; ");
            Ok(GuardOutcome::Stop(format!(
                "Conflict: {}. Nothing was written — re-read the note before writing again.",
                detail
            )))
        }
    }
}

fn settle_write_guard(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    ready: &crate::knowledge::write_guard::ReadyWrite,
    error: Option<&str>,
) {
    let Ok(conn) = db.lock() else {
        // 记不上账不能装作记上了：批次会停在 approved，由 stale_changesets 兜底。
        crate::chat_file_log::log_agent(&format!(
            "changeset_settle_skipped id={} reason=db_lock",
            ready.changeset_id
        ));
        return;
    };
    let outcome = match error {
        None => Ok(()),
        Some(e) => Err(e),
    };
    if let Err(e) = crate::knowledge::write_guard::settle(&conn, ready, outcome) {
        crate::chat_file_log::log_agent(&format!(
            "changeset_settle_failed id={} err={}",
            ready.changeset_id, e
        ));
    }
}

#[tauri::command]
pub async fn agent_chat(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: super::AgentChatRequest,
) -> Result<String, ZettelError> {
    // Mint a fresh run id. This subsumes the old `reset_agent_stop()` since
    // `begin_agent_run()` resets the stop flag internally and also publishes a
    // `RunStarted` event so the frontend can filter stale payloads.
    let run_id = llm::begin_agent_run();
    let _ = app.emit("agent-event", serde_json::json!({
        "type": "run_started",
        "run_id": run_id,
    }));

    // Clone the fields the config needs: `request` itself is handed whole to
    // `run_agent_turn` below (it still needs messages, vault_path, current_file…),
    // so we must not move individual fields out of it here.
    let config = LlmConfig {
        api_url: request.api_url.clone().unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key.clone()),
        model: request.model.clone().unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id.clone(),
        supports_thinking: request.supports_thinking,
        ..Default::default()
    };

    // A single-note turn is just the N=1 case of a batch, so the turn body lives
    // in `run_agent_turn` and both callers share it. The run lifecycle stays
    // *here* on purpose — see that function's doc comment.
    run_agent_turn(&state, &app, config, request).await
}

/// One agent turn: everything after the run id has been minted.
///
/// Factored out of `agent_chat` so `run_batch_agent` can push N notes through
/// the **same** run_id. It deliberately does **not** call `begin_agent_run()` —
/// that would mint a fresh id per note and make `undo_agent_run` a per-note
/// operation, which is exactly what the batch feature exists to avoid. The
/// caller owns the run lifecycle; this function only consumes the ambient
/// run_id that `tool_hooks` already carries.
async fn run_agent_turn(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    config: LlmConfig,
    request: super::AgentChatRequest,
) -> Result<String, ZettelError> {
    let vault_path = request.vault_path.unwrap_or_default();
    // Build the complete list of vault paths (multi-vault support)
    let all_vault_paths: Vec<String> = {
        let mut paths = request.vault_paths.unwrap_or_default();
        // Ensure primary vault_path is always included and first
        if !vault_path.is_empty() {
            if !paths.contains(&vault_path) {
                paths.insert(0, vault_path.clone());
            }
        }
        paths.retain(|p| !p.is_empty());
        if paths.is_empty() && !vault_path.is_empty() {
            paths.push(vault_path.clone());
        }
        paths
    };

    // Load MCP configs + skill directories in one DB lock acquisition
    let (mcp_configs, skill_dirs) = {
        let conn = state.db.lock().map_err(|e| ZettelError::System(e.to_string()))?;
        let mcp_json = crate::db::schema::get_setting(&conn, "mcp_servers")
            .ok().flatten()
            .unwrap_or_else(|| "[]".to_string());
        let mcp_configs: Vec<crate::tools::mcp_client::McpServerConfig> = serde_json::from_str(&mcp_json)
            .unwrap_or_default();

        let skill_json = crate::db::schema::get_setting(&conn, "skill_directories")
            .ok().flatten()
            .unwrap_or_else(|| "[]".to_string());
        let skill_dirs: Vec<String> = serde_json::from_str(&skill_json).unwrap_or_default();
        drop(conn);

        (mcp_configs, skill_dirs)
    };

    // Collect MCP tool definitions
    let mcp_tools = {
        if mcp_configs.iter().any(|c| c.enabled) {
            let (tools, errors) = crate::tools::mcp_client::collect_mcp_tools(&mcp_configs);
            for err in &errors {
                log::warn!("MCP: {}", err);
            }
            tools
        } else {
            Vec::new()
        }
    };

    let tools = crate::tools::get_all_tool_defs(&mcp_tools, &skill_dirs);
    let mut messages = request.messages;

    // Extract the last user message early: archival recall keys off it, so we
    // need this value BEFORE the memory-loading block below. It is recomputed
    // later verbatim for downstream routing to keep the diff minimal — cost is
    // one linear scan of a small Vec.
    let user_query_for_recall: String = messages.iter().rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    // ── Layered Memory Loading (2026 MemGPT-style) ───────────────────

    // Layer 1: Core Memory — structured memory.md, always loaded in system prompt
    let core_memory_context = {
        let mut core_parts: Vec<String> = Vec::new();

        for vp in &all_vault_paths {
            let memory_path = std::path::PathBuf::from(vp)
                .join(".zettelagent")
                .join("memory.md");
            if memory_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&memory_path) {
                    let mem = crate::tools::internal_tools::workspace_ops::parse_structured_memory(&content);

                    // Build structured section output
                    for (section, items) in &mem.sections {
                        if !items.is_empty() {
                            core_parts.push(format!("### {}", section));
                            for item in items {
                                core_parts.push(format!("- {}", item));
                            }
                        }
                    }
                }
            }
        }

        core_parts.join("\n")
    };

    // Layer 2: Archival Memory — lexically recall the most relevant facts for
    // this turn's query (Mem0-style retrieval). We inject the actual contents,
    // not just a count, so the model can use them without an extra tool round
    // trip. Expired facts are pruned first so they never surface.
    let archival_recalled: Vec<crate::db::memory_store::ArchivalMemory> = {
        match state.db.lock() {
            Ok(conn) => {
                let _ = crate::db::memory_store::prune_expired(&conn);
                crate::db::memory_store::recall(
                    &conn,
                    &user_query_for_recall,
                    crate::db::memory_store::RECALL_LIMIT,
                )
                .unwrap_or_default()
            }
            Err(_) => Vec::new(),
        }
    };

    // Build unified memories context string for agent prompts.
    //
    // Core memory is deliberately NOT dumped here any more: `ContextCompiler`
    // picks the `memory.md` sections that are relevant to this turn instead of
    // copying the whole file every turn (see the compile call below, and
    // `core_memory_fallback` for what happens when compilation fails).
    let memories_context = {
        let mut ctx = String::new();

        if !archival_recalled.is_empty() {
            ctx.push_str("### Recalled Memory (relevant to this request)\n");
            for m in &archival_recalled {
                if m.category.is_empty() {
                    ctx.push_str(&format!("- {}\n", m.content));
                } else {
                    ctx.push_str(&format!("- [{}] {}\n", m.category, m.content));
                }
            }
            ctx.push_str("_(More may exist — use `search_memory` to look for anything not shown here.)_\n");
        }

        ctx
    };

    // Load Skill prompts from configured directories
    let skills_context = {
        if skill_dirs.is_empty() {
            String::new()
        } else {
            crate::tools::skill_loader::collect_skill_prompts(&skill_dirs)
        }
    };

    // A-1: System prompt is now constructed entirely on the backend.
    // Frontend sends flags (deep_thinking, web_search, current_file, attached_context)
    // instead of building its own system prompt, eliminating duplication.

    // Remove any frontend system prompt (if still sent for backward compatibility)
    messages.retain(|m| m.role != "system");

    let methodology = request.methodology.as_deref().unwrap_or("zettelkasten");

    // A-3: Build vault info and current time for context-aware prompts
    let vault_info = {
        let conn_result = state.db.lock();
        if let Ok(conn) = conn_result {
            let note_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                .unwrap_or(0);
            let vault_name = std::path::Path::new(&vault_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| vault_path.clone());
            format!("- Active vault: {} ({} notes)", vault_name, note_count)
        } else {
            String::new()
        }
    };
    let current_time = chrono::Local::now().format("%Y-%m-%d %H:%M (%A)").to_string();

    // ── Multi-Agent Orchestration ──────────────────────────────────────

    // Build additional context (current file, attached notes, web search flag)
    let mut additional_context_parts: Vec<String> = Vec::new();

    if request.web_search.unwrap_or(false) {
        additional_context_parts.push(
            "## Web Search Mode\nThe user has enabled Web Search. You MUST use the `web_search` tool to search the internet for relevant and up-to-date information BEFORE formulating your answer. Always search first, then synthesize the results with source references.".to_string()
        );
    }

    if let Some(ref cf) = request.current_file {
        if !cf.is_empty() {
            additional_context_parts.push(format!(
                "## Currently Open Note\nThe user has this note open: \"{}\". When they say \"this note\" or \"这篇笔记\", they mean this one.",
                cf
            ));
        }
    }

    // The attached notes themselves are no longer pasted in raw here — they go
    // through `ContextCompiler` so they arrive as a provenanced item the model
    // can tell apart from what retrieval found. `context_fallback` below still
    // pastes them raw if compilation fails.

    // Extract user query for routing (last user message)
    let user_query = messages.iter().rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    // Build chat history from request messages (for multi-turn continuity)
    let chat_history: Vec<ChatMessage> = messages.iter()
        .filter(|m| m.role != "system")
        .cloned()
        .collect();

    crate::chat_file_log::log_agent(&format!(
        "turn_start model={} query={} web_search={}",
        config.model,
        crate::chat_file_log::trunc(&user_query, 240),
        request.web_search.unwrap_or(false)
    ));

    // ── Greeting / small-talk fast-path ──────────────────────────────
    // A pure greeting ("你好啊", "hi", "thanks") does NOT need the router,
    // tool loading, agent selection, or the full multi-tool agent system
    // prompt. Running all that ceremony with a large prompt made weak/local
    // models stall before producing any token — which shows up as a stuck
    // "thinking" spinner. Answer directly with a minimal prompt and no tools:
    // instant, no stage events, no "Agent activated" badge.
    if crate::llm::is_greeting_or_chitchat(&user_query) {
        log::info!("Greeting fast-path: answering directly without orchestration");
        let mut greet_messages: Vec<ChatMessage> = vec![ChatMessage {
            role: "system".to_string(),
            content: crate::agents::fast_path::chitchat_system_prompt(&current_time),
            ..Default::default()
        }];
        greet_messages.extend(chat_history.iter().cloned());

        let content = crate::agents::fast_path::stream_natural_reply(
            &config,
            &greet_messages,
            app,
            true,
        )
        .await
        .map_err(|e| {
            crate::chat_file_log::log_agent(&format!("error greeting_path {}", e));
            e
        })?;
        crate::chat_file_log::log_agent(&format!(
            "turn_complete greeting_path chars={}",
            content.len()
        ));
        return Ok(content);
    }

    // 1. Classify intent via AgentRouter (new hybrid classifier)
    crate::chat_file_log::log_agent("stage routing");
    let _ = app.emit("agent-event", serde_json::json!({
        "type": "stage",
        "stage": "routing",
        "message": if user_query.chars().any(|c| c.is_ascii_alphabetic()) {
            "Routing request to the right agent…"
        } else {
            "正在将请求路由到合适的 Agent…"
        },
    }));
    // (The earlier 300ms `sleep` here existed only to let the frontend "routing"
    // animation play — but the animation is already event-driven, so the sleep
    // was pure dead time on the hot path. Same reasoning applies to the two
    // sleeps below and the one in `agents/instance.rs`. Total reclaimed per
    // turn: 850ms of pure wait before the first LLM byte.)

    // Use new three-layer hybrid classifier (with conversation context)
    let history_for_classify: Vec<ChatMessage> = chat_history
        .iter()
        .take(chat_history.len().saturating_sub(1))
        .cloned()
        .collect();
    let classification = crate::agents::router::AgentRouter::classify(
        &config,
        &user_query,
        if history_for_classify.is_empty() {
            None
        } else {
            Some(&history_for_classify[..])
        },
    )
    .await;

    // Emit intent classification result for frontend display
    let layer_str = match classification.layer {
        crate::agents::intent::ClassificationLayer::L0 => "L0",
        crate::agents::intent::ClassificationLayer::L1 => "L1",
        crate::agents::intent::ClassificationLayer::L2 => "L2",
    };
    let is_zh = user_query.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    let intent_name = classification.intent.label(is_zh);
    let _ = app.emit("agent-event", serde_json::json!({
        "type": "intent_classified",
        "intent": classification.intent,
        "confidence": classification.confidence,
        "layer": layer_str,
        "intent_name": intent_name,
    }));

    crate::chat_file_log::log_agent(&format!(
        "routing_done intent={:?} confidence={} layer={}",
        classification.intent, classification.confidence, layer_str
    ));

    let mut strategy = crate::agents::strategy::ExecutionStrategy::from_intent(&classification.intent);
    // Multi-turn + non-L0 chitchat → full agent (history-aware), not blind fast path.
    if strategy.fast_path
        && matches!(classification.intent, crate::agents::intent::TurnIntent::Chitchat)
        && crate::agents::intent_classifier::has_prior_assistant_turns(
            if history_for_classify.is_empty() {
                None
            } else {
                Some(&history_for_classify[..])
            },
        )
        && classification.layer != crate::agents::intent::ClassificationLayer::L0
    {
        strategy.fast_path = false;
        crate::chat_file_log::log_agent("strategy: multi_turn chitchat → full agent (not fast_path)");
    }
    let intent = crate::agents::router::AgentRouter::to_agent_intent(&classification);

    // ── L3 fast paths (high-confidence Chitchat / VaultStats) ──────────
    if strategy.fast_path {
        use crate::agents::intent::TurnIntent;
        match classification.intent {
            TurnIntent::Chitchat => {
                crate::chat_file_log::log_agent("stage executing (fast_path chitchat)");
                let _ = app.emit("agent-event", serde_json::json!({
                    "type": "stage",
                    "stage": "executing",
                    "message": if is_zh { "正在回复…" } else { "Replying…" },
                }));
                return crate::agents::fast_path::run_chitchat_fast_path(
                    &config,
                    &user_query,
                    &chat_history,
                    &current_time,
                    app,
                )
                .await;
            }
            TurnIntent::VaultStats => {
                crate::chat_file_log::log_agent("stage executing (fast_path vault_stats)");
                let _ = app.emit("agent-event", serde_json::json!({
                    "type": "stage",
                    "stage": "executing",
                    "message": if is_zh { "正在统计知识库…" } else { "Gathering vault stats…" },
                }));
                let db = state.db.clone();
                return crate::agents::fast_path::run_vault_stats_fast_path(
                    &config,
                    &user_query,
                    &chat_history,
                    &current_time,
                    &vault_info,
                    db,
                    vault_path.clone(),
                    all_vault_paths.clone(),
                    skill_dirs.clone(),
                    app,
                )
                .await;
            }
            _ => {}
        }
    }

    // Narrow the tool surface to the intent's scope (`ToolScope::None` drops everything;
    // `ToolScope::All` resolves to the default surface = tools::CORE_TOOLS + runtime
    // extension tools, not all ~63 defs — see agents/strategy.rs::visible_tool_defs).
    // The `todo_write` fallback below also guarantees the list is never empty, which
    // some providers reject when a `tools` key is present.
    let mut filtered_tools = strategy.visible_tool_defs(&tools);
    if let Some(todo) = tools.iter().find(|t| t.function.name == "todo_write") {
        if !filtered_tools.iter().any(|t| t.function.name == "todo_write") {
            filtered_tools.push(todo.clone());
        }
    }
    if request.web_search.unwrap_or(false) {
        for name in ["web_search", "fetch_web_content"] {
            if !filtered_tools.iter().any(|t| t.function.name == name) {
                if let Some(t) = tools.iter().find(|t| t.function.name == name) {
                    filtered_tools.push(t.clone());
                }
            }
        }
    }
    crate::chat_file_log::log_agent(&format!(
        "strategy tools={}/{} intent={:?}",
        filtered_tools.len(),
        tools.len(),
        classification.intent
    ));

    // ── ContextCompiler ────────────────────────────────────────────────
    // Retrieval results are never concatenated straight into the prompt. They
    // are compiled into a ContextPackage first, whose `render()` is the single
    // place knowledge becomes prompt text, and whose `inspector_summary()` is
    // what the Context Inspector shows — same data, so the UI cannot disagree
    // with what the model actually saw.
    //
    // Compilation runs AFTER routing on purpose: the intent decides whether
    // this turn wants the current note in full or a wide recall.
    //
    // It is an enhancement, not a dependency. On failure we fall back to the
    // old raw-string context (core memory + attached notes) so the turn still
    // has everything it used to.
    let context = {
        let mut parts = additional_context_parts.clone();
        let compiled = {
            let mut req = crate::llm::context_compiler::CompileRequest::new(
                user_query.clone(),
                crate::llm::context_compiler::ContextIntent::from(&classification.intent),
            );
            req.scopes = all_vault_paths.clone();
            req.current_file = request.current_file.clone();
            req.attached_context = request.attached_context.clone();
            req.core_memory = if core_memory_context.is_empty() {
                None
            } else {
                Some(core_memory_context.clone())
            };
            req.already_injected = Some(memories_context.clone());

            match state.db.lock() {
                Ok(conn) => crate::llm::context_compiler::compile(&conn, &req)
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }
        };

        match compiled {
            Ok(pkg) => {
                crate::chat_file_log::log_agent(&format!(
                    "context_compiled intent={} facts={} memories={} tasks={} related={} conflicts={} tokens={}/{} truncated={}",
                    pkg.intent.as_str(),
                    pkg.facts.len(),
                    pkg.memories.len(),
                    pkg.open_tasks.len(),
                    pkg.related_objects.len(),
                    pkg.conflicts.len(),
                    pkg.budget.used_tokens,
                    pkg.budget.max_tokens,
                    pkg.budget.truncated_candidates,
                ));
                // The inspector event carries no body text (see
                // `inspector_summary`) — it crosses IPC and lands in logs.
                let _ = app.emit("agent-event", serde_json::json!({
                    "type": "context_package_ready",
                    "run_id": crate::llm::tool_hooks::current_run_id(),
                    "package": pkg.inspector_summary(),
                }));
                if !pkg.is_empty() {
                    parts.push(pkg.render());
                }
                parts
            }
            Err(e) => {
                log::warn!("Context compilation failed, falling back to raw context: {}", e);
                crate::chat_file_log::log_agent(&format!("context_compile_failed {}", e));
                if !core_memory_context.is_empty() {
                    parts.push(format!(
                        "## Core Memory (verified preferences & decisions)\n{}",
                        core_memory_context
                    ));
                }
                if let Some(ref ac) = request.attached_context {
                    if !ac.is_empty() {
                        parts.push(format!("## Attached Notes for Context\n{}", ac));
                    }
                }
                parts
            }
        }
    };
    let context = if context.is_empty() {
        None
    } else {
        Some(context.join("\n\n"))
    };

    // 2. Build Agent Registry with role-specific prompts
    crate::chat_file_log::log_agent("stage loading_tools");
    let _ = app.emit("agent-event", serde_json::json!({
        "type": "stage",
        "stage": "loading_tools",
        "message": "Loading tools & building agent…",
    }));
    let registry = crate::agents::registry::AgentRegistry::new_with_defaults(
        &config, &memories_context, &skills_context, methodology, &current_time, &vault_info,
    );

    // 3. Execute via Orchestrator
    crate::chat_file_log::log_agent("stage planning");
    // Register the active vault so tool hooks / the context compressor can
    // flush key facts to core memory without threading the path through.
    crate::llm::tool_hooks::set_active_vault_path(&vault_path);
    // Register the AppHandle so background flushers can emit MemoryFlushed
    // events (compress_context_window isn't itself invoked with a handle).
    crate::llm::tool_hooks::set_active_app_handle(app.clone());
    // Register the DB handle so the approval gate can consult `approval_rules`
    // from inside the orchestrator loop (which is only handed a tool_executor).
    crate::llm::approval::set_active_db(state.db.clone());
    let _ = app.emit("agent-event", serde_json::json!({
        "type": "stage",
        "stage": "planning",
        "message": "Planning & executing…",
    }));
    let db = state.db.clone();
    let vault = vault_path.clone();
    let vault_paths_for_closure = all_vault_paths.clone();
    let config_clone = config.clone();
    let skill_dirs_clone = skill_dirs.clone();

    let result = crate::agents::orchestrator::AgentOrchestrator::execute(
        &registry,
        intent,
        &user_query,
        if chat_history.is_empty() { None } else { Some(&chat_history) },
        context.as_deref(),
        &filtered_tools,
        |name: &str, args: &str| {
            let db = db.clone();
            let vault = vault.clone();
            let all_vaults = vault_paths_for_closure.clone();
            let config = config_clone.clone();
            let skill_dirs_inner = skill_dirs_clone.clone();
            Box::pin(async move {
                // Agent 的写入必须先拿到一个 ChangeSet：预演过、无冲突、留了审计。
                // 审批本身已经在 orchestrator 的 approval gate 里发生过了，这里不重判。
                let ready = match open_write_guard(&db, &vault, &all_vaults, name, args) {
                    Ok(GuardOutcome::Proceed(ready)) => ready,
                    Ok(GuardOutcome::Stop(message)) => return Ok(message),
                    Err(e) => {
                        // 守卫跑不起来就不写。放行等于让这次写入绕过 ChangeSet，
                        // 而那正是这一层存在的理由。
                        crate::chat_file_log::log_agent(&format!(
                            "write_guard_unavailable tool={} err={}", name, e
                        ));
                        return Ok(format!(
                            "Write refused: the change-set guard could not run ({}). Nothing was written. Please retry.",
                            e
                        ));
                    }
                };

                let result = crate::tools::execute_tool(name, args, &db, &vault, &all_vaults, &config, &skill_dirs_inner).await;

                if let Some(ready) = ready {
                    let error = result.as_ref().err().map(|e| e.to_string());
                    settle_write_guard(&db, &ready, error.as_deref());
                }
                result
            })
        },
        app,
    )
    .await;

    // A failed or cancelled turn still consumed tokens, so report accounting
    // before the error path short-circuits.
    llm::emit_turn_token_usage(app);

    let result = result.map_err(|e| {
        crate::chat_file_log::log_agent(&format!("error orchestrator {}", e));
        ZettelError::Llm(llm::format_llm_user_error(&e.to_string()))
    })?;

    crate::chat_file_log::log_agent(&format!(
        "turn_complete orchestrator chars={}",
        result.len()
    ));

    // ── Post-Conversation Memory Extraction ──────────────────────────
    // Files what the model thinks is worth remembering as *proposals* in the
    // memory layer. Nothing here becomes an active fact on its own unless the
    // user asked for it outright and none of the confirmation gates fire —
    // see `memory::requires_confirmation`. Does not block the response.
    {
        let extract_config = config.clone();
        let extract_messages = chat_history.clone();
        let extract_vault = vault_path.clone();
        let extract_db = state.db.clone();
        // Captured here, not inside the task: the taint slot is process-global
        // and gets cleared when the next run starts, so reading it later would
        // lose the flag exactly when it matters.
        let extract_taint = llm::tool_hooks::turn_taint();
        let extract_session = llm::tool_hooks::current_run_id();
        tokio::spawn(async move {
            match crate::llm::memory_extractor::extract_and_merge_enhanced(
                &extract_config,
                &extract_messages,
                &extract_vault,
                Some(extract_db),
                extract_session.as_deref(),
                extract_taint.as_deref(),
            ).await {
                Ok(outcome) => {
                    if outcome.proposed > 0 {
                        log::info!(
                            "memory extraction: {} proposal(s) — {} active now, {} awaiting the user",
                            outcome.proposed,
                            outcome.active_now,
                            outcome.awaiting
                        );
                    }
                }
                Err(e) => {
                    log::warn!("Memory extraction failed (non-critical): {}", e);
                }
            }
        });
    }

    Ok(result)
}

// ── 批量 AI（体检台）— Batch AI over selected notes ──────────────────

/// How much of a per-note AI reply is kept in the report.
/// The report is a summary surface, not a transcript — full replies are already
/// in `logs/agent.log` and in the events the frontend streamed.
const BATCH_SUMMARY_CHARS: usize = 400;

/// Truncate by **characters**, never bytes.
///
/// A byte slice at an arbitrary offset splits a multi-byte UTF-8 sequence and
/// panics; every note in this vault is Chinese-first, so that is the common
/// case, not the edge case.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{}…", head)
}

/// After the loop stops early (a `break` on fatal error, or a mid-batch cancel),
/// every file that never got its own row is owed a `skipped` one, in order, so
/// `report.items.len() == total` always holds and the UI can render one line
/// per selected note.
fn pad_skipped(items: &mut Vec<super::BatchAgentItem>, file_paths: &[String]) {
    for file_path in file_paths.iter().skip(items.len()) {
        items.push(super::BatchAgentItem {
            file_path: file_path.clone(),
            status: "skipped".to_string(),
            summary: None,
            error: None,
        });
    }
}

/// Resolve a selected note's path against the vault.
///
/// The frontend selection may carry either absolute paths or vault-relative
/// ones depending on where the list came from, so accept both rather than
/// forcing a convention the caller cannot always honour.
fn resolve_note_path(vault_path: &str, file_path: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(file_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::Path::new(vault_path).join(p)
    }
}

/// Run one AI instruction over N selected notes as a **single undoable unit**.
///
/// The whole point is the run id: `begin_agent_run()` is called exactly **once**
/// here, and every note's turn reuses it, so all snapshots/journal rows land
/// under one id and `undo_agent_run(run_id)` rolls the entire batch back. Doing
/// this from the frontend by calling `agent_chat` N times would mint N run ids
/// and force N undos.
///
/// **Serial on purpose.** Three reasons, all of them structural rather than
/// stylistic: (1) the approval gate is a blocking human interaction, and
/// concurrent turns would stack approval cards the user cannot attribute to a
/// note; (2) the write path takes the single `Mutex<Connection>` per snapshot +
/// journal row, so parallel turns would mostly queue on that lock anyway; and
/// (3) cancellation and the run's `seq` ordering are process-global — undo
/// replays in reverse `seq`, which is only meaningful if writes were ordered.
#[tauri::command]
pub async fn run_batch_agent(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: super::BatchAgentRequest,
) -> Result<super::BatchAgentReport, ZettelError> {
    let total = request.file_paths.len();
    let continue_on_error = request.continue_on_error.unwrap_or(true);

    // One run for the whole batch. This also resets the stop flag and the token
    // accumulator once — deliberately NOT per note, because a per-note reset
    // would silently swallow a cancellation issued during the previous note.
    let run_id = llm::begin_agent_run();
    let _ = app.emit("agent-event", serde_json::json!({
        "type": "run_started",
        "run_id": run_id,
    }));
    crate::chat_file_log::log_agent(&format!(
        "batch_start run={} notes={} instruction={}",
        run_id,
        total,
        crate::chat_file_log::trunc(&request.instruction, 240)
    ));

    // Resolved once: the precedence rule (request key wins, keychain fills the
    // gap) is identical for every note, and re-reading the credential store N
    // times would be pure overhead.
    let config = LlmConfig {
        api_url: request.api_url.clone().unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: crate::secrets::resolve_api_key_with_override(&app, request.api_key),
        model: request.model.clone().unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id.clone(),
        ..Default::default()
    };

    let mut items: Vec<super::BatchAgentItem> = Vec::with_capacity(total);
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut cancelled = false;

    for (i, file_path) in request.file_paths.iter().enumerate() {
        let index = i + 1;

        // Cancellation is checked at the note boundary: the orchestrator already
        // aborts mid-turn on the same flag, so by the time we get here the
        // current note has stopped and everything after it is untouched.
        if cancelled || llm::is_agent_cancelled() {
            cancelled = true;
            items.push(super::BatchAgentItem {
                file_path: file_path.clone(),
                status: "skipped".to_string(),
                summary: None,
                error: None,
            });
            emit_batch_progress(&app, index, total, file_path, "skipped");
            continue;
        }

        emit_batch_progress(&app, index, total, file_path, "start");

        // The note body is injected as attached_context, mirroring what the
        // frontend pre-resolves for a single-note `agent_chat` turn.
        let abs = resolve_note_path(&request.vault_path, file_path);
        let note_body = match std::fs::read_to_string(&abs) {
            Ok(body) => body,
            Err(e) => {
                failed += 1;
                let msg = format!("无法读取笔记 / Cannot read note: {}", e);
                items.push(super::BatchAgentItem {
                    file_path: file_path.clone(),
                    status: "error".to_string(),
                    summary: None,
                    error: Some(msg),
                });
                emit_batch_progress(&app, index, total, file_path, "error");
                if continue_on_error {
                    continue;
                }
                break;
            }
        };

        let turn_request = super::AgentChatRequest {
            // One fresh user turn per note — no cross-note history, so note #7
            // cannot be contaminated by what the model decided about note #3.
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: request.instruction.clone(),
                ..Default::default()
            }],
            api_url: request.api_url.clone(),
            model: request.model.clone(),
            // Unused downstream: `run_agent_turn` takes the already-resolved
            // `config` above. Left at Default so no unresolved key can leak in.
            api_key: Default::default(),
            provider_id: request.provider_id.clone(),
            vault_path: Some(request.vault_path.clone()),
            vault_paths: None,
            methodology: request.methodology.clone(),
            // Batch runs never silently reach the internet.
            web_search: Some(false),
            current_file: Some(file_path.clone()),
            attached_context: Some(note_body),
            context_window: None,
            supports_thinking: None,
        };

        match run_agent_turn(&state, &app, config.clone(), turn_request).await {
            Ok(reply) => {
                // A cancel that landed inside this turn: the turn may have
                // returned a partial reply rather than an error. Report it as
                // done (its writes are real and journaled) and stop the batch.
                if llm::is_agent_cancelled() {
                    cancelled = true;
                }
                succeeded += 1;
                items.push(super::BatchAgentItem {
                    file_path: file_path.clone(),
                    status: "ok".to_string(),
                    summary: Some(truncate_chars(&reply, BATCH_SUMMARY_CHARS)),
                    error: None,
                });
                emit_batch_progress(&app, index, total, file_path, "ok");
            }
            Err(e) => {
                if llm::is_agent_cancelled() {
                    cancelled = true;
                }
                failed += 1;
                items.push(super::BatchAgentItem {
                    file_path: file_path.clone(),
                    status: "error".to_string(),
                    summary: None,
                    error: Some(e.to_string()),
                });
                emit_batch_progress(&app, index, total, file_path, "error");
                // 一篇挂了不该拖垮整批 / one bad note must not kill the batch.
                if !continue_on_error && !cancelled {
                    // Remaining notes are reported as skipped below.
                    break;
                }
            }
        }
    }

    // Anything left unvisited after a `break` is still owed a report row.
    pad_skipped(&mut items, &request.file_paths);

    // Release the run id. Without this, a plain editor save made after the batch
    // finishes would be journaled under this batch's run and get rolled back by
    // a later "undo this batch". `agent_chat` gets away with never clearing only
    // because its next invocation overwrites the slot.
    crate::llm::tool_hooks::clear_current_run_id();

    crate::chat_file_log::log_agent(&format!(
        "batch_complete run={} total={} ok={} err={} cancelled={}",
        run_id, total, succeeded, failed, cancelled
    ));

    Ok(super::BatchAgentReport {
        run_id,
        total,
        succeeded,
        failed,
        items,
        cancelled,
    })
}

/// Per-note progress so the UI can show 「正在处理 3/12：xxx.md」.
/// Goes through `emit_agent_event` rather than a raw `app.emit` so the payload
/// is run-id stamped exactly like every other agent event.
fn emit_batch_progress(
    app: &tauri::AppHandle,
    index: usize,
    total: usize,
    file_path: &str,
    status: &str,
) {
    llm::emit_agent_event(app, llm::AgentEvent::BatchProgress {
        index,
        total,
        file_path: file_path.to_string(),
        status: status.to_string(),
    });
}

/// Cancel the currently-running agent turn.
/// Sets a global stop flag that the agent loop checks between tool calls.
/// Returns true if the flag was set.
#[tauri::command]
pub fn cancel_agent_turn() -> Result<bool, String> {
    llm::cancel_agent_turn_global();
    Ok(true)
}

/// Default MCP servers bundled with ZettelAgent (no API key required).
fn default_mcp_servers() -> Vec<crate::tools::mcp_client::McpServerConfig> {
    vec![]
}

#[tauri::command]
pub fn list_mcp_servers(state: State<'_, AppState>) -> Result<Vec<crate::tools::mcp_client::McpServerConfig>, ZettelError> {
    let conn = state.db.lock()?;
    let existing = crate::db::schema::get_setting(&conn, "mcp_servers").ok().flatten();
    let seeded = crate::db::schema::get_setting(&conn, "mcp_defaults_seeded_v1").ok().flatten();

    let mut configs = match (existing, seeded) {
        (Some(json_str), Some(_)) => {
            // Normal path: user has configured servers and defaults were already seeded
            let configs: Vec<crate::tools::mcp_client::McpServerConfig> = serde_json::from_str(&json_str)
                .unwrap_or_default();
            configs
        }
        (Some(json_str), None) => {
            // Upgrade path: user has existing config but defaults haven't been seeded yet
            // Merge defaults with existing (skip duplicates)
            let mut configs: Vec<crate::tools::mcp_client::McpServerConfig> = serde_json::from_str(&json_str)
                .unwrap_or_default();
            let defaults = default_mcp_servers();
            for d in defaults {
                if !configs.iter().any(|c| c.name == d.name) {
                    configs.push(d);
                }
            }
            let json = serde_json::to_string(&configs)?;
            let _ = crate::db::schema::set_setting(&conn, "mcp_servers", &json);
            let _ = crate::db::schema::set_setting(&conn, "mcp_defaults_seeded_v1", "1");
            configs
        }
        _ => {
            // First run: seed with defaults
            let defaults = default_mcp_servers();
            let json = serde_json::to_string(&defaults)?;
            let _ = crate::db::schema::set_setting(&conn, "mcp_servers", &json);
            let _ = crate::db::schema::set_setting(&conn, "mcp_defaults_seeded_v1", "1");
            defaults
        }
    };

    // ── v2 migration: fix pandoc/time from npx to uvx ──
    let migrated_v2 = crate::db::schema::get_setting(&conn, "mcp_defaults_migrated_v2").ok().flatten();
    if migrated_v2.is_none() {
        let mut changed = false;
        for cfg in configs.iter_mut() {
            if (cfg.name == "pandoc" || cfg.name == "time") && cfg.command == "npx" {
                cfg.command = "uvx".to_string();
                cfg.args = cfg.args.iter()
                    .filter(|a| *a != "-y")
                    .cloned()
                    .collect();
                changed = true;
            }
        }
        if changed {
            let json = serde_json::to_string(&configs)?;
            let _ = crate::db::schema::set_setting(&conn, "mcp_servers", &json);
        }
        let _ = crate::db::schema::set_setting(&conn, "mcp_defaults_migrated_v2", "1");
    }

    Ok(configs)
}

#[tauri::command]
pub fn add_mcp_server(
    state: State<'_, AppState>,
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    let json_str = crate::db::schema::get_setting(&conn, "mcp_servers")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let mut configs: Vec<crate::tools::mcp_client::McpServerConfig> = serde_json::from_str(&json_str)
        .unwrap_or_default();

    // Check for duplicates
    if configs.iter().any(|c| c.name == name) {
        return Err(ZettelError::System(format!("MCP server '{}' already exists", name)));
    }

    configs.push(crate::tools::mcp_client::McpServerConfig {
        name,
        command,
        args,
        env: env.unwrap_or_default(),
        enabled: true,
    });

    let new_json = serde_json::to_string(&configs)?;
    let _ = crate::db::schema::set_setting(&conn, "mcp_servers", &new_json);
    crate::tools::mcp_client::invalidate_tool_cache();
    Ok(())
}

#[tauri::command]
pub fn remove_mcp_server(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    let json_str = crate::db::schema::get_setting(&conn, "mcp_servers")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let mut configs: Vec<crate::tools::mcp_client::McpServerConfig> = serde_json::from_str(&json_str)
        .unwrap_or_default();

    configs.retain(|c| c.name != name);

    let new_json = serde_json::to_string(&configs)?;
    let _ = crate::db::schema::set_setting(&conn, "mcp_servers", &new_json);
    crate::tools::mcp_client::invalidate_tool_cache();
    Ok(())
}

#[tauri::command]
pub async fn test_mcp_connection(
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<String>, ZettelError> {
    let config = crate::tools::mcp_client::McpServerConfig {
        name,
        command,
        args,
        env: env.unwrap_or_default(),
        enabled: true,
    };
    let tool_names = crate::tools::mcp_client::test_mcp_connection(&config)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(tool_names)
}

// ── Skill Directory Management Commands ─────────────────────────────

#[tauri::command]
pub fn list_skill_directories(state: State<'_, AppState>) -> Result<Vec<String>, ZettelError> {
    let conn = state.db.lock()?;
    let json_str = crate::db::schema::get_setting(&conn, "skill_directories")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let dirs: Vec<String> = serde_json::from_str(&json_str).unwrap_or_default();
    Ok(dirs)
}

#[tauri::command]
pub fn add_skill_directory(
    state: State<'_, AppState>,
    directory: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    let json_str = crate::db::schema::get_setting(&conn, "skill_directories")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let mut dirs: Vec<String> = serde_json::from_str(&json_str).unwrap_or_default();

    if dirs.contains(&directory) {
        return Err(ZettelError::System(format!("Directory '{}' already added", directory)));
    }

    dirs.push(directory);
    let new_json = serde_json::to_string(&dirs)?;
    let _ = crate::db::schema::set_setting(&conn, "skill_directories", &new_json);
    Ok(())
}

#[tauri::command]
pub fn remove_skill_directory(
    state: State<'_, AppState>,
    directory: String,
) -> Result<(), ZettelError> {
    let conn = state.db.lock()?;
    let json_str = crate::db::schema::get_setting(&conn, "skill_directories")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let mut dirs: Vec<String> = serde_json::from_str(&json_str).unwrap_or_default();

    dirs.retain(|d| d != &directory);
    let new_json = serde_json::to_string(&dirs)?;
    let _ = crate::db::schema::set_setting(&conn, "skill_directories", &new_json);
    Ok(())
}

#[tauri::command]
pub fn scan_skills(state: State<'_, AppState>) -> Result<Vec<crate::tools::skill_loader::SkillInfo>, ZettelError> {
    let conn = state.db.lock()?;
    let json_str = crate::db::schema::get_setting(&conn, "skill_directories")
        .ok().flatten()
        .unwrap_or_else(|| "[]".to_string());
    let dirs: Vec<String> = serde_json::from_str(&json_str).unwrap_or_default();
    drop(conn); // Release lock before scanning filesystem

    let skills = crate::tools::skill_loader::scan_all_skill_directories(&dirs);
    Ok(skills)
}

#[tauri::command]
pub fn get_skill_detail(skill_dir: String) -> Result<crate::tools::skill_loader::SkillDetail, ZettelError> {
    let detail = crate::tools::skill_loader::get_skill_detail(&skill_dir)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(detail)
}

// ── Internal Tool Summaries for Settings UI ─────────────────────────

#[derive(serde::Serialize)]
pub struct ToolSummary {
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub fn list_internal_tools() -> Vec<ToolSummary> {
    crate::tools::internal_tools::get_internal_tool_summaries()
        .into_iter()
        .map(|(name, description)| ToolSummary { name, description })
        .collect()
}

// ── Persistent Memory File Commands ─────────────────────────────────

#[tauri::command]
pub fn read_memory_file(vault_path: String) -> Result<String, ZettelError> {
    let memory_path = std::path::PathBuf::from(&vault_path)
        .join(".zettelagent")
        .join("memory.md");
    if !memory_path.exists() {
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(&memory_path)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(content)
}

#[tauri::command]
pub fn write_memory_file(vault_path: String, content: String) -> Result<(), ZettelError> {
    let zettelagent_dir = std::path::PathBuf::from(&vault_path).join(".zettelagent");
    std::fs::create_dir_all(&zettelagent_dir)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    let memory_path = zettelagent_dir.join("memory.md");
    std::fs::write(&memory_path, &content)
        .map_err(|e| ZettelError::System(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod rag_search_rerank_tests {
    use super::*;
    use crate::db::search::rerank::{self, RerankConfig, RerankMode};

    /// The RAG retrieval entry point must honour the persisted rerank config.
    /// Under Tier 1 the exact-phrase note wins; under `Off` it stays in FTS order.
    #[test]
    fn rag_run_search_respects_active_rerank_config() {
        let _g = rerank::config_guard();
        let conn = crate::db::search::test_db_with_ranking_disagreement();

        rerank::store_config(RerankConfig::lexical());
        let reranked = rag_run_search(&conn, "fts", "knowledge graph", None, 5).unwrap();
        assert_eq!(
            reranked[0].file_path, "b.md",
            "RAG search should apply the lexical rerank"
        );

        rerank::store_config(RerankConfig { mode: RerankMode::Off, ..Default::default() });
        let off = rag_run_search(&conn, "fts", "knowledge graph", None, 5).unwrap();
        let plain = search::full_text_search(&conn, "knowledge graph", 5).unwrap();
        assert_eq!(
            off.iter().map(|r| &r.file_path).collect::<Vec<_>>(),
            plain.iter().map(|r| &r.file_path).collect::<Vec<_>>(),
            "Off must reproduce the plain FTS order for RAG"
        );
    }
}

/// The batch command's pure pieces. The agent turn itself needs a live Tauri
/// runtime and a reachable model, so it is verified by reading the code path;
/// what *is* testable here is everything that can silently corrupt a report:
/// UTF-8 truncation and the skipped/cancelled bookkeeping.
#[cfg(test)]
mod batch_agent_tests {
    use super::*;

    fn paths(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("笔记-{}.md", i)).collect()
    }

    fn ok_item(p: &str) -> super::super::BatchAgentItem {
        super::super::BatchAgentItem {
            file_path: p.to_string(),
            status: "ok".to_string(),
            summary: Some("已处理".to_string()),
            error: None,
        }
    }

    /// Byte-slicing a Chinese summary panics; char-slicing must not.
    #[test]
    fn summary_truncation_is_char_based_not_byte_based() {
        // 10 chars, 30 bytes — a byte-based `&s[..4]` would split a codepoint.
        let zh = "一二三四五六七八九十";
        assert_eq!(truncate_chars(zh, 4), "一二三四…");
        assert_eq!(truncate_chars(zh, 10), zh, "exactly at the limit must not gain an ellipsis");
        assert_eq!(truncate_chars(zh, 99), zh);
        assert_eq!(truncate_chars("", 5), "");

        // The ellipsis is the only thing appended, so the kept prefix is exact.
        let cut = truncate_chars(zh, 3);
        assert_eq!(cut.chars().count(), 4);
    }

    /// A grapheme cluster made of multiple codepoints is still safe to cut —
    /// the result may look odd but must never panic or emit invalid UTF-8.
    #[test]
    fn truncation_survives_multi_codepoint_content() {
        let mixed = "note 混合 🇨🇳 内容";
        for n in 0..mixed.chars().count() + 2 {
            let out = truncate_chars(mixed, n);
            assert!(out.is_char_boundary(out.len()));
        }
    }

    /// Every selected note owes exactly one row, even when the loop broke early.
    #[test]
    fn pad_skipped_completes_the_report_after_an_early_break() {
        let all = paths(5);
        let mut items = vec![ok_item(&all[0]), ok_item(&all[1])];

        pad_skipped(&mut items, &all);

        assert_eq!(items.len(), all.len(), "one row per selected note");
        assert_eq!(
            items.iter().map(|i| i.status.as_str()).collect::<Vec<_>>(),
            vec!["ok", "ok", "skipped", "skipped", "skipped"]
        );
        // Order must match the selection order so the UI can zip them.
        assert_eq!(
            items.iter().map(|i| i.file_path.clone()).collect::<Vec<_>>(),
            all
        );
        // Skipped rows carry neither a summary nor an error.
        for it in items.iter().skip(2) {
            assert!(it.summary.is_none() && it.error.is_none());
        }
    }

    /// Idempotent: a batch that ran to completion must not grow extra rows.
    #[test]
    fn pad_skipped_is_a_noop_when_every_note_already_reported() {
        let all = paths(3);
        let mut items: Vec<_> = all.iter().map(|p| ok_item(p)).collect();

        pad_skipped(&mut items, &all);

        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|i| i.status == "ok"));
    }

    /// An empty selection is a valid, non-error batch: zero rows, zero panics.
    #[test]
    fn pad_skipped_handles_an_empty_selection() {
        let mut items: Vec<super::super::BatchAgentItem> = Vec::new();
        pad_skipped(&mut items, &[]);
        assert!(items.is_empty());
    }

    /// Absolute paths are honoured; relative ones resolve under the vault.
    /// Getting this backwards would make the batch read the wrong note.
    #[test]
    fn note_paths_resolve_relative_to_the_vault_unless_absolute() {
        let vault = if cfg!(windows) { r"D:\vault" } else { "/vault" };

        let rel = resolve_note_path(vault, "子目录/笔记.md");
        assert!(rel.starts_with(vault), "relative paths must land inside the vault");
        assert!(rel.ends_with("笔记.md"));

        let abs_input = if cfg!(windows) { r"E:\other\笔记.md" } else { "/other/笔记.md" };
        let abs = resolve_note_path(vault, abs_input);
        assert_eq!(abs, std::path::PathBuf::from(abs_input));
        assert!(!abs.starts_with(vault));
    }

    /// The `batch_progress` payload is what drives 「正在处理 3/12」, so its
    /// wire shape is part of the frontend contract.
    #[test]
    fn batch_progress_serializes_with_the_expected_wire_shape() {
        let ev = llm::AgentEvent::BatchProgress {
            index: 3,
            total: 12,
            file_path: "收件箱/笔记.md".to_string(),
            status: "start".to_string(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "batch_progress");
        assert_eq!(v["index"], 3);
        assert_eq!(v["total"], 12);
        assert_eq!(v["file_path"], "收件箱/笔记.md");
        assert_eq!(v["status"], "start");
    }
}
