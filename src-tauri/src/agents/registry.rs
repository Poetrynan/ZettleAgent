use std::collections::HashMap;
use crate::llm::{self, LlmConfig};
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
                exec_config: AgentExecutionConfig {
                    max_iterations: 50,
                    max_total_tool_calls: 200,
                },
            },
        );

        // Unified Agent — default. Has access to ALL tools (empty allowed_tools
        // is treated as "all allowed" by filter_tools). Used for every non-
        // composite query; the role-specific agents only run as pipeline steps
        // when the router detects a Composite intent.
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
                allowed_tools: Vec::new(),
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
