use crate::llm::{self, ChatMessage, LlmConfig, ToolDef, AgentEvent};
use std::time::Duration;

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
    pub allowed_tools: Vec<String>,
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

        // 6. Emit "role_selected" event to frontend
        tokio::time::sleep(Duration::from_millis(150)).await;
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
    /// An empty `allowed_tools` means "all tools allowed" (the unified agent).
    fn filter_tools(&self, all_tools: &[ToolDef]) -> Vec<ToolDef> {
        if self.allowed_tools.is_empty() {
            return all_tools.to_vec();
        }
        all_tools
            .iter()
            .filter(|t| self.allowed_tools.contains(&t.function.name))
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
