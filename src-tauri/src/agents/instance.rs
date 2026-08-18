use crate::llm::{self, ChatMessage, LlmConfig, ToolDef, AgentEvent};

/// Execution configuration for an agent — controls loop limits.
/// Replaces the hardcoded values in chat_completion_with_tools().
#[derive(Debug, Clone)]
pub struct AgentExecutionConfig {
    pub max_iterations: usize,
    pub max_total_tool_calls: usize,
}

impl Default for AgentExecutionConfig {
    fn default() -> Self {
        Self {
            max_iterations: 10,
            max_total_tool_calls: 30,
        }
    }
}

/// Output from an agent execution.
pub struct AgentOutput {
    /// The final text response from the agent.
    pub content: String,
    /// Which agent produced this output.
    pub agent_id: String,
    /// Where the final answer came from (loop / mandatory synthesis / stub retry).
    pub answer_source: Option<llm::AnswerSource>,
    /// Full message history — preserved for pipeline downstream use.
    pub messages_history: Vec<ChatMessage>,
    /// Conditional routing: agent can signal which agent should handle next.
    pub next_action: Option<super::router::AgentIntent>,
}

/// An independent Agent instance with its own config, prompt, tools, and execution loop.
pub struct AgentInstance {
    pub id: String,
    pub display_name: String,
    pub icon: String,
    /// Independent LLM configuration — can use a different model per agent.
    pub config: LlmConfig,
    /// Role-specific complete system prompt.
    pub system_prompt: String,
    /// Allowed tool names — only these tools are passed to the LLM.
    ///
    /// Empty means "all tools" (see `filter_tools`). That convention is correct
    /// *here* because an `AgentInstance` is a fixed role whose author decides its
    /// whole tool surface up front — an empty list is a deliberate "no
    /// restriction". This differs from `agents::strategy`, where an empty scope
    /// arrived by accident (a router path that set no tools) and got silently
    /// promoted to "everything", inverting the intended Chitchat lockdown; that
    /// layer now uses an explicit `ToolScope` enum instead.
    pub allowed_tools: Vec<String>,
    /// When `true`, runtime-registered extension tools (MCP `mcp_*`, skill
    /// `skill_*`, `read_skill`) bypass the `allowed_tools` filter. The unified
    /// agent sets this so a curated `CORE_TOOLS` list does not accidentally hide
    /// the user's installed integrations, which no compiled list can enumerate.
    /// Preset expert agents leave it `false`: they publish an exact tool surface.
    pub allow_extension_tools: bool,
    /// Execution limits.
    pub exec_config: AgentExecutionConfig,
}

impl AgentInstance {
    /// Core execution method — owns an independent message history.
    ///
    /// `chat_history`: optional multi-turn history from previous conversations.
    /// `context`: optional upstream agent output or attached note context.
    pub async fn run<F>(
        &self,
        user_message: &str,
        chat_history: Option<&[ChatMessage]>,
        context: Option<&str>,
        all_tools: &[ToolDef],
        tool_executor: F,
        app_handle: &tauri::AppHandle,
    ) -> anyhow::Result<AgentOutput>
    where
        F: for<'a> Fn(&'a str, &'a str) -> futures_util::future::BoxFuture<'a, anyhow::Result<String>>,
    {
        // 1. Build independent message history
        let mut messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: self.system_prompt.clone(),
                ..Default::default()
            },
        ];

        // 2. Inject upstream context (from pipeline or attached notes)
        if let Some(ctx) = context {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!("## Additional Context\n{}", ctx),
                ..Default::default()
            });
        }

        // 3. Inject multi-turn chat history (excluding system messages to avoid prompt conflicts)
        if let Some(history) = chat_history {
            for msg in history {
                if msg.role != "system" {
                    messages.push(msg.clone());
                }
            }
        }

        // 4. User message
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
            ..Default::default()
        });

        // 5. Filter tools to only allowed subset
        let filtered_tools = self.filter_tools(all_tools);

        // 6. Emit "role_selected" event to frontend.
        // The earlier 150ms sleep here was purely for animation timing; the
        // event alone is enough — the frontend already sequences its own UI.
        llm::emit_agent_event(
            app_handle,
            AgentEvent::RoleSelected {
                agent_id: self.id.clone(),
                agent_name: self.display_name.clone(),
                agent_icon: self.icon.clone(),
            },
        );

        // 7. Call chat_completion_with_tools with independent exec_config
        let turn = llm::chat_completion_with_tools(
            &self.config,
            &mut messages,
            &filtered_tools,
            &self.exec_config,
            tool_executor,
            app_handle,
        )
        .await?;

        // 8. Parse conditional routing signal from agent output
        let next_action = parse_next_action(&turn.content);

        Ok(AgentOutput {
            content: turn.content,
            answer_source: Some(turn.source),
            agent_id: self.id.clone(),
            messages_history: messages,
            next_action,
        })
    }

    /// Filter tools to only those in `allowed_tools`.
    ///
    /// An empty `allowed_tools` still means "all tools allowed" — see the field
    /// doc for why that is safe at this layer (a role's tool surface is authored,
    /// not derived from a router decision).
    ///
    /// `allow_extension_tools` adds MCP / skill tools back on top of a non-empty
    /// list. Without it, the moment an agent names its tools it would also
    /// uninstall every MCP server and skill tool the user configured, because
    /// those names only exist at runtime.
    pub(crate) fn filter_tools(&self, all_tools: &[ToolDef]) -> Vec<ToolDef> {
        if self.allowed_tools.is_empty() {
            return all_tools.to_vec();
        }
        all_tools
            .iter()
            .filter(|t| {
                self.allowed_tools.contains(&t.function.name)
                    || (self.allow_extension_tools
                        && crate::tools::is_extension_tool(&t.function.name))
            })
            .cloned()
            .collect()
    }
}

