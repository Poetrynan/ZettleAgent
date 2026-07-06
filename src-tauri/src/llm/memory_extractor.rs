/// Memory Extraction Pipeline (2026 Mem0-style)
///
/// After each conversation, this module can extract structured facts
/// from the dialogue and merge them into the user's Core Memory.
/// Uses a lightweight LLM call to identify preferences, decisions, and habits.

use crate::llm::{ChatMessage, LlmConfig};
use crate::tools::internal_tools::workspace_ops::{
    parse_structured_memory, serialize_structured_memory, StructuredMemory,
};

/// A fact extracted from conversation
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExtractedFact {
    pub section: String,
    pub content: String,
    #[serde(default)]
    pub replaces: Option<String>,
}

/// System prompt for the extraction LLM call
fn extraction_system_prompt() -> String {
    r#"You are a memory extraction agent. Given a conversation between a user and an AI assistant, extract ONLY genuinely important facts that should be remembered across future conversations.

## What to Extract
- User preferences (language, style, methodology, tools they use)
- Workflow habits (daily routines, how they organize notes)
- Important decisions (methodology changes, model choices, feature toggles)
- Vault/project context (vault structure, key folders, naming conventions)
- Research topics (subjects, projects, or areas the user is currently working on or interested in)

## What NOT to Extract
- Conversation-specific details (what notes were searched, specific edits made)
- Trivial information (greetings, acknowledgements)
- Information already present in existing memory (avoid duplicates)
- Technical debugging details

## Output Format
Return a JSON array of objects. Each object has:
- "section": one of "preferences", "habits", "decisions", "vault", "research"
- "content": the fact to remember (concise, single line)
- "replaces": (optional) if this fact contradicts/supersedes an existing memory item, include the old item text here

If there is NOTHING worth extracting, return an empty array: []

IMPORTANT: Be very selective. Most conversations produce 0-2 facts worth remembering. Quality over quantity."#.to_string()
}

/// Build the user message for extraction
fn extraction_user_message(messages: &[ChatMessage], existing_memory: &str) -> String {
    // Only include user and assistant messages, skip tool calls/results
    let conversation: String = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .filter(|m| m.tool_calls.is_none() && m.tool_call_id.is_none())
        .map(|m| format!("[{}]: {}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n");

    // Truncate very long conversations to last ~3000 chars
    let conversation = if conversation.len() > 3000 {
        let start = conversation.len() - 3000;
        format!("...(truncated)\n{}", &conversation[start..])
    } else {
        conversation
    };

    format!(
        "## Existing Memory\n{}\n\n## Conversation to Analyze\n{}",
        if existing_memory.is_empty() { "(empty)" } else { existing_memory },
        conversation
    )
}

/// Extract memories from a conversation and merge into core memory.
/// Returns the number of new facts merged.
pub async fn extract_and_merge(
    config: &LlmConfig,
    messages: &[ChatMessage],
    vault_path: &str,
) -> anyhow::Result<usize> {
    // Skip if conversation is too short (< 4 messages)
    let meaningful_messages: Vec<_> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .filter(|m| m.tool_calls.is_none() && m.tool_call_id.is_none())
        .collect();

    if meaningful_messages.len() < 4 {
        return Ok(0);
    }

    // Load existing core memory
    let memory_path = std::path::PathBuf::from(vault_path)
        .join(".zettelagent")
        .join("memory.md");

    let existing_raw = if memory_path.exists() {
        std::fs::read_to_string(&memory_path).unwrap_or_default()
    } else {
        String::new()
    };

    let existing_memory_str = if existing_raw.trim().is_empty() {
        String::new()
    } else {
        let mem = parse_structured_memory(&existing_raw);
        let mut out = String::new();
        for (section, items) in &mem.sections {
            if !items.is_empty() {
                out.push_str(&format!("### {}\n", section));
                for item in items {
                    out.push_str(&format!("- {}\n", item));
                }
            }
        }
        out
    };

    // Build extraction messages
    let extraction_messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: extraction_system_prompt(),
            ..Default::default()
        },
        ChatMessage {
            role: "user".to_string(),
            content: extraction_user_message(messages, &existing_memory_str),
            ..Default::default()
        },
    ];

    // Use a lighter config (lower temperature, lower max_tokens)
    let mut extract_config = config.clone();
    extract_config.temperature = 0.1;
    extract_config.max_tokens = Some(500);

    // Call LLM
    let response = crate::llm::chat_completion(&extract_config, &extraction_messages).await?;

    // Parse JSON response
    let facts = parse_extraction_response(&response)?;

    if facts.is_empty() {
        return Ok(0);
    }

    // Merge facts into core memory
    let mut mem = if memory_path.exists() {
        let raw = std::fs::read_to_string(&memory_path)?;
        parse_structured_memory(&raw)
    } else {
        StructuredMemory::default()
    };

    let mut merged_count = 0;

    for fact in &facts {
        let section_name = resolve_section_name(&fact.section);

        // Ensure section exists
        if !mem.sections.iter().any(|(name, _)| name == &section_name) {
            mem.sections.push((section_name.clone(), Vec::new()));
        }

        let items = &mut mem.sections.iter_mut()
            .find(|(name, _)| name == &section_name)
            .unwrap()
            .1;

        // Handle replacement
        if let Some(ref replaces) = fact.replaces {
            let lower_replaces = replaces.to_lowercase();
            items.retain(|item| !item.to_lowercase().contains(&lower_replaces));
        }

        // Add if not duplicate
        let lower_content = fact.content.to_lowercase();
        if !items.iter().any(|existing| existing.to_lowercase() == lower_content) {
            items.push(fact.content.clone());
            merged_count += 1;
        }
    }

    if merged_count > 0 {
        mem.last_updated = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

        let zettelagent_dir = std::path::PathBuf::from(vault_path).join(".zettelagent");
        std::fs::create_dir_all(&zettelagent_dir)?;
        std::fs::write(&memory_path, serialize_structured_memory(&mem))?;
    }

    Ok(merged_count)
}

