use tauri::State;
use crate::AppState;
use crate::reconciler;

/// Detect conflicts between user content and AI-generated content in a file.
/// Returns the list of conflicting sections (no LLM involved).
#[tauri::command]
pub async fn detect_file_conflicts(
    file_path: String,
    _state: State<'_, AppState>,
) -> Result<Vec<reconciler::Conflict>, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    if !content.contains("<!-- @generated -->") {
        return Ok(Vec::new());
    }

    let user_content = strip_generated_blocks(&content);
    let conflicts = reconciler::detect_conflicts(&file_path, &user_content, &content);
    Ok(conflicts)
}

/// Apply a user's resolution choice for a specific conflict.
#[tauri::command]
pub async fn resolve_conflict(
    file_path: String,
    section_heading: String,
    resolution: String,
    _state: State<'_, AppState>,
) -> Result<bool, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let user_content = strip_generated_blocks(&content);
    let user_sections = reconciler::parse_sections(&user_content);

    let final_content = match resolution.as_str() {
        "keep_user" => {
            rebuild_content(&content, &user_sections, &section_heading, "user")
        }
        "keep_ai" => {
            content.clone()
        }
        _ => return Err(format!("Unknown resolution: {}", resolution)),
    };

    std::fs::write(&file_path, &final_content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(true)
}

/// Strip all `<!-- @generated -->` ... `<!-- /@generated -->` blocks from content.
fn strip_generated_blocks(content: &str) -> String {
    let mut result = String::new();
    let mut in_generated = false;

    for line in content.lines() {
        if line.contains("<!-- @generated -->") {
            in_generated = true;
            continue;
        }
        if line.contains("<!-- /@generated -->") {
            in_generated = false;
            continue;
        }
        if !in_generated {
            result.push_str(line);
            result.push('\n');
        }
    }

    result
}

/// Rebuild content, replacing a specific section with user's version.
fn rebuild_content(
    content: &str,
    user_sections: &std::collections::HashMap<String, String>,
    target_heading: &str,
    source: &str,
) -> String {
    let mut result = String::new();
    let mut in_target_section = false;

    for line in content.lines() {
        let is_heading = {
            let trimmed = line.trim_start();
            let num_hashes = trimmed.chars().take_while(|&c| c == '#').count();
            num_hashes >= 1 && num_hashes <= 6 && trimmed.chars().nth(num_hashes) == Some(' ')
        };

        if is_heading {
            if line.trim() == target_heading {
                in_target_section = true;
                result.push_str(line);
                result.push('\n');
                if source == "user" {
                    if let Some(user_text) = user_sections.get(target_heading) {
                        result.push_str(user_text);
                        result.push('\n');
                    }
                }
                continue;
            } else {
                in_target_section = false;
            }
        }

        if in_target_section && source == "user" {
            continue;
        }

        result.push_str(line);
        result.push('\n');
    }

    result
}
