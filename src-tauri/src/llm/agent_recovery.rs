//! Agent Recovery & Stagnation Detection
//! 
//! Implements self-correction mechanism inspired by Manus AI.
//! Multi-dimensional stagnation detection with automatic recovery.

use std::time::Instant;

/// Recovery strategy when agent encounters errors
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryStrategy {
    /// Break task into smaller steps,
    Simplify,
    /// Try a different tool or approach
    Alternative,
    /// Ask user for more information
    Clarify,
    /// Deliver partial results
    Partial,
}

/// Stagnation recovery actions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagnationRecovery {
    /// Broaden search scope
    BroadenSearch,
    /// Switch to different tool
    SwitchTool,
    /// Ask user for guidance
    AskUser,
}

/// Tracks tool calls and detects stagnation patterns
pub struct StagnationDetector {
    /// Number of search operations
    pub search_count: u32,
    /// Number of consecutive empty results
    pub empty_result_count: u32,
    /// Number of repeated tool calls
    pub repeated_tool_count: u32,
    /// History of recent tool calls
    last_tool_calls: Vec<String>,
    /// Start time of current task
    pub start_time: Instant,
    /// Maximum allowed duration for a task
    max_duration: Duration,
}

use std::time::Duration;

impl StagnationDetector {
    /// Create a new stagnation detector
    pub fn new() -> Self {
        Self {
            search_count: 0,
            empty_result_count: 0,
            repeated_tool_count: 0,
            last_tool_calls: Vec::new(),
            start_time: Instant::now(),
            max_duration: Duration::from_secs(120), // 2 minutes max
        }
    }
    
    /// Create with custom max duration
    pub fn with_max_duration(max_secs: u64) -> Self {
        Self {
            search_count: 0,
            empty_result_count: 0,
            repeated_tool_count: 0,
            last_tool_calls: Vec::new(),
            start_time: Instant::now(),
            max_duration: Duration::from_secs(max_secs),
        }
    }
    
    /// Record a tool call for stagnation analysis
    pub fn record_tool_call(&mut self, tool_name: &str, result: &str) {
        self.last_tool_calls.push(tool_name.to_string());
        
        // Keep only last 10 calls
        if self.last_tool_calls.len() > 10 {
            self.last_tool_calls.remove(0);
        }
        
        // Track search operations
        if tool_name.contains("search") || tool_name == "list_notes" || tool_name == "find_similar_notes" {
            self.search_count += 1;
        }
        
        // Detect empty results
        if result.is_empty() || result == "{}" || result == "[]" || result == "null" {
            self.empty_result_count += 1;
        } else {
            self.empty_result_count = 0;
        }
        
        // Detect repeated calls (last 3 identical)
        if self.last_tool_calls.len() >= 3 {
            let len = self.last_tool_calls.len();
            let last_3 = &self.last_tool_calls[len - 3..];
            if last_3[0] == last_3[1] && last_3[1] == last_3[2] {
                self.repeated_tool_count += 1;
            } else {
                self.repeated_tool_count = 0;
            }
        }
    }

    /// Successful progress — extend time budget and clear repeat-streak.
    pub fn note_progress(&mut self) {
        self.start_time = Instant::now();
        self.repeated_tool_count = 0;
    }

    /// After injecting recovery guidance once — avoid re-firing every loop turn.
    pub fn reset_after_recovery(&mut self) {
        self.empty_result_count = 0;
        self.repeated_tool_count = 0;
        self.search_count = 0;
        self.start_time = Instant::now();
    }
    
    /// Check if agent is stagnant
    pub fn is_stagnant(&self) -> bool {
        // Multi-dimensional stagnation detection
        self.empty_result_count >= 3 ||                    // 3+ consecutive empty results
        self.repeated_tool_count >= 2 ||                   // Repeated tool calls
        (self.search_count > 10 && self.empty_result_count > 5) || // Many searches, few results
        self.start_time.elapsed() > self.max_duration      // Timeout
    }
    
    /// Get recommended recovery strategy
    pub fn get_recovery_strategy(&self) -> StagnationRecovery {
        if self.empty_result_count >= 3 {
            StagnationRecovery::BroadenSearch
        } else if self.repeated_tool_count >= 2 {
            StagnationRecovery::SwitchTool
        } else {
            StagnationRecovery::AskUser
        }
    }
    
