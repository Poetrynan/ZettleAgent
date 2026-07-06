use pulldown_cmark::{Parser, Event, Tag, TagEnd, HeadingLevel};
use serde::{Deserialize, Serialize};

/// Represents a single chunk of a markdown document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    /// The text content of this chunk
    pub content: String,
    /// Heading hierarchy path, e.g. "## Section > ### Subsection"
    pub heading_hierarchy: String,
    /// Type of marker: "user", "generated", or "mixed"
    pub marker_type: String,
    /// Index of this chunk in the document (0-based)
    pub chunk_index: usize,
}

/// Configuration for the chunker.
pub struct ChunkerConfig {
    /// Maximum characters per chunk before forcing a split
    pub max_chunk_size: usize,
    /// Whether to split on H2 boundaries (true) or H1 boundaries (false)
    pub split_level: HeadingLevel,
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        Self {
            max_chunk_size: 2000,
            split_level: HeadingLevel::H2,
        }
    }
}

/// Split a markdown document into chunks based on heading boundaries.
///
/// The chunker walks the pulldown-cmark event stream and groups content
/// under heading sections. Each chunk preserves its heading hierarchy.
pub fn chunk_markdown(content: &str, config: &ChunkerConfig) -> Vec<Chunk> {
    let parser = Parser::new(content);
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut current_content = String::new();
    let mut heading_stack: Vec<String> = Vec::new();
    let mut current_heading_level: Option<HeadingLevel> = None;
    let mut chunk_index: usize = 0;
    let mut in_fence = false;
    let mut marker_type = "user";

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                // If we hit a split-level heading and have content, flush the current chunk
                if level <= config.split_level && !current_content.trim().is_empty() {
                    chunks.push(Chunk {
                        content: current_content.trim().to_string(),
                        heading_hierarchy: heading_stack.join(" > "),
                        marker_type: marker_type.to_string(),
                        chunk_index,
                    });
                    chunk_index += 1;
                    current_content.clear();
                    marker_type = "user";
                }

                // Track heading level for the next text
                current_heading_level = Some(level);
                // Clear deeper headings from stack
                let depth = heading_level_depth(level);
                heading_stack.truncate(depth.saturating_sub(1));
            }
            Event::End(TagEnd::Heading(_)) => {
                current_heading_level = None;
            }
            Event::Start(Tag::CodeBlock(_kind)) => {
                in_fence = true;
                current_content.push_str("```\n");
            }
            Event::End(TagEnd::CodeBlock) => {
                in_fence = false;
                current_content.push_str("```\n");
            }
            Event::Text(text) => {
                // If we just entered a heading, capture the heading text
                if let Some(level) = current_heading_level {
                    let heading_text = text.to_string();
                    heading_stack.push(format!("{} {}", "#".repeat(heading_level_depth(level)), heading_text));
                    current_content.push_str(&format!("{} {}\n", "#".repeat(heading_level_depth(level)), heading_text));
                } else {
                    // Detect marker type from HTML comments
                    let t = text.trim();
                    if t.starts_with("@generated") || t.starts_with("@ai") {
                        marker_type = "generated";
                    } else if t.starts_with("@user") {
                        marker_type = "user";
                    }
                    current_content.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                current_content.push('\n');
            }
            Event::Rule => {
                current_content.push_str("---\n");
            }
            _ => {}
        }

        // Force split if chunk exceeds max size (only outside code fences)
        if !in_fence && current_content.len() > config.max_chunk_size {
            if !current_content.trim().is_empty() {
                chunks.push(Chunk {
                    content: current_content.trim().to_string(),
                    heading_hierarchy: heading_stack.join(" > "),
                    marker_type: marker_type.to_string(),
                    chunk_index,
                });
                chunk_index += 1;
                current_content.clear();
                marker_type = "user";
            }
        }
    }

    // Flush remaining content
    if !current_content.trim().is_empty() {
        chunks.push(Chunk {
            content: current_content.trim().to_string(),
            heading_hierarchy: heading_stack.join(" > "),
            marker_type: marker_type.to_string(),
            chunk_index,
        });
    }

    chunks
}

/// Map heading level to numeric depth (H1=1, H2=2, etc.)
fn heading_level_depth(level: HeadingLevel) -> usize {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_chunking() {
        let md = r#"# Title

## Section 1

Some content here.

## Section 2

More content here.
"#;
        let chunks = chunk_markdown(md, &ChunkerConfig::default());
        assert!(chunks.len() >= 2, "Expected at least 2 chunks, got {}", chunks.len());
    }

    #[test]
    fn test_heading_hierarchy() {
        let md = r#"# Main

## Sub

Content under sub.
"#;
        let chunks = chunk_markdown(md, &ChunkerConfig::default());
        assert!(!chunks.is_empty());
    }
}
