//! Unified intent taxonomy for the Hybrid Intent Recognition architecture.
//!
//! Three-layer classification pipeline:
//! - L0: Rule-based fast path (0ms, high confidence)
//! - L1: Structured keyword scoring (<1ms, medium confidence)
//! - L2: LLM classifier (~200-800ms, only when L0/L1 uncertain)

use serde::{Deserialize, Serialize};

/// Unified intent categories shared across all layers.
/// Replaces the fragmented `AgentIntent`, `TaskKind`, and `is_greeting_or_chitchat` classifiers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TurnIntent {
    /// Greetings, thanks, small-talk — no tools needed
    Chitchat,
    /// Vault statistics queries ("多少篇笔记", "库有多大")
    VaultStats,
    /// Search/find queries
    Search,
    /// Analysis, comparison, graph exploration
    Analyze,
    /// Create/edit notes
    Write,
    /// Organize, merge, clean, delete
    Curate,
    /// Health checks, blind-spot scans
    Diagnose,
    /// Multiple sequential intents
    Composite(Vec<TurnIntent>),
    /// Could not classify — fall back to full agent
    Unknown,
}

/// Which classification layer produced this result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationLayer {
    /// L0: Exact rule match (zero cost, <1ms)
    L0,
    /// L1: Structured keyword scoring (<1ms)
    L1,
    /// L2: LLM classification (~200-800ms)
    L2,
}

/// Result of intent classification with metadata for downstream decisions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentClassification {
    pub intent: TurnIntent,
    pub confidence: f32,
    pub layer: ClassificationLayer,
    /// Extracted entities (e.g., {"metric": "note_count"})
    #[serde(default)]
    pub entities: serde_json::Value,
    /// Optional reasoning for debugging
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

impl IntentClassification {
    /// High confidence — safe to use for execution decisions.
    pub fn is_confident(&self) -> bool {
        self.confidence >= 0.7
    }

    /// Low confidence — trigger LLM fallback (L2).
    pub fn needs_llm_fallback(&self) -> bool {
        self.confidence < 0.5 || matches!(self.intent, TurnIntent::Unknown)
    }

    /// Create a new classification with the given parameters.
    pub fn new(
        intent: TurnIntent,
        confidence: f32,
        layer: ClassificationLayer,
    ) -> Self {
        Self {
            intent,
            confidence,
            layer,
            entities: serde_json::json!({}),
            reasoning: None,
        }
    }

    /// Add entities to the classification.
    pub fn with_entities(mut self, entities: serde_json::Value) -> Self {
        self.entities = entities;
        self
    }

    /// Add reasoning for debugging.
    pub fn with_reasoning(mut self, reasoning: impl Into<String>) -> Self {
        self.reasoning = Some(reasoning.into());
        self
    }
}

impl TurnIntent {
    /// Convert to a human-readable label (localized).
    pub fn label(&self, zh: bool) -> &'static str {
        match (self, zh) {
            (TurnIntent::Chitchat, true) => "寒暄",
            (TurnIntent::Chitchat, false) => "Chitchat",
            (TurnIntent::VaultStats, true) => "统计查询",
            (TurnIntent::VaultStats, false) => "Vault Stats",
            (TurnIntent::Search, true) => "搜索",
            (TurnIntent::Search, false) => "Search",
            (TurnIntent::Analyze, true) => "分析",
            (TurnIntent::Analyze, false) => "Analysis",
            (TurnIntent::Write, true) => "创建/编辑",
            (TurnIntent::Write, false) => "Write",
            (TurnIntent::Curate, true) => "整理",
            (TurnIntent::Curate, false) => "Curate",
            (TurnIntent::Diagnose, true) => "诊断",
            (TurnIntent::Diagnose, false) => "Diagnose",
            (TurnIntent::Composite(_), true) => "复合任务",
            (TurnIntent::Composite(_), false) => "Composite",
            (TurnIntent::Unknown, true) => "未知",
            (TurnIntent::Unknown, false) => "Unknown",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_confidence_checks() {
        let high = IntentClassification::new(
            TurnIntent::Chitchat,
            0.95,
            ClassificationLayer::L0,
        );
        assert!(high.is_confident());
        assert!(!high.needs_llm_fallback());

        let low = IntentClassification::new(
            TurnIntent::Unknown,
            0.3,
            ClassificationLayer::L1,
        );
        assert!(!low.is_confident());
        assert!(low.needs_llm_fallback());
    }

    #[test]
    fn turn_intent_serializes_to_snake_case() {
        let intent = TurnIntent::VaultStats;
        let json = serde_json::to_string(&intent).unwrap();
        assert_eq!(json, r#""vault_stats""#);

        let deserialized: TurnIntent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, TurnIntent::VaultStats);
    }

    #[test]
    fn composite_intent_serializes() {
        let composite = TurnIntent::Composite(vec![
            TurnIntent::Search,
            TurnIntent::Write,
        ]);
        let json = serde_json::to_value(&composite).unwrap();
        // Composite variant serializes as {"composite": [...]}
        assert_eq!(
            json,
            serde_json::json!({"composite": ["search", "write"]})
        );
    }

    #[test]
    fn labels_localized() {
        assert_eq!(TurnIntent::VaultStats.label(true), "统计查询");
        assert_eq!(TurnIntent::VaultStats.label(false), "Vault Stats");
    }
}
