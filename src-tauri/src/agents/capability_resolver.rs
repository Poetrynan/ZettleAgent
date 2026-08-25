//! Domain-aware tool surface expansion for Agent turns.
//!
//! `ToolScope::All` deliberately resolves to `CORE_TOOLS` so unclassified turns
//! do not pay the full ~10k-token schema tax. That is correct for chitchat and
//! simple Q&A — but wrong when the user is clearly asking about the vault's
//! structure, graph, canvas, or health: those tools *exist* in the catalogue,
//! yet the model never sees their ToolDefs and invents "I don't have get_graph".
//!
//! This module answers one question: given the user text and classified intent,
//! which extra catalogue tools should join the schema list for *this* turn?
//! It is not a second permission system — write tools still go through
//! capability / approval / write_guard.

use crate::agents::intent::TurnIntent;
use crate::llm::ToolDef;

// ── Domain-Specific Capability Packs ───────────────────────────────

/// Canvas Reasoning Pack: interactive reasoning, visual layout & graph-to-canvas compiling
pub const CANVAS_REASONING_TOOLS: &[&str] = &[
    "read_canvas",
    "modify_canvas",
    "create_canvas",
    "knowledge_canvas_plan",
    "group_canvas_nodes",
    "arrange_canvas_by",
    "compile_canvas_to_note",
    "generate_canvas_from_notes",
];

/// Graph Diagnose Pack: topological health, lint, isolated nodes & repair planning
pub const GRAPH_DIAGNOSE_TOOLS: &[&str] = &[
    "get_graph",
    "get_local_graph",
    "find_shortest_path",
    "run_lint",
    "knowledge_graph_plan",
    "get_vault_stats",
];

/// Graph Explore Pack: relations, communities, clusters & semantic topology
pub const GRAPH_EXPLORE_TOOLS: &[&str] = &[
    "get_graph",
    "get_local_graph",
    "query_relations",
    "get_relations_by_type",
    "explain_relationship",
    "query_graph_communities",
    "generate_community_summaries",
];

/// MOC Construction Pack: structure note creation & evidence-backed MOC drafting
pub const MOC_CONSTRUCTION_TOOLS: &[&str] = &[
    "generate_structure_note",
    "knowledge_create_moc_draft",
    "batch_read_notes",
    "get_note_metadata",
];

/// Evidence Investigation Pack: temporal tracking, fact verification & note comparisons
pub const EVIDENCE_INVESTIGATION_TOOLS: &[&str] = &[
    "get_note_facts",
    "query_temporal",
    "compare_notes",
    "get_timeline",
    "get_global_timeline",
    "get_embedding_status",
];

/// Memory Lifecycle Pack: user preferences, profile & memory updates
pub const MEMORY_LIFECYCLE_TOOLS: &[&str] = &[
    "read_memory",
    "search_memory",
    "update_memory",
];

/// Read-focused knowledge tools that must be reachable without a discovery
/// round-trip when the request is about structure, graph, canvas, or health.
pub const KNOWLEDGE_BROAD_TOOLS: &[&str] = &[
    "get_graph",
    "get_local_graph",
    "find_shortest_path",
    "query_relations",
    "run_lint",
    "get_vault_stats",
    "read_canvas",
    "modify_canvas",
    "create_canvas",
    "knowledge_canvas_plan",
    "group_canvas_nodes",
    "arrange_canvas_by",
    "compile_canvas_to_note",
    "generate_canvas_from_notes",
    "get_note_metadata",
    "compare_notes",
    "get_timeline",
    "get_note_facts",
    "get_global_timeline",
    "generate_structure_note",
    "explain_relationship",
    "query_temporal",
    "get_embedding_status",
    "query_graph_communities",
    "generate_community_summaries",
    "knowledge_graph_plan",
    "knowledge_create_moc_draft",
    "batch_read_notes",
];

