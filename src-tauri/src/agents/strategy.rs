//! Execution strategy mapping: TurnIntent → tool subset + plan config.
//!
//! This is Layer 3 (L3) of the hybrid intent recognition architecture.
//! It translates classified intents into concrete execution parameters
//! that the orchestrator can use to narrow the agent's search space.

use crate::agents::intent::TurnIntent;
use crate::llm::ToolDef;

/// How deep the agent should plan before executing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanDepth {
    /// No planning needed — direct answer (chitchat, simple stats)
    None,
    /// Single-step execution (get_vault_stats → answer)
    Single,
    /// Short plan (1-3 steps, e.g., search → read → answer)
    Short,
    /// Full planning with multi-step reasoning
    Full,
}

/// Whether a dedicated synthesis pass is required after tool execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynthesisPolicy {
    /// Never run synthesis
    Never,
    /// Run synthesis only if multiple tools were called
    Conditional,
    /// Always run synthesis (for analysis/diagnose)
    Mandatory,
}

/// Complete execution strategy derived from intent classification.
#[derive(Debug, Clone)]
pub struct ExecutionStrategy {
    /// Which tools the agent is allowed to call (empty = all tools)
    pub allowed_tools: Vec<String>,
    /// How deep to plan
    pub plan_depth: PlanDepth,
    /// Whether to run synthesis
    pub synthesis: SynthesisPolicy,
    /// Whether this intent can be fast-pathed (skip full agent loop)
    pub fast_path: bool,
}

impl ExecutionStrategy {
    /// Derive execution strategy from classified intent.
    pub fn from_intent(intent: &TurnIntent) -> Self {
        match intent {
            TurnIntent::Chitchat => Self {
                allowed_tools: vec![], // No tools for chitchat
                plan_depth: PlanDepth::None,
                synthesis: SynthesisPolicy::Never,
                fast_path: true,
            },

            TurnIntent::VaultStats => Self {
                allowed_tools: vec!["get_vault_stats".to_string()],
                plan_depth: PlanDepth::Single,
                synthesis: SynthesisPolicy::Never,
                fast_path: true,
            },

            TurnIntent::Search => Self {
                allowed_tools: vec![
                    "search_notes".to_string(),
                    "list_notes".to_string(),
                    "read_note".to_string(),
                    "find_similar_notes".to_string(),
                    "search_by_tag".to_string(),
                    "get_note_tags".to_string(),
                ],
                plan_depth: PlanDepth::Short,
                synthesis: SynthesisPolicy::Conditional,
                fast_path: false,
            },

            TurnIntent::Analyze => Self {
                allowed_tools: vec![
                    "search_notes".to_string(),
                    "list_notes".to_string(),
                    "read_note".to_string(),
                    "get_graph".to_string(),
                    "get_local_graph".to_string(),
                    "get_backlinks".to_string(),
                    "find_shortest_path".to_string(),
                    "query_relations".to_string(),
                    "compare_notes".to_string(),
                ],
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Mandatory,
                fast_path: false,
            },

            TurnIntent::Write => Self {
                allowed_tools: vec![
                    "create_note".to_string(),
                    "edit_note".to_string(),
                    "patch_note".to_string(),
                    "append_to_note".to_string(),
                    "search_notes".to_string(),
                    "read_note".to_string(),
                    "get_note_tags".to_string(),
                ],
                plan_depth: PlanDepth::Short,
                synthesis: SynthesisPolicy::Never,
                fast_path: false,
            },

            TurnIntent::Curate => Self {
                allowed_tools: vec![
                    "search_notes".to_string(),
                    "list_notes".to_string(),
                    "read_note".to_string(),
                    "rename_note".to_string(),
                    "move_note".to_string(),
                    "merge_notes".to_string(),
                    "delete_note".to_string(),
                    "edit_note".to_string(),
                    "append_to_note".to_string(),
                    "create_folder".to_string(),
                    "get_backlinks".to_string(),
                    "fix_broken_link".to_string(),
                ],
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Conditional,
                fast_path: false,
            },

            TurnIntent::Diagnose => Self {
                allowed_tools: vec![
                    "run_lint".to_string(),
                    "get_vault_stats".to_string(),
                    "get_graph".to_string(),
                    "get_backlinks".to_string(),
                    "query_relations".to_string(),
                    "get_note_metadata".to_string(),
                    "list_notes".to_string(),
                ],
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Mandatory,
                fast_path: false,
            },

            TurnIntent::Composite(sub_intents) => {
                // Merge strategies from all sub-intents
                let mut merged = Self {
                    allowed_tools: vec![],
                    plan_depth: PlanDepth::Full,
                    synthesis: SynthesisPolicy::Mandatory,
                    fast_path: false,
                };
                for sub in sub_intents {
                    let sub_strategy = Self::from_intent(sub);
                    // Union of all allowed tools
                    for tool in &sub_strategy.allowed_tools {
                        if !merged.allowed_tools.contains(tool) {
                            merged.allowed_tools.push(tool.clone());
                        }
                    }
                }
                merged
            }

            TurnIntent::Unknown => Self {
                // Unknown intent — give full access (safe fallback)
                allowed_tools: vec![], // empty = all tools allowed
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Conditional,
                fast_path: false,
            },
        }
    }

