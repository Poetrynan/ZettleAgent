//! Bounded, read-only research utilities. No shell or model-generated answers.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().filter(|s| !s.trim().is_empty()).with_context(|| format!("Missing {key}"))
}

/// Small arithmetic grammar, deliberately unrelated to an interpreter or shell.
struct Arithmetic<'a> { bytes: &'a [u8], pos: usize }
impl Arithmetic<'_> {
    fn space(&mut self) { while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() { self.pos += 1; } }
    fn expr(&mut self, min: u8, depth: u8) -> Result<f64> {
        ensure!(depth <= 32, "Expression nesting exceeds 32");
        self.space();
        let next = self.bytes.get(self.pos).copied().context("Expected number")?;
        let mut value = match next {
            b'+' | b'-' => { self.pos += 1; let n = self.expr(3, depth + 1)?; if next == b'-' { -n } else { n } }
            b'(' => { self.pos += 1; let n = self.expr(0, depth + 1)?; self.space(); ensure!(self.bytes.get(self.pos) == Some(&b')'), "Missing closing parenthesis"); self.pos += 1; n }
            _ => {
                let start = self.pos;
                while self.pos < self.bytes.len() {
                    let c = self.bytes[self.pos];
                    if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' ||
                        ((c == b'+' || c == b'-') && self.pos > start && matches!(self.bytes[self.pos - 1], b'e' | b'E')) { self.pos += 1; } else { break; }
                }
                ensure!(self.pos > start, "Expected a number at byte {start}");
                std::str::from_utf8(&self.bytes[start..self.pos])?.parse::<f64>().context("Invalid number")?
            }
        };
        ensure!(value.is_finite(), "Non-finite number");
        loop {
            self.space();
            let Some(op) = self.bytes.get(self.pos).copied() else { break };
            let prec = match op { b'+' | b'-' => 1, b'*' | b'/' | b'%' => 2, b'^' => 4, _ => break };
            if prec < min { break; }
            self.pos += 1;
            let rhs = self.expr(if op == b'^' { prec } else { prec + 1 }, depth + 1)?;
            value = match op { b'+' => value + rhs, b'-' => value - rhs, b'*' => value * rhs,
                b'/' => { ensure!(rhs != 0.0, "Division by zero"); value / rhs },
                b'%' => { ensure!(rhs != 0.0, "Modulo by zero"); value % rhs }, _ => value.powf(rhs) };
            ensure!(value.is_finite(), "Non-finite result");
        }
        Ok(value)
    }
}

fn unit(name: &str) -> Result<(&'static str, f64, f64)> {
    Ok(match name.to_lowercase().as_str() {
        "m" => ("length", 1., 0.), "cm" => ("length", 0.01, 0.), "mm" => ("length", 0.001, 0.),
        "km" => ("length", 1000., 0.), "in" => ("length", 0.0254, 0.), "ft" => ("length", 0.3048, 0.), "mi" => ("length", 1609.344, 0.),
        "kg" => ("mass", 1., 0.), "g" => ("mass", 0.001, 0.), "mg" => ("mass", 0.000001, 0.), "lb" => ("mass", 0.45359237, 0.),
        "s" => ("time", 1., 0.), "min" => ("time", 60., 0.), "h" => ("time", 3600., 0.), "day" => ("time", 86400., 0.),
        "l" => ("volume", 1., 0.), "ml" => ("volume", 0.001, 0.),
        "celsius" | "°c" => ("temperature", 1., 273.15), "kelvin" | "k" => ("temperature", 1., 0.),
        "fahrenheit" | "°f" => ("temperature", 5. / 9., 255.3722222222222),
        _ => bail!("Unsupported unit: {name}"),
    })
}

pub fn calculate(args: &Value) -> Result<Value> {
    match args["operation"].as_str().unwrap_or("expression") {
        "expression" => {
            let expression = text(args, "expression")?;
            ensure!(expression.len() <= 512 && expression.is_ascii(), "Use at most 512 ASCII characters");
            let mut parser = Arithmetic { bytes: expression.as_bytes(), pos: 0 };
            let result = parser.expr(0, 0)?;
            parser.space(); ensure!(parser.pos == expression.len(), "Unexpected input at byte {}", parser.pos);
            Ok(json!({"operation":"expression","expression":expression,"result":result}))
        }
        "convert" => {
            let value = args["value"].as_f64().context("Missing finite value")?;
            ensure!(value.is_finite(), "Value must be finite");
            let from = text(args, "from")?; let to = text(args, "to")?;
            let (kind, scale, offset) = unit(from)?;
            let (target, target_scale, target_offset) = unit(to)?;
            ensure!(kind == target, "Incompatible units");
            let result = ((value * scale + offset - target_offset) / target_scale * 1e12).round() / 1e12;
            ensure!(result.is_finite(), "Non-finite result");
            Ok(json!({"operation":"convert","value":value,"from":from,"to":to,"result":result}))
        }
        "date_difference" => {
            let from = chrono::NaiveDate::parse_from_str(text(args, "from")?, "%Y-%m-%d")?;
            let to = chrono::NaiveDate::parse_from_str(text(args, "to")?, "%Y-%m-%d")?;
            Ok(json!({"operation":"date_difference","from":from.to_string(),"to":to.to_string(),"days":(to-from).num_days()}))
        }
        _ => bail!("Unknown calculation operation"),
    }
}

