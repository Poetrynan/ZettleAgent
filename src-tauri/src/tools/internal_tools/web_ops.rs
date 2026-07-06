use serde_json::json;

// Web operations: web_search, fetch_web_content + URL helpers


pub(super) async fn execute_web_search(
    arguments: &str,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let query = args["query"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'query' parameter"))?;
    let max_results = args["max_results"].as_u64().unwrap_or(5).min(10) as usize;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    // Use the Lite endpoint: html.duckduckgo.com now serves a CAPTCHA
    // (anomaly-modal) to non-browser clients, which silently yields 0 results.
    let resp = client
        .get(format!("https://lite.duckduckgo.com/lite/?q={}", urlencoding_simple(query)))
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Web search request failed (network error or timeout): {}", e))?;

    if !resp.status().is_success() {
        anyhow::bail!("DuckDuckGo returned HTTP {}", resp.status());
    }

    let html = resp.text().await
        .map_err(|e| anyhow::anyhow!("Failed to read search response: {}", e))?;

    // Bot-detection page instead of results: report a clear error so the LLM
    // knows the search SERVICE is down, not that the query found nothing.
    if html.contains("anomaly-modal") || html.contains("challenge-form") {
        anyhow::bail!(
            "Web search is temporarily blocked by DuckDuckGo bot detection (CAPTCHA). \
             Do not retry with different keywords — the service is unavailable. \
             Answer from your own knowledge or other tools."
        );
    }

    let results = parse_ddg_lite_results(&html, max_results);

    if results.is_empty() {
        return Ok(json!({
            "query": query,
            "results": [],
            "message": "No results found. Try different keywords."
        }).to_string());
    }

    Ok(serde_json::to_string_pretty(&json!({
        "query": query,
        "result_count": results.len(),
        "results": results
    }))?)
}

/// Parse the DuckDuckGo Lite results page. Each result is an
/// `<a class='result-link'>` row followed by an optional
/// `<td class='result-snippet'>` row; walk both in document order and attach
/// each snippet to the link that precedes it.
fn parse_ddg_lite_results(html: &str, max_results: usize) -> Vec<serde_json::Value> {
    let document = scraper::Html::parse_document(html);
    let combined_selector = scraper::Selector::parse("a.result-link, td.result-snippet").unwrap();

    let mut results: Vec<serde_json::Value> = Vec::new();

    for el in document.select(&combined_selector) {
        if el.value().name() == "a" {
            if results.len() >= max_results {
                break;
            }
            let title: String = el.text().collect::<String>().trim().to_string();
            let raw_href = el.value().attr("href").unwrap_or("").to_string();
            // DuckDuckGo wraps URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded_url>&...
            let url = extract_ddg_url(&raw_href);
            if !title.is_empty() && !url.is_empty() {
                results.push(json!({
                    "title": title,
                    "url": url,
                    "snippet": "",
                }));
            }
        } else if let Some(last) = results.last_mut() {
            if last["snippet"].as_str() == Some("") {
                let snippet_text: String = el.text().collect::<String>()
                    .split_whitespace().collect::<Vec<_>>().join(" ");
                last["snippet"] = json!(snippet_text);
            }
        }
    }

    results
}

pub(super) async fn execute_fetch_web_content(
    arguments: &str,
    vault_path: &str,
) -> anyhow::Result<String> {
    let args: serde_json::Value = serde_json::from_str(arguments)?;
    let url = args["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing 'url' parameter"))?;
    let save_to_vault = args["save_to_vault"].as_bool().unwrap_or(false);

    // Basic URL validation
    if !url.starts_with("http://") && !url.starts_with("https://") {
        anyhow::bail!("Invalid URL: must start with http:// or https://");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to fetch URL (network error or timeout): {}", e))?;

    if !resp.status().is_success() {
        anyhow::bail!("Server returned HTTP {}", resp.status());
    }

    // Limit body size to 2MB to prevent OOM
    let content_length = resp.content_length().unwrap_or(0);
    if content_length > 2 * 1024 * 1024 {
        anyhow::bail!("Page too large ({:.1} MB). Maximum is 2 MB.", content_length as f64 / 1024.0 / 1024.0);
    }

    let html = resp.text().await
        .map_err(|e| anyhow::anyhow!("Failed to read page content: {}", e))?;

    // Enforce size limit on the downloaded text too
    if html.len() > 2 * 1024 * 1024 {
        anyhow::bail!("Page content too large ({:.1} MB after download). Maximum is 2 MB.", html.len() as f64 / 1024.0 / 1024.0);
    }

    // Convert HTML to Markdown using the existing converter
    let (title, markdown) = crate::import::html::html_to_markdown(&html);
    let title = if title.is_empty() { "Untitled Page".to_string() } else { title };
    let char_count = markdown.chars().count();

    // Optionally save to vault
    let saved_path = if save_to_vault {
        let clips_dir = std::path::PathBuf::from(vault_path).join("_web_clips");
        std::fs::create_dir_all(&clips_dir)?;

        // Sanitize filename
        let safe_title: String = title
            .chars()
            .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
            .collect::<String>()
            .trim()
            .to_string();
        let safe_title = if safe_title.len() > 80 {
            safe_title.chars().take(80).collect::<String>()
        } else {
            safe_title
        };
        let filename = format!("{}.md", if safe_title.is_empty() { "web_clip" } else { &safe_title });
        let file_path = clips_dir.join(&filename);

        // Build note content with frontmatter
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        let note_content = format!(
            "---\ntitle: \"{}\"\nsource: \"{}\"\nclipped: \"{}\"\ntags: [web-clip]\n---\n\n# {}\n\n> Source: [{}]({})\n> Clipped: {}\n\n{}\n",
            title, url, now, title, url, url, now, markdown
        );

        std::fs::write(&file_path, &note_content)?;
        let relative = format!("_web_clips/{}", filename);
        Some(relative)
    } else {
        None
    };

    // Sanitize content: remove control characters that can break LLM API JSON
    let sanitized: String = markdown.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();

    // Strip markdown link syntax [text](url) → text  to reduce token bloat
    let cleaned = strip_markdown_links(&sanitized);

    // P1-5: Smart truncation — 1200->4000 chars, sandwich approach (head+tail)
    let max_llm_chars = 4000;
    let total_cleaned = cleaned.chars().count();
    let truncated = if total_cleaned > max_llm_chars {
        let head: String = cleaned.chars().take(2500).collect();
        let tail: String = cleaned.chars().skip(total_cleaned.saturating_sub(1200)).collect();
        format!("{}\n\n[...{} chars omitted...]\n\n{}\n\n[Total {} chars. Use save_to_vault=true to save full content.]",
            head, char_count.saturating_sub(3700), tail, char_count)
    } else {
        cleaned
    };

    let mut result = json!({
        "title": title,
        "url": url,
        "char_count": char_count,
        "content": truncated,
    });

    if let Some(path) = saved_path {
        result["saved_to"] = json!(path);
        result["message"] = json!(format!("Content saved to vault: {}", path));
    }

    Ok(serde_json::to_string_pretty(&result)?)
}

/// Strip markdown link syntax `[text](url)` → `text` without regex crate.
fn strip_markdown_links(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            // Look for closing ] followed by (
            if let Some(close_bracket) = chars[i+1..].iter().position(|&c| c == ']') {
                let cb = i + 1 + close_bracket;
                if cb + 1 < chars.len() && chars[cb + 1] == '(' {
                    // Find closing )
                    if let Some(close_paren) = chars[cb+2..].iter().position(|&c| c == ')') {
                        // Extract just the link text
                        let text: String = chars[i+1..cb].iter().collect();
                        result.push_str(&text);
                        i = cb + 2 + close_paren + 1;
                        continue;
                    }
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

fn urlencoding_simple(input: &str) -> String {
    let mut result = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b' ' => result.push('+'),
            _ => {
                result.push('%');
                result.push_str(&format!("{:02X}", byte));
            }
        }
    }
    result
}

/// Extract the actual URL from a DuckDuckGo redirect link.
/// DDG wraps results as: //duckduckgo.com/l/?uddg=<url_encoded_target>&...
fn extract_ddg_url(raw: &str) -> String {
    // Try to find uddg= parameter
    if let Some(start) = raw.find("uddg=") {
        let encoded = &raw[start + 5..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        let encoded_url = &encoded[..end];
        // URL-decode the target
        url_decode_simple(encoded_url)
    } else if raw.starts_with("http") {
        raw.to_string()
    } else if raw.starts_with("//") {
        format!("https:{}", raw)
    } else {
        raw.to_string()
    }
}

/// Simple percent-decoding for URL strings.
fn url_decode_simple(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut bytes_buf: Vec<u8> = Vec::new();
    let mut chars = input.chars();

    loop {
        let c = chars.next();
        // When we hit a non-% char (or end), flush accumulated bytes as UTF-8
        if c != Some('%') && !bytes_buf.is_empty() {
            result.push_str(&String::from_utf8_lossy(&bytes_buf));
            bytes_buf.clear();
        }
        match c {
            None => break,
            Some('%') => {
                let hex: String = chars.by_ref().take(2).collect();
                if hex.len() == 2 {
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        bytes_buf.push(byte);
                    } else {
                        result.push('%');
                        result.push_str(&hex);
                    }
                } else {
                    result.push('%');
                    result.push_str(&hex);
                }
            }
            Some('+') => result.push(' '),
            Some(other) => result.push(other),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal copy of the real lite.duckduckgo.com/lite/ table layout.
    const LITE_HTML: &str = r#"
    <table>
      <tr><td>1.&nbsp;</td><td>
        <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frust%2Dlang.org%2F&amp;rut=abc" class='result-link'>Rust Programming Language</a>
      </td></tr>
      <tr><td>&nbsp;</td><td class='result-snippet'>
        A language empowering everyone   to build reliable software.
      </td></tr>
      <tr><td>2.&nbsp;</td><td>
        <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRust&amp;rut=def" class='result-link'>Rust - Wikipedia</a>
      </td></tr>
      <tr><td>&nbsp;</td><td class='result-snippet'>General-purpose language.</td></tr>
    </table>"#;

    #[test]
    fn parses_lite_results_with_snippets() {
        let results = parse_ddg_lite_results(LITE_HTML, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["title"], "Rust Programming Language");
        assert_eq!(results[0]["url"], "https://rust-lang.org/");
        assert_eq!(
            results[0]["snippet"],
            "A language empowering everyone to build reliable software."
        );
        assert_eq!(results[1]["url"], "https://en.wikipedia.org/wiki/Rust");
    }

    #[test]
    fn respects_max_results() {
        let results = parse_ddg_lite_results(LITE_HTML, 1);
        assert_eq!(results.len(), 1);
        // Snippet of the kept result still gets attached.
        assert_eq!(
            results[0]["snippet"],
            "A language empowering everyone to build reliable software."
        );
    }
}

// ── 18. find_similar_notes ─────────────────────────────────────────

