use super::*;

fn ideograph(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{9fff}' | '\u{3040}'..='\u{30ff}' | '\u{f900}'..='\u{faff}' | '\u{20000}'..='\u{323af}')
}

// Keep a source byte range for each normalized byte so the excerpt always comes
// from the real source, including its original spacing and line endings.
fn normalized(text: &str, fold_case: bool) -> (String, Vec<(usize, usize)>) {
    let mut result = String::new();
    let mut spans = Vec::new();
    let mut whitespace = None;
    let mut previous = None;
    for (index, c) in text.char_indices() {
        if c.is_whitespace() {
            whitespace.get_or_insert(index);
            continue;
        }
        if let Some(start) = whitespace.take() {
            if previous.is_some() && !(previous.is_some_and(ideograph) && ideograph(c)) {
                result.push(' ');
                spans.push((start, index));
            }
        }
        let before = result.len();
        if fold_case {
            result.extend(c.to_lowercase());
        } else {
            result.push(c);
        }
        spans.resize(
            spans.len() + result.len() - before,
            (index, index + c.len_utf8()),
        );
        previous = Some(c);
    }
    (result, spans)
}

fn matches_in(segment: &Value, quote: &str, mode: &str, matches: &mut Vec<Value>) {
    let text = segment["content"].as_str().unwrap_or("");
    if text.is_empty() {
        return;
    }
    let mut add = |a: usize, b: usize| {
        let excerpt = &text[a..b];
        let mut entry = json!({"excerpt":excerpt,"locator":segment["locator"]});
        if let Some(first) = segment["start_line"].as_u64() {
            let line = first + text[..a].bytes().filter(|&c| c == b'\n').count() as u64;
            let end = line + excerpt.bytes().filter(|&c| c == b'\n').count() as u64;
            entry["start_line"] = json!(line);
            entry["end_line"] = json!(end);
            entry["locator"] = json!(format!("#L{line}-L{end}"));
        } else {
            entry["page"] = segment["page"].clone();
            entry["page_label"] = segment["page_label"].clone();
        }
        matches.push(entry);
        matches.len() >= 8
    };
    if mode == "exact" {
        for (i, _) in text.match_indices(quote) {
            if add(i, i + quote.len()) {
                break;
            }
        }
    } else {
        let fold_case = mode == "approximate";
        let (hay, spans) = normalized(text, fold_case);
        let (needle, _) = normalized(quote, fold_case);
        for (pos, _) in hay.match_indices(&needle) {
            if add(spans[pos].0, spans[pos + needle.len() - 1].1) {
                break;
            }
        }
    }
}

pub(super) fn verify(args: &Value, vault: &str, vaults: &[String]) -> Result<Value> {
    let quote = required(args, "quote")?;
    ensure!(
        quote.chars().count() <= 32_000,
        "Quote exceeds 32000 characters"
    );
    let kind = args
        .get("quote_kind")
        .map(|v| v.as_str().unwrap_or(""))
        .unwrap_or("original");
    ensure!(
        matches!(kind, "original" | "translation" | "paraphrase"),
        "Unknown quote_kind"
    );
    let raw = required(args, "path")?;
    let mut result = json!({"path":raw,"source_checksum":null,"status":"unavailable",
        "quote_kind":kind,"verified":false,"matches":[],"truncated":false,"search_coverage":[]});
    let r: range::Range = serde_json::from_value(args.clone())?;
    let attempt = (|| -> Result<Value> {
        let path = exact_file(raw, vault, vaults)?;
        let key = snapshot_path_key(&path);
        result["path"] = json!(key);
        result["source_id"] = json!(key);
        let bytes = bounded_bytes(&path)?;
        let checksum = digest(&bytes);
        result["source_checksum"] = json!(checksum);
        validate_checksum(&r, &checksum)?;
        range::contents(&path, &bytes, &r, 150_000)
    })();
    let page = match attempt {
        Ok(page) => page,
        Err(error) => {
            result["reason"] = json!(error.to_string());
            return Ok(result);
        }
    };
    let segments = page["segments"].as_array().unwrap();
    for key in [
        "truncated",
        "next_start_line",
        "next_start_page",
        "next_start_char",
        "total_lines",
        "total_pages",
        "locator",
    ] {
        if let Some(v) = page.get(key) {
            result[key] = v.clone();
        }
    }
    result["search_coverage"] = json!(segments
        .iter()
        .map(|s| json!({
            "locator":s["locator"], "needs_ocr":s["needs_ocr"], "start_char":s["start_char"],
            "chars":s["content"].as_str().unwrap_or("").chars().count()
        }))
        .collect::<Vec<_>>());
    if kind != "original" {
        result["reason"] = json!("Translations and paraphrases require interpretation and cannot be verified as verbatim quotations.");
        return Ok(result);
    }
    for mode in ["exact", "normalized", "approximate"] {
        let mut matches = Vec::new();
        for segment in segments {
            if segment["needs_ocr"] == true && mode != "approximate" {
                continue;
            }
            matches_in(segment, quote, mode, &mut matches);
            if matches.len() == 8 {
                break;
            }
        }
        if !matches.is_empty() {
            result["matches"] = json!(matches);
            result["status"] = json!(mode);
            result["verified"] = json!(mode != "approximate");
            result["reason"] = json!(match mode {
                "exact" => "Verbatim text occurs in the indicated source range.",
                "normalized" => "Text matches after whitespace and line-wrap normalization.",
                _ => "Candidate text is case-insensitive or from a page flagged for OCR.",
            });
            return Ok(result);
        }
    }
    if segments.is_empty() || segments.iter().any(|s| s["needs_ocr"] == true) {
        result["reason"] =
            json!("The requested range contains missing or insufficient extractable text.");
    } else {
        result["status"] = json!("not_found");
        result["reason"] = json!("No match within the reported search coverage.");
    }
    Ok(result)
}
