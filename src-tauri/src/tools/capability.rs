//! 工具能力元数据 / capability metadata for tools.
//!
//! ## 为什么不是第二套权限系统
//!
//! 风险等级（`approval::base_risk_level`）回答"错了用户损失多大"，read-only 分类
//! （`approval::is_read_only_tool`）回答"会不会写"。这两个问题已经有答案了，本模块
//! **复用**它们，不重新判一遍——判两遍就一定会漂移，而漂移的那一天没人知道该信哪个。
//!
//! 这里补的是它们回答不了的三件事：
//!
//! 1. **能寻址什么**：一个工具只该碰笔记，还是也能改记忆、关系、任务？
//! 2. **要不要走 ChangeSet**：写用户内容的必须能预览、审批、回滚。
//! 3. **来源可信吗**：`mcp_*` / `skill_*` 来自第三方，不能享受内建工具的默认信任。
//!
//! ## 失败关闭
//!
//! [`capability_of`] 对未知名字返回"写、高风险、要 ChangeSet、不可信"。新加一个工具
//! 忘了登记，后果是它被当成危险工具对待，而不是悄悄获得全部权限。

use crate::knowledge::types::ObjectKind;
use crate::llm::approval::{base_risk_level, is_read_only_tool, RiskLevel};

/// 一次调用会对世界做什么 / what a call does to the world.
///
/// 与 `RiskLevel` 正交：`delete_note` 和 `create_note` 都是 [`Effect::Write`]，
/// 风险却差三级；`web_search` 风险低但会出网，这是 `RiskLevel` 表达不了的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// 只读。可以并发跑，可以重试，不需要审批。
    Read,
    /// 写用户内容（Markdown / canvas / 记忆 / 关系）。
    Write,
    /// 只写派生索引。可以从 vault 重建，所以不算改用户内容。
    Reindex,
    /// 出网。不改本地状态，但会把内容送出去。
    Network,
    /// Agent 自己的控制面（todo、工具发现）。不碰用户数据。
    Control,
}

impl Effect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Reindex => "reindex",
            Self::Network => "network",
            Self::Control => "control",
        }
    }
}

/// 一个工具的能力声明 / one tool's declared capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCapability {
    pub effect: Effect,
    pub risk: RiskLevel,
    /// 这个工具能寻址的对象类型。空表示不针对任何知识对象（控制面工具）。
    pub target_kinds: &'static [ObjectKind],
    /// 写入是否必须包成 ChangeSet 才能落盘。
    pub requires_changeset: bool,
    /// 调用前是否必须给出 scope（vault / 目录），不允许"整个库"。
    pub requires_scope: bool,
    /// 来源是否可信。第三方 MCP / skill 一律 false。
    pub trusted: bool,
}

impl ToolCapability {
    /// 给 IPC 事件与审批卡片用的形状 / the shape the UI and audit trail see.
    ///
    /// 手写而不是 `derive(Serialize)`：`RiskLevel` 属于审批系统，不该为了本模块的
    /// 序列化需求给那个枚举加 derive。
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "effect": self.effect.as_str(),
            "risk": self.risk.as_str(),
            "targetKinds": self.target_kinds.iter().map(|k| k.as_str()).collect::<Vec<_>>(),
            "requiresChangeset": self.requires_changeset,
            "requiresScope": self.requires_scope,
            "trusted": self.trusted,
        })
    }
}

const NOTE_KINDS: &[ObjectKind] = &[ObjectKind::Document, ObjectKind::Block];
const NOTHING: &[ObjectKind] = &[];

