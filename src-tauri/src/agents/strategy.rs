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

/// Which tools an intent may reach.
///
/// This used to be a bare `Vec<String>` where "empty" meant "all tools" — which
/// silently inverted `Chitchat`'s intent: it asked for *no* tools and got *every*
/// tool. The three cases are now distinct at the type level so that mistake
/// cannot be made again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolScope {
    /// No tools at all — answer from the conversation alone.
    None,
    /// Every tool the caller offers (safe fallback for unclassified turns).
    All,
    /// Only these tools.
    Only(Vec<String>),
}

impl ToolScope {
    /// The explicit tool list, or `&[]` for `None`/`All`. Callers that need to
    /// distinguish those two must match on the variant instead.
    pub fn names(&self) -> &[String] {
        match self {
            ToolScope::Only(v) => v,
            _ => &[],
        }
    }

    /// True when at least one tool is reachable.
    pub fn allows_any(&self) -> bool {
        match self {
            ToolScope::None => false,
            ToolScope::All => true,
            ToolScope::Only(v) => !v.is_empty(),
        }
    }

    fn only(tools: &[&str]) -> Self {
        ToolScope::Only(tools.iter().map(|s| s.to_string()).collect())
    }
}

/// Complete execution strategy derived from intent classification.
#[derive(Debug, Clone)]
pub struct ExecutionStrategy {
    /// Which tools the agent is allowed to call
    pub tool_scope: ToolScope,
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
                // Genuinely toolless. When a multi-turn chitchat is demoted off
                // the fast path (chat_commands.rs), this is what keeps it from
                // being handed the entire tool surface.
                tool_scope: ToolScope::None,
                plan_depth: PlanDepth::None,
                synthesis: SynthesisPolicy::Never,
                fast_path: true,
            },

            TurnIntent::VaultStats => Self {
                tool_scope: ToolScope::only(&["get_vault_stats"]),
                plan_depth: PlanDepth::Single,
                synthesis: SynthesisPolicy::Never,
                fast_path: true,
            },

            TurnIntent::Search => Self {
                tool_scope: ToolScope::only(&[
                    "search_notes",
                    "list_notes",
                    "read_note",
                    "find_similar_notes",
                    "search_by_tag",
                    "get_note_tags",
                ]),
                plan_depth: PlanDepth::Short,
                synthesis: SynthesisPolicy::Conditional,
                fast_path: false,
            },

            TurnIntent::Analyze => Self {
                tool_scope: ToolScope::only(&[
                    "search_notes",
                    "list_notes",
                    "read_note",
                    "batch_read_notes",
                    "get_graph",
                    "get_local_graph",
                    "get_backlinks",
                    "find_shortest_path",
                    "query_relations",
                    "compare_notes",
                    "read_canvas",
                    "get_note_metadata",
                    "get_note_tags",
                    "find_similar_notes",
                    "query_graph_communities",
                    "generate_community_summaries",
                    "explain_relationship",
                    "generate_structure_note",
                    "get_timeline",
                    "todo_write",
                    crate::tools::LIST_AVAILABLE_TOOLS,
                ]),
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Mandatory,
                fast_path: false,
            },

            TurnIntent::Write => Self {
                tool_scope: ToolScope::only(&[
                    "create_note",
                    "edit_note",
                    "patch_note",
                    "append_to_note",
                    "search_notes",
                    "read_note",
                    "get_note_tags",
                ]),
                plan_depth: PlanDepth::Short,
                synthesis: SynthesisPolicy::Never,
                fast_path: false,
            },

            TurnIntent::Curate => Self {
                tool_scope: ToolScope::only(&[
                    "search_notes",
                    "list_notes",
                    "read_note",
                    "rename_note",
                    "move_note",
                    "merge_notes",
                    "delete_note",
                    "edit_note",
                    "append_to_note",
                    "create_folder",
                    "get_backlinks",
                    "fix_broken_link",
                ]),
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Conditional,
                fast_path: false,
            },

            TurnIntent::Diagnose => Self {
                tool_scope: ToolScope::only(&[
                    "run_lint",
                    "get_vault_stats",
                    "get_graph",
                    "get_local_graph",
                    "get_backlinks",
                    "query_relations",
                    "get_note_metadata",
                    "list_notes",
                    "batch_read_notes",
                    "search_notes",
                    "read_note",
                    "query_graph_communities",
                    "generate_community_summaries",
                    "generate_structure_note",
                    "find_shortest_path",
                    "compare_notes",
                    "todo_write",
                    crate::tools::LIST_AVAILABLE_TOOLS,
                ]),
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Mandatory,
                fast_path: false,
            },

            TurnIntent::Composite(sub_intents) => {
                // Union of the sub-intents' scopes. `All` dominates; a composite
                // made only of toolless intents stays toolless.
                let mut union: Vec<String> = Vec::new();
                let mut saw_all = false;
                let mut saw_any_scope = false;
                for sub in sub_intents {
                    match Self::from_intent(sub).tool_scope {
                        ToolScope::All => saw_all = true,
                        ToolScope::None => {}
                        ToolScope::Only(tools) => {
                            saw_any_scope = true;
                            for tool in tools {
                                if !union.contains(&tool) {
                                    union.push(tool);
                                }
                            }
                        }
                    }
                }
                let tool_scope = if saw_all {
                    ToolScope::All
                } else if saw_any_scope {
                    ToolScope::Only(union)
                } else {
                    ToolScope::None
                };
                Self {
                    tool_scope,
                    plan_depth: PlanDepth::Full,
                    synthesis: SynthesisPolicy::Mandatory,
                    fast_path: false,
                }
            }

            TurnIntent::Unknown => Self {
                // Unclassified — full access is the safe fallback.
                tool_scope: ToolScope::All,
                plan_depth: PlanDepth::Full,
                synthesis: SynthesisPolicy::Conditional,
                fast_path: false,
            },
        }
    }

    /// True when at least one tool is reachable under this strategy.
    pub fn allows_any_tool(&self) -> bool {
        self.tool_scope.allows_any()
    }

    /// Check if a specific tool is allowed under this strategy.
    pub fn allows_tool(&self, tool_name: &str) -> bool {
        match &self.tool_scope {
            ToolScope::None => false,
            ToolScope::All => true,
            ToolScope::Only(v) => v.iter().any(|t| t == tool_name),
        }
    }

    /// Filter a list of tool names, keeping only allowed ones.
    pub fn filter_tools(&self, tools: &[String]) -> Vec<String> {
        match &self.tool_scope {
            ToolScope::None => Vec::new(),
            ToolScope::All => tools.to_vec(),
            ToolScope::Only(_) => tools.iter().filter(|t| self.allows_tool(t)).cloned().collect(),
        }
    }

    /// Filter tool definitions for the orchestrator based on allowed tool names.
    ///
    /// `All` here means *literally* every tool passed in. For the schema list that
    /// actually goes to the model, use [`Self::visible_tool_defs`] — an unclassified
    /// turn should not cost the full ~10k-token schema block.
    pub fn filter_tool_defs(&self, all_tools: &[ToolDef]) -> Vec<ToolDef> {
        match &self.tool_scope {
            ToolScope::None => Vec::new(),
            ToolScope::All => all_tools.to_vec(),
            ToolScope::Only(_) => all_tools
                .iter()
                .filter(|t| self.allows_tool(&t.function.name))
                .cloned()
                .collect(),
        }
    }

    /// The schema list to offer the model for this turn.
    ///
    /// Same as [`Self::filter_tool_defs`] except that `ToolScope::All` resolves to
    /// the **default surface** — `tools::CORE_TOOLS` plus runtime extension tools
    /// (MCP / skill), rather than all ~63 definitions. Capability is not removed:
    /// `list_available_tools` is in `CORE_TOOLS`, and `tools::execute_tool`
    /// dispatches purely by name, so anything the model discovers it can still call.
    ///
    /// Without this, the `CORE_TOOLS` convergence would only apply to the
    /// `AgentInstance` path and miss the main chat path entirely, which routes
    /// through here (`commands/chat_commands.rs`).
    pub fn visible_tool_defs(&self, all_tools: &[ToolDef]) -> Vec<ToolDef> {
        match &self.tool_scope {
            ToolScope::All => all_tools
                .iter()
                .filter(|t| {
                    let name = t.function.name.as_str();
                    crate::tools::CORE_TOOLS.contains(&name) || crate::tools::is_extension_tool(name)
                })
                .cloned()
                .collect(),
            _ => self.filter_tool_defs(all_tools),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chitchat_has_no_tools() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Chitchat);
        assert_eq!(strategy.tool_scope, ToolScope::None);
        // The whole point of the fix: toolless must NOT read as "all tools".
        assert!(!strategy.allows_any_tool());
        assert!(!strategy.allows_tool("read_note"));
        assert!(!strategy.allows_tool("delete_note"));
        assert!(strategy.filter_tool_defs(&[]).is_empty());
        assert!(strategy.fast_path);
        assert_eq!(strategy.synthesis, SynthesisPolicy::Never);
    }

    #[test]
    fn vault_stats_only_allows_stats_tool() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::VaultStats);
        assert_eq!(strategy.tool_scope, ToolScope::only(&["get_vault_stats"]));
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
        assert_eq!(strategy.tool_scope, ToolScope::All);
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
        // …but not tools from an intent that was not part of the composite.
        assert!(!strategy.allows_tool("delete_note"));
        assert_eq!(strategy.synthesis, SynthesisPolicy::Mandatory);
    }

    /// A composite that mixes chitchat with a real intent must not have the
    /// toolless member widen the scope, nor narrow the other member away.
    #[test]
    fn composite_with_chitchat_keeps_the_other_intents_scope() {
        let composite = TurnIntent::Composite(vec![TurnIntent::Chitchat, TurnIntent::Search]);
        let strategy = ExecutionStrategy::from_intent(&composite);
        assert!(strategy.allows_tool("search_notes"));
        assert!(!strategy.allows_tool("delete_note"));
    }

    /// A composite of nothing but toolless intents stays toolless — under the old
    /// empty-vec convention this produced "all tools".
    #[test]
    fn composite_of_only_chitchat_stays_toolless() {
        let composite = TurnIntent::Composite(vec![TurnIntent::Chitchat, TurnIntent::Chitchat]);
        let strategy = ExecutionStrategy::from_intent(&composite);
        assert_eq!(strategy.tool_scope, ToolScope::None);
        assert!(!strategy.allows_tool("read_note"));
    }

    /// `Unknown` dominates a merge: if any part of the request is unclassified we
    /// cannot safely claim a narrower scope.
    #[test]
    fn composite_with_unknown_widens_to_all() {
        let composite = TurnIntent::Composite(vec![TurnIntent::Search, TurnIntent::Unknown]);
        let strategy = ExecutionStrategy::from_intent(&composite);
        assert_eq!(strategy.tool_scope, ToolScope::All);
        assert!(strategy.allows_tool("anything"));
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

    #[test]
    fn filter_tools_returns_nothing_for_a_toolless_scope() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Chitchat);
        let all_tools = vec!["read_note".to_string(), "delete_note".to_string()];
        assert!(strategy.filter_tools(&all_tools).is_empty());
    }

    #[test]
    fn filter_tools_passes_everything_through_for_all_scope() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Unknown);
        let all_tools = vec!["read_note".to_string(), "delete_note".to_string()];
        assert_eq!(strategy.filter_tools(&all_tools), all_tools);
    }

    /// The main chat path calls `visible_tool_defs`, so `All` must resolve to the
    /// narrowed default surface — otherwise the CORE_TOOLS convergence would only
    /// apply to the `AgentInstance` path and the main path would keep paying the
    /// full ~10k-token schema block on every unclassified turn.
    #[test]
    fn visible_tool_defs_narrows_all_scope_to_the_core_surface() {
        let all = crate::tools::get_all_tool_defs(&[], &[]);
        assert!(all.len() > 40, "expected the full catalogue, got {}", all.len());

        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Unknown);
        let visible = strategy.visible_tool_defs(&all);

        assert!(
            visible.len() * 2 < all.len(),
            "default surface should be far smaller: {} vs {}",
            visible.len(),
            all.len()
        );

        let names: Vec<&str> = visible.iter().map(|t| t.function.name.as_str()).collect();
        // Everyday work must still be reachable without a discovery round-trip…
        for must in ["search_notes", "read_note", "create_note", "edit_note", "todo_write"] {
            assert!(names.contains(&must), "{} must stay in the default surface", must);
        }
        // …and the escape hatch must be there, or the removed tools are unreachable.
        assert!(names.contains(&crate::tools::LIST_AVAILABLE_TOOLS));
        // A tool deliberately left out of CORE_TOOLS must not be in the schema list.
        assert!(!names.contains(&"merge_notes"));

        // `filter_tool_defs` keeps its literal meaning — the two must not be aliases.
        assert_eq!(strategy.filter_tool_defs(&all).len(), all.len());
    }

    /// Narrowing `All` must not leak into the other two variants.
    #[test]
    fn visible_tool_defs_leaves_none_and_only_untouched() {
        let all = crate::tools::get_all_tool_defs(&[], &[]);

        let chitchat = ExecutionStrategy::from_intent(&TurnIntent::Chitchat);
        assert!(chitchat.visible_tool_defs(&all).is_empty());

        let search = ExecutionStrategy::from_intent(&TurnIntent::Search);
        assert_eq!(
            search.visible_tool_defs(&all).len(),
            search.filter_tool_defs(&all).len()
        );
    }

    #[test]
    fn diagnose_scope_exposes_get_graph_and_run_lint() {
        let strategy = ExecutionStrategy::from_intent(&TurnIntent::Diagnose);
        assert!(strategy.allows_tool("get_graph"));
        assert!(strategy.allows_tool("run_lint"));
        assert!(strategy.allows_tool("query_graph_communities"));
        assert!(strategy.allows_tool("generate_structure_note"));
        let all = crate::tools::get_all_tool_defs(&[], &[]);
        let visible = strategy.visible_tool_defs(&all);
        let names: Vec<&str> = visible.iter().map(|t| t.function.name.as_str()).collect();
        assert!(names.contains(&"get_graph"));
        assert!(names.contains(&"run_lint"));
    }
}