struct Note { path: String, content: String, checksum: String }
/// Never follows links, never escapes the selected vault, never scans without a budget.
fn notes(args: &Value, vault: &str) -> Result<(Vec<Note>, bool, Vec<String>)> {
    let root = Path::new(vault).canonicalize()?;
    let folder = args["folder"].as_str().unwrap_or("");
    ensure!(!Path::new(folder).components().any(|c| matches!(c, std::path::Component::ParentDir)), "Parent traversal is not allowed");
    let start = root.join(folder).canonicalize()?;
    ensure!(start.starts_with(&root) && start.is_dir(), "Folder must be inside the selected vault");
    let budget = args["max_files"].as_u64().unwrap_or(200).clamp(1, 500) as usize;
    let mut stack = vec![start]; let mut out = Vec::new(); let mut bytes = 0; let mut skipped = Vec::new(); let mut truncated = false;
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let kind = entry.file_type()?; let path = entry.path();
            if kind.is_symlink() { continue; }
            let name = entry.file_name(); let name = name.to_string_lossy();
            if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target") { continue; }
            if kind.is_dir() { stack.push(path); continue; }
            if !kind.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) { continue; }
            if out.len() >= budget { truncated = true; break; }
            let size = entry.metadata()?.len() as usize;
            if size > 2_000_000 || bytes + size > 20_000_000 { skipped.push(path.to_string_lossy().into_owned()); continue; }
            let canonical = path.canonicalize()?;
            ensure!(canonical.starts_with(&root), "Source escaped vault");
            match std::fs::read_to_string(&canonical) {
                Ok(content) => { bytes += size; out.push(Note { path: canonical.to_string_lossy().into_owned(), checksum: format!("{:x}", Sha256::digest(content.as_bytes())), content }); }
                Err(_) => skipped.push(canonical.to_string_lossy().into_owned()),
            }
        }
        if truncated { break; }
    }
    Ok((out, truncated, skipped))
}

pub fn duplicate_groups(args: &Value, vault: &str) -> Result<Value> {
    let (notes, truncated, skipped) = notes(args, vault)?;
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for note in &notes {
        let normalized = note.content.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if normalized.len() < 16 { continue; }
        groups.entry(format!("{:x}", Sha256::digest(normalized.as_bytes()))).or_default()
            .push(json!({"path":note.path,"checksum":note.checksum}));
    }
    let limit = args["limit"].as_u64().unwrap_or(30).clamp(1, 100) as usize;
    let mut matches = Vec::new();
    for (fingerprint, members) in groups.into_iter().filter(|(_, v)| v.len() > 1) {
        let exact = members.iter().all(|m| m["checksum"] == members[0]["checksum"]);
        matches.push(json!({
            "fingerprint": fingerprint,
            "match_kind": if exact { "exact" } else { "normalized" },
            "score": 1.0,
            "paths": members.iter().map(|m| &m["path"]).collect::<Vec<_>>(),
            "members": members,
            "requires_confirmation": true
        }));
    }

    if matches.len() < limit && notes.len() <= 200 {
        let token_sets: Vec<(usize, BTreeSet<&str>)> = notes
            .iter()
            .enumerate()
            .map(|(idx, n)| (idx, n.content.split_whitespace().collect()))
            .collect();

        for i in 0..token_sets.len() {
            if matches.len() >= limit { break; }
            let (idx_a, set_a) = &token_sets[i];
            if set_a.len() < 5 { continue; }
            for j in (i + 1)..token_sets.len() {
                if matches.len() >= limit { break; }
                let (idx_b, set_b) = &token_sets[j];
                if set_b.len() < 5 { continue; }
                let intersection = set_a.intersection(set_b).count();
                let union = set_a.union(set_b).count();
                if union > 0 {
                    let sim = intersection as f64 / union as f64;
                    if sim >= 0.75 && sim < 1.0 {
                        let na = &notes[*idx_a];
                        let nb = &notes[*idx_b];
                        let fp = format!("{:x}", Sha256::digest(format!("{}|{}", na.checksum, nb.checksum).as_bytes()));
                        matches.push(json!({
                            "fingerprint": fp,
                            "match_kind": "lexical_similarity",
                            "score": (sim * 1000.0).round() / 1000.0,
                            "paths": [&na.path, &nb.path],
                            "members": [
                                {"path": &na.path, "checksum": &na.checksum},
                                {"path": &nb.path, "checksum": &nb.checksum}
                            ],
                            "requires_confirmation": true
                        }));
                    }
                }
            }
        }
    }

    let omitted = matches.len().saturating_sub(limit); matches.truncate(limit);
    Ok(json!({"groups":matches,"scanned_files":notes.len(),"truncated":truncated || omitted > 0,"omitted_groups":omitted,
        "skipped_paths":skipped,"method":"exact, normalized and lexical similarity content; candidates only, no automatic merge"}))
}

