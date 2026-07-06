// ── Non-native reasoning: XML <thought> stream parser ─────────────
// When supports_thinking is false, models are prompted to wrap reasoning in
// <thought>...</thought>. This module parses the stream and emits unified events.

use crate::llm::prompts::{non_native_thought_prompt, NON_NATIVE_THOUGHT_MARKER};
use crate::llm::{AgentEvent, ChatMessage, LlmConfig};
use tauri::AppHandle;

const START_TAG: &str = "<thought>";
const END_TAG: &str = "</thought>";

/// Length (in bytes) of the longest buffer suffix that is a proper prefix of `tag`.
/// Only such a suffix could become the tag once more chunks arrive, so only that
/// much needs to be held back. Tag prefixes are pure ASCII, so the returned split
/// point is always a valid UTF-8 char boundary — slicing at an arbitrary
/// `len - N` byte offset would panic on multi-byte text (e.g. Chinese).
fn tag_prefix_holdback(buffer: &str, tag: &str) -> usize {
    let max = tag.len().saturating_sub(1).min(buffer.len());
    for len in (1..=max).rev() {
        let start = buffer.len() - len;
        if buffer.is_char_boundary(start) && tag.starts_with(&buffer[start..]) {
            return len;
        }
    }
    0
}

/// User-controlled switch: true = native reasoning API fields, false = XML prompt + parser.
pub fn is_native_reasoning(config: &LlmConfig) -> bool {
    config.supports_thinking == Some(true)
}

/// Append XML thought-format instructions to the system message (non-native path only).
pub fn inject_non_native_thought_prompt(messages: &mut Vec<ChatMessage>) {
    let prompt = non_native_thought_prompt();
    if let Some(sys) = messages.iter_mut().find(|m| m.role == "system") {
        if !sys.content.contains(NON_NATIVE_THOUGHT_MARKER) {
            sys.content.push_str("\n\n");
            sys.content.push_str(prompt);
        }
    } else {
        messages.insert(
            0,
            ChatMessage {
                role: "system".to_string(),
                content: prompt.to_string(),
                ..Default::default()
            },
        );
    }
}

pub fn emit_thinking(app_handle: &AppHandle, text: &str) {
    if text.is_empty() {
        return;
    }
    crate::llm::emit_agent_event(
        app_handle,
        AgentEvent::Thinking {
            message: text.to_string(),
        },
    );
}

pub fn emit_content(app_handle: &AppHandle, text: &str) {
    if text.is_empty() {
        return;
    }
    crate::llm::emit_agent_event(
        app_handle,
        AgentEvent::TextDelta {
            content: text.to_string(),
        },
    );
}

/// Streaming state machine that splits <thought>...</thought> from plain content.
#[derive(Debug, Default)]
pub struct ThoughtStreamParser {
    inside_thought: bool,
    buffer: String,
    clean_content: String,
}

impl ThoughtStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a content delta; returns (thought_chunks, content_chunks) to emit.
    pub fn feed(&mut self, text: &str) -> (Vec<String>, Vec<String>) {
        self.buffer.push_str(text);
        let mut thoughts = Vec::new();
        let mut contents = Vec::new();

        loop {
            if !self.inside_thought {
                if let Some(idx) = self.buffer.find(START_TAG) {
                    if idx > 0 {
                        let normal = self.buffer[..idx].to_string();
                        self.clean_content.push_str(&normal);
                        contents.push(normal);
                    }
                    self.inside_thought = true;
                    self.buffer = self.buffer[idx + START_TAG.len()..].to_string();
                } else {
                    // Hold back only a suffix that could still become "<thought>".
                    let keep = tag_prefix_holdback(&self.buffer, START_TAG);
                    let safe = self.buffer.len() - keep;
                    if safe > 0 {
                        let normal = self.buffer[..safe].to_string();
                        self.clean_content.push_str(&normal);
                        contents.push(normal);
                        self.buffer = self.buffer[safe..].to_string();
                    }
                    break;
                }
            } else if let Some(idx) = self.buffer.find(END_TAG) {
                let thought = self.buffer[..idx].to_string();
                if !thought.is_empty() {
                    thoughts.push(thought);
                }
                self.inside_thought = false;
                self.buffer = self.buffer[idx + END_TAG.len()..].to_string();
            } else {
                // Hold back only a suffix that could still become "</thought>".
                let keep = tag_prefix_holdback(&self.buffer, END_TAG);
                let safe = self.buffer.len() - keep;
                if safe > 0 {
                    let thought = self.buffer[..safe].to_string();
                    thoughts.push(thought);
                    self.buffer = self.buffer[safe..].to_string();
                }
                break;
            }
        }

        (thoughts, contents)
    }

    /// Flush remaining buffer at end of stream.
    pub fn flush(&mut self) -> (Vec<String>, Vec<String>) {
        if self.buffer.is_empty() {
            return (Vec::new(), Vec::new());
        }
        let remaining = std::mem::take(&mut self.buffer);
        if self.inside_thought {
            (vec![remaining], Vec::new())
        } else {
            self.clean_content.push_str(&remaining);
            (Vec::new(), vec![remaining])
        }
    }

    pub fn clean_content(&self) -> &str {
        &self.clean_content
    }

    pub fn append_clean(&mut self, text: &str) {
        self.clean_content.push_str(text);
    }
}