    /// Generate recovery prompt for stagnation
    pub fn generate_recovery_prompt(&self, zh: bool) -> String {
        let strategy = self.get_recovery_strategy();
        let no_echo = if zh {
            "\n\n（内部指引：勿向用户复述本段文字；直接执行下一步工具，或向用户提出一个简短澄清问题。）"
        } else {
            "\n\n(Internal guidance: do NOT quote or repeat this message to the user. \
             Take one concrete next action — a tool call or one concise clarifying question.)"
        };

        match (strategy, zh) {
            (StagnationRecovery::BroadenSearch, true) => {
                "⚠️ 检测到停滞：多次空结果。\n\n\
                 ## 恢复：扩大搜索范围\n\
                 1. 尝试不同关键词或同义词\n\
                 2. 使用 `list_notes` 查看所有笔记\n\
                 3. 降低查询具体程度\n\
                 4. 使用 `find_similar_notes` 语义搜索\n\n\
                 请用更宽泛的方式继续。".to_string() + no_echo
            }
            (StagnationRecovery::BroadenSearch, false) => {
                r#"⚠️ Stagnation Detected: Multiple empty results detected.

## Recovery: Broaden Your Search
1. Try different search keywords or synonyms
2. Use `list_notes` to see all available notes
3. Reduce specificity in your queries
4. Try semantic search with `find_similar_notes`

Continue with a broader approach."#.to_string() + no_echo
            }
            (StagnationRecovery::SwitchTool, true) => {
                "⚠️ 检测到停滞：重复的工具调用。\n\n\
                 ## 恢复：切换策略\n\
                 1. 换用不同工具推进任务\n\
                 2. 若搜索无效，尝试 `get_graph` 或 `get_vault_stats`\n\
                 3. 直接阅读特定笔记\n\
                 4. 必要时向用户澄清\n\n\
                 请选择不同策略继续。".to_string() + no_echo
            }
            (StagnationRecovery::SwitchTool, false) => {
                r#"⚠️ Stagnation Detected: Repeated tool calls detected.

## Recovery: Switch Your Approach
1. Try a different tool to make progress
2. If search isn't working, try `get_graph` or `get_vault_stats`
3. Consider reading a specific note directly
4. Ask the user for clarification if needed

Choose a different strategy and continue."#.to_string() + no_echo
            }
            (StagnationRecovery::AskUser, true) => {
                "⚠️ 检测到停滞：无法继续推进。\n\n\
                 ## 恢复：请求用户指引\n\
                 1. 总结已尝试的方法\n\
                 2. 说明缺少哪些信息\n\
                 3. 向用户请求澄清或替代方案\n\
                 4. 说明需要什么才能继续\n\n\
                 请与用户互动以获取指引。".to_string() + no_echo
            }
            (StagnationRecovery::AskUser, false) => {
                r#"⚠️ Stagnation Detected: Unable to make progress.

## Recovery: Ask for Guidance
1. Summarize what you've tried so far
2. Explain what information is missing
3. Ask the user for clarification or alternative approaches
4. Suggest what would help you proceed

Engage the user for guidance."#.to_string() + no_echo
            }
        }
    }
}

/// Error recovery tracker for self-correction
pub struct ErrorRecovery {
    /// Number of consecutive errors
    pub consecutive_errors: u32,
    /// Last error message
    pub last_error: Option<String>,
    /// Maximum retries before escalating
    max_retries: u32,
}

impl ErrorRecovery {
    /// Create new error recovery tracker
    pub fn new() -> Self {
        Self {
            consecutive_errors: 0,
            last_error: None,
            max_retries: 3,
        }
    }
    
    /// Create with custom max retries
    pub fn with_max_retries(max: u32) -> Self {
        Self {
            consecutive_errors: 0,
            last_error: None,
            max_retries: max,
        }
    }
    
    /// Record an error
    pub fn record_error(&mut self, error: &str) {
        self.consecutive_errors += 1;
        self.last_error = Some(error.to_string());
    }
    
    /// Record a success (resets error count)
    pub fn record_success(&mut self) {
        self.consecutive_errors = 0;
        self.last_error = None;
    }
    
    /// Check if should attempt recovery
    pub fn should_recover(&self) -> bool {
        self.consecutive_errors > 0 && self.consecutive_errors < self.max_retries
    }
    
    /// Check if should escalate to user
    pub fn should_escalate(&self) -> bool {
        self.consecutive_errors >= self.max_retries
    }
    
