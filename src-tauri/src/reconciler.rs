use serde::{Deserialize, Serialize};

/// Represents a conflict between user edits and AI-generated content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    pub file_path: String,
    pub section_heading: String,
    pub user_content: String,
    pub ai_content: String,
    pub conflict_type: ConflictType,
}

/// Types of conflicts that can occur during reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConflictType {
    /// Both user and AI modified the same section
    OverlappingEdit,
    /// User deleted a section that AI modified
    DeletedByUser,
    /// AI added content to a section the user restructured
    StructuralChange,
}

/// Reconciliation strategy to apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub enum ReconcileStrategy {
    /// Keep user's version, discard AI changes
    KeepUser,
    /// Keep AI's version, discard user changes
    KeepAI,
    /// Attempt to merge both versions
    Merge,
    /// Present conflict to user for manual resolution
    Manual,
}

/// Result of a reconciliation operation.
#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ReconcileResult {
    pub file_path: String,
    pub strategy_used: ReconcileStrategy,
    pub merged_content: Option<String>,
    pub conflicts: Vec<Conflict>,
    pub success: bool,
}

/// Detect conflicts between user-edited content and AI-generated content
/// by comparing heading-based sections.
pub fn detect_conflicts(
    file_path: &str,
    user_content: &str,
    ai_content: &str,
) -> Vec<Conflict> {
    let mut conflicts = Vec::new();

    let user_sections = parse_sections(user_content);
    let ai_sections = parse_sections(ai_content);

    for (heading, ai_text) in &ai_sections {
        if let Some(user_text) = user_sections.get(heading) {
            if user_text != ai_text {
                conflicts.push(Conflict {
                    file_path: file_path.to_string(),
                    section_heading: heading.clone(),
                    user_content: user_text.clone(),
                    ai_content: ai_text.clone(),
                    conflict_type: ConflictType::OverlappingEdit,
                });
            }
        }
    }

    conflicts
}

/// Apply a reconciliation strategy to resolve conflicts.
#[allow(dead_code)]
pub fn reconcile(
    file_path: &str,
    original_content: &str,
    ai_content: &str,
    strategy: &ReconcileStrategy,
) -> ReconcileResult {
    let conflicts = detect_conflicts(file_path, original_content, ai_content);

    if conflicts.is_empty() {
        return ReconcileResult {
            file_path: file_path.to_string(),
            strategy_used: strategy.clone(),
            merged_content: Some(ai_content.to_string()),
            conflicts: Vec::new(),
            success: true,
        };
    }

    match strategy {
        ReconcileStrategy::KeepUser => ReconcileResult {
            file_path: file_path.to_string(),
            strategy_used: strategy.clone(),
            merged_content: Some(original_content.to_string()),
            conflicts,
            success: true,
        },
        ReconcileStrategy::KeepAI => ReconcileResult {
            file_path: file_path.to_string(),
            strategy_used: strategy.clone(),
            merged_content: Some(ai_content.to_string()),
            conflicts,
            success: true,
        },
        ReconcileStrategy::Merge => {
            let merged = simple_merge(original_content, ai_content, &conflicts);
            ReconcileResult {
                file_path: file_path.to_string(),
                strategy_used: strategy.clone(),
                merged_content: Some(merged),
                conflicts,
                success: true,
            }
        }
        ReconcileStrategy::Manual => ReconcileResult {
            file_path: file_path.to_string(),
            strategy_used: strategy.clone(),
            merged_content: None,
            conflicts,
            success: false,
        },
    }
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

fn is_markdown_heading(line: &str) -> bool {
    let trimmed = line.trim_start();
    let num_hashes = trimmed.chars().take_while(|&c| c == '#').count();
    num_hashes >= 1 && num_hashes <= 6 && trimmed.chars().nth(num_hashes) == Some(' ')
}

/// Parse markdown content into heading -> content sections.
pub fn parse_sections(content: &str) -> std::collections::HashMap<String, String> {
    let mut sections = std::collections::HashMap::new();
    let mut current_heading = String::from("_top");
    let mut current_content = String::new();

    for line in content.lines() {
        if is_markdown_heading(line) {
            if !current_content.trim().is_empty() {
                sections.insert(current_heading.clone(), current_content.trim().to_string());
            }
            current_heading = line.trim().to_string();
            current_content.clear();
        } else {
            current_content.push_str(line);
            current_content.push('\n');
        }
    }

    if !current_content.trim().is_empty() {
        sections.insert(current_heading, current_content.trim().to_string());
    }

    sections
}

/// Simple merge: prefer user content for conflicting sections, keep AI additions.
pub fn simple_merge(
    user_content: &str,
    ai_content: &str,
    conflicts: &[Conflict],
) -> String {
    let conflict_headings: std::collections::HashSet<&str> = conflicts
        .iter()
        .map(|c| c.section_heading.as_str())
        .collect();

    let user_sections = parse_sections(user_content);

    let mut merged = String::new();
    let mut skip_current_section = false;

    for line in ai_content.lines() {
        let is_heading = is_markdown_heading(line);
        if is_heading {
            if conflict_headings.contains(line.trim()) {
                skip_current_section = true;
                if let Some(user_text) = user_sections.get(line.trim()) {
                    merged.push_str(line);
                    merged.push('\n');
                    merged.push_str(user_text);
                    merged.push('\n');
                }
                continue;
            } else {
                skip_current_section = false;
            }
        }

        if skip_current_section {
            continue;
        }

        merged.push_str(line);
        merged.push('\n');
    }

    merged
}