/// Parse `[ROUTE:xxx]` signals from agent output for conditional routing.
fn parse_next_action(content: &str) -> Option<super::router::AgentIntent> {
    if let Some(start) = content.find("[ROUTE:") {
        if let Some(end) = content[start..].find(']') {
            let target = &content[start + 7..start + end];
            return match target.trim().to_lowercase().as_str() {
                "knowledge" => Some(super::router::AgentIntent::Knowledge),
                "create" | "creator" => Some(super::router::AgentIntent::Create),
                "curate" | "curator" => Some(super::router::AgentIntent::Curate),
                _ => None,
            };
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolFunction;

    fn tool(name: &str) -> ToolDef {
        ToolDef {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: name.to_string(),
                description: format!("{name} description"),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            },
        }
    }

    fn agent(allowed: &[&str], allow_extension_tools: bool) -> AgentInstance {
        AgentInstance {
            id: "t".to_string(),
            display_name: "T".to_string(),
            icon: "🧪".to_string(),
            config: LlmConfig::default(),
            system_prompt: String::new(),
            allowed_tools: allowed.iter().map(|s| s.to_string()).collect(),
            allow_extension_tools,
            exec_config: AgentExecutionConfig::default(),
        }
    }

    fn names(tools: &[ToolDef]) -> Vec<String> {
        tools.iter().map(|t| t.function.name.clone()).collect()
    }

    #[test]
    fn empty_allowed_tools_still_means_all_tools() {
        // Preserved on purpose: a role with no list has authored no restriction.
        let all = vec![tool("search_notes"), tool("delete_note")];
        assert_eq!(names(&agent(&[], false).filter_tools(&all)), names(&all));
    }

    #[test]
    fn a_named_list_hides_everything_else() {
        let all = vec![tool("search_notes"), tool("delete_note")];
        let kept = agent(&["search_notes"], false).filter_tools(&all);
        assert_eq!(names(&kept), vec!["search_notes".to_string()]);
    }

    #[test]
    fn extension_tools_survive_a_named_list_only_when_opted_in() {
        let all = vec![
            tool("search_notes"),
            tool("delete_note"),
            tool("mcp_github_create_issue"),
            tool("skill_writer_outline"),
            tool("read_skill"),
        ];

        // Unified-agent shape: curated core + whatever the user installed.
        let opted_in = names(&agent(&["search_notes"], true).filter_tools(&all));
        assert!(opted_in.contains(&"mcp_github_create_issue".to_string()));
        assert!(opted_in.contains(&"skill_writer_outline".to_string()));
        assert!(opted_in.contains(&"read_skill".to_string()));
        assert!(!opted_in.contains(&"delete_note".to_string()));

        // Role-agent shape: the published list is exactly the surface.
        let closed = names(&agent(&["search_notes"], false).filter_tools(&all));
        assert_eq!(closed, vec!["search_notes".to_string()]);
    }
}