/// Parse the LLM extraction response into structured facts
fn parse_extraction_response(response: &str) -> anyhow::Result<Vec<ExtractedFact>> {
    let trimmed = response.trim();

    // Try to extract JSON array from response (may have markdown code fences)
    let json_str = if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            &trimmed[start..=end]
        } else {
            return Ok(Vec::new());
        }
    } else {
        return Ok(Vec::new());
    };

    let facts: Vec<ExtractedFact> = serde_json::from_str(json_str)
        .unwrap_or_default();

    Ok(facts)
}

/// Map section aliases to canonical names (mirrors workspace_ops logic)
fn resolve_section_name(section: &str) -> String {
    match section.to_lowercase().as_str() {
        "preferences" | "prefs" | "user preferences" => "User Preferences".to_string(),
        "habits" | "workflow" | "workflow habits" => "Workflow Habits".to_string(),
        "decisions" | "important decisions" => "Important Decisions".to_string(),
        "vault" | "vault context" | "context" => "Vault Context".to_string(),
        "research" | "research topics" | "topics" => "Research Topics".to_string(),
        other => {
            let mut c = other.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        }
    }
}

// ── Enhanced Memory Extraction ─────────────────────────────────────

/// Check if a message is meaningful for memory extraction
pub fn is_meaningful_message(message: &ChatMessage) -> bool {
    // Skip tool calls and results
    if message.tool_calls.is_some() || message.tool_call_id.is_some() {
        return false;
    }
    
    let content = message.content.trim();
    
    // Skip empty or very short messages
    if content.len() < 20 {
        return false;
    }
    
    // Skip pure greetings
    let greetings = [
        "你好", "hello", "hi", "hey", "好的", "ok", "okay",
        "谢谢", "thanks", "thank you", "不客气", "you're welcome",
    ];
    let content_lower = content.to_lowercase();
    if greetings.iter().any(|g| content_lower.starts_with(g)) && content.len() < 30 {
        return false;
    }
    
    // Skip pure tool result acknowledgments
    if content.starts_with("✓") || content.starts_with("✅") || content.starts_with("[") {
        return false;
    }
    
    true
}

