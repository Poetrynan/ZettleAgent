// ── OpenAI-compatible Adapter ──────────────────────────────────────
// Handles: DeepSeek, OpenAI, Qwen, Zhipu, Moonshot, SiliconFlow, etc.

use reqwest::Client;
use crate::llm::{ChatMessage, LlmConfig, ToolDef, ToolCall, ChatRequest, ToolCallFunction};
use crate::llm::prompted_thinking::{
    ThoughtStreamParser, dispatch_content_delta, flush_content_parser, is_native_reasoning,
    emit_thinking,
};

use super::ToolCallResponse;

pub(crate) fn build_http_client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?)
}

pub(crate) async fn send_and_parse_openai_tools(
    config: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[ToolDef],
    app_handle: &tauri::AppHandle,
) -> anyhow::Result<ToolCallResponse> {
    let client = build_http_client()?;

    let msg_values: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let mut obj = if m.role == "assistant" && m.tool_calls.is_some() && m.content.is_empty() {
                // Some APIs (Zhipu/GLM) require content to be null (not empty string)
                // when assistant message contains tool_calls
                serde_json::json!({"role": m.role, "content": serde_json::Value::Null})
            } else {
                serde_json::json!({"role": m.role, "content": m.content})
            };
            if let Some(ref tcs) = m.tool_calls {
                obj["tool_calls"] = serde_json::to_value(tcs).unwrap_or_default();
            }
            if let Some(ref tcid) = m.tool_call_id {
                obj["tool_call_id"] = serde_json::json!(tcid);
            }
            obj
        })
        .collect();

    let request = ChatRequest {
        model: config.model.clone(),
        messages: msg_values,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        stream: true,
        prompt_cache_key: None,
        tools: if tools.is_empty() { None } else { Some(tools.to_vec()) },
    };

    let mut builder = client.post(&config.api_url).json(&request);
    if let Some(key) = &config.api_key {
        builder = builder.header("Authorization", format!("Bearer {}", key));
    }

    let response = builder.send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("LLM API error ({}): {}", status, body);
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut byte_buffer = Vec::new();
    
    let mut content = String::new();
    let mut thought_parser: Option<ThoughtStreamParser> = None;
    let native = is_native_reasoning(config);

    #[derive(Default, Debug)]
    struct ToolCallAssembler {
        id: Option<String>,
        name: Option<String>,
        arguments: String,
        emitted: bool,
    }
    let mut tool_assemblers = std::collections::HashMap::<usize, ToolCallAssembler>::new();
    let mut stream_done = false;
    let mut finish_reason: Option<String> = None;

    'outer: loop {
        // Poll the stream with a short timeout so the user-cancel flag is
        // checked even while the server has not sent any bytes yet (e.g. a
        // thinking model's silent prefill phase, or a busy single-slot local
        // server). Without this, `stream.next().await` blocks until data
        // arrives and the stop button appears dead.
        let chunk_result = match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            stream.next(),
        )
        .await
        {
            Ok(Some(r)) => r,
            Ok(None) => break 'outer, // stream ended
            Err(_) => {
                if super::is_agent_cancelled() {
                    log::info!("OpenAI stream cancelled while waiting for data");
                    stream_done = true;
                    break 'outer;
                }
                continue;
            }
        };
        // Mid-stream hard cancel: breaking here drops the bytes_stream (and the
        // underlying reqwest connection), so the provider stops generating.
        // Content accumulated so far is preserved and returned as a partial answer.
        if super::is_agent_cancelled() {
            log::info!("OpenAI stream cancelled mid-flight by user");
            stream_done = true;
            break 'outer;
        }
        let bytes = chunk_result.map_err(|e| {
            anyhow::anyhow!(super::format_llm_user_error(&e.to_string()))
        })?;
        byte_buffer.extend_from_slice(&bytes);
        while let Some(pos) = byte_buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = &byte_buffer[..pos];
            let line_str = String::from_utf8_lossy(line_bytes).trim().to_string();
            byte_buffer.drain(..pos + 1);

            if line_str.is_empty() || line_str.starts_with(':') { continue; }
            if line_str == "data: [DONE]" {
                stream_done = true;
                break 'outer;
            }
            if let Some(data) = line_str.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(choices) = parsed["choices"].as_array() {
                        if !choices.is_empty() {
                            // Track finish_reason to detect truncation vs normal completion
                            if let Some(fr) = choices[0]["finish_reason"].as_str() {
                                finish_reason = Some(fr.to_string());
                            }
                            let delta = &choices[0]["delta"];

                            if let Some(reasoning) = delta["reasoning_content"].as_str() {
                                if !reasoning.is_empty() {
                                    if !is_native_reasoning(config) {
                                        crate::llm::reasoning_mode::bail_on_native_reasoning_mismatch(config)?;
                                    }
                                    emit_thinking(app_handle, reasoning);
                                }
                            }

                            if let Some(text) = delta["content"].as_str() {
                                dispatch_content_delta(
                                    config,
                                    app_handle,
                                    text,
                                    &mut thought_parser,
                                    &mut content,
                                );
                            }
                            if let Some(tcs) = delta["tool_calls"].as_array() {
                                for tc in tcs {
                                    let idx = tc["index"].as_u64().map(|i| i as usize).unwrap_or(0);
                                    let assembler = tool_assemblers.entry(idx).or_default();
                                    if let Some(id) = tc["id"].as_str() {
                                        if !id.is_empty() {
                                            assembler.id = Some(id.to_string());
                                        }
                                    }
                                    if let Some(name) = tc["function"]["name"].as_str() {
                                        if !name.is_empty() {
                                            if let Some(ref mut existing_name) = assembler.name {
                                                existing_name.push_str(name);
                                            } else {
                                                assembler.name = Some(name.to_string());
                                            }
                                        }
                                    }
                                    if let Some(args) = tc["function"]["arguments"].as_str() {
                                        assembler.arguments.push_str(args);
                                    }
                                    // Emit ToolCallDetected as soon as name is known
                                    if !assembler.emitted {
                                        if let (Some(ref id), Some(ref name)) = (&assembler.id, &assembler.name) {
                                            if !name.trim().is_empty() {
                                                crate::llm::emit_agent_event(
                                                    app_handle,
                                                    crate::llm::AgentEvent::ToolCallDetected {
                                                        tool_call_id: id.clone(),
                                                        name: name.clone(),
                                                    },
                                                );
                                                assembler.emitted = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    flush_content_parser(config, app_handle, &mut thought_parser, &mut content);

    // Log finish state for debugging
    log::info!(
        "OpenAI stream finished: native={}, done={}, finish_reason={:?}, content_len={}, tool_assemblers={}",
        native,
        stream_done,
        finish_reason,
        content.len(),
        tool_assemblers.len()
    );

    // Detect max_tokens truncation: model wanted to say more but was cut off
    if finish_reason.as_deref() == Some("length") {
        log::warn!("LLM response was truncated due to max_tokens limit! Tool calls may be incomplete.");
        // If we have content but no tool calls, and the response was truncated,
        // the model likely intended to call tools but ran out of tokens
        if !content.is_empty() && tool_assemblers.is_empty() {
            log::warn!("Truncated response with text but no tool calls — model may have been cut off before emitting tool_calls");
        }
    }

    let mut tool_calls = Vec::new();
    let mut sorted_keys: Vec<_> = tool_assemblers.keys().cloned().collect();
    sorted_keys.sort();
    for k in sorted_keys {
        if let Some(assembler) = tool_assemblers.get(&k) {
            let name = assembler.name.clone().unwrap_or_default();
            // Skip tool calls with empty or whitespace-only names (LLM hallucination)
            if name.trim().is_empty() {
                log::warn!("Skipping tool call with empty name (index {})", k);
                continue;
            }
            tool_calls.push(ToolCall {
                id: assembler.id.clone().unwrap_or_else(|| format!("call_{}", k)),
                call_type: "function".to_string(),
                function: ToolCallFunction {
                    name,
                    arguments: assembler.arguments.clone(),
                },
            });
        }
    }

    Ok(ToolCallResponse { content, tool_calls })
}
