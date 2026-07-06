// ── Google Gemini Adapter ──────────────────────────────────────────
// Handles: Gemini (functionCall / functionResponse format)

use crate::llm::{ChatMessage, LlmConfig, ToolDef, ToolCall, ToolCallFunction};
use crate::llm::prompted_thinking::{
    ThoughtStreamParser, dispatch_content_delta, flush_content_parser,
};

use super::ToolCallResponse;
use super::openai::build_http_client;

/// Convert our ToolDef (OpenAI format) to Gemini's functionDeclarations
fn tool_defs_to_gemini(tools: &[ToolDef]) -> serde_json::Value {
    let declarations: Vec<serde_json::Value> = tools.iter().map(|t| {
        serde_json::json!({
            "name": t.function.name,
            "description": t.function.description,
            "parameters": t.function.parameters,
        })
    }).collect();

    serde_json::json!([{"functionDeclarations": declarations}])
}

/// Convert internal messages to Gemini's contents format
pub(crate) fn messages_to_gemini(messages: &[ChatMessage]) -> (Option<serde_json::Value>, Vec<serde_json::Value>) {
    let system = messages.iter()
        .find(|m| m.role == "system")
        .map(|m| serde_json::json!({"parts": [{"text": m.content}]}));

    let mut contents: Vec<serde_json::Value> = Vec::new();

    for m in messages.iter().filter(|m| m.role != "system") {
        if m.role == "assistant" {
            let mut parts: Vec<serde_json::Value> = Vec::new();
            if !m.content.is_empty() {
                parts.push(serde_json::json!({"text": m.content}));
            }
            if let Some(ref tcs) = m.tool_calls {
                for tc in tcs {
                    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::json!({}));
                    parts.push(serde_json::json!({
                        "functionCall": {
                            "name": tc.function.name,
                            "args": args,
                        }
                    }));
                }
            }
            contents.push(serde_json::json!({"role": "model", "parts": parts}));
        } else if m.role == "tool" {
            // Gemini: functionResponse in a user-role message
            // Extract actual tool name from generated id (gemini_{name}_{index})
            let tool_name = m.tool_call_id.as_deref().unwrap_or("unknown");
            let tool_name = if tool_name.starts_with("gemini_") {
                // Strip "gemini_" prefix and "_N" suffix
                let rest = &tool_name[7..]; // skip "gemini_"
                rest.rfind('_').map(|i| &rest[..i]).unwrap_or(rest)
            } else {
                tool_name
            };
            let parsed_val: serde_json::Value = serde_json::from_str(&m.content)
                .unwrap_or(serde_json::json!({"result": m.content}));
            let response_data = if parsed_val.is_object() {
                parsed_val
            } else {
                serde_json::json!({"result": parsed_val})
            };
            contents.push(serde_json::json!({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": tool_name,
                        "response": response_data,
                    }
                }]
            }));
        } else {
            // user
            contents.push(serde_json::json!({
                "role": "user",
                "parts": [{"text": m.content}]
            }));
        }
    }

    (system, contents)
}

/// Send tool-calling request and parse Gemini response
pub(crate) async fn send_and_parse_gemini_tools(
    config: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[ToolDef],
    app_handle: &tauri::AppHandle,
) -> anyhow::Result<ToolCallResponse> {
    let client = build_http_client()?;
    let (system_instruction, contents) = messages_to_gemini(messages);
    let gemini_tools = tool_defs_to_gemini(tools);

    // Build Gemini URL for streamGenerateContent: {baseUrl}/models/{model}:streamGenerateContent?alt=sse&key={apiKey}
    let api_key = config.api_key.as_deref().unwrap_or("");
    let url = if config.api_url.contains("generateContent") {
        let updated_url = config.api_url.replace("generateContent", "streamGenerateContent");
        if updated_url.contains("key=") {
            if updated_url.contains('?') {
                format!("{}&alt=sse", updated_url)
            } else {
                format!("{}?alt=sse", updated_url)
            }
        } else {
            format!("{}?alt=sse&key={}", updated_url, api_key)
        }
    } else {
        let base = config.api_url.trim_end_matches('/');
        format!("{}/models/{}:streamGenerateContent?alt=sse&key={}", base, config.model, api_key)
    };

    let mut gen_config = serde_json::json!({
        "temperature": config.temperature,
    });
    if let Some(mt) = config.max_tokens {
        gen_config["maxOutputTokens"] = serde_json::json!(mt);
    }

    let mut request = serde_json::json!({
        "contents": contents,
        "generationConfig": gen_config,
    });

    if let Some(sys) = system_instruction {
        request["systemInstruction"] = sys;
    }
    if !tools.is_empty() {
        request["tools"] = gemini_tools;
    }

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Gemini API error ({}): {}", status, body);
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut byte_buffer = Vec::new();

    let mut text_content = String::new();
    let mut thought_parser: Option<ThoughtStreamParser> = None;
    let mut tool_calls = Vec::new();
    let mut fc_index = 0;

    loop {
        // Poll with a short timeout so user-cancel works even while the
        // server has not sent any bytes yet.
        let chunk_result = match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            stream.next(),
        )
        .await
        {
            Ok(Some(r)) => r,
            Ok(None) => break, // stream ended
            Err(_) => {
                if super::is_agent_cancelled() {
                    log::info!("Gemini stream cancelled while waiting for data");
                    break;
                }
                continue;
            }
        };
        // Mid-stream hard cancel: drop the stream so the provider stops generating.
        if super::is_agent_cancelled() {
            log::info!("Gemini stream cancelled mid-flight by user");
            break;
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
            if let Some(data) = line_str.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(candidates) = parsed["candidates"].as_array() {
                        if !candidates.is_empty() {
                            if let Some(parts) = candidates[0]["content"]["parts"].as_array() {
                                for part in parts {
                                    if let Some(text) = part["text"].as_str() {
                                        dispatch_content_delta(
                                            config,
                                            app_handle,
                                            text,
                                            &mut thought_parser,
                                            &mut text_content,
                                        );
                                    }
                                    if let Some(fc) = part.get("functionCall") {
                                        let name = fc["name"].as_str().unwrap_or("").to_string();
                                        // Skip function calls with empty names (LLM hallucination)
                                        if name.trim().is_empty() {
                                            log::warn!("Skipping Gemini functionCall with empty name");
                                            continue;
                                        }
                                        let tc_id = format!("gemini_{}_{}", name, fc_index);
                                        // Emit ToolCallDetected immediately for real-time UI
                                        crate::llm::emit_agent_event(
                                            app_handle,
                                            crate::llm::AgentEvent::ToolCallDetected {
                                                tool_call_id: tc_id.clone(),
                                                name: name.clone(),
                                            },
                                        );
                                        let args = fc["args"].clone();
                                        tool_calls.push(ToolCall {
                                            id: tc_id,
                                            call_type: "function".to_string(),
                                            function: ToolCallFunction {
                                                name,
                                                arguments: serde_json::to_string(&args).unwrap_or_default(),
                                            },
                                        });
                                        fc_index += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    flush_content_parser(config, app_handle, &mut thought_parser, &mut text_content);

    Ok(ToolCallResponse { content: text_content, tool_calls })
}
