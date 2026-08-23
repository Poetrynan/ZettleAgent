//! ContextCompiler：把召回结果编译成带 provenance 的结构化上下文。
//!
//! 这个模块存在的唯一理由是一条纪律：**检索结果不得直接拼进 prompt**。
//! 原来的路径是 `core_memory_context` / `archival_recalled` / `memories_context` /
//! current file / attached context 各自 `format!` 成一段字符串，然后串起来。那样做
//! 有三个后果：模型看不出哪句话有出处、UI 无法解释为什么召回了这些、超预算时不知道
//! 被砍掉了什么。
//!
//! 这里把它们统一成一个 [`ContextPackage`]：每一项带来源、置信度和 warning，
//! 预算裁剪有记录，最后由 [`ContextPackage::render`] 一次性渲染成 prompt 片段。
//!
//! ## 与 `llm::context` 的分工
//!
//! `llm::context` 继续负责 token 预算、tool schema 计费、MicroCompact、full fold、
//! turn atomicity 和 fold 前的 memory flush——那是**对话记录**的压缩。本模块负责
//! **知识选择**：这一轮该带哪些事实、记忆、任务进来。两件事不该在一个地方做。

use serde::Serialize;

use crate::knowledge::retrieval::{self, RetrievalQuery, RetrievedItem};
use crate::knowledge::types::ObjectKind;

/// 这一轮的意图 / the turn's intent.
///
/// 与 `agents::TurnIntent` 是两个东西：那个决定用哪套工具和策略，这个决定上下文
/// 该偏向什么。写入类意图需要更完整的当前笔记内容，问答类更需要广召回。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextIntent {
    Answer,
    Write,
    Plan,
    Research,
    Execute,
    Reflect,
}

impl ContextIntent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Answer => "answer",
            Self::Write => "write",
            Self::Plan => "plan",
            Self::Research => "research",
            Self::Execute => "execute",
            Self::Reflect => "reflect",
        }
    }

    /// 写入类意图更需要当前笔记的完整内容，问答类更需要广召回。
    fn favors_current_object(&self) -> bool {
        matches!(self, Self::Write | Self::Execute)
    }
}

/// 路由意图 → 上下文意图 / map the router's intent onto a context intent.
///
/// 两套枚举刻意不合并：`TurnIntent` 决定用哪个 agent 和哪些工具，会随产品形态变；
/// `ContextIntent` 只决定上下文偏向，粒度粗得多。合并会让任何一次路由改动都牵动
/// 召回行为。`Composite` 取第一个子意图——复合任务的第一步决定它现在需要什么。
impl From<&crate::agents::intent::TurnIntent> for ContextIntent {
    fn from(intent: &crate::agents::intent::TurnIntent) -> Self {
        use crate::agents::intent::TurnIntent as T;
        match intent {
            T::Write => Self::Write,
            T::Curate => Self::Execute,
            T::Analyze => Self::Research,
            T::Diagnose => Self::Reflect,
            T::Search | T::VaultStats | T::Chitchat | T::Unknown => Self::Answer,
            T::Composite(parts) => parts
                .first()
                .map(Self::from)
                .unwrap_or(Self::Answer),
        }
    }
}

/// 编译的输入 / what the compiler is given.
#[derive(Debug, Clone)]
pub struct CompileRequest {
    pub query: String,
    pub intent: ContextIntent,
    pub scopes: Vec<String>,
    pub current_file: Option<String>,
    /// 前端已解析好的附件内容。会被包成带来源的 context item，而不是裸字符串。
    pub attached_context: Option<String>,
    /// `memory.md` 的当前内容。稳定的核心记忆不逐轮全量复制，只取与本轮相关的段。
    pub core_memory: Option<String>,
    /// 本轮已经通过其它路径进 prompt 的文本（如 system prompt 里的 `memories_context`）。
    ///
    /// 新记忆激活时会投影回 `ai_memory`，所以同一条声明可能两边都召回得到。这里做
    /// 一次原文包含检查，重复的就不再进包——同一句话说两遍不会让模型更相信它，
    /// 只会浪费预算并让 Context Inspector 里出现看不懂的重复项。
    pub already_injected: Option<String>,
    pub query_embedding: Option<Vec<f32>>,
    pub max_tokens: usize,
    pub top_k: usize,
}