pub fn entity_aliases(args: &Value, vault: &str) -> Result<Value> {
    let (notes, truncated, skipped) = notes(args, vault)?;
    let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
    let mut candidates = Vec::new();
    for note in notes {
        let mut terms = BTreeSet::new();
        if let Some(stem) = Path::new(&note.path).file_stem() { terms.insert(stem.to_string_lossy().into_owned()); }
        terms.extend(crate::db::mentions::frontmatter_aliases(&note.content));
        if let Some(title) = note.content.lines().find_map(|l| l.strip_prefix("# ")) { terms.insert(title.trim().to_owned()); }
        let matched: Vec<_> = terms.iter().filter(|t| query.is_empty() || t.to_lowercase() == query).cloned().collect();
        if !matched.is_empty() { candidates.push(json!({"path":note.path,"aliases":terms,"matched_terms":matched,
            "source_checksum":note.checksum,"basis":"filename, heading and explicit frontmatter aliases","confirmed":false})); }
    }
    let total = candidates.len(); candidates.truncate(100);
    Ok(json!({"candidates":candidates,"ambiguous":total > 1,"requires_confirmation":true,"truncated":truncated || total > 100,"skipped_paths":skipped}))
}

fn isbn_valid(id: &str) -> bool {
    let digits: Vec<_> = id.chars().map(|c| if c == 'X' { Some(10) } else { c.to_digit(10) }).collect::<Option<_>>().unwrap_or_default();
    match digits.len() {
        10 => digits[..9].iter().all(|d| *d < 10) && digits.iter().enumerate().map(|(i,d)| (10-i) as u32*d).sum::<u32>() % 11 == 0,
        13 => digits.iter().all(|d| *d < 10) && digits.iter().enumerate().map(|(i,d)| if i%2 == 0 {*d} else {3*d}).sum::<u32>() % 10 == 0,
        _ => false,
    }
}

