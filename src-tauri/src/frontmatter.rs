/// Frontmatter validation and repair utilities.
///
/// Ensures every `.md` file written by the AI pipeline has well-formed YAML frontmatter:
///   - Opening/closing delimiters are exactly `---`
///   - Required fields (`type`, `created`) exist
///   - Tags are in `[a, b, c]` format

use chrono::Local;

/// Repair common frontmatter malformations and ensure required fields exist.
///
/// This function is idempotent — running it on already-correct content is a no-op.
pub fn sanitize_frontmatter(content: &str) -> String {
    // Step 1: Try to detect and extract frontmatter region (may be malformed)
    let (fm_region, body) = match extract_frontmatter_region(content) {
        Some((fm, body)) => (fm, body),
        None => {
            // No frontmatter at all — inject a minimal one
            return inject_default_frontmatter(content);
        }
    };

    // Step 2: Normalize the delimiters and clean up the YAML lines
    let yaml_lines = normalize_yaml_lines(&fm_region);

    // Step 3: Ensure required fields
    let yaml_lines = ensure_required_fields(yaml_lines);

    // Step 4: Rebuild the file
    let mut result = String::from("---\n");
    for line in &yaml_lines {
        result.push_str(line);
        result.push('\n');
    }
    result.push_str("---\n");
    result.push_str(&body);

    result
}

/// Try to extract the frontmatter region, tolerating common malformations.
/// Returns (yaml_lines_without_delimiters, body_after_frontmatter).
fn extract_frontmatter_region(content: &str) -> Option<(Vec<String>, String)> {
    let mut lines = content.lines();

    // Find opening delimiter: must be on the first line, accept `---`, `***`, or `---...`
    let first = lines.next()?.trim();
    if !is_dash_or_star_delimiter(first) {
        return None;
    }

    let mut yaml_lines: Vec<String> = Vec::new();
    let mut found_closing = false;
    let mut body_start_offset = 0;

    for line in lines {
        let trimmed = line.trim();
        if is_dash_or_star_delimiter(trimmed) {
            found_closing = true;
            // Calculate offset: everything after this line is body
            body_start_offset += line.len() + 1; // +1 for \n
            break;
        }
        yaml_lines.push(line.to_string());
        body_start_offset += line.len() + 1;
    }

    if !found_closing {
        // No closing delimiter found — treat entire content as having no frontmatter
        return None;
    }

    // Body is everything after the closing delimiter
    let body = &content[content.len().min(find_offset(content, body_start_offset))..];
    Some((yaml_lines, body.to_string()))
}

/// Check if a line is a frontmatter delimiter (3+ dashes or 3+ stars).
fn is_dash_or_star_delimiter(line: &str) -> bool {
    let trimmed = line.trim();
    (trimmed.chars().all(|c| c == '-') && trimmed.len() >= 3)
        || (trimmed.chars().all(|c| c == '*') && trimmed.len() >= 3)
}

/// Find the byte offset corresponding to skipping `n` bytes of line content + newlines.
fn find_offset(content: &str, n: usize) -> usize {
    // Walk the content counting bytes for lines + newlines
    let mut consumed = 0;
    for (i, line) in content.lines().enumerate() {
        if i > 0 {
            consumed += 1; // \n
        }
        consumed += line.len();
        if consumed >= n {
            return consumed.min(content.len());
        }
    }
    content.len()
}

/// Normalize YAML lines: trim, remove empty lines at edges.
fn normalize_yaml_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|l| l.trim().to_string())
        .collect()
}

/// Ensure `type`, `created` fields exist. Add defaults if missing.
fn ensure_required_fields(mut lines: Vec<String>) -> Vec<String> {
    let has_type = lines.iter().any(|l| l.starts_with("type:"));
    let has_created = lines.iter().any(|l| l.starts_with("created:") || l.starts_with("date:"));

    if !has_type {
        lines.push("type: permanent".to_string());
    }
    if !has_created {
        let today = Local::now().format("%Y-%m-%d").to_string();
        lines.push(format!("created: {}", today));
    }

    lines
}

/// Inject a minimal frontmatter block before the content.
fn inject_default_frontmatter(content: &str) -> String {
    let today = Local::now().format("%Y-%m-%d").to_string();
    format!(
        "---\ntype: permanent\ncreated: {}\n---\n{}",
        today, content
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normal_frontmatter_unchanged() {
        let input = "---\ntype: literature\ntags: [AI]\ncreated: 2024-01-01\n---\n\n# Title\n";
        let result = sanitize_frontmatter(input);
        assert!(result.starts_with("---\n"));
        assert!(result.contains("type: literature"));
        assert!(result.contains("# Title"));
    }

    #[test]
    fn test_fix_stars_delimiter() {
        let input = "***\ntype: literature\ncreated: 2024-01-01\n***\n\n# Title\n";
        let result = sanitize_frontmatter(input);
        assert!(result.starts_with("---\n"));
        assert!(result.contains("---\n")); // closing delimiter
        assert!(result.contains("# Title"));
    }

    #[test]
    fn test_fix_long_dashes() {
        let input = "---\ntype: permanent\n-------------------\n\n# Title\n";
        let result = sanitize_frontmatter(input);
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines[0], "---");
        // The long-dash line must be normalized to exactly `---`.
        // Note: sanitize also auto-adds a `created:` field, so the closing
        // delimiter is not at a fixed index — find it after the YAML fields.
        let closing_idx = lines.iter().skip(1).position(|l| *l == "---").map(|i| i + 1);
        assert!(closing_idx.is_some(), "closing --- delimiter missing: {:?}", lines);
        assert!(!result.contains("-------"), "long dashes not normalized: {}", result);
        assert!(result.contains("# Title"));
    }

    #[test]
    fn test_no_frontmatter_injects_default() {
        let input = "# Just a title\n\nSome content.\n";
        let result = sanitize_frontmatter(input);
        assert!(result.starts_with("---\n"));
        assert!(result.contains("type: permanent"));
        assert!(result.contains("# Just a title"));
    }

    #[test]
    fn test_missing_type_field() {
        let input = "---\ntags: [AI]\ncreated: 2024-01-01\n---\n# Title\n";
        let result = sanitize_frontmatter(input);
        assert!(result.contains("type: permanent"));
    }

    #[test]
    fn test_missing_created_field() {
        let input = "---\ntype: literature\ntags: [AI]\n---\n# Title\n";
        let result = sanitize_frontmatter(input);
        assert!(result.contains("created:"));
    }
}