/// Calculate importance score for a message (0-10)
pub fn message_importance(message: &ChatMessage) -> u8 {
    let content = &message.content;
    let mut score: u8 = 5; // Base score
    
    // User messages with preferences get higher score
    if message.role == "user" {
        let preference_keywords = [
            "prefer", "like", "want", "always", "never", "usually",
            "偏好", "喜欢", "想要", "总是", "从不", "通常",
        ];
        if preference_keywords.iter().any(|k| content.to_lowercase().contains(k)) {
            score += 2;
        }
        
        // Explicit memory triggers
        let memory_triggers = [
            "remember", "记住", "以后", "from now on", "always do",
            "save this", "note that", "请注意",
        ];
        if memory_triggers.iter().any(|k| content.to_lowercase().contains(k)) {
            score += 3;
        }
    }
    
    // Assistant conclusions get higher score
    if message.role == "assistant" {
        let conclusion_keywords = [
            "therefore", "结论", "总结", "in summary", "to summarize",
            "decision", "decided", "决定",
        ];
        if conclusion_keywords.iter().any(|k| content.to_lowercase().contains(k)) {
            score += 1;
        }
    }
    
    score.min(10)
}

/// Enhanced memory extraction with better filtering and conflict detection
pub async fn extract_and_merge_enhanced(
    config: &LlmConfig,
    messages: &[ChatMessage],
    vault_path: &str,
) -> anyhow::Result<usize> {
    // Filter meaningful messages
    let meaningful_messages: Vec<&ChatMessage> = messages
        .iter()
        .filter(|m| is_meaningful_message(m))
        .collect();
    
    if meaningful_messages.len() < 4 {
        return Ok(0);
    }
    
    // Calculate average importance
    let avg_importance: f64 = meaningful_messages
        .iter()
        .map(|m| message_importance(m) as f64)
        .sum::<f64>() / meaningful_messages.len() as f64;
    
    // Skip if average importance is too low (most messages are trivial)
    if avg_importance < 4.0 {
        return Ok(0);
    }
    
    // Use the original extraction logic with filtered messages
    extract_and_merge(config, &meaningful_messages.into_iter().cloned().collect::<Vec<_>>(), vault_path).await
}

/// Detect and resolve memory conflicts
pub fn detect_memory_conflicts(existing: &str, new_facts: &[ExtractedFact]) -> Vec<(String, String)> {
    let mut conflicts: Vec<(String, String)> = Vec::new();
    
    let existing_lower = existing.to_lowercase();
    
    for fact in new_facts {
        let fact_lower = fact.content.to_lowercase();
        
        // Check for contradictions (simplified heuristic)
        let contradiction_pairs = [
            ("always", "never"),
            ("prefer", "don't prefer"),
            ("喜欢", "不喜欢"),
        ];
        
        for (pos, neg) in &contradiction_pairs {
            if fact_lower.contains(pos) {
                // Check if existing has the negative form
                if existing_lower.contains(neg) {
                    // Potential conflict
                    conflicts.push((fact.content.clone(), format!("Contradicts existing: {}", neg)));
                }
            }
        }
    }
    
    conflicts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_meaningful_message() {
        let meaningful = ChatMessage {
            role: "user".to_string(),
            content: "I prefer using Zettelkasten methodology for my notes".to_string(),
            ..Default::default()
        };
        assert!(is_meaningful_message(&meaningful));
        
        let trivial = ChatMessage {
            role: "user".to_string(),
            content: "你好".to_string(),
            ..Default::default()
        };
        assert!(!is_meaningful_message(&trivial));
    }

    #[test]
    fn test_message_importance() {
        let preference_msg = ChatMessage {
            role: "user".to_string(),
            content: "I prefer to write notes in Chinese and always tag them".to_string(),
            ..Default::default()
        };
        let score = message_importance(&preference_msg);
        assert!(score >= 7);
    }

    #[test]
    fn test_resolve_section_name() {
        assert_eq!(resolve_section_name("preferences"), "User Preferences");
        assert_eq!(resolve_section_name("habits"), "Workflow Habits");
        assert_eq!(resolve_section_name("unknown"), "Unknown");
    }
}
