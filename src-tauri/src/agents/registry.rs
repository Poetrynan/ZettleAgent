use std::collections::HashMap;
use crate::llm::{self, LlmConfig};
use crate::tools::CORE_TOOLS;
use super::instance::{AgentInstance, AgentExecutionConfig};
use super::{KNOWLEDGE_TOOLS, CREATOR_TOOLS, CURATOR_TOOLS};

/// Agent registry: manages all available agent instances.
pub struct AgentRegistry {
    agents: HashMap<String, AgentInstance>,
    default_id: String,
}

impl AgentRegistry {
    /// Build registry with 3 preset agents using shared LlmConfig.
    /// In Phase C, each agent can have its own model/API.
    pub fn new_with_defaults(
        base_config: &LlmConfig,
        memories_context: &str,
        skills_context: &str,
        methodology: &str,
        current_time: &str,
        vault_info: &str,
    ) -> Self {
        let mut agents = HashMap::new();

        // 🔬 Knowledge Agent
        agents.insert(
            "knowledge".to_string(),
            AgentInstance {
                id: "knowledge".to_string(),
                display_name: "Knowledge Agent".to_string(),
                icon: "🔬".to_string(),
                config: base_config.clone(),
                system_prompt: llm::prompts::knowledge_agent_prompt(
                    memories_context, skills_context, methodology, current_time, vault_info,
                ),
                allowed_tools: KNOWLEDGE_TOOLS.iter().map(|s| s.to_string()).collect(),
                allow_extension_tools: false,
                exec_config: AgentExecutionConfig {
                    max_iterations: 50,
                    max_total_tool_calls: 200,
                },
            },
        );

        // ✍️ Creator Agent
        agents.insert(
            "creator".to_string(),
            AgentInstance {
                id: "creator".to_string(),
                display_name: "Creator Agent".to_string(),
                icon: "✍️".to_string(),
                config: base_config.clone(),
                system_prompt: llm::prompts::creator_agent_prompt(
                    memories_context, skills_context, methodology, current_time, vault_info,
                ),
                allowed_tools: CREATOR_TOOLS.iter().map(|s| s.to_string()).collect(),
                allow_extension_tools: false,
                exec_config: AgentExecutionConfig {
                    max_iterations: 50,
                    max_total_tool_calls: 200,
                },
            },
        );

        // 📦 Curator Agent
        agents.insert(
            "curator".to_string(),
            AgentInstance {
                id: "curator".to_string(),
                display_name: "Curator Agent".to_string(),
                icon: "📦".to_string(),
                config: base_config.clone(),
                system_prompt: llm::prompts::curator_agent_prompt(
                    memories_context, skills_context, methodology, current_time, vault_info,
                ),
                allowed_tools: CURATOR_TOOLS.iter().map(|s| s.to_string()).collect(),
                allow_extension_tools: false,
                exec_config: AgentExecutionConfig {
                    max_iterations: 50,
                    max_total_tool_calls: 200,
                },
            },
        );

        // Unified Agent — default. Handles every non-composite query; the
        // role-specific agents above only run as pipeline steps when the router
        // detects a Composite intent.
        //
        // It used to carry `allowed_tools: Vec::new()` ("all 62 tools"). That
        // put ~6k tokens of JSON schema in front of every single request and
        // made tool choice a 62-way decision. It now gets `CORE_TOOLS` plus,
        // via `allow_extension_tools`, whatever MCP/skill tools the user has
        // actually installed — those are runtime-registered, so no compiled
        // list can name them.
        //
        // This is a *visibility* change, not a capability change:
        // `list_available_tools` (in CORE_TOOLS) surfaces the rest by name and
        // `tools::execute_tool` dispatches on name alone, so anything the model
        // discovers is immediately callable. Approval behaviour is untouched.
        agents.insert(
            "unified".to_string(),
            AgentInstance {
                id: "unified".to_string(),
                display_name: "Agent".to_string(),
                icon: "🤖".to_string(),
                config: base_config.clone(),
                system_prompt: llm::prompts::base_agent_prompt(
                    "knowledge", memories_context, skills_context, methodology, current_time, vault_info,
                ),
                allowed_tools: CORE_TOOLS.iter().map(|s| s.to_string()).collect(),
                allow_extension_tools: true,
                exec_config: AgentExecutionConfig {
                    max_iterations: 50,
                    max_total_tool_calls: 200,
                },
            },
        );

        Self {
            agents,
            default_id: "unified".to_string(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&AgentInstance> {
        self.agents.get(id)
    }

    pub fn get_default(&self) -> &AgentInstance {
        self.agents.get(&self.default_id).unwrap()
    }

    /// Map an intent to the agent's display name.
    pub fn get_name_for_intent(&self, intent: &super::router::AgentIntent) -> String {
        let id = match intent {
            super::router::AgentIntent::Knowledge => "knowledge",
            super::router::AgentIntent::Create => "creator",
            super::router::AgentIntent::Curate => "curator",
            _ => "knowledge",
        };
        self.agents.get(id).map(|a| a.display_name.clone()).unwrap_or_else(|| id.to_string())
    }

    /// Register a custom agent (future: user-defined agents).
    #[allow(dead_code)]
    pub fn register(&mut self, agent: AgentInstance) {
        self.agents.insert(agent.id.clone(), agent);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> AgentRegistry {
        AgentRegistry::new_with_defaults(&LlmConfig::default(), "", "", "", "2026-01-01", "")
    }

    #[test]
    fn default_agent_is_narrowed_to_the_core_set() {
        let reg = registry();
        let unified = reg.get_default();
        assert_eq!(unified.id, "unified");
        // The old value here was `Vec::new()` → "all 62 tools".
        assert!(!unified.allowed_tools.is_empty(), "unified must name its tools");
        assert_eq!(unified.allowed_tools.len(), CORE_TOOLS.len());
        assert!(unified.allowed_tools.iter().all(|t| CORE_TOOLS.contains(&t.as_str())));
        // MCP / skill tools cannot be named in a compiled list, so they must ride
        // the extension bypass rather than being filtered away.
        assert!(unified.allow_extension_tools);
    }

    #[test]
    fn role_agents_keep_their_curated_lists_untouched() {
        let reg = registry();
        for (id, expected) in [
            ("knowledge", KNOWLEDGE_TOOLS),
            ("creator", CREATOR_TOOLS),
            ("curator", CURATOR_TOOLS),
        ] {
            let agent = reg.get(id).expect("preset agent missing");
            let expected: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
            assert_eq!(agent.allowed_tools, expected, "{id} tool list drifted");
            // Role agents publish an exact surface; no extension bypass for them.
            assert!(!agent.allow_extension_tools, "{id} must stay closed");
        }
        // Sizes are asserted separately so a shrink shows up as its own failure.
        assert_eq!(KNOWLEDGE_TOOLS.len(), 38);
        assert_eq!(CREATOR_TOOLS.len(), 26);
        assert_eq!(CURATOR_TOOLS.len(), 39);
    }
}