/// Signals that the request is about the knowledge base even when the
/// classifier landed on `Unknown` (or a low-confidence composite).
const KNOWLEDGE_SIGNALS: &[&str] = &[
    // ZH
    "笔记",
    "知识库",
    "知识",
    "vault",
    "结构",
    "关系",
    "图谱",
    "链接",
    "白板",
    "画布",
    "主题",
    "moc",
    "证据",
    "事实",
    "记忆",
    "任务",
    "整理",
    "连接",
    "孤立",
    "重复",
    "依赖",
    "研究",
    "组织",
    "断着",
    "断裂",
    "连接性",
    "冗余",
    "盲区",
    "审查",
    "审计",
    "卡片",
    "社区",
    // EN
    "note",
    "notes",
    "graph",
    "canvas",
    "relation",
    "relationship",
    "orphan",
    "structure",
    "structural",
    "cluster",
    "community",
    "backlink",
    "wikilink",
    "knowledge",
    "zettel",
    "lint",
    "bridge",
    "contradict",
];

/// True when the query mentions knowledge-domain work.
pub fn has_knowledge_signals(query: &str) -> bool {
    let q = query.to_lowercase();
    KNOWLEDGE_SIGNALS.iter().any(|s| q.contains(s))
}

/// Whether this turn should widen the schema with [`KNOWLEDGE_BROAD_TOOLS`].
pub fn should_expand_knowledge_broad(intent: &TurnIntent, query: &str) -> bool {
    match intent {
        // Already scoped precisely — no need to pile on.
        TurnIntent::Chitchat | TurnIntent::VaultStats | TurnIntent::Search | TurnIntent::Write => {
            false
        }
        // These scopes already name their tools; expanding would only help if
        // a sub-intent was Unknown inside a Composite (handled below).
        TurnIntent::Analyze | TurnIntent::Diagnose | TurnIntent::Curate => false,
        TurnIntent::Unknown => has_knowledge_signals(query),
        TurnIntent::Composite(parts) => {
            parts.iter().any(|p| matches!(p, TurnIntent::Unknown)) && has_knowledge_signals(query)
        }
    }
}

/// Merge catalogue tools named in `extra` into `visible`, preserving order and
/// skipping names that are not registered.
pub fn merge_named_tools(visible: &mut Vec<ToolDef>, catalogue: &[ToolDef], extra: &[&str]) -> Vec<String> {
    let mut added = Vec::new();
    for name in extra {
        if visible.iter().any(|t| t.function.name == *name) {
            continue;
        }
        if let Some(def) = catalogue.iter().find(|t| t.function.name == *name) {
            visible.push(def.clone());
            added.push((*name).to_string());
        }
    }
    added
}

/// Detect the specific domain matching the user's inquiry
pub fn detect_domain(query: &str) -> &'static str {
    let q = query.to_lowercase();
    if q.contains("白板") || q.contains("画布") || q.contains("canvas") || q.contains("board") {
        "canvas_reasoning"
    } else if q.contains("moc") || q.contains("结构笔记") || q.contains("大纲") || q.contains("目录") {
        "moc_construction"
    } else if q.contains("诊断") || q.contains("孤立") || q.contains("断着") || q.contains("断裂") || q.contains("盲区") || q.contains("lint") || q.contains("orphan") {
        "graph_diagnose"
    } else if q.contains("社区") || q.contains("聚类") || q.contains("cluster") || q.contains("community") {
        "graph_explore"
    } else if q.contains("证据") || q.contains("事实") || q.contains("时序") || q.contains("时间线") || q.contains("timeline") || q.contains("temporal") {
        "evidence_investigation"
    } else if q.contains("记忆") || q.contains("偏好") || q.contains("档案") || q.contains("memory") {
        "memory_lifecycle"
    } else {
        "knowledge_broad"
    }
}

