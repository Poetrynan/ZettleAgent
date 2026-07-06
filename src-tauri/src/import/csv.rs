/// Convert CSV content to a Markdown table.
/// Handles UTF-8 BOM, trims whitespace, and limits preview to 20 rows.
pub fn csv_to_markdown(csv_content: &str) -> String {
    // Strip UTF-8 BOM if present
    let content = csv_content.strip_prefix('\u{FEFF}').unwrap_or(csv_content);

    let mut lines = content.lines().filter(|l| !l.trim().is_empty());

    // Parse header
    let header_line = match lines.next() {
        Some(h) => h,
        None => return "*Empty CSV file*".to_string(),
    };

    let headers: Vec<&str> = parse_csv_row(header_line);
    if headers.is_empty() {
        return "*Empty CSV file*".to_string();
    }

    let mut output = String::new();

    // Column count
    let col_count = headers.len();

    // Header row
    output.push_str("| ");
    output.push_str(&headers.iter().map(|h| h.trim()).collect::<Vec<_>>().join(" | "));
    output.push_str(" |\n");

    // Separator
    output.push_str("| ");
    output.push_str(&headers.iter().map(|_| "---").collect::<Vec<_>>().join(" | "));
    output.push_str(" |\n");

    // Data rows (limit to 20 for preview)
    let mut row_count = 0;
    let mut total_rows = 0;
    for line in lines {
        total_rows += 1;
        if row_count < 20 {
            let cells: Vec<&str> = parse_csv_row(line);
            // Pad or truncate to match header column count
            let mut padded: Vec<String> = Vec::with_capacity(col_count);
            for i in 0..col_count {
                padded.push(cells.get(i).unwrap_or(&"").trim().to_string());
            }
            output.push_str("| ");
            output.push_str(&padded.join(" | "));
            output.push_str(" |\n");
            row_count += 1;
        }
    }

    if total_rows > 20 {
        output.push_str(&format!("\n*... and {} more rows (see source file)*\n", total_rows - 20));
    }

    output
}

/// Simple CSV row parser that handles quoted fields.
fn parse_csv_row(line: &str) -> Vec<&str> {
    // For simple CSVs without embedded commas in quotes, just split by comma.
    // For quoted fields, we do a basic scan.
    let mut fields = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let bytes = line.as_bytes();

    for i in 0..bytes.len() {
        match bytes[i] {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                let field = &line[start..i];
                fields.push(field.trim_matches('"').trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    // Last field
    if start <= line.len() {
        let field = &line[start..];
        fields.push(field.trim_matches('"').trim());
    }

    fields
}