impl CompileRequest {
    pub fn new(query: impl Into<String>, intent: ContextIntent) -> Self {
        Self {
            query: query.into(),
            intent,
            scopes: Vec::new(),
            current_file: None,
            attached_context: None,
            core_memory: None,
            already_injected: None,
            query_embedding: None,
            max_tokens: 4000,
            top_k: 8,
        }
    }
}

/// 一条进入上下文的知识 / one piece of knowledge that made it into the context.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub object_id: Option<String>,
    pub kind: ObjectKind,
    pub title: String,
    pub content: String,
    /// 回到原文的坐标。为 `None` 时 UI 必须显示为不可验证。
    pub locator: Option<String>,
    pub scope: String,
    pub score: f64,
    pub why: Vec<String>,
    pub warnings: Vec<String>,
    pub evidence_ids: Vec<String>,
}

impl From<RetrievedItem> for ContextItem {
    fn from(item: RetrievedItem) -> Self {
        Self {
            object_id: item.object_id,
            kind: item.kind,
            title: item.title,
            content: item.excerpt,
            locator: item.locator,
            scope: item.scope,
            score: item.score,
            why: item.why_matched,
            warnings: item.warnings,
            evidence_ids: item.evidence_ids,
        }
    }
}

/// 预算账 / the budget ledger.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    pub max_tokens: usize,
    pub used_tokens: usize,
    /// 被裁掉的候选数。为 0 才说明"全都装下了"。
    pub truncated_candidates: usize,
}

/// 编译产物 / the compiled context.
///
/// 结构体本身就是 Context Inspector 的数据源——UI 显示的东西和进 prompt 的东西是
/// 同一份，不存在"界面上说召回了 A，实际给模型的是 B"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackage {
    pub query: String,
    pub intent: ContextIntent,
    pub scope: Vec<String>,
    pub current_object: Option<ContextItem>,
    pub facts: Vec<ContextItem>,
    pub memories: Vec<ContextItem>,
    pub open_tasks: Vec<ContextItem>,
    pub related_objects: Vec<ContextItem>,
    /// 互相矛盾的条目对。两边都留着，由用户或后续轮次裁决。
    pub conflicts: Vec<ContextItem>,
    /// 明确知道自己不知道的：召回为空、只有 legacy 身份、向量索引未就绪。
    pub knowledge_gaps: Vec<String>,
    pub warnings: Vec<String>,
    pub budget: ContextBudget,
}

