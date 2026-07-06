use crate::llm::{AgentEvent, ChatMessage, ToolDef};
use super::registry::AgentRegistry;
use super::router::AgentIntent;

/// Orchestrator: selects and runs agents based on intent, supports pipelines.
pub struct AgentOrchestrator;

impl AgentOrchestrator {
    /// Execute the appropriate agent(s) based on classified intent.
    pub async fn execute<F>(
        registry: &AgentRegistry,
        intent: AgentIntent,
        user_message: &str,
        chat_history: Option<&[ChatMessage]>,
        context: Option<&str>,
        all_tools: &[ToolDef],
        tool_executor: F,
        app_handle: &tauri::AppHandle,
    ) -> anyhow::Result<String>
    where
        F: for<'a> Fn(&'a str, &'a str) -> futures_util::future::BoxFuture<'a, anyhow::Result<String>>
            + Clone,
    {
        match intent {
            // Default path: any non-composite intent goes to the unified agent,
            // which has access to the full tool set. No role restriction — the
            // model picks the right tools itself (Cursor/Claude Code style).
            AgentIntent::Knowledge | AgentIntent::Create | AgentIntent::Curate => {
                let agent = registry.get("unified").ok_or_else(|| {
                    anyhow::anyhow!("Unified agent not found in registry")
                })?;

                let output = agent
                    .run(
                        user_message,
                        chat_history,
                        context,
                        all_tools,
                        tool_executor.clone(),
                        app_handle,
                    )
                    .await?;

                // Check for handoff: explicit signal OR intelligent content analysis
                let next_action = output.next_action.or_else(|| {
                    Self::detect_handoff_from_content("unified", &output.content)
                });

                // Conditional routing: if the unified agent signals handoff to a
                // specialized role, run that role as a follow-up step.
                if let Some(next) = next_action {
                    let next_agent_id = match &next {
                        AgentIntent::Knowledge => "knowledge",
                        AgentIntent::Create => "creator",
                        AgentIntent::Curate => "curator",
                        _ => return Ok(output.content),
                    };

                    crate::llm::emit_agent_event(
                        app_handle,
                        AgentEvent::PipelineProgress {
                            current_step: 1,
                            total_steps: 2,
                            agent_name: agent.display_name.clone(),
                        },
                    );

                    crate::llm::emit_agent_event(
                        app_handle,
                        AgentEvent::PipelineProgress {
                            current_step: 2,
                            total_steps: 2,
                            agent_name: registry.get_name_for_intent(&next),
                        },
                    );

                    let next_agent = registry.get(next_agent_id).ok_or_else(|| {
                        anyhow::anyhow!("Next agent '{}' not found", next_agent_id)
                    })?;
                    let upstream_context = format!(
                        "## Previous Agent ({}) Output:\n{}",
                        agent.display_name, output.content
                    );
                    let next_output = next_agent
                        .run(
                            user_message,
                            chat_history,
                            Some(&upstream_context),
                            all_tools,
                            tool_executor,
                            app_handle,
                        )
                        .await?;
                    return Ok(next_output.content);
                }

                Ok(output.content)
            }

            AgentIntent::Composite(steps) => {
                let total = steps.len();
                let mut accumulated_context = context.map(String::from);
                let mut final_output = String::new();

                crate::llm::emit_agent_event(
                    app_handle,
                    AgentEvent::PipelineProgress {
                        current_step: 0,
                        total_steps: total,
                        agent_name: "Pipeline".to_string(),
                    },
                );

                for (idx, step_intent) in steps.iter().enumerate() {
                    let agent_id = match step_intent {
                        AgentIntent::Knowledge => "knowledge",
                        AgentIntent::Create => "creator",
                        AgentIntent::Curate => "curator",
                        AgentIntent::Composite(_) => "knowledge", // nested composite fallback
                    };
                    let agent = registry.get(agent_id).ok_or_else(|| {
                        anyhow::anyhow!("Pipeline agent '{}' not found", agent_id)
                    })?;

                    // Emit pipeline progress
                    crate::llm::emit_agent_event(
                        app_handle,
                        AgentEvent::PipelineProgress {
                            current_step: idx + 1,
                            total_steps: total,
                            agent_name: agent.display_name.clone(),
                        },
                    );

                    let output = agent
                        .run(
                            user_message,
                            chat_history,
                            accumulated_context.as_deref(),
                            all_tools,
                            tool_executor.clone(),
                            app_handle,
                        )
                        .await?;

                    accumulated_context = Some(format!(
                        "## Previous Agent ({}) Output:\n{}",
                        agent.display_name, output.content
                    ));
                    final_output = output.content;
                }

                Ok(final_output)
            }
        }
    }
    
    /// Intelligent handoff detection based on output content analysis.
    /// Analyzes what the agent actually said to determine if handoff is needed.
    fn detect_handoff_from_content(agent_id: &str, content: &str) -> Option<AgentIntent> {
        let content_lower = content.to_lowercase();
        
        match agent_id {
            "knowledge" => {
                // Knowledge Agent suggests creating content
                if content_lower.contains("建议创建") ||
                   content_lower.contains("should create") ||
                   content_lower.contains("值得写成笔记") ||
                   content_lower.contains("建议整理") ||
                   content_lower.contains("needs organizing") {
                    Some(AgentIntent::Create)
                } else if content_lower.contains("需要清理") ||
                          content_lower.contains("should clean up") ||
                          content_lower.contains("needs curation") {
                    Some(AgentIntent::Curate)
                } else {
                    None
                }
            }
            "creator" => {
                // Creator Agent needs more research
                if content_lower.contains("需要更多研究") ||
                   content_lower.contains("needs more research") ||
                   content_lower.contains("信息不足") ||
                   content_lower.contains("insufficient information") {
                    Some(AgentIntent::Knowledge)
                } else if content_lower.contains("建议整理") ||
                          content_lower.contains("should organize") {
                    Some(AgentIntent::Curate)
                } else {
                    None
                }
            }
            "curator" => {
                // Curator Agent found content that needs analysis
                if content_lower.contains("发现有趣") ||
                   content_lower.contains("interesting findings") ||
                   content_lower.contains("值得分析") ||
                   content_lower.contains("worth analyzing") {
                    Some(AgentIntent::Knowledge)
                } else if content_lower.contains("建议创建") ||
                          content_lower.contains("should create") {
                    Some(AgentIntent::Create)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}
