//! Runtime validation: configured model type vs actual API reasoning fields.
//!
//! When the user selects "非思考模型" but the provider streams native reasoning
//! (`reasoning_content`, Claude `thinking` blocks), fail fast with a settings hint
//! instead of mixing XML and native parsing (which breaks the thought chain).

use crate::llm::prompted_thinking::is_native_reasoning;
use crate::llm::LlmConfig;

/// Bilingual user-facing error when native reasoning appears but settings say non-thinking.
pub fn native_reasoning_mismatch_error() -> String {
    "检测到模型返回了原生思考链，但「模型类型」设置为「非思考模型」。\
     请前往 设置 → AI，将模型类型改为「思考模型」后重试。\n\n\
     The model returned native reasoning output, but Model Type is set to \
     \"Non-thinking model\". Go to Settings → AI and select \"Thinking model\", then retry."
        .to_string()
}

/// Fail if native reasoning was observed while `supports_thinking` is off.
pub fn bail_on_native_reasoning_mismatch(config: &LlmConfig) -> anyhow::Result<()> {
    if is_native_reasoning(config) {
        return Ok(());
    }
    crate::chat_file_log::log_agent(
        "reasoning_mode_mismatch: native reasoning from API but Model Type = non-thinking",
    );
    anyhow::bail!("{}", native_reasoning_mismatch_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mismatch_only_when_non_native_setting() {
        let mut cfg = LlmConfig::default();
        cfg.supports_thinking = Some(false);
        assert!(bail_on_native_reasoning_mismatch(&cfg).is_err());

        cfg.supports_thinking = Some(true);
        assert!(bail_on_native_reasoning_mismatch(&cfg).is_ok());
    }
}
