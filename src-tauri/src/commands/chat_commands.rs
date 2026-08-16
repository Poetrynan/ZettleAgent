use tauri::{Emitter, State};
use crate::AppState;
use crate::llm::{self, ChatMessage, LlmConfig};
use crate::db::search;
use crate::error::ZettelError;
use super::{ChatRequest, ChatResponse, RagChatRequest, CardMetadataRequest};

#[tauri::command]
pub async fn chat_with_llm(request: ChatRequest) -> Result<ChatResponse, ZettelError> {
    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: request.api_key,
        model: request.model.unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id,
        context_window: request.context_window,
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
        api_key: request.api_key,
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
    match search_mode {
        "hybrid" => {
            let emb = query_embedding.ok_or_else(|| {
                ZettelError::Llm("Missing query embedding for hybrid search".to_string())
            })?;
            Ok(search::hybrid_search(conn, query, emb, limit)?)
        }
        "vector" => {
            let emb = query_embedding.ok_or_else(|| {
                ZettelError::Llm("Missing query embedding for vector search".to_string())
            })?;
            Ok(search::vector_search(conn, emb, limit)?)
        }
        _ => Ok(search::full_text_search(conn, query, limit)?),
    }
}

#[tauri::command]
pub async fn rag_search_and_chat(
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
        api_key: request.api_key,
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
        api_key: request.api_key.clone(),
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
pub async fn generate_card_metadata(request: CardMetadataRequest) -> Result<String, ZettelError> {
    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: request.api_key,
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

    let config = LlmConfig {
        api_url: request.api_url.unwrap_or_else(|| "http://127.0.0.1:11434/v1/chat/completions".to_string()),
        api_key: request.api_key,
        model: request.model.unwrap_or_else(|| "deepseek-v4".to_string()),
        provider_id: request.provider_id,
        supports_thinking: request.supports_thinking,
        ..Default::default()
    };

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

    // Build unified memories context string for agent prompts
    let memories_context = {
        let mut ctx = String::new();

        if !core_memory_context.is_empty() {
            ctx.push_str("### Core Memory (verified preferences & decisions)\n");
            ctx.push_str(&core_memory_context);
            ctx.push('\n');
        }

        if !archival_recalled.is_empty() {
            ctx.push_str("\n### Recalled Memory (relevant to this request)\n");
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

    if let Some(ref ac) = request.attached_context {
        if !ac.is_empty() {
            additional_context_parts.push(format!("## Attached Notes for Context\n{}", ac));
        }
    }

    let context = if additional_context_parts.is_empty() {
        None
    } else {
        Some(additional_context_parts.join("\n\n"))
    };

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
            &app,
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
                    &app,
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
                    &app,
                )
                .await;
            }
            _ => {}
        }
    }

    // Filter tools to intent-specific subset (empty allowed_tools = all tools).
    let mut filtered_tools = strategy.filter_tool_defs(&tools);
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
                crate::tools::execute_tool(name, args, &db, &vault, &all_vaults, &config, &skill_dirs_inner).await
            })
        },
        &app,
    )
    .await;

    // A failed or cancelled turn still consumed tokens, so report accounting
    // before the error path short-circuits.
    llm::emit_turn_token_usage(&app);

    let result = result.map_err(|e| {
        crate::chat_file_log::log_agent(&format!("error orchestrator {}", e));
        ZettelError::Llm(llm::format_llm_user_error(&e.to_string()))
    })?;

    crate::chat_file_log::log_agent(&format!(
        "turn_complete orchestrator chars={}",
        result.len()
    ));

    // ── Post-Conversation Memory Extraction (2026 Mem0-style) ────────
    // Spawn a background task to extract facts from the conversation and
    // dual-write them: Core Memory (memory.md, structured/bounded) + Archival
    // Memory (ai_memory table, recall-scored). Does not block the response.
    {
        let extract_config = config.clone();
        let extract_messages = chat_history.clone();
        let extract_vault = vault_path.clone();
        let extract_db = state.db.clone();
        tokio::spawn(async move {
            match crate::llm::memory_extractor::extract_and_merge_enhanced(
                &extract_config,
                &extract_messages,
                &extract_vault,
                Some(extract_db),
                None,
            ).await {
                Ok(count) => {
                    if count > 0 {
                        log::info!("Memory extraction: merged {} new facts (core + archival)", count);
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