/// 编译一次上下文 / compile one turn's context.
///
/// 失败时返回 `Err`，调用方应降级为旧的字符串路径而不是让这一轮挂掉：上下文编译是
/// 增强，不是必需品。
pub fn compile(
    conn: &rusqlite::Connection,
    req: &CompileRequest,
) -> anyhow::Result<ContextPackage> {
    let mut q = RetrievalQuery::new(req.query.clone());
    q.query_embedding = req.query_embedding.clone();
    q.scopes = req.scopes.clone();
    q.current_file = req.current_file.clone();
    q.top_k = req.top_k;
    // 留一部分预算给当前笔记和核心记忆，不让召回把额度吃光。
    q.max_tokens = req.max_tokens.saturating_mul(3) / 4;

    let result = retrieval::retrieve(conn, &q)
        .map_err(|e| anyhow::anyhow!("unified retrieval failed: {e}"))?;

    let mut pkg = ContextPackage {
        query: req.query.clone(),
        intent: req.intent,
        scope: req.scopes.clone(),
        current_object: None,
        facts: Vec::new(),
        memories: Vec::new(),
        open_tasks: Vec::new(),
        related_objects: Vec::new(),
        conflicts: Vec::new(),
        knowledge_gaps: Vec::new(),
        warnings: result.warnings.clone(),
        budget: ContextBudget {
            max_tokens: req.max_tokens,
            used_tokens: result.used_tokens,
            truncated_candidates: result.truncated_candidates,
        },
    };

    // 分桶：按 kind 和"是否扩展而来"归类，UI 与 prompt 用的是同一份分类。
    for item in result.items {
        let expanded = item.warnings.iter().any(|w| w == "expanded");
        let is_current = req
            .current_file
            .as_deref()
            .is_some_and(|current| current == item.legacy_source_id);
        let conflicting = item.warnings.iter().any(|w| w == "conflicting");
        // 已经从别的路径进过 prompt 的记忆不再重复一遍（见 `already_injected`）。
        // 只对记忆做：笔记摘录碰巧出现在别处是正常的，记忆声明重复则一定是投影。
        if item.kind == ObjectKind::Memory {
            if let Some(injected) = &req.already_injected {
                if !item.excerpt.trim().is_empty() && injected.contains(item.excerpt.trim()) {
                    continue;
                }
            }
        }
        let ctx: ContextItem = item.into();

        if conflicting {
            pkg.conflicts.push(ctx);
        } else if is_current {
            pkg.current_object = Some(ctx);
        } else if expanded {
            pkg.related_objects.push(ctx);
        } else {
            match ctx.kind {
                ObjectKind::Memory => pkg.memories.push(ctx),
                ObjectKind::Task => pkg.open_tasks.push(ctx),
                _ => pkg.facts.push(ctx),
            }
        }
    }

    // 核心记忆：只取与本轮相关的段，而不是每轮无条件复制整个 memory.md。
    if let Some(core) = &req.core_memory {
        if let Some(relevant) = select_relevant_core_memory(core, &req.query) {
            pkg.memories.insert(
                0,
                ContextItem {
                    object_id: None,
                    kind: ObjectKind::Memory,
                    title: "core memory".into(),
                    content: relevant,
                    locator: Some(".zettelagent/memory.md".into()),
                    scope: String::new(),
                    score: 1.0,
                    why: vec!["core_memory".into()],
                    // 用户可直接编辑这个文件，所以它是 user-authored 而非模型推断。
                    warnings: Vec::new(),
                    evidence_ids: Vec::new(),
                },
            );
        }
    }

    // 附件包成带来源的一项，而不是并进正文——模型要能分清"用户贴给我的"和"我搜到的"。
    if let Some(attached) = &req.attached_context {
        if !attached.trim().is_empty() {
            pkg.facts.insert(
                0,
                ContextItem {
                    object_id: None,
                    kind: ObjectKind::Resource,
                    title: "attached by user".into(),
                    content: attached.clone(),
                    locator: None,
                    scope: String::new(),
                    score: 1.0,
                    why: vec!["user_attached".into()],
                    warnings: Vec::new(),
                    evidence_ids: Vec::new(),
                },
            );
        }
    }

    // 写入类意图下当前笔记缺位是一个真实缺口，必须说出来而不是当作没事。
    if req.intent.favors_current_object() && pkg.current_object.is_none() {
        pkg.knowledge_gaps
            .push("no current note in context for a write-intent turn".into());
    }
    if pkg.facts.is_empty() && pkg.memories.is_empty() {
        pkg.knowledge_gaps.push("retrieval returned nothing".into());
    }
    let legacy_only = pkg
        .facts
        .iter()
        .filter(|f| f.warnings.iter().any(|w| w == "no_stable_identity"))
        .count();
    if legacy_only > 0 {
        pkg.knowledge_gaps.push(format!(
            "{legacy_only} result(s) have no stable object identity yet (backfill pending)"
        ));
    }

    Ok(pkg)
}

