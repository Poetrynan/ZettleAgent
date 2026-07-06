//! Agent Router — classifies user intent and routes to appropriate execution path.
//!
//! Now uses the unified TurnIntent taxonomy via the three-layer hybrid classifier:
//! - L0: Rule-based fast path (0ms, zero cost)
//! - L1: Structured keyword scoring (<1ms)
//! - L2: LLM classifier (only when L0/L1 uncertain)

use crate::agents::intent::IntentClassification;
use crate::agents::intent_classifier;
use crate::llm::{ChatMessage, LlmConfig};

/// Legacy AgentIntent enum — kept for backward compatibility with orchestrator.
/// New code should use `TurnIntent` from `intent.rs`.
#[derive(Debug, Clone)]
pub enum AgentIntent {
    /// Search, read, analyze, graph exploration
    Knowledge,
    /// Create, edit, write notes
    Create,
    /// Organize, clean, merge, rename, delete
    Curate,
    /// Composite: sequential pipeline of multiple intents
    Composite(Vec<AgentIntent>),
}

pub struct AgentRouter;

impl AgentRouter {
    /// Unified entry: uses the new Three-layer hybrid classifier.
    /// Returns detailed IntentClassification for downstream execution decisions.
    pub async fn classify(
        config: &LlmConfig,
        query: &str,
        chat_history: Option<&[ChatMessage]>,
    ) -> IntentClassification {
        intent_classifier::classify(config, query, chat_history).await
    }

    /// Legacy entry point: returns AgentIntent for backward compatibility.
    /// Prefer [`Self::to_agent_intent`] when you already have a classification result.
    pub async fn classify_legacy(config: &LlmConfig, query: &str) -> AgentIntent {
        let classification = Self::classify(config, query, None).await;
        Self::to_agent_intent(&classification)
    }

    /// Map an existing classification to legacy AgentIntent (no extra LLM call).
    pub fn to_agent_intent(classification: &IntentClassification) -> AgentIntent {
        Self::turn_intent_to_agent_intent(&classification.intent)
    }

    /// Convert TurnIntent to legacy AgentIntent for backward compatibility.
    fn turn_intent_to_agent_intent(intent: &crate::agents::intent::TurnIntent) -> AgentIntent {
        use crate::agents::intent::TurnIntent::*;

        match intent {
            Chitchat | VaultStats | Search | Analyze => AgentIntent::Knowledge,
            Write => AgentIntent::Create,
            Curate | Diagnose => AgentIntent::Curate,
            Composite(intents) => {
                let legacy_intents: Vec<AgentIntent> = intents
                    .iter()
                    .map(Self::turn_intent_to_agent_intent)
                    .collect();
                AgentIntent::Composite(legacy_intents)
            }
            Unknown => AgentIntent::Knowledge, // Default fallback
        }
    }

    /// Get a human-readable name for legacy AgentIntent (for logging).
    pub fn intent_name(intent: &AgentIntent) -> &'static str {
        match intent {
            AgentIntent::Knowledge => "Knowledge",
            AgentIntent::Create => "Create",
            AgentIntent::Curate => "Curate",
            AgentIntent::Composite(_) => "Composite",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::intent::TurnIntent;

    #[test]
    fn turn_intent_to_agent_intent_mapping() {
        assert!(matches!(
            AgentRouter::turn_intent_to_agent_intent(&TurnIntent::Chitchat),
            AgentIntent::Knowledge
        ));
        assert!(matches!(
            AgentRouter::turn_intent_to_agent_intent(&TurnIntent::Write),
            AgentIntent::Create
        ));
        assert!(matches!(
            AgentRouter::turn_intent_to_agent_intent(&TurnIntent::Curate),
            AgentIntent::Curate
        ));
        assert!(matches!(
            AgentRouter::turn_intent_to_agent_intent(&TurnIntent::Unknown),
            AgentIntent::Knowledge
        ));
    }
}