/// Route a plain content delta through native (passthrough) or XML parser path.
pub fn dispatch_content_delta(
    config: &LlmConfig,
    app_handle: &AppHandle,
    text: &str,
    parser: &mut Option<ThoughtStreamParser>,
    content_acc: &mut String,
) {
    if text.is_empty() {
        return;
    }

    if is_native_reasoning(config) {
        content_acc.push_str(text);
        emit_content(app_handle, text);
        return;
    }

    let p = parser.get_or_insert_with(ThoughtStreamParser::new);
    let (thoughts, contents) = p.feed(text);
    for t in thoughts {
        emit_thinking(app_handle, &t);
    }
    for c in contents {
        content_acc.push_str(&c);
        emit_content(app_handle, &c);
    }
}

/// Flush parser at end of stream (non-native path only).
pub fn flush_content_parser(
    config: &LlmConfig,
    app_handle: &AppHandle,
    parser: &mut Option<ThoughtStreamParser>,
    content_acc: &mut String,
) {
    if is_native_reasoning(config) {
        return;
    }
    if let Some(p) = parser.as_mut() {
        let (thoughts, contents) = p.flush();
        for t in thoughts {
            emit_thinking(app_handle, &t);
        }
        for c in contents {
            content_acc.push_str(&c);
            emit_content(app_handle, &c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_thought_block() {
        let mut p = ThoughtStreamParser::new();
        let (t1, c1) = p.feed("Hello <thought>I need grep</thought> Done.");
        assert!(c1.contains(&"Hello ".to_string()));
        assert!(t1.contains(&"I need grep".to_string()));
        let (t2, c2) = p.feed("");
        let (_, c2b) = p.flush();
        let all_content: String = c1.iter().chain(c2.iter()).chain(c2b.iter()).cloned().collect();
        assert!(all_content.contains("Hello "));
        assert!(all_content.contains("Done."));
        assert!(t1.iter().any(|s| s.contains("I need grep")));
        assert!(t2.is_empty());
    }

    #[test]
    fn handles_split_tags() {
        let mut p = ThoughtStreamParser::new();
        p.feed("Hello <tho");
        let (thoughts, contents) = p.feed("ught>world</thought>!");
        let (_, flush_c) = p.flush();
        let thought: String = thoughts.join("");
        let content: String = contents.iter().chain(flush_c.iter()).cloned().collect();
        assert!(thought.contains("world"), "thought was: {:?}", thought);
        assert!(content.contains("!"), "content was: {:?}", content);
    }

    #[test]
    fn handles_split_close_tag() {
        // The close tag arriving split across chunks must still terminate the
        // thought block — otherwise the final answer is swallowed as thinking.
        let mut p = ThoughtStreamParser::new();
        let mut thoughts = Vec::new();
        let mut contents = Vec::new();
        for chunk in ["<thought>plan things</thou", "ght>Final answer here."] {
            let (t, c) = p.feed(chunk);
            thoughts.extend(t);
            contents.extend(c);
        }
        let (ft, fc) = p.flush();
        thoughts.extend(ft);
        contents.extend(fc);
        let thought: String = thoughts.join("");
        let content: String = contents.join("");
        assert_eq!(thought, "plan things", "thought was: {:?}", thought);
        assert_eq!(content, "Final answer here.", "content was: {:?}", content);
    }

    #[test]
    fn no_panic_on_multibyte_utf8() {
        // Chinese output used to hit a non-char-boundary byte slice in the
        // holdback logic and panic, which hung the whole agent turn.
        let mut p = ThoughtStreamParser::new();
        let mut contents = Vec::new();
        for chunk in ["这是一个很长的中文回答，", "包含多字节字符。", "<thought>思考中……</thought>", "最终答案。"] {
            let (_, c) = p.feed(chunk);
            contents.extend(c);
        }
        let (_, fc) = p.flush();
        contents.extend(fc);
        let content: String = contents.join("");
        assert!(content.contains("这是一个很长的中文回答"));
        assert!(content.contains("最终答案。"));
        assert!(!content.contains("思考中"));
    }

    #[test]
    fn streams_content_without_holdback_lag() {
        // Plain text with no possible tag prefix should be emitted in full,
        // not have its last N bytes held back until flush.
        let mut p = ThoughtStreamParser::new();
        let (_, c) = p.feed("Hello world.");
        assert_eq!(c.join(""), "Hello world.");
    }
}