/// Expand the visible ToolDef list for this turn when knowledge signals demand it.
///
/// Returns `(added_tool_names, domain_identifier)` so the caller can emit
/// a localized, domain-aware `capability_expanded` event.
pub fn expand_visible_tools(
    visible: &mut Vec<ToolDef>,
    catalogue: &[ToolDef],
    intent: &TurnIntent,
    query: &str,
) -> (Vec<String>, &'static str) {
    if !should_expand_knowledge_broad(intent, query) {
        return (Vec::new(), "none");
    }
    let domain = detect_domain(query);
    let tools_to_add = match domain {
        "canvas_reasoning" => CANVAS_REASONING_TOOLS,
        "moc_construction" => MOC_CONSTRUCTION_TOOLS,
        "graph_diagnose" => GRAPH_DIAGNOSE_TOOLS,
        "graph_explore" => GRAPH_EXPLORE_TOOLS,
        "evidence_investigation" => EVIDENCE_INVESTIGATION_TOOLS,
        "memory_lifecycle" => MEMORY_LIFECYCLE_TOOLS,
        _ => KNOWLEDGE_BROAD_TOOLS,
    };
    let added = merge_named_tools(visible, catalogue, tools_to_add);
    (added, domain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::intent::TurnIntent;

    #[test]
    fn knowledge_signals_catch_structure_review_phrasing() {
        assert!(has_knowledge_signals(
            "对整个知识库进行结构性审查，识别孤立卡片，发现冗余话题，并找出潜在的 MOC 机会。"
        ));
        assert!(has_knowledge_signals(
            "帮我看看这些内容之间到底是怎么组织起来的，哪些地方还断着。"
        ));
        assert!(has_knowledge_signals(
            "around this topic build a canvas with support and contradict edges"
        ));
        assert!(!has_knowledge_signals("你好"));
        assert!(!has_knowledge_signals("what is the capital of France"));
    }

    #[test]
    fn domain_detection_routes_accurately() {
        assert_eq!(detect_domain("在白板上构建推理画布"), "canvas_reasoning");
        assert_eq!(detect_domain("基于这几篇笔记生成一个 MOC 目录"), "moc_construction");
        assert_eq!(detect_domain("审查知识库盲区和孤立卡片"), "graph_diagnose");
        assert_eq!(detect_domain("查看知识图谱社区分布"), "graph_explore");
        assert_eq!(detect_domain("探索这一结论的事实证据和时间线"), "evidence_investigation");
        assert_eq!(detect_domain("更新我的用户偏好记忆档案"), "memory_lifecycle");
    }

    #[test]
    fn unknown_with_knowledge_signals_expands() {
        assert!(should_expand_knowledge_broad(
            &TurnIntent::Unknown,
            "帮我看看这些内容之间到底是怎么组织起来的，哪些地方还断着。"
        ));
        assert!(!should_expand_knowledge_broad(
            &TurnIntent::Unknown,
            "what time is it in Tokyo"
        ));
    }

    #[test]
    fn diagnose_does_not_double_expand() {
        // Diagnose already carries get_graph / run_lint via ToolScope::Only.
        assert!(!should_expand_knowledge_broad(
            &TurnIntent::Diagnose,
            "扫描知识库盲区"
        ));
    }

    #[test]
    fn expand_adds_domain_tools_to_core_surface() {
        let catalogue = crate::tools::get_all_tool_defs(&[], &[]);
        let mut visible = catalogue
            .iter()
            .filter(|t| crate::tools::CORE_TOOLS.contains(&t.function.name.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        assert!(!visible.iter().any(|t| t.function.name == "get_graph"));

        let (added, domain) = expand_visible_tools(
            &mut visible,
            &catalogue,
            &TurnIntent::Unknown,
            "检查知识库结构和孤立笔记",
        );
        assert_eq!(domain, "graph_diagnose");
        assert!(added.contains(&"get_graph".to_string()));
        assert!(added.contains(&"run_lint".to_string()));
        assert!(visible.iter().any(|t| t.function.name == "get_graph"));
        assert!(visible.iter().any(|t| t.function.name == "run_lint"));
        // Still not the full catalogue.
        assert!(visible.len() < catalogue.len());
    }

    #[test]
    fn all_domain_pack_tools_exist_in_catalogue() {
        let catalogue = crate::tools::get_all_tool_defs(&[], &[]);
        let names: Vec<&str> = catalogue.iter().map(|t| t.function.name.as_str()).collect();
        for required in KNOWLEDGE_BROAD_TOOLS {
            assert!(
                names.contains(required),
                "{required} must exist in the internal catalogue"
            );
        }
    }
}
