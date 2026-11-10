use super::*;
use oxidize_pdf::parser::{PdfDocument, PdfReader};
use serde::Deserialize;
use std::io::Cursor;

#[derive(Default, Deserialize)]
pub(super) struct Range {
    start_line: Option<usize>,
    end_line: Option<usize>,
    start_page: Option<usize>,
    end_page: Option<usize>,
    heading: Option<String>,
    start_char: Option<usize>,
    max_chars: Option<usize>,
    pub expected_checksum: Option<String>,
}

fn bounds(start: Option<usize>, end: Option<usize>, total: usize) -> Result<(usize, usize)> {
    let (first, last) = (start.unwrap_or(1), end.unwrap_or(total));
    ensure!(
        first > 0 && first <= last && last <= total,
        "Requested range {first}–{last} is outside 1–{total}"
    );
    Ok((first, last))
}

fn heading_bounds(lines: &[&str], heading: &str) -> Result<(usize, usize)> {
    let mut found = None;
    let mut fence = None;
    for (index, raw) in lines.iter().enumerate() {
        let text = raw.trim_end().trim_start_matches(' ');
        if raw.len() - raw.trim_start_matches(' ').len() > 3 {
            continue;
        }
        let marker = text.chars().next().unwrap_or(' ');
        let count = text.chars().take_while(|&c| c == marker).count();
        if matches!(marker, '`' | '~') && count >= 3 {
            match fence {
                None => fence = Some((marker, count)),
                Some((m, n)) if m == marker && count >= n && text[count..].trim().is_empty() => {
                    fence = None
                }
                _ => {}
            }
            continue;
        }
        if fence.is_some() || marker != '#' || count > 6 {
            continue;
        }
        let tail = &text[count..];
        if !tail.starts_with(char::is_whitespace) {
            continue;
        }
        if let Some((first, level)) = found {
            if count <= level {
                return Ok((first, index));
            }
        } else {
            let label = tail.trim();
            let trimmed = label.trim_end_matches('#');
            let label = if trimmed.ends_with(char::is_whitespace) {
                trimmed.trim_end()
            } else {
                label
            };
            if label == heading.trim() {
                found = Some((index + 1, count));
            }
        }
    }
    found
        .map(|(first, _)| (first, lines.len()))
        .ok_or_else(|| anyhow!("Markdown heading not found: {heading}"))
}

fn char_byte(text: &str, index: usize) -> usize {
    text.char_indices()
        .nth(index)
        .map_or(text.len(), |(byte, _)| byte)
}

fn text_lines(text: &str, r: &Range, budget: usize) -> Result<Value> {
    ensure!(
        r.start_page.is_none() && r.end_page.is_none(),
        "Page selectors require a PDF"
    );
    let lines: Vec<_> = text.split_inclusive('\n').collect();
    let total = lines.len();
    if total == 0 && r.start_line.is_none() && r.end_line.is_none() && r.heading.is_none() {
        return Ok(json!({"segments":[],"total_lines":0,"truncated":false,"locator":null}));
    }
    let (mut first, mut last) = bounds(r.start_line, r.end_line, total)?;
    if let Some(h) = &r.heading {
        let (a, b) = heading_bounds(&lines, h)?;
        first = first.max(a);
        last = last.min(b);
        ensure!(first <= last, "Requested lines are outside heading {h}");
    }
    let offset = r.start_char.unwrap_or(0);
    let mut content = String::new();
    let mut used = 0;
    let mut end = first;
    let mut next = None;
    for n in first..=last {
        let raw = lines[n - 1];
        let line = raw
            .strip_suffix("\r\n")
            .or_else(|| raw.strip_suffix('\n'))
            .unwrap_or(raw);
        let from = if n == first { offset } else { 0 };
        ensure!(
            from <= line.chars().count(),
            "start_char is beyond line {n}"
        );
        let part = &line[char_byte(line, from)..];
        let sep = if n == first {
            ""
        } else if lines[n - 2].ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let length = part.chars().count();
        if n != first && used + sep.len() + length > budget {
            next = Some((n, 0));
            break;
        }
        content.push_str(sep);
        used += sep.len();
        let take = (budget - used).min(length);
        content.push_str(&part[..char_byte(part, take)]);
        end = n;
        used += take;
        if take < length {
            next = Some((n, from + take));
            break;
        }
    }
    let locator = format!("#L{first}-L{end}");
    let mut result = json!({"locator":locator,"total_lines":total,"truncated":next.is_some(),
        "segments":[{"content":content,"locator":locator,"start_line":first,"end_line":end,
        "needs_ocr":false,"start_char":offset}]});
    if let Some((line, ch)) = next {
        result["next_start_line"] = json!(line);
        result["next_start_char"] = json!(ch);
    }
    Ok(result)
}

pub(super) fn pdf_document(bytes: &[u8]) -> Result<PdfDocument<Cursor<&[u8]>>> {
    Ok(PdfDocument::new(PdfReader::new(Cursor::new(bytes))?))
}

fn pdf_pages(bytes: &[u8], r: &Range, mut budget: usize) -> Result<Value> {
    ensure!(
        r.start_line.is_none() && r.end_line.is_none() && r.heading.is_none(),
        "PDFs use physical page selectors"
    );
    let pdf = pdf_document(bytes)?;
    let total = pdf.page_count()? as usize;
    let (first, last) = bounds(r.start_page, r.end_page, total)?;
    let mut segments = Vec::new();
    let mut next = None;
    for page in first..=last {
        if budget == 0 || segments.len() == 100 {
            next = Some((page, 0));
            break;
        }
        let text = pdf.extract_text_from_page((page - 1) as u32)?.text;
        let from = if page == first {
            r.start_char.unwrap_or(0)
        } else {
            0
        };
        let length = text.chars().count();
        ensure!(from <= length, "start_char is beyond page {page}");
        let content = &text[char_byte(&text, from)..];
        let take = budget.min(length - from);
        segments.push(
            json!({"content": &content[..char_byte(content,take)], "page":page,
            "page_label":null,"locator":format!("#page={page}"),"start_char":from,
            "needs_ocr":text.trim().chars().count() < 20}),
        );
        budget -= take;
        if take < length - from {
            next = Some((page, from + take));
            break;
        }
    }
    let mut result = json!({"segments":segments,"locator": format!("#page={first}"),
        "total_pages":total,"truncated":next.is_some()});
    if let Some((page, ch)) = next {
        result["next_start_page"] = json!(page);
        result["next_start_char"] = json!(ch);
    }
    Ok(result)
}

pub(super) fn contents(
    path: &Path,
    bytes: &[u8],
    r: &Range,
    default_budget: usize,
) -> Result<Value> {
    let budget = r.max_chars.unwrap_or(default_budget).min(250_000);
    ensure!(budget > 0, "max_chars must be positive");
    let ext = extension(path);
    let mut result = match ext.as_str() {
        "pdf" => pdf_pages(bytes, r, budget)?,
        "docx" => text_lines(&docx_text(path, bytes)?, r, budget)?,
        "md" | "markdown" | "txt" | "text" | "csv" | "html" | "htm" => {
            text_lines(std::str::from_utf8(bytes)?, r, budget)?
        }
        _ => bail!("Unsupported source type: {ext}"),
    };
    result["kind"] = json!(match ext.as_str() {
        "md" | "markdown" => "markdown",
        "txt" | "text" => "text",
        "htm" => "html",
        other => other,
    });
    Ok(result)
}