/// 从 `memory.md` 里挑出与本轮相关的段 / pick the relevant sections of core memory.
///
/// 稳定的核心记忆不该每轮无条件全量进 prompt——那既烧 token 又稀释注意力。
///
/// 门槛是**相对**的，不是"沾到一个字就算相关"：CJK 按单字切词，一个虚词（"是"、
/// "的"）就能让任何一段拿到正分。所以先算出最高分，只保留达到最高分一半的段。
/// 一段都没匹配上时返回 `None`。
fn select_relevant_core_memory(core: &str, query: &str) -> Option<String> {
    let tokens = crate::db::memory_store::tokenize(query);
    if tokens.is_empty() {
        return None;
    }

    // `memory.md` v2 用 `## <section>` 分段（见 `workspace_ops::StructuredMemory`）。
    let scored: Vec<(&str, f64)> = core
        .split("\n## ")
        .filter(|section| !section.trim().is_empty())
        .map(|section| {
            (
                section,
                crate::db::memory_store::lexical_overlap(&tokens, section),
            )
        })
        .collect();

    let best = scored.iter().map(|(_, s)| *s).fold(0.0f64, f64::max);
    if best <= 0.0 {
        return None;
    }
    let floor = best / 2.0;

    let kept: Vec<&str> = scored
        .into_iter()
        .filter(|(_, score)| *score >= floor)
        .map(|(section, _)| section)
        .collect();

    if kept.is_empty() {
        return None;
    }
    Some(kept.join("\n\n"))
}

impl ContextPackage {
    /// 渲染成 prompt 片段 / render into a prompt fragment.
    ///
    /// **唯一**允许把知识变成 prompt 文本的地方。每一项都带 kind、来源坐标和
    /// warning，所以模型能自己判断"这条能不能当事实用"，而不是把所有输入等价看待。
    /// 冲突项刻意并列呈现并明说是冲突——藏起一边比两边都给更危险。
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("<knowledge_context>\n");

        if let Some(current) = &self.current_object {
            out.push_str("## 当前笔记 / current note\n");
            out.push_str(&render_item(current));
        }

        render_section(&mut out, "## 相关知识 / retrieved knowledge", &self.facts);
        render_section(&mut out, "## 长期记忆 / memories", &self.memories);
        render_section(&mut out, "## 未完成事项 / open items", &self.open_tasks);
        render_section(&mut out, "## 关联笔记 / related", &self.related_objects);

        if !self.conflicts.is_empty() {
            out.push_str("## 冲突事实 / conflicting claims\n");
            out.push_str("以下条目互相矛盾，尚未裁决。回答时必须指出冲突，不要择一当作事实。\n");
            for item in &self.conflicts {
                out.push_str(&render_item(item));
            }
        }

        if !self.knowledge_gaps.is_empty() {
            out.push_str("## 已知缺口 / known gaps\n");
            for gap in &self.knowledge_gaps {
                out.push_str(&format!("- {gap}\n"));
            }
        }

        if self.budget.truncated_candidates > 0 {
            out.push_str(&format!(
                "\n（另有 {} 条候选因上下文预算被裁剪。）\n",
                self.budget.truncated_candidates
            ));
        }