    /// Check if a specific tool is allowed under this strategy.
    pub fn allows_tool(&self, tool_name: &str) -> bool {
        // Empty allowed_tools means all tools are allowed (fallback)
        if self.allowed_tools.is_empty() {
            return true;
        }
        self.allowed_tools.iter().any(|t| t == tool_name)
    }

    /// Filter a list of tool names, keeping only allowed ones.
    pub fn filter_tools(&self, tools: &[String]) -> Vec<String> {
        if self.allowed_tools.is_empty() {
            return tools.to_vec(); // All allowed
        }
        tools
            .iter()
            .filter(|t| self.allows_tool(t))
            .cloned()
            .collect()
    }

    /// Filter tool definitions for the orchestrator based on allowed tool names.
    pub fn filter_tool_defs(&self, all_tools: &[ToolDef]) -> Vec<ToolDef> {
        if self.allowed_tools.is_empty() {
            return all_tools.to_vec();
        }
        all_tools
            .iter()
            .filter(|t| self.allows_tool(&t.function.name))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chitchat_has_no_tools() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Chitchat);
        assert!(strategy.allowed_tools.is_empty());
        assert!(strategy.fast_path);
        assert_eq!(strategy.synthesis, SynthesisPolicy::Never);
    }

    #[test]
    fn vault_stats_only_allows_stats_tool() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::VaultStats);
        assert_eq!(strategy.allowed_tools, vec!["get_vault_stats"]);
        assert!(strategy.fast_path);
        assert!(strategy.allows_tool("get_vault_stats"));
        assert!(!strategy.allows_tool("search_notes"));
    }

    #[test]
    fn search_has_read_tools_only() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Search);
        assert!(strategy.allows_tool("search_notes"));
        assert!(strategy.allows_tool("read_note"));
        assert!(!strategy.allows_tool("create_note"));
        assert!(!strategy.allows_tool("delete_note"));
    }

    #[test]
    fn analyze_requires_synthesis() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Analyze);
        assert_eq!(strategy.synthesis, SynthesisPolicy::Mandatory);
        assert_eq!(strategy.plan_depth, PlanDepth::Full);
    }

    #[test]
    fn curate_has_write_tools() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Curate);
        assert!(strategy.allows_tool("delete_note"));
        assert!(strategy.allows_tool("merge_notes"));
        assert!(strategy.allows_tool("rename_note"));
        assert!(!strategy.allows_tool("create_note")); // Curate doesn't create
    }

    #[test]
    fn diagnose_has_scan_tools() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Diagnose);
        assert!(strategy.allows_tool("run_lint"));
        assert!(strategy.allows_tool("get_vault_stats"));
        assert_eq!(strategy.synthesis, SynthesisPolicy::Mandatory);
    }

    #[test]
    fn unknown_allows_all_tools() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Unknown);
        assert!(strategy.allows_tool("any_tool"));
        assert!(strategy.allows_tool("another_tool"));
    }

    #[test]
    fn composite_merges_tools() {
        let composite = TurnIntent::Composite(vec![
            TurnIntent::Search,
            TurnIntent::Write,
        ]);
        let strategy = ExecutionStrategy::from_intent(&composite);
        // Should have tools from both Search and Write
        assert!(strategy.allows_tool("search_notes")); // from Search
        assert!(strategy.allows_tool("create_note")); // from Write
        assert_eq!(strategy.synthesis, SynthesisPolicy::Mandatory);
    }

    #[test]
    fn filter_tools_works() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::VaultStats);
        let all_tools = vec![
            "get_vault_stats".to_string(),
            "search_notes".to_string(),
            "create_note".to_string(),
        ];
        let filtered = strategy.filter_tools(&all_tools);
        assert_eq!(filtered, vec!["get_vault_stats"]);
    }
}