pub async fn resolve_reference(args: &Value) -> Result<Value> {
    let raw = text(args, "reference")?.trim(); ensure!(raw.len() <= 512, "Reference too long");
    let doi = raw.strip_prefix("https://doi.org/").or_else(|| raw.strip_prefix("http://doi.org/")).or_else(|| raw.strip_prefix("doi:" )).unwrap_or(raw).trim();
    let arxiv = raw.strip_prefix("https://arxiv.org/abs/").or_else(|| raw.strip_prefix("https://arxiv.org/pdf/")).or_else(|| raw.strip_prefix("arXiv:")).unwrap_or(raw).trim_end_matches(".pdf");
    let isbn = raw.strip_prefix("ISBN:").unwrap_or(raw).replace(['-', ' '], "").to_uppercase();
    let (kind, id, provider, url) = if regex::Regex::new(r"^10\.\d{4,9}/[^\s?#]+$")?.is_match(doi) {
        let mut url = reqwest::Url::parse("https://api.crossref.org/works/")?;
        url.path_segments_mut().map_err(|_| anyhow::anyhow!("Invalid reference URL"))?.pop_if_empty().push(doi);
        ("doi", doi.to_string(), "Crossref", url)
    } else if regex::Regex::new(r"^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?/\d{7})(v\d+)?$")?.is_match(arxiv) {
        let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query")?; url.query_pairs_mut().append_pair("id_list", arxiv);
        ("arxiv", arxiv.to_string(), "arXiv", url)
    } else if isbn_valid(&isbn) {
        let mut url = reqwest::Url::parse("https://openlibrary.org/api/books")?;
        url.query_pairs_mut().append_pair("bibkeys", &format!("ISBN:{isbn}")).append_pair("format","json").append_pair("jscmd","data");
        ("isbn", isbn, "Open Library", url)
    } else { bail!("Expected a DOI, valid ISBN or arXiv identifier / URL"); };
    let mut out = json!({"kind":kind,"identifier":id,"provider":provider,"provider_url":url.as_str(),"status":"identifier_only"});
    if !args["fetch_metadata"].as_bool().unwrap_or(true) { return Ok(out); }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).user_agent("ZettelAgent/0.3 research-reference").build()?;
    let fetched = async {
        let mut response = client.get(url).send().await?.error_for_status()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? { ensure!(bytes.len() + chunk.len() <= 2_000_000, "Metadata response too large"); bytes.extend_from_slice(&chunk); }
        Ok::<_, anyhow::Error>(String::from_utf8(bytes)?)
    }.await;
    match fetched {
        Ok(body) => {
            let metadata = if kind == "arxiv" {
                let html = scraper::Html::parse_document(&body);
                let select = |selector: &str| -> Option<String> { let selector = scraper::Selector::parse(selector).ok()?; html.select(&selector).next().map(|e| e.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")) };
                match select("entry title") { Some(title) => json!({"title":title,"authors":html.select(&scraper::Selector::parse("entry author name").unwrap()).map(|e| e.text().collect::<String>()).collect::<Vec<_>>(),"published":select("entry published")}), None => Value::Null }
            } else { let parsed: Value = serde_json::from_str(&body)?; if kind == "doi" { parsed["message"].clone() } else { parsed[format!("ISBN:{id}")].clone() } };
            out["status"] = json!(if metadata.is_null() {"not_found"} else {"resolved"});
            out["metadata"] = metadata;
            out["retrieved_at_ms"] = json!(crate::knowledge::types::now_ms());
        }
        Err(error) => { out["status"] = json!("unavailable"); out["error"] = json!(error.to_string()); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn arithmetic_has_precedence_and_rejects_code_and_nonfinite_results() {
        assert_eq!(calculate(&json!({"expression":"2 + 3 * (4 - 1)^2"})).unwrap()["result"], 29.0);
        assert_eq!(calculate(&json!({"expression":"-2^2"})).unwrap()["result"], -4.0);
        for expression in ["1/0", "NaN", "std::process::exit(1)", "2 3", "1e999", "2^^3"] {
            assert!(calculate(&json!({"expression":expression})).is_err(), "{expression}");
        }
    }
    #[test]
    fn units_and_dates_are_explicit_and_bounded() {
        assert_eq!(calculate(&json!({"operation":"convert","value":100.0,"from":"cm","to":"m"})).unwrap()["result"], 1.0);
        assert_eq!(calculate(&json!({"operation":"date_difference","from":"2024-02-28","to":"2024-03-01"})).unwrap()["days"], 2);
        assert!(calculate(&json!({"operation":"convert","value":1,"from":"kg","to":"m"})).is_err());
        assert_eq!(calculate(&json!({"operation":"convert","value":0,"from":"celsius","to":"fahrenheit"})).unwrap()["result"], 32.0);
        assert!(calculate(&json!({"expression":"(".repeat(1000)})).is_err());
    }
    #[test]
    fn candidates_are_scoped_and_do_not_change_sources() {
        let root = std::env::temp_dir().join(format!("zettel-maintenance-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let a = "---\naliases: [KG, Knowledge Graph]\n---\nSame content";
        std::fs::write(root.join("a.md"), a).unwrap();
        std::fs::write(root.join("b.md"), a).unwrap();
        std::fs::write(root.join("c.md"), "Different").unwrap();
        let vault = root.to_str().unwrap();
        let out = duplicate_groups(&json!({}), vault).unwrap();
        assert_eq!(out["groups"].as_array().unwrap().len(), 1);
        assert_eq!(out["groups"][0]["paths"].as_array().unwrap().len(), 2);
        let aliases = entity_aliases(&json!({"query":"kg"}), vault).unwrap();
        assert_eq!(aliases["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), a);
        assert!(duplicate_groups(&json!({"folder":"../"}), vault).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reference_identifiers_validate_without_inventing_metadata() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let doi = resolve_reference(&json!({"reference":"https://doi.org/10.1000/xyz123","fetch_metadata":false})).await.unwrap();
            assert_eq!(doi["identifier"], "10.1000/xyz123");
            assert_eq!(doi["status"], "identifier_only");
            assert!(doi.get("title").is_none());
            assert!(resolve_reference(&json!({"reference":"not a reference","fetch_metadata":false})).await.is_err());
        });
    }
    #[test]
    fn duplicate_candidates_include_substantial_near_copies_with_explicit_scores() {
        let root = std::env::temp_dir().join(format!("zettel-near-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let original = "A durable research project preserves its question, assumptions, source evidence and the next action. Each claim points back to its original passage so a later reader can check the reasoning.";
        std::fs::write(root.join("first.md"), original).unwrap();
        std::fs::write(root.join("second.md"), format!("{original} A short addition.")).unwrap();
        let out = duplicate_groups(&json!({}), root.to_str().unwrap()).unwrap();
        assert_eq!(out["groups"][0]["match_kind"], "lexical_similarity");
        assert!(out["groups"][0]["score"].as_f64().unwrap() > 0.8);
        std::fs::remove_dir_all(root).unwrap();
    }
}