        out.push_str("</knowledge_context>\n");
        out
    }

    /// 这一份上下文里有没有任何东西 / is there anything here at all.
    ///
    /// 调用方据此决定要不要把片段塞进 prompt——空的 `<knowledge_context>` 只会浪费
    /// token 并且让模型以为"检索过了但什么都没有"，那是两件不同的事。
    pub fn is_empty(&self) -> bool {
        self.current_object.is_none()
            && self.facts.is_empty()
            && self.memories.is_empty()
            && self.open_tasks.is_empty()
            && self.related_objects.is_empty()
            && self.conflicts.is_empty()
    }

    /// 给 `agent-event` 用的精简摘要 / a compact summary for the inspector event.
    ///
    /// 不带正文：事件是要过 IPC 的，把全部召回内容再发一遍既浪费又可能把私密内容
    /// 写进前端日志。
    pub fn inspector_summary(&self) -> serde_json::Value {
        serde_json::json!({
            "query": self.query,
            "intent": self.intent.as_str(),
            "scope": self.scope,
            "counts": {
                "facts": self.facts.len(),
                "memories": self.memories.len(),
                "openTasks": self.open_tasks.len(),
                "related": self.related_objects.len(),
                "conflicts": self.conflicts.len(),
            },
            "items": self.all_items_with_section().map(|(section, i)| serde_json::json!({
                "objectId": i.object_id,
                "kind": i.kind.as_str(),
                // 哪个桶召回的它。UI 靠这个把条目分组成人话标题（当前笔记 / 事实 /
                // 记忆 / 未完成的事 / 相关 / 冲突），而不是自己按 kind 猜。
                "section": section,
                "title": i.title,
                "locator": i.locator,
                "score": i.score,
                "why": i.why,
                "warnings": i.warnings,
                // 只有 id，没有正文。Evidence 抽屉要看原文时再按 id 去
                // `knowledge_get_evidence` 取，摘要本身仍然不搬内容。
                "evidenceIds": i.evidence_ids,
            })).collect::<Vec<_>>(),
            "knowledgeGaps": self.knowledge_gaps,
            "warnings": self.warnings,
            "budget": self.budget,
        })
    }

    /// 遍历所有进包条目，带上它来自哪个桶。
    ///
    /// 顺序就是 `render()` 写进 prompt 的顺序，所以 Inspector 列出的次序和模型读到
    /// 的次序一致。
    fn all_items_with_section(&self) -> impl Iterator<Item = (&'static str, &ContextItem)> {
        self.current_object
            .iter()
            .map(|i| ("current", i))
            .chain(self.facts.iter().map(|i| ("fact", i)))
            .chain(self.memories.iter().map(|i| ("memory", i)))
            .chain(self.open_tasks.iter().map(|i| ("task", i)))
            .chain(self.related_objects.iter().map(|i| ("related", i)))
            .chain(self.conflicts.iter().map(|i| ("conflict", i)))
    }
}

fn render_section(out: &mut String, heading: &str, items: &[ContextItem]) {
    if items.is_empty() {
        return;
    }
    out.push_str(heading);
    out.push('\n');
    for item in items {
        out.push_str(&render_item(item));
    }
}