/// 查一个工具的能力 / look up one tool's capability.
///
/// 未知名字失败关闭：写、高风险、要 ChangeSet、不可信。
pub fn capability_of(name: &str) -> ToolCapability {
    let risk = base_risk_level(name);

    // 控制面：不碰用户数据，也不该被 scope 或 ChangeSet 约束。
    if name == "todo_write" || name == crate::tools::LIST_AVAILABLE_TOOLS {
        return ToolCapability {
            effect: Effect::Control,
            risk: RiskLevel::Low,
            target_kinds: NOTHING,
            requires_changeset: false,
            requires_scope: false,
            trusted: true,
        };
    }

    // 出网：本地什么都不改，但内容会离开这台机器，所以单独一类。
    if matches!(name, "web_search" | "fetch_web_content") {
        return ToolCapability {
            effect: Effect::Network,
            risk,
            target_kinds: NOTHING,
            requires_changeset: false,
            requires_scope: false,
            trusted: true,
        };
    }

    // 只写派生索引：这些表可以从 `.md` 重建，丢了不算丢用户内容。
    // 这份名单与 `approval::requires_approval` 的 Class C 是同一组，理由也一样。
    if matches!(name, "extract_facts" | "trigger_sync" | "rebuild_semantic_edges" | "generate_community_summaries") {
        return ToolCapability {
            effect: Effect::Reindex,
            risk,
            target_kinds: NOTE_KINDS,
            requires_changeset: false,
            requires_scope: true,
            trusted: true,
        };
    }

    // `read_skill` 名字带扩展前缀，但它是内建的读工具：读本机 SKILL.md，别的什么都不做。
    // 放在扩展判断之前，否则它会被当成第三方工具而失去 trusted。
    if name == "read_skill" {
        return ToolCapability {
            effect: Effect::Read,
            risk,
            target_kinds: NOTHING,
            requires_changeset: false,
            requires_scope: false,
            trusted: true,
        };
    }

    // 第三方：即使名字看起来像读操作也不给 trusted。
    if crate::tools::is_extension_tool(name) {
        return ToolCapability {
            effect: if is_read_only_tool(name) { Effect::Read } else { Effect::Write },
            risk,
            target_kinds: NOTHING,
            requires_changeset: !is_read_only_tool(name),
            requires_scope: true,
            trusted: false,
        };
    }

    if is_read_only_tool(name) {
        return ToolCapability {
            effect: Effect::Read,
            risk,
            target_kinds: read_targets(name),
            requires_changeset: false,
            requires_scope: false,
            trusted: true,
        };
    }

    // 已知写工具与未登记的新工具走同一条路：写、要 ChangeSet、要 scope。
    // 区别只在 `trusted`——内建工具的代码在这个仓库里，第三方的不在。
    ToolCapability {
        effect: Effect::Write,
        risk,
        target_kinds: write_targets(name),
        requires_changeset: true,
        requires_scope: true,
        trusted: true,
    }
}

/// 读工具能寻址什么 / what a read tool can address.
fn read_targets(name: &str) -> &'static [ObjectKind] {
    match name {
        "read_memory" | "search_memory" => &[ObjectKind::Memory],
        "get_note_facts" | "query_temporal" | "get_timeline" | "get_global_timeline" => {
            &[ObjectKind::Document, ObjectKind::Fact]
        }
        _ => NOTE_KINDS,
    }
}

/// 图谱写工具改的是边，不是笔记正文 / graph writers touch edges, not note bodies.
///
/// 声明 `Relation` 而不是 `Document` 是一条越权边界：`add_relation` 拿到的许可不该
/// 顺带让它改一篇笔记的正文，而 `edit_note` 的许可也不该让它偷偷连线。
const RELATION_KINDS: &[ObjectKind] = &[ObjectKind::Relation];

/// 写工具能寻址什么 / what a write tool can address.
///
/// 未登记的工具落到 `NOTE_KINDS`：一个没登记的工具不该被推断出"能改记忆"。
fn write_targets(name: &str) -> &'static [ObjectKind] {
    match name {
        "update_memory" => &[ObjectKind::Memory],
        "propagate_fact_update" => &[ObjectKind::Fact, ObjectKind::Document],
        "add_relation" | "delete_relation" | "batch_link_notes" => RELATION_KINDS,
        _ => NOTE_KINDS,
    }
}

/// 这个工具能不能碰这一类对象 / may this tool address this kind of object.
///
/// 用于 ChangeSet 校验：一个只声明了 `document` 的工具提交了改 `memory` 的操作，
/// 是越权，必须在提交前拦住。
pub fn may_target(name: &str, kind: ObjectKind) -> bool {
    let cap = capability_of(name);
    cap.target_kinds.contains(&kind)
}