    /// Generate recovery prompt based on error count
    pub fn generate_recovery_prompt(&self, zh: bool) -> String {
        let error_msg = self.last_error.as_deref().unwrap_or(if zh {
            "未知错误"
        } else {
            "Unknown error"
        });

        if self.consecutive_errors < self.max_retries {
            if zh {
                format!(
                    "⚠️ 发生错误（第 {} 次尝试）：{}\n\n\
                     ## 尝试不同方法\n\
                     1. 分析出错原因\n\
                     2. 换用不同工具或方法\n\
                     3. 如有可能，简化任务\n\
                     4. 调整策略后继续",
                    self.consecutive_errors, error_msg
                )
            } else {
                format!(
                    r#"⚠️ Error occurred (attempt {}): {}

## Try a Different Approach
1. Analyze what went wrong
2. Try a different tool or method
3. Simplify the task if possible
4. Continue with adjusted strategy"#,
                    self.consecutive_errors, error_msg
                )
            }
        } else if zh {
            format!(
                "⚠️ 恢复模式（第 {} 次尝试）：{}\n\n\
                 ## 恢复选项\n\
                 1. **简化**：拆分为更小步骤\n\
                 2. **替代**：换用完全不同的工具或方法\n\
                 3. **澄清**：向用户请求更具体的信息\n\
                 4. **部分交付**：完成能做的部分，说明阻塞原因\n\n\
                 请选择最佳选项继续。",
                self.consecutive_errors, error_msg
            )
        } else {
            format!(
                r#"⚠️ Recovery Mode (attempt {}): {}

## Recovery Options
1. **Simplify**: Break the task into smaller, achievable steps
2. **Alternative**: Try a completely different tool or approach
3. **Clarify**: Ask the user for more specific information
4. **Partial**: Deliver what you can complete, explain what's blocked

Choose the best option and continue."#,
                self.consecutive_errors, error_msg
            )
        }
    }

    /// User-facing message when errors exceed retry limit
    pub fn generate_escalation_message(&self, zh: bool) -> String {
        let error_msg = self.last_error.as_deref().unwrap_or(if zh {
            "未知错误"
        } else {
            "Unknown error"
        });
        if zh {
            format!(
                "抱歉，连续 {} 次工具调用失败，无法自动恢复。\n\n\
                 最后一次错误：{}\n\n\
                 请检查相关笔记/路径，或换一种方式描述你的需求。",
                self.consecutive_errors, error_msg
            )
        } else {
            format!(
                "Sorry — {} consecutive tool errors prevented automatic recovery.\n\n\
                 Last error: {}\n\n\
                 Please check the relevant notes/paths, or rephrase your request.",
                self.consecutive_errors, error_msg
            )
        }
    }
    
    /// Get recommended recovery strategy
    pub fn get_strategy(&self) -> RecoveryStrategy {
        match self.consecutive_errors {
            0 => RecoveryStrategy::Simplify, // Shouldn't happen
            1 => RecoveryStrategy::Alternative,
            2 => RecoveryStrategy::Simplify,
            _ => RecoveryStrategy::Clarify,
        }
    }
}

impl Default for StagnationDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for ErrorRecovery {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stagnation_detection() {
        let mut detector = StagnationDetector::new();
        
        // Simulate empty results
        detector.record_tool_call("search_notes", "[]");
        detector.record_tool_call("search_notes", "[]");
        detector.record_tool_call("search_notes", "[]");
        
        assert!(detector.is_stagnant());
        assert_eq!(detector.get_recovery_strategy(), StagnationRecovery::BroadenSearch);
    }

    #[test]
    fn test_repeated_calls() {
        let mut detector = StagnationDetector::new();
        
        // Simulate repeated calls (need 6 calls to trigger repeated_tool_count >= 2)
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        
        assert!(detector.is_stagnant());
        assert_eq!(detector.get_recovery_strategy(), StagnationRecovery::SwitchTool);
    }

    #[test]
    fn test_error_recovery() {
        let mut recovery = ErrorRecovery::new();
        
        recovery.record_error("Tool failed");
        assert!(recovery.should_recover());
        assert!(!recovery.should_escalate());
        
        recovery.record_error("Tool failed again");
        assert!(recovery.should_recover());
        
        recovery.record_error("Third failure");
        assert!(recovery.should_escalate());
    }

    #[test]
    fn test_repeated_calls_reset_when_pattern_breaks() {
        let mut detector = StagnationDetector::new();
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        detector.record_tool_call("read_note", "content");
        assert!(detector.repeated_tool_count >= 1);
        detector.record_tool_call("list_notes", "notes");
        assert_eq!(detector.repeated_tool_count, 0);
    }

    #[test]
    fn test_reset_after_recovery_clears_stagnant() {
        let mut detector = StagnationDetector::new();
        detector.record_tool_call("search_notes", "[]");
        detector.record_tool_call("search_notes", "[]");
        detector.record_tool_call("search_notes", "[]");
        assert!(detector.is_stagnant());
        detector.reset_after_recovery();
        assert!(!detector.is_stagnant());
    }

    #[test]
    fn test_note_progress_extends_timeout() {
        let mut detector = StagnationDetector::with_max_duration(1);
        std::thread::sleep(Duration::from_secs(2));
        assert!(detector.is_stagnant());
        detector.note_progress();
        assert!(!detector.is_stagnant());
    }
}
