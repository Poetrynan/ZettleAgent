use std::path::{Path, PathBuf};
use anyhow::Result;
use reqwest::Client;
use pure_onnx_ocr::OcrEngineBuilder;
use crate::llm::LlmConfig;

/// Resolve OCR model paths from the bundled resources directory.
/// Models are shipped with the app in `resources/ocr_models/`.
/// At runtime they live under `<resource_dir>/ocr_models/`.
pub fn resolve_bundled_models(resource_dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let models_dir = resource_dir.join("ocr_models");
    let det_path = models_dir.join("det.onnx");
    let rec_path = models_dir.join("rec.onnx");
    let dict_path = models_dir.join("ppocrv5_dict.txt");

    if !det_path.exists() {
        anyhow::bail!("Bundled OCR model not found: {}", det_path.display());
    }
    if !rec_path.exists() {
        anyhow::bail!("Bundled OCR model not found: {}", rec_path.display());
    }
    if !dict_path.exists() {
        anyhow::bail!("Bundled OCR dictionary not found: {}", dict_path.display());
    }

    Ok((det_path, rec_path, dict_path))
}

async fn try_llm_ocr(image_bytes: &[u8], config: &LlmConfig) -> Result<String> {
    use crate::llm::detect_provider;
    use base64::Engine;
    
    let base64_image = base64::engine::general_purpose::STANDARD.encode(image_bytes);
    let provider = detect_provider(config);
    
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
        
    let response = match provider {
        "gemini" => {
            let api_key = config.api_key.as_deref().unwrap_or("");
            let base = config.api_url.trim_end_matches('/');
            let url = format!("{}/models/{}:generateContent?key={}", base, config.model, api_key);
            
            let request = serde_json::json!({
                "contents": [{
                    "parts": [
                        { "text": "Extract all text from this image. Return only the extracted text, preserving structure as much as possible." },
                        {
                            "inline_data": {
                                "mime_type": "image/png",
                                "data": base64_image
                            }
                        }
                    ]
                }],
                "generationConfig": {
                    "temperature": 0.2,
                }
            });
            
            client.post(&url)
                .header("Content-Type", "application/json")
                .json(&request)
                .send()
                .await?
        }
        "claude" => {
            let mut builder = client.post(&config.api_url)
                .header("Content-Type", "application/json")
                .header("anthropic-version", "2023-06-01");
                
            if let Some(key) = &config.api_key {
                builder = builder.header("x-api-key", key);
            }
            
            let request = serde_json::json!({
                "model": config.model,
                "max_tokens": 8192,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "Extract all text from this image. Return only the extracted text." },
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": base64_image
                            }
                        }
                    ]
                }],
                "temperature": 0.2
            });
            
            builder.json(&request).send().await?
        }
        _ => {
            let mut builder = client.post(&config.api_url);
            if let Some(key) = &config.api_key {
                builder = builder.header("Authorization", format!("Bearer {}", key));
            }
            
            let request = serde_json::json!({
                "model": config.model,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "Extract all text from this image. Return only the extracted text, preserving structure as much as possible." },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", base64_image)
                            }
                        }
                    ]
                }],
                "temperature": 0.2
            });
            
            builder.json(&request).send().await?
        }
    };
    
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("LLM OCR API error ({}): {}", status, body);
    }
    
    let result: serde_json::Value = response.json().await?;
    
    let content = match provider {
        "claude" => {
            result["content"].as_array()
                .map(|arr| arr.iter()
                    .filter_map(|b| if b["type"].as_str() == Some("text") { b["text"].as_str() } else { None })
                    .collect::<Vec<_>>()
                    .join(""))
                .unwrap_or_default()
        }
        "gemini" => {
            result["candidates"][0]["content"]["parts"].as_array()
                .map(|parts| parts.iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(""))
                .unwrap_or_default()
        }
        _ => {
            result["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string()
        }
    };
    
    Ok(content)
}

pub fn try_local_ocr(image_bytes: &[u8], resource_dir: &Path) -> Result<String> {
    let (det_path, rec_path, dict_path) = resolve_bundled_models(resource_dir)?;
    
    let img = image::load_from_memory(image_bytes)?;
    
    let engine = OcrEngineBuilder::new()
        .det_model_path(det_path)
        .rec_model_path(rec_path)
        .dictionary_path(dict_path)
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build OCR engine: {}", e))?;
        
    let results = engine.run_from_image(&img)
        .map_err(|e| anyhow::anyhow!("OCR run failed: {}", e))?;
        
    let full_text = results.iter()
        .map(|r| r.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
        
    Ok(full_text)
}

pub async fn extract_text_from_image(
    image_bytes: &[u8],
    llm_config: Option<&LlmConfig>,
    resource_dir: &Path,
) -> Result<String> {
    if let Some(config) = llm_config {
        match try_llm_ocr(image_bytes, config).await {
            Ok(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Ok(trimmed.to_string());
                }
            }
            Err(e) => {
                log::warn!("LLM OCR failed: {}. Falling back to local OCR.", e);
            }
        }
    }
    
    try_local_ocr(image_bytes, resource_dir)
}
