//! Adaptive Prompt System
//! 
//! Dynamically adjusts prompt complexity based on task complexity.
//! Implements the "Less Control, More Tools" philosophy from Genspark.

use super::ChatMessage;

/// Task complexity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskComplexity {
    /// Simple query: single tool call can complete (e.g., "read note X")
    Simple,
    /// Medium query: requires 2-3 tool coordination (e.g., "search and summarize")
    Medium,
    /// Complex query: needs full planning-execution-reflection loop
    Complex,
}

/// Assess task complexity based on query analysis
pub fn assess_complexity(query: &str, history: &[ChatMessage]) -> TaskComplexity {
    let q = query.to_lowercase();
    
    // ── Quick heuristic rules ──
    
    // Simple query indicators: direct, single action
    let simple_indicators = [
        "读", "打开", "查看", "显示", "read", "open", "show", "display",
        "是什么", "what is", "定义", "define",
    ];
    if simple_indicators.iter().any(|k| q.contains(k)) && q.len() < 50 {
        return TaskComplexity::Simple;
    }
    
    // Complex query indicators: multi-step, analysis, creation
    let complex_indicators = [
        "分析", "比较", "整理", "优化", "重构", "调研",
        "analyze", "compare", "organize", "optimize", "refactor", "research",
        "然后", "接着", "并且", "同时", "then", "and then", "also",
        "总结", "综合", "生成", "创建", "summarize", "synthesize", "generate", "create",
    ];
    let complex_count = complex_indicators.iter().filter(|k| q.contains(*k)).count();
    if complex_count >= 2 || q.len() > 100 {
        return TaskComplexity::Complex;
    }
    
    // Medium: has some complexity indicators but not many
    let medium_indicators = [
        "搜索", "查找", "分析", "比较", "推荐",
        "search", "find", "analyze", "compare", "recommend",
        "多个", "所有", "related", "connected",
    ];
    let medium_count = medium_indicators.iter().filter(|k| q.contains(*k)).count();
    if medium_count >= 1 {
        return TaskComplexity::Medium;
    }
    
    // Check conversation history for context
    if history.len() > 6 {
        // Long conversation suggests complex task
        return TaskComplexity::Medium;
    }
    
    // Default to medium
    TaskComplexity::Medium
}

/// Build adaptive prompt based on task complexity
pub fn build_prompt(complexity: TaskComplexity, base_prompt: &str) -> String {
    match complexity {
        TaskComplexity::Simple => {
            // Minimal prompt for simple tasks
            format!(
                r#"{base_prompt}

## Quick Mode
This is a simple query. Provide a direct answer with minimal tool calls.
Focus on being fast and precise."#
            )
        }
        TaskComplexity::Medium => {
            // Standard prompt with tool coordination guidance
            format!(
                r#"{base_prompt}

## Tool Coordination
For this task, you may need to chain 2-3 tools together.
Plan your approach: search → read → act.
Avoid unnecessary tool calls."#
            )
        }
        TaskComplexity::Complex => {
            // Full prompt with planning guidance
            format!(
                r#"{base_prompt}

## Complex Task Mode
This is a complex multi-step task. Consider:
1. Break it into clear sub-steps
2. Execute methodically, verifying results
3. Synthesize findings into a coherent response
4. Use graph tools for relationship analysis if relevant"#
            )
        }
    }
}

/// Get tool quick reference section
pub fn tool_quick_ref() -> &'static str {
    r##"
## Quick Reference
- `search_notes` / `find_similar_notes`: Find relevant notes
- `read_note` / `batch_read_notes`: Read note content
- `create_note` / `patch_note`: Create or edit notes
- `get_graph` / `get_local_graph`: Explore connections
"##
}

/// Get tool coordination guide section
pub fn tool_coordination_guide() -> &'static str {
    r##"
## Tool Coordination Guide
1. **Start broad**: Use search or graph overview to understand context
2. **Focus**: Read the most relevant results in detail
3. **Act**: Make targeted changes based on findings
4. **Verify**: Confirm changes had the intended effect

Avoid: Calling the same tool with identical arguments repeatedly.
"##
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_query() {
        assert_eq!(
            assess_complexity("读一下笔记X", &[]),
            TaskComplexity::Simple
        );
        assert_eq!(
            assess_complexity("What is machine learning?", &[]),
            TaskComplexity::Simple
        );
    }

    #[test]
    fn test_complex_query() {
        assert_eq!(
            assess_complexity("分析我的知识库结构并整理所有孤立笔记", &[]),
            TaskComplexity::Complex
        );
        assert_eq!(
            assess_complexity("Research AI safety and create a summary note with key insights", &[]),
            TaskComplexity::Complex
        );
    }

    #[test]
    fn test_medium_query() {
        assert_eq!(
            assess_complexity("搜索关于深度学习的笔记", &[]),
            TaskComplexity::Medium
        );
        assert_eq!(
            assess_complexity("Find notes related to my project", &[]),
            TaskComplexity::Medium
        );
    }
}