/// 未确认的写入是否被允许 / is this write allowed at all.
///
/// 唯一的硬拦截点：不可信来源的写入永远要走 ChangeSet 与审批，不存在"这次算了"。
pub fn write_needs_review(name: &str) -> bool {
    let cap = capability_of(name);
    matches!(cap.effect, Effect::Write) && (cap.requires_changeset || !cap.trusted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 没登记的工具按最危险处理 / an unregistered tool is treated as dangerous.
    ///
    /// 这条是本模块存在的理由。反过来（默认放行）意味着任何人加一个工具就顺便
    /// 拿到了绕过 ChangeSet 的权限。
    #[test]
    fn an_unknown_tool_fails_closed() {
        let cap = capability_of("some_tool_nobody_registered");
        assert_eq!(cap.effect, Effect::Write);
        assert_eq!(cap.risk, RiskLevel::High);
        assert!(cap.requires_changeset);
        assert!(cap.requires_scope);
        assert!(write_needs_review("some_tool_nobody_registered"));
    }

    /// 第三方工具不可信 / third-party tools never get trusted.
    #[test]
    fn extension_tools_are_never_trusted() {
        for name in ["mcp_github_create_issue", "skill_do_thing"] {
            assert!(!capability_of(name).trusted, "{name} must not be trusted");
        }
        // `read_skill` 名字带扩展前缀，但它是内建的读工具。
        let read_skill = capability_of("read_skill");
        assert_eq!(read_skill.effect, Effect::Read);
        assert!(read_skill.trusted);
        assert!(capability_of("mcp_x_write").requires_changeset);
    }

    /// 读工具不需要 ChangeSet / read tools never need a changeset.
    #[test]
    fn read_tools_need_no_changeset() {
        for name in ["search_notes", "read_note", "get_backlinks", "query_database"] {
            let cap = capability_of(name);
            assert_eq!(cap.effect, Effect::Read, "{name}");
            assert!(!cap.requires_changeset, "{name}");
            assert!(!write_needs_review(name), "{name}");
        }
    }

    /// 控制面工具不碰知识对象 / control-plane tools address nothing.
    #[test]
    fn control_tools_address_no_knowledge_objects() {
        let cap = capability_of("todo_write");
        assert_eq!(cap.effect, Effect::Control);
        assert!(cap.target_kinds.is_empty());
        assert!(!may_target("todo_write", ObjectKind::Document));
    }

    /// 索引重建不算改用户内容 / reindexing is not a content write.
    #[test]
    fn reindex_tools_are_separated_from_content_writes() {
        for name in ["trigger_sync", "rebuild_semantic_edges", "extract_facts"] {
            let cap = capability_of(name);
            assert_eq!(cap.effect, Effect::Reindex, "{name}");
            assert!(!cap.requires_changeset, "{name}");
        }
    }

    /// 越权目标要被拦住 / an out-of-declaration target is refused.
    #[test]
    fn a_note_tool_may_not_address_memory() {
        assert!(may_target("edit_note", ObjectKind::Document));
        assert!(!may_target("edit_note", ObjectKind::Memory));
        assert!(may_target("update_memory", ObjectKind::Memory));
        assert!(!may_target("update_memory", ObjectKind::Document));
    }

    /// 风险等级来自审批系统，不在这里重判 / risk is delegated, not re-derived.
    #[test]
    fn risk_is_delegated_to_the_approval_gate() {
        assert_eq!(capability_of("delete_note").risk, RiskLevel::Critical);
        assert_eq!(capability_of("create_note").risk, RiskLevel::Low);
        assert_eq!(capability_of("edit_note").risk, RiskLevel::Medium);
        assert_eq!(capability_of("merge_notes").risk, RiskLevel::High);
    }

    /// 核心工具集里没有"既写又不需要复核"的漏洞 / no core tool writes unreviewed.
    ///
    /// 注意 Canvas/GraphRAG 那四个工具（`compile_canvas_to_note` 等）目前没有在
    /// `approval::base_risk_level` 里登记，所以落到兜底的 High + 需要 ChangeSet。
    /// 这是**正确的失败方向**：没人判过的工具按危险处理。这条测试锁的就是这一点，
    /// 而不是假装它们已经被分类过。
    #[test]
    fn no_core_tool_can_write_without_review() {
        for name in crate::tools::CORE_TOOLS {
            let cap = capability_of(name);
            if cap.effect == Effect::Write {
                assert!(
                    cap.requires_changeset,
                    "{name} writes but does not require a changeset"
                );
                assert!(write_needs_review(name), "{name}");
            }
        }
    }

    /// Canvas 与 GraphRAG 工具具有明确的风险与能力分级。
    #[test]
    fn the_canvas_and_graphrag_tools_are_explicitly_classified() {
        let cap_compile = capability_of("compile_canvas_to_note");
        assert_eq!(cap_compile.effect, Effect::Write);
        assert_eq!(cap_compile.risk, RiskLevel::Medium);
        assert!(cap_compile.requires_changeset);

        let cap_gen_canvas = capability_of("generate_canvas_from_notes");
        assert_eq!(cap_gen_canvas.effect, Effect::Write);
        assert_eq!(cap_gen_canvas.risk, RiskLevel::Low);
        assert!(cap_gen_canvas.requires_changeset);

        let cap_communities = capability_of("query_graph_communities");
        assert_eq!(cap_communities.effect, Effect::Read);
        assert_eq!(cap_communities.risk, RiskLevel::Low);
        assert!(!cap_communities.requires_changeset);

        let cap_summaries = capability_of("generate_community_summaries");
        assert_eq!(cap_summaries.effect, Effect::Reindex);
        assert_eq!(cap_summaries.risk, RiskLevel::Low);
        assert!(!cap_summaries.requires_changeset);
    }
}
