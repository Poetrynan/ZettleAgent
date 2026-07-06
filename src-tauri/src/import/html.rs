use scraper::{Html, Selector};

/// Convert HTML content to Markdown.
/// Returns (title, markdown_body).
pub fn html_to_markdown(html_content: &str) -> (String, String) {
    let document = Html::parse_document(html_content);

    // Extract title
    let title = extract_title(&document);

    // Extract text content, converting to markdown
    let mut markdown = String::new();
    let body_selector = Selector::parse("body").unwrap();

    if let Some(body) = document.select(&body_selector).next() {
        convert_element(&body, &mut markdown);
    } else {
        // No body tag, try the whole document
        convert_element(&document.root_element(), &mut markdown);
    }

    // Clean up excessive whitespace
    let cleaned = clean_markdown(&markdown);
    (title, cleaned)
}

fn extract_title(document: &Html) -> String {
    // Try <title> tag
    if let Ok(sel) = Selector::parse("title") {
        if let Some(elem) = document.select(&sel).next() {
            let t = elem.text().collect::<String>().trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    // Try <h1>
    if let Ok(sel) = Selector::parse("h1") {
        if let Some(elem) = document.select(&sel).next() {
            let t = elem.text().collect::<String>().trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    String::new()
}

fn convert_element(element: &scraper::ElementRef, output: &mut String) {
    use scraper::Node;

    for child in element.children() {
        match child.value() {
            Node::Text(text) => {
                let t = text.text.trim();
                if !t.is_empty() {
                    output.push_str(t);
                }
            }
            Node::Element(el) => {
                let tag = el.name.local.as_ref();

                // Skip non-content tags
                if matches!(tag, "script" | "style" | "nav" | "footer" | "aside" | "noscript" | "svg" | "iframe") {
                    continue;
                }

                if let Some(child_ref) = scraper::ElementRef::wrap(child) {
                    match tag {
                        "h1" => {
                            output.push_str("\n\n## ");
                            let text: String = child_ref.text().collect();
                            output.push_str(text.trim());
                            output.push_str("\n\n");
                        }
                        "h2" => {
                            output.push_str("\n\n### ");
                            let text: String = child_ref.text().collect();
                            output.push_str(text.trim());
                            output.push_str("\n\n");
                        }
                        "h3" | "h4" | "h5" | "h6" => {
                            output.push_str("\n\n#### ");
                            let text: String = child_ref.text().collect();
                            output.push_str(text.trim());
                            output.push_str("\n\n");
                        }
                        "p" => {
                            output.push_str("\n\n");
                            convert_element(&child_ref, output);
                            output.push_str("\n\n");
                        }
                        "br" => {
                            output.push('\n');
                        }
                        "strong" | "b" => {
                            output.push_str("**");
                            convert_element(&child_ref, output);
                            output.push_str("**");
                        }
                        "em" | "i" => {
                            output.push('*');
                            convert_element(&child_ref, output);
                            output.push('*');
                        }
                        "code" => {
                            output.push('`');
                            let text: String = child_ref.text().collect();
                            output.push_str(&text);
                            output.push('`');
                        }
                        "pre" => {
                            output.push_str("\n\n```\n");
                            let text: String = child_ref.text().collect();
                            output.push_str(&text);
                            output.push_str("\n```\n\n");
                        }
                        "a" => {
                            let href = child_ref.value().attr("href").unwrap_or("");
                            let text: String = child_ref.text().collect();
                            let text = text.trim();
                            if !text.is_empty() && !href.is_empty() {
                                output.push_str(&format!("[{}]({})", text, href));
                            } else if !text.is_empty() {
                                output.push_str(text);
                            }
                        }
                        "ul" | "ol" => {
                            output.push('\n');
                            convert_element(&child_ref, output);
                            output.push('\n');
                        }
                        "li" => {
                            output.push_str("\n- ");
                            convert_element(&child_ref, output);
                        }
                        "blockquote" => {
                            output.push_str("\n\n> ");
                            let text: String = child_ref.text().collect();
                            output.push_str(text.trim());
                            output.push_str("\n\n");
                        }
                        "table" => {
                            output.push_str("\n\n");
                            convert_table(&child_ref, output);
                            output.push_str("\n\n");
                        }
                        "img" => {
                            let alt = child_ref.value().attr("alt").unwrap_or("image");
                            let src = child_ref.value().attr("src").unwrap_or("");
                            if !src.is_empty() {
                                output.push_str(&format!("![{}]({})", alt, src));
                            }
                        }
                        "hr" => {
                            output.push_str("\n\n---\n\n");
                        }
                        "div" | "section" | "article" | "main" | "header" | "span"
                        | "figure" | "figcaption" | "details" | "summary" => {
                            convert_element(&child_ref, output);
                        }
                        _ => {
                            convert_element(&child_ref, output);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn convert_table(table: &scraper::ElementRef, output: &mut String) {
    let tr_sel = Selector::parse("tr").unwrap();
    let th_sel = Selector::parse("th").unwrap();
    let td_sel = Selector::parse("td").unwrap();

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut has_header = false;

    for tr in table.select(&tr_sel) {
        let ths: Vec<String> = tr.select(&th_sel)
            .map(|th| th.text().collect::<String>().trim().to_string())
            .collect();
        if !ths.is_empty() {
            rows.push(ths);
            has_header = true;
        } else {
            let tds: Vec<String> = tr.select(&td_sel)
                .map(|td| td.text().collect::<String>().trim().to_string())
                .collect();
            if !tds.is_empty() {
                rows.push(tds);
            }
        }
    }

    if rows.is_empty() {
        return;
    }

    // If no explicit header, treat first row as header
    if !has_header && rows.len() > 1 {
        // just use first row as header anyway
    }

    // Output header
    let header = &rows[0];
    output.push_str("| ");
    output.push_str(&header.join(" | "));
    output.push_str(" |\n");

    // Separator
    output.push_str("| ");
    output.push_str(&header.iter().map(|_| "---").collect::<Vec<_>>().join(" | "));
    output.push_str(" |\n");

    // Data rows
    for row in rows.iter().skip(1) {
        output.push_str("| ");
        output.push_str(&row.join(" | "));
        output.push_str(" |\n");
    }
}

fn clean_markdown(raw: &str) -> String {
    let mut result = String::new();
    let mut prev_empty = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !prev_empty {
                result.push('\n');
                prev_empty = true;
            }
        } else {
            result.push_str(trimmed);
            result.push('\n');
            prev_empty = false;
        }
    }

    result.trim().to_string()
}