fn render_item(item: &ContextItem) -> String {
    let mut head = format!("- [{}] {}", item.kind.as_str(), item.title);
    if let Some(locator) = &item.locator {
        head.push_str(&format!(" ({locator})"));
    }
    if !item.warnings.is_empty() {
        head.push_str(&format!(" ⚠ {}", item.warnings.join(",")));
    }
    format!("{head}\n  {}\n", item.content.replace('\n', "\n  "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::intent::TurnIntent;
    use rusqlite::{params, Connection};

    /// 与生产同一条建库路径 / the same schema path production runs.
    fn db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        crate::knowledge::migration::run_knowledge_migrations(&conn).unwrap();
        conn
    }

    fn add_note(conn: &Connection, path: &str, title: &str, body: &str) {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, ?2, ?3)",
            params![path, format!("h-{title}"), title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type)
             VALUES (?1, 0, ?2, '', 'user')",
            params![path, body],
        )
        .unwrap();
    }

    /// 意图映射是稳定的 / the intent mapping is explicit, not incidental.
    #[test]
    fn router_intents_map_onto_context_intents() {
        assert_eq!(ContextIntent::from(&TurnIntent::Write), ContextIntent::Write);
        assert_eq!(ContextIntent::from(&TurnIntent::Curate), ContextIntent::Execute);
        assert_eq!(ContextIntent::from(&TurnIntent::Analyze), ContextIntent::Research);
        assert_eq!(ContextIntent::from(&TurnIntent::Search), ContextIntent::Answer);
        // 复合任务的第一步决定它现在需要什么上下文。
        assert_eq!(
            ContextIntent::from(&TurnIntent::Composite(vec![TurnIntent::Write, TurnIntent::Search])),
            ContextIntent::Write
        );
        assert_eq!(
            ContextIntent::from(&TurnIntent::Composite(vec![])),
            ContextIntent::Answer
        );
    }

    /// 空包不渲染 / an empty package must not emit an empty tag block.
    ///
    /// 空的 `<knowledge_context>` 会让模型以为"检索过了但库里什么都没有"，那和
    /// "这一轮没检索"是两件不同的事。
    #[test]
    fn an_empty_package_reports_itself_as_empty() {
        let conn = db();
        let req = CompileRequest::new("完全无关的查询 xyzzy", ContextIntent::Answer);
        let pkg = compile(&conn, &req).unwrap();

        assert!(pkg.is_empty());
        assert!(pkg.knowledge_gaps.iter().any(|g| g.contains("nothing")));
    }

    /// 召回的每一项都带出处 / every rendered item carries its locator.
    #[test]
    fn rendered_items_carry_their_locator_back_to_the_source() {
        let conn = db();
        add_note(&conn, "d:/vault/latency.md", "Latency", "latency budget accounting");

        let req = CompileRequest::new("latency budget", ContextIntent::Answer);
        let pkg = compile(&conn, &req).unwrap();
        let rendered = pkg.render();

        assert!(rendered.contains("<knowledge_context>"));
        assert!(rendered.contains("d:/vault/latency.md#chunk:"), "got {rendered}");
        // backfill 没跑，所以必须如实标出来。
        assert!(rendered.contains("no_stable_identity"));
    }

    /// 用户附件是独立一项，不并进正文 / attachments stay distinguishable.
    #[test]
    fn attached_context_becomes_its_own_provenanced_item() {
        let conn = db();
        let mut req = CompileRequest::new("总结一下", ContextIntent::Answer);
        req.attached_context = Some("用户贴进来的一段话".to_string());
        let pkg = compile(&conn, &req).unwrap();

        assert_eq!(pkg.facts.len(), 1);
        assert_eq!(pkg.facts[0].kind, crate::knowledge::types::ObjectKind::Resource);
        assert!(pkg.facts[0].why.contains(&"user_attached".to_string()));
        assert!(pkg.render().contains("用户贴进来的一段话"));
    }

    /// 核心记忆只带相关段 / core memory contributes only the relevant sections.
    ///
    /// 每轮复制整个 `memory.md` 既烧 token 又稀释注意力。
    #[test]
    fn core_memory_contributes_only_the_sections_that_match() {
        let conn = db();
        let core = "## 偏好\n- 用户偏好 rerank 相关的笔记\n\n## 无关段\n- 咖啡机型号是 XYZ\n";

        let mut req = CompileRequest::new("rerank 的偏好是什么", ContextIntent::Answer);
        req.core_memory = Some(core.to_string());
        let pkg = compile(&conn, &req).unwrap();

        let core_item = pkg
            .memories
            .iter()
            .find(|m| m.why.contains(&"core_memory".to_string()))
            .expect("the matching section must be carried");
        assert!(core_item.content.contains("rerank"));
        assert!(
            !core_item.content.contains("咖啡机"),
            "an unrelated section must not ride along: {}",
            core_item.content
        );

        // 一段都不相关时不带任何核心记忆进来。
        let mut unrelated = CompileRequest::new("quantum chromodynamics", ContextIntent::Answer);
        unrelated.core_memory = Some(core.to_string());
        let pkg = compile(&conn, &unrelated).unwrap();
        assert!(pkg.memories.is_empty());
    }

    /// 已经进过 prompt 的记忆不重复 / an already-injected memory is not repeated.
    ///
    /// 记忆激活时会投影回 `ai_memory`，两条路径会召回同一句话。说两遍不会让模型
    /// 更相信它，只会浪费预算并让 Inspector 里出现看不懂的重复项。
    #[test]
    fn a_memory_already_in_the_prompt_is_not_added_twice() {
        let conn = db();
        let claim = "用户偏好 Zettelkasten 方法论";
        let mut proposal = crate::knowledge::memory::MemoryProposal::new(
            crate::knowledge::types::MemoryKind::Semantic,
            claim,
            "d:/vault",
        );
        proposal.user_requested = true;
        proposal.confidence = 0.95;
        crate::knowledge::memory::propose(&conn, proposal).unwrap();

        let mut req = CompileRequest::new("Zettelkasten 方法论", ContextIntent::Answer);
        req.scopes = vec!["d:/vault".to_string()];
        let with_dup = compile(&conn, &req).unwrap();
        assert_eq!(with_dup.memories.len(), 1, "baseline: the memory is recalled");

        req.already_injected = Some(format!("### Recalled Memory\n- {claim}\n"));
        let deduped = compile(&conn, &req).unwrap();
        assert!(deduped.memories.is_empty(), "got {:?}", deduped.memories);
    }

    /// 写入意图缺当前笔记要说出来 / a write turn with no open note admits the gap.
    #[test]
    fn a_write_intent_without_a_current_note_reports_the_gap() {
        let conn = db();
        let pkg = compile(&conn, &CompileRequest::new("改一下这段", ContextIntent::Write)).unwrap();

        assert!(
            pkg.knowledge_gaps
                .iter()
                .any(|g| g.contains("no current note")),
            "got {:?}",
            pkg.knowledge_gaps
        );
        assert!(pkg.render().contains("已知缺口"));
    }

    /// Inspector 摘要不带正文 / the inspector summary carries no body text.
    ///
    /// 这个事件要过 IPC 并可能落进前端日志，把召回内容再发一遍既浪费又可能泄漏。
    #[test]
    fn the_inspector_summary_never_carries_body_text() {
        let conn = db();
        add_note(&conn, "d:/vault/secret.md", "Secret", "the passphrase is hunter2");

        let pkg = compile(&conn, &CompileRequest::new("passphrase", ContextIntent::Answer)).unwrap();
        assert!(pkg.render().contains("hunter2"), "the prompt does get the content");

        let summary = serde_json::to_string(&pkg.inspector_summary()).unwrap();
        assert!(
            !summary.contains("hunter2"),
            "the inspector event must stay metadata-only: {summary}"
        );
        assert!(summary.contains("d:/vault/secret.md"), "but the locator is fine");
    }

    /// 上下文与渲染同源 / the inspector and the prompt see the same items.
    #[test]
    fn the_inspector_and_the_prompt_are_the_same_data() {
        let conn = db();
        add_note(&conn, "d:/vault/a.md", "A", "graph traversal notes");
        add_note(&conn, "d:/vault/b.md", "B", "graph traversal caveats");

        let pkg = compile(&conn, &CompileRequest::new("graph traversal", ContextIntent::Answer)).unwrap();
        let summary = pkg.inspector_summary();
        let listed = summary["items"].as_array().unwrap().len();

        let rendered = pkg.render();
        for item in pkg.facts.iter() {
            assert!(rendered.contains(&item.title), "{} missing from the prompt", item.title);
        }
        assert_eq!(listed, pkg.facts.len() + pkg.memories.len() + pkg.open_tasks.len()
            + pkg.related_objects.len() + pkg.conflicts.len()
            + usize::from(pkg.current_object.is_some()));
    }

    /// 每个条目都说清自己是哪个桶召回的 / every item names the bucket it came from.
    ///
    /// Context Inspector 的默认视图按人话分组（当前笔记 / 事实 / 记忆 / …）。分组
    /// 依据必须来自后端，否则前端只能按 `kind` 猜，猜错了显示的分类就是假的。
    #[test]
    fn the_inspector_summary_names_each_items_section() {
        let conn = db();
        add_note(&conn, "d:/vault/a.md", "A", "graph traversal notes");

        let mut req = CompileRequest::new("graph traversal", ContextIntent::Answer);
        req.current_file = Some("d:/vault/a.md".to_string());
        let pkg = compile(&conn, &req).unwrap();
        let summary = pkg.inspector_summary();
        let items = summary["items"].as_array().unwrap();
        assert!(!items.is_empty(), "expected at least the current note");

        for item in items {
            let section = item["section"].as_str().expect("section is always present");
            assert!(
                matches!(section, "current" | "fact" | "memory" | "task" | "related" | "conflict"),
                "unknown section {section}"
            );
            // 证据 id 出现，证据正文不出现。
            assert!(item["evidenceIds"].is_array(), "evidenceIds is always an array");
        }
        assert_eq!(
            items[0]["section"].as_str(),
            Some("current"),
            "the current note is listed first, matching the prompt order"
        );
    }
}
