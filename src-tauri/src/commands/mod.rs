use serde::{Deserialize, Serialize};
use crate::llm::ChatMessage;

pub mod file_commands;
pub mod search_commands;
pub mod chat_commands;
pub mod chat_history_commands;
pub mod graph_commands;
pub mod scheduler_commands;
pub mod lint_commands;
pub mod timeline_commands;
pub mod attachment_commands;
pub mod bases_commands;
pub mod reconcile_commands;
pub use file_commands::*;
pub use search_commands::*;
pub use chat_commands::*;
pub use chat_history_commands::*;
pub use graph_commands::*;
pub use scheduler_commands::*;
pub use lint_commands::*;
pub use timeline_commands::*;
pub use attachment_commands::*;
pub use bases_commands::*;
pub use reconcile_commands::*;

// ── Shared API Request/Response Types ─────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DirTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<DirTreeNode>,
    pub file_count: usize,
}

#[derive(Serialize)]
pub struct SyncResult {
    pub files_updated: usize,
    pub files_removed: usize,
    pub total_files: usize,
}

#[derive(Serialize)]
pub struct ChunkResult {
    pub chunks: Vec<ChunkInfo>,
    pub total: usize,
}

#[derive(Serialize)]
pub struct ChunkInfo {
    pub content: String,
    pub heading_hierarchy: String,
    pub marker_type: String,
    pub chunk_index: usize,
}

#[derive(Serialize)]
#[allow(dead_code)]
pub struct VaultConfig {
    pub path: String,
    pub methodology: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    pub limit: Option<usize>,
    pub mode: Option<String>,
    pub query_embedding: Option<Vec<f32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub api_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub provider_id: Option<String>,
    /// Selected model's context window (tokens) — from the provider preset.
    /// When set, overrides the backend heuristic context budget.
    #[allow(dead_code)]
    pub context_window: Option<u32>,
    /// User-controlled native reasoning switch (from Settings).
    #[serde(default)]
    pub supports_thinking: Option<bool>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagChatRequest {
    pub query: String,
    pub api_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub provider_id: Option<String>,
    pub search_limit: Option<usize>,
    pub search_mode: Option<String>,
    pub chat_history: Option<Vec<ChatMessage>>,
    pub query_embedding: Option<Vec<f32>>,
    pub methodology: Option<String>,
    pub current_file: Option<String>,
    pub attached_context: Option<String>,
    /// R-6: File paths to exclude from search (already returned in previous turns)
    pub exclude_paths: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardMetadataRequest {
    pub note_content: String,
    pub api_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub provider_id: Option<String>,
    pub methodology: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSchedulerRequest {
    pub interval_secs: Option<u64>,
    pub batch_size: Option<usize>,
    pub max_api_calls: Option<usize>,
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub methodology: Option<String>,
    pub search_result_count: Option<usize>,
    pub content_truncation_limit: Option<usize>,
    pub include_journals: Option<bool>,
    pub daily_note_path: Option<String>,
    pub vault_paths: Option<Vec<String>>,
    pub min_note_length: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSchedulerNowRequest {
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub methodology: Option<String>,
    pub path_prefix: Option<String>,
    pub batch_size: Option<usize>,
    pub search_result_count: Option<usize>,
    pub content_truncation_limit: Option<usize>,
    /// Whether to include journal/diary notes in organizing (default: true)
    pub include_journals: Option<bool>,
    /// Absolute path to daily notes folder
    pub daily_note_path: Option<String>,
    /// Force full reconciliation even if file hash is unchanged
    pub force: Option<bool>,
    pub min_note_length: Option<usize>,
}

// EmbeddingStats remains used for progress UI
#[derive(Serialize)]
pub struct EmbeddingStats {
    pub total_chunks: usize,
    pub indexed_chunks: usize,
    pub has_index: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRequest {
    pub messages: Vec<ChatMessage>,
    pub api_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub provider_id: Option<String>,
    pub vault_path: Option<String>,
    /// All mounted workspace root directories (multi-vault support)
    pub vault_paths: Option<Vec<String>>,
    /// Knowledge management methodology (zettelkasten, para, gtd, etc.)
    pub methodology: Option<String>,
    /// Whether web search mode is enabled
    pub web_search: Option<bool>,
    /// Currently open file path hint
    pub current_file: Option<String>,
    /// Attached note context (pre-resolved content)
    pub attached_context: Option<String>,
    /// Selected model's context window (tokens) — from the provider preset.
    /// When set, overrides the backend heuristic context budget.
    #[allow(dead_code)]
    pub context_window: Option<u32>,
    /// User-controlled native reasoning switch (from Settings). No model whitelist.
    #[serde(default)]
    pub supports_thinking: Option<bool>,
}
