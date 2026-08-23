//! 写路径守卫 / the guard that forces agent writes through a ChangeSet.
//!
//! ## 它补的是哪个洞
//!
//! [`changeset`](super::changeset) 有了提议、预演、冲突检测与记账，但它不知道工具
//! 参数长什么样，也刻意不碰文件系统。于是"Agent 的写入必须走 ChangeSet"这句话在
//! 那一层还只是个约定——只要有人直接调 `note_ops`，约定就作废了。
//!
//! 本模块把约定变成代码：它挂在 `execute_tool` 的调用点上。凡是
//! `capability::capability_of(tool).requires_changeset` 为真的调用，都必须先拿到
//! 一个 [`Guarded::Ready`] 才能执行，执行完必须 [`settle`]。
//!
//! ## 为什么分成 open / settle 两半
//!
//! 真实写盘留在 `note_ops`（快照、回收站、journal、undo、wikilink retarget 都在那
//! 儿），本模块不去抢那份工作。所以：
//!
//! - [`open`] 在写之前跑：映射参数 → 定位对象 → scope/能力校验 → 预演冲突 → 记审批；
//! - 中间调用方去写盘；
//! - [`settle`] 在写之后跑：把落定的内容与新路径记账，或者把失败如实记下来。
//!
//! 中间那一步故意不搬进来。硬把文件 IO 塞进 rusqlite 事务，只会得到一个 SQLite 能
//! 回滚、磁盘不能的四不像。
//!
//! ## 未映射的写工具
//!
//! 参数形状读不懂的写工具**不会被放过，也不会被放行**：[`open`] 直接返回
//! [`Guarded::Refused`]，changeset 记成 `rejected`。放行等于让一次写入绕过预览、基线
//! 和回滚，只在审计里留下一个空批次；假装知道目标同样危险。
//!
//! 现在落在这一类里的是三种写入：目录（`create_folder` / `delete_folder`）、关系表
//! （`add_relation` / `delete_relation` / `batch_link_notes`）、以及目标要等模型跑完才
//! 知道的（`propagate_fact_update`）；第三方 MCP 的写工具也一样。它们共同的问题是这一
//! 层的 op 模型只描述"某个文件/对象的某一版变成另一版"，而目录、关系行、事后才确定的
//! 目标都不是那个形状。要让它们能写，得先给 op 模型补上对应的种类，而不是在这里放行。
//!
//! [`intents_of`] 已经覆盖的是笔记与画布文件、`fix_broken_link`、OCR/PDF 存稿，以及
//! Core Memory（`.zettelagent/memory.md`）。
//!
//! ## 冲突检测覆盖到哪里，没覆盖到哪里
//!
//! 基线取的是 **Agent 真正读到的那一版**：[`open`] 对读工具调用 [`remember_reads`]，
//! 把 `(run_id, object_id) → 版本` 记进 `agent_reads`，写的时候再取回来当
//! `expected_version`。所以下面这条路径是被拦住的：
//!
//! ```text
//! Agent 读 note.md（v3）→ 用户手改成 v4 → Agent 基于 v3 写 → StaleRead 冲突，不落盘
//! ```
//!
//! 没覆盖到的还有两处，都写出来而不是留一个 TODO：
//!
//! - **没先读就写**。`create_note`、以及模型凭上下文里的旧内容直接改而这一轮没调过
//!   读工具的情况，没有读记录，基线退回到"准备写入这一刻"。这时确实无从知道 Agent
//!   看到的是哪一版，编一个只会制造假冲突。
//! - **跨轮的读**。读记录按 `run_id` 分桶，上一轮读的不会成为这一轮的基线：轮之间
//!   上下文可能已经被压缩，那份"读过"未必还在模型眼前。

use rusqlite::{params, Connection, OptionalExtension};

use super::changeset::{self, DryRunReport, NewChangeSet, NewOp, ObservedRead, Refusal};
use super::object_store::{self, ObjectResult};
use super::types::{now_ms, ChangeOpKind, ObjectKind, SourceRef};
use crate::tools::capability;
use crate::tools::internal_tools::helpers::{
    ocr_note_relative_path, pdf_extract_relative_path, resolve_path_multi_vault, snapshot_path_key,
};

/// 一次 Agent 写调用的上下文 / who is writing, where, and under which run.
#[derive(Debug, Clone, Default)]
pub struct WriteContext {
    pub actor: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    /// 主 vault：相对路径的解析基准。
    pub primary_vault: String,
    /// 所有 vault 根目录。既是 scope，也是多库解析的候选集。
    pub vaults: Vec<String>,
}

/// 拦截的结果 / what the guard decided.
#[derive(Debug)]
pub enum Guarded {
    /// 不是知识写入（读、出网、索引、控制面）。照常执行。
    Unguarded,
    /// 拒绝执行。把 [`Refusal::message`] 回给模型，让它换个目标重试。
    Refused {
        changeset_id: Option<String>,
        refusal: Refusal,
    },
    /// 有冲突。不执行，让用户先看一眼。
    Conflicted {
        changeset_id: String,
        report: DryRunReport,
    },
    /// 可以执行。执行完**必须**调 [`settle`]，否则批次会停在 `approved`，
    /// 由 `changeset::stale_changesets` 兜底查出来。
    Ready(ReadyWrite),
}

/// 已经开好、等写盘结果的批次 / an approved change set awaiting its outcome.
#[derive(Debug, Clone)]
pub struct ReadyWrite {
    pub changeset_id: String,
    /// 这次会碰到的绝对路径，按 op 顺序。用于写盘后回读内容。
    pub paths: Vec<String>,
}

/// 改名/移动要重绑的目标 / the rebind recorded in `changeset_ops.side_effects`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SideEffect {
    /// 重命名/移动之后的绝对路径。
    new_path: String,
}

// ── 参数映射 / mapping tool arguments onto operations ────────────────────────

/// 一个工具调用打算做的事 / what a tool call intends, before any path resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Intent {
    pub kind: ChangeOpKind,
    /// 工具参数里给的路径，可能是 vault 相对路径。
    pub raw_path: String,
    /// 已经落定的完整新内容。`None` 表示要等写盘后回读（patch/append/改名）。
    pub content: Option<String>,
    /// 改名/移动的目标路径（相对或绝对，按工具的参数原样）。
    pub dest: Option<String>,
    pub target_kind: ObjectKind,
}

/// 参数形状已经登记过的写工具 / write tools whose arguments this module understands.
///
/// [`intents_of`] 对这些工具返回空 vec 只有一个含义：**这一次的参数没填全**（漏了
/// `path`、只给了一半的 merge）。对不在这张表里的写工具，空 vec 的含义完全不同：
/// 我们根本读不懂它的参数。两者都要拒绝，但给模型的话必须不一样，所以这里把"登记过"
/// 显式列出来，而不是让 `open` 去猜空 vec 是哪种空。
///
/// 加新写工具时两处一起改：这张表和 [`intents_of`] 的 match。漏改这张表的后果是那个
/// 工具被当成未映射工具拒掉——方向是安全的。
const MAPPED_WRITE_TOOLS: &[&str] = &[
    "create_note",
    "edit_note",
    "append_to_note",
    "patch_note",
    "apply_edit",
    "revert_note",
    "delete_note",
    "rename_note",
    "move_note",
    "merge_notes",
    // 画布也是文件：`canvas_path` 就是目标，落定后的 JSON 从磁盘回读。
    "create_canvas",
    "modify_canvas",
    "group_canvas_nodes",
    "arrange_canvas_by",
    "generate_canvas_from_notes",
    "compile_canvas_to_note",
    "fix_broken_link",
    // 目标由固定规则算出来，不在参数里，但依然是写之前就能算的。
    "ocr_image",
    "extract_pdf_text",
    "update_memory",
];

/// 这个工具的参数形状登记过吗 / does the guard know how to read this tool's arguments?
pub fn maps_to_operations(tool_name: &str) -> bool {
    MAPPED_WRITE_TOOLS.contains(&tool_name)
}

/// 这一次调用其实什么都不写 / this call writes nothing, despite the tool being a writer.
///
/// 三个工具有"只看不存"的模式：`compile_canvas_to_note` 不给 `output_path` 时只把
/// Markdown 返回给模型，`ocr_image` / `extract_pdf_text` 不开 `store_as_note` /
/// `save_to_vault` 时同理。这些调用没有目标，不是因为参数漏填，而是因为**确实没有目
/// 标**——给它们开一个 changeset 会让"有 changeset"不再等于"有人写过东西"，拒绝它们
/// 则会砍掉一个正常功能。
fn writes_nothing(tool_name: &str, args_json: &str) -> bool {
    let parsed: serde_json::Value =
        serde_json::from_str(args_json).unwrap_or(serde_json::Value::Null);
    let flag = |key: &str| parsed.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    match tool_name {
        "compile_canvas_to_note" => parsed
            .get("output_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty(),
        "ocr_image" => !flag("store_as_note"),
        "extract_pdf_text" => !flag("save_to_vault"),
        _ => false,
    }
}

/// 把一次工具调用拆成若干意图 / decompose one tool call.
///
/// 参数名与 `approval::build_approval_diff_data` 保持一致——同一次调用在审批卡片上
/// 和在 changeset 里必须指向同一个文件，两处各猜一遍就会出现"批准了 A、改了 B"。
///
/// 返回空 vec = 读不懂这个工具的参数。调用方据此走"未映射写入"那条路，而不是放行。
pub fn intents_of(tool_name: &str, args_json: &str) -> Vec<Intent> {
    let parsed: serde_json::Value =
        serde_json::from_str(args_json).unwrap_or(serde_json::Value::Null);
    let get = |key: &str| {
        parsed
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let note = |kind: ChangeOpKind, path: Option<String>, content: Option<String>| {
        path.filter(|p| !p.is_empty())
            .map(|raw_path| Intent {
                kind,
                raw_path,
                content,
                dest: None,
                target_kind: ObjectKind::Document,
            })
            .into_iter()
            .collect::<Vec<_>>()
    };

    match tool_name {
        "create_note" => note(ChangeOpKind::Create, get("path"), get("content")),
        "edit_note" => note(ChangeOpKind::Edit, get("path"), get("content")),
        "append_to_note" => note(ChangeOpKind::Append, get("path"), get("content")),
        // patch/apply_edit/revert 的参数里没有最终全文，内容留到写盘后回读。
        "patch_note" | "apply_edit" => note(ChangeOpKind::Patch, get("path"), None),
        "revert_note" => note(ChangeOpKind::Patch, get("note_path"), None),
        "delete_note" => note(ChangeOpKind::Delete, get("path"), None),
        "rename_note" => match (get("old_path"), get("new_path")) {
            (Some(old), Some(new)) if !old.is_empty() && !new.is_empty() => vec![Intent {
                kind: ChangeOpKind::Rename,
                raw_path: old,
                content: None,
                dest: Some(new),
                target_kind: ObjectKind::Document,
            }],
            _ => Vec::new(),
        },
        "move_note" => match (get("path"), get("destination")) {
            (Some(path), Some(dest)) if !path.is_empty() && !dest.is_empty() => vec![Intent {
                kind: ChangeOpKind::Move,
                raw_path: path,
                content: None,
                dest: Some(dest),
                target_kind: ObjectKind::Document,
            }],
            _ => Vec::new(),
        },
        // 合并是两件事：目标被改写、源被吃掉。拆成两个 op，UI 才能把"源笔记会消失"
        // 显示出来，而不是只看到目标变长了。
        "merge_notes" => {
            let mut ops = Vec::new();
            if let Some(target) = get("target_path").filter(|p| !p.is_empty()) {
                ops.push(Intent {
                    kind: ChangeOpKind::Edit,
                    raw_path: target,
                    content: None,
                    dest: None,
                    target_kind: ObjectKind::Document,
                });
            }
            if let Some(source) = get("source_path").filter(|p| !p.is_empty()) {
                ops.push(Intent {
                    kind: ChangeOpKind::Delete,
                    raw_path: source,
                    content: None,
                    dest: None,
                    target_kind: ObjectKind::Document,
                });
            }
            if ops.len() == 2 {
                ops
            } else {
                // 只拿到一半的合并没法预演。空 vec 会让 `open` 拒绝这次调用，而不是
                // 让它带着一个没有 op 的批次往下走。
                Vec::new()
            }
        }
        // 画布写入：参数里给的是节点操作，不是最终文件内容，所以内容留到写盘后回读。
        // 用 `Patch` 而不是 `Create`/`Edit`——那两个要求参数里就带全文，而画布工具的
        // 全文只有写完才存在。
        "create_canvas" | "modify_canvas" | "group_canvas_nodes" | "arrange_canvas_by"
        | "generate_canvas_from_notes" => note(ChangeOpKind::Patch, get("canvas_path"), None),
        // 不给 `output_path` 时这个工具只把 Markdown 返回给模型，由 `writes_nothing`
        // 提前放行，走不到这里。
        "compile_canvas_to_note" => note(ChangeOpKind::Patch, get("output_path"), None),
        "fix_broken_link" => note(ChangeOpKind::Patch, get("file_path"), None),
        // 目标不在参数里，而是由固定规则算出来的。算它的是工具自己那一份实现
        // （`helpers::*_relative_path`），不是这里再猜一遍——猜错的后果是守卫预览、
        // 回滚一个从来没被碰过的文件。
        "ocr_image" => note(
            ChangeOpKind::Patch,
            Some(ocr_note_relative_path(
                get("note_title").as_deref().unwrap_or("OCR Result"),
            )),
            None,
        ),
        "extract_pdf_text" => note(
            ChangeOpKind::Patch,
            get("pdf_path").map(|p| pdf_extract_relative_path(&p)),
            None,
        ),
        // Core Memory 写的是 `<vault>/.zettelagent/memory.md`，路径来自 vault 而不是
        // 参数。登记成 op 之后它才和笔记一样有版本、有 diff、能回滚。
        "update_memory" => vec![Intent {
            kind: ChangeOpKind::Patch,
            raw_path: ".zettelagent/memory.md".to_string(),
            content: None,
            dest: None,
            target_kind: ObjectKind::Memory,
        }],
        _ => Vec::new(),
    }
}

// ── 定位 / locating the real target ─────────────────────────────────────────

/// 把工具参数里的路径变成索引里用的那个字符串 / the path key the index actually uses.
///
/// `chunks.file_path` / `files.path` 存的是同步时走文件树得到的绝对路径，而工具参数
/// 给的通常是 vault 相对路径。两者对不上的后果不是报错，而是**静默失去基线**——
/// `find_by_source` 查不到对象，冲突检测就永远说"没冲突"。所以这一步必须做对。
fn path_key(ctx: &WriteContext, raw: &str) -> Option<String> {
    let resolved = resolve_path_multi_vault(raw, &ctx.primary_vault, &ctx.vaults).ok()?;
    Some(snapshot_path_key(&resolved))
}

/// 找到这个路径对应的对象 / the knowledge object backing this path, if any.
///
/// 查不到就返回 `None`：可能是还没 backfill、也可能是新建。两种都不是错误，但
/// 都意味着没有乐观并发基线，`dry_run` 会如实地不报冲突。
fn locate(conn: &Connection, key: &str) -> ObjectResult<(String, Option<String>)> {
    if let Some(object) = object_store::find_by_source(conn, &SourceRef::file(key))? {
        return Ok((key.to_string(), Some(object.id)));
    }

    // 大小写/盘符拼写不同（`d:\` vs `D:\`）会让上面的精确匹配落空。索引里存的那个
    // 拼法才是权威，拿它再试一次，顺便把 op 的路径也统一成索引的拼法。
    let stored: Option<String> = conn
        .query_row(
            "SELECT path FROM files WHERE path = ?1 COLLATE NOCASE",
            params![key],
            |r| r.get(0),
        )
        .optional()?;

    if let Some(stored) = stored {
        if stored != key {
            if let Some(object) = object_store::find_by_source(conn, &SourceRef::file(&stored))? {
                return Ok((stored, Some(object.id)));
            }
            return Ok((stored, None));
        }
    }
    Ok((key.to_string(), None))
}

/// 改名/移动之后的绝对路径 / where the note will live after the move.
///
/// `move_note` 的 `destination` 是目录，最终文件名沿用原来的——这与
/// `note_ops::execute_move_note` 的算法一致。两处算得不一样的话，重绑就会指向一个
/// 不存在的路径，对象从此与它的文件失联。
fn destination_key(ctx: &WriteContext, intent: &Intent) -> Option<String> {
    let dest = intent.dest.as_deref()?;
    match intent.kind {
        ChangeOpKind::Rename => path_key_unchecked(ctx, dest),
        ChangeOpKind::Move => {
            let old = resolve_path_multi_vault(&intent.raw_path, &ctx.primary_vault, &ctx.vaults)
                .ok()?;
            let filename = old.file_name()?;
            let dir = resolve_path_multi_vault(dest, &ctx.primary_vault, &ctx.vaults)
                .unwrap_or_else(|_| std::path::PathBuf::from(&ctx.primary_vault).join(dest));
            Some(snapshot_path_key(&dir.join(filename)))
        }
        _ => None,
    }
}

/// 目标路径还不存在时也要能算出 key / the key for a path that is not on disk yet.
///
/// 改名的目标文件在写盘前当然不存在，`resolve_path_multi_vault` 对相对路径会退回
/// 主 vault，这正是我们要的。
fn path_key_unchecked(ctx: &WriteContext, raw: &str) -> Option<String> {
    let resolved = resolve_path_multi_vault(raw, &ctx.primary_vault, &ctx.vaults)
        .unwrap_or_else(|_| std::path::PathBuf::from(&ctx.primary_vault).join(raw));
    Some(snapshot_path_key(&resolved))
}

// ── 读记录 / the read ledger ─────────────────────────────────────────────────

/// 一次读工具调用碰到的笔记 / the notes one read tool call touched.
///
/// 只认**真的把整篇内容交给模型**的那几个工具。`search_notes` 之类给的是片段，把它
/// 算成"读过这篇笔记"会让基线钉在一个模型其实没看全的版本上，之后每次写都报假冲突。
fn read_intents_of(tool_name: &str, args_json: &str) -> Vec<String> {
    let parsed: serde_json::Value =
        serde_json::from_str(args_json).unwrap_or(serde_json::Value::Null);
    match tool_name {
        "read_note" => parsed
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty())
            .map(|p| vec![p.to_string()])
            .unwrap_or_default(),
        "batch_read_notes" => parsed
            .get("paths")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str())
                    .filter(|p| !p.is_empty())
                    .map(|p| p.to_string())
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// 读记录保留多久 / how long a read stays usable as a baseline.
///
/// 一天。超过这个跨度的"读"不该再决定一次写入的基线，而这个表也不该无限长大。
const READ_LEDGER_TTL_MS: i64 = 86_400_000;

/// 记下 Agent 这一轮读到了哪一版 / record the version the agent just saw.
///
/// 在工具**执行之前**记，而不是之后。之后记会拿到用户刚改出来的新版本号，配上模型
/// 实际读到的旧内容——那正是静默覆盖的配方。之前记最坏是多报一次冲突，方向是安全的。
pub fn remember_reads(
    conn: &Connection,
    ctx: &WriteContext,
    tool_name: &str,
    args_json: &str,
) -> ObjectResult<usize> {
    let paths = read_intents_of(tool_name, args_json);
    if paths.is_empty() {
        return Ok(0);
    }

    let run_id = ctx.run_id.clone().unwrap_or_default();
    let now = now_ms();
    let mut recorded = 0usize;

    for raw in paths {
        let Some(key) = path_key(ctx, &raw) else { continue };
        let (_, object_id) = locate(conn, &key)?;
        // 没有对象就没有版本可记。这不是错误：backfill 还没覆盖到的笔记本来也没有基线。
        let Some(object_id) = object_id else { continue };
        let Some(object) = object_store::get_object(conn, &object_id)? else {
            continue;
        };
        let checksum = object_store::get_object_version(conn, &object_id, object.current_version)?
            .map(|v| v.checksum);

        conn.execute(
            "INSERT INTO agent_reads (run_id, object_id, version, checksum, read_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(run_id, object_id) DO UPDATE SET
                version = ?3, checksum = ?4, read_at_ms = ?5",
            params![run_id, object_id, object.current_version, checksum, now],
        )?;
        recorded += 1;
    }

    conn.execute(
        "DELETE FROM agent_reads WHERE read_at_ms < ?1",
        params![now - READ_LEDGER_TTL_MS],
    )?;
    Ok(recorded)
}

/// 取这一轮对某个对象的读记录 / the baseline this run's read established.
fn baseline_from_read(
    conn: &Connection,
    run_id: &str,
    object_id: &str,
) -> ObjectResult<Option<ObservedRead>> {
    let row = conn
        .query_row(
            "SELECT version, checksum, read_at_ms FROM agent_reads
             WHERE run_id = ?1 AND object_id = ?2 AND read_at_ms >= ?3",
            params![run_id, object_id, now_ms() - READ_LEDGER_TTL_MS],
            |r| {
                Ok(ObservedRead {
                    version: r.get(0)?,
                    checksum: r.get(1)?,
                    read_at_ms: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

// ── 写之前 / before the write ────────────────────────────────────────────────

/// 拦下一次工具调用 / gate one tool call.
///
/// 审批本身已经在上游发生过了（`approval::decide` 在 orchestrator 循环里，早于工具
/// 执行器被调用）。所以这里直接 [`changeset::record_decision`]`(true)` 记的是一件
/// 已经发生的事实，不是本模块自己批的——审批逻辑有两份实现的那天，就是它们开始不
/// 一致的那天。
pub fn open(
    conn: &Connection,
    ctx: &WriteContext,
    tool_name: &str,
    args_json: &str,
) -> ObjectResult<Guarded> {
    if !capability::capability_of(tool_name).requires_changeset {
        // 读也要留痕：它是后面那次写的基线来源。记失败不该让一次读失败——降级成
        // "没有读记录"，基线退回当前版本，行为回到本模块升级之前的样子。
        if let Err(e) = remember_reads(conn, ctx, tool_name, args_json) {
            log::warn!("read baseline not recorded for {tool_name}: {e}");
        }
        return Ok(Guarded::Unguarded);
    }

    // 写工具的"只看不存"模式：没有目标，也确实没有写入。开一个空 changeset 会污染
    // 审计（"有 changeset"不再等于"有人写过东西"），拒绝会砍掉一个正常功能。
    if writes_nothing(tool_name, args_json) {
        return Ok(Guarded::Unguarded);
    }

    let mut req = NewChangeSet::new(if ctx.actor.is_empty() { "agent" } else { &ctx.actor });
    req.session_id = ctx.session_id.clone();
    req.run_id = ctx.run_id.clone();
    req.intent = Some(tool_name.to_string());
    req.scopes = ctx.vaults.clone();
    let cs = changeset::propose(conn, &req)?;

    let intents = intents_of(tool_name, args_json);
    // 一个 op 都解析不出来时必须拒绝，不能放行。
    //
    // 这是 §7.6 那个漏洞：`intents` 为空时下面的循环一次都不跑，`dry_run` 对一个没有
    // op 的批次当然报"无冲突"，于是 `record_decision(true)` 把它记成已批准，函数返回
    // `Ready { paths: [] }`——调用方照常执行工具。结果是**写操作绕过了整套 ChangeSet
    // 保障**（没有预览、没有基线、没有可回滚的 op），而审计里留下一个空批次，看起来
    // 一切正常。
    //
    // 拒绝的理由分两种，因为回给模型的话不同：登记过的工具是这次参数没填全，重试有
    // 用；没登记过的工具（canvas、第三方 MCP 写入）是它的写入压根还不能预览和回滚，
    // 让它"补全参数重试"是假建议。
    if intents.is_empty() {
        let refusal = if maps_to_operations(tool_name) {
            Refusal::NoResolvableOperation(tool_name.to_string())
        } else {
            Refusal::UnmappedWriteTool(tool_name.to_string())
        };
        changeset::set_state(conn, &cs.id, super::types::ChangeSetState::Rejected, None)?;
        return Ok(Guarded::Refused {
            changeset_id: Some(cs.id),
            refusal,
        });
    }

    let run_key = ctx.run_id.clone().unwrap_or_default();
    let mut paths = Vec::new();

    for intent in &intents {
        // scope 判断交给 `resolve_path_multi_vault`：它已经是全仓库唯一的"路径在不在
        // 库里"的答案，再写一个前缀比较就是第二份实现。
        let Some(key) = path_key(ctx, &intent.raw_path) else {
            changeset::set_state(conn, &cs.id, super::types::ChangeSetState::Rejected, None)?;
            return Ok(Guarded::Refused {
                changeset_id: Some(cs.id),
                refusal: Refusal::OutOfScope(intent.raw_path.clone()),
            });
        };
        let (key, object_id) = locate(conn, &key)?;

        let mut op = NewOp::new(intent.kind, tool_name);
        op.legacy_path = Some(key.clone());
        op.target_object_id = object_id.clone();
        op.new_content = intent.content.clone();
        op.target_kind = intent.target_kind;
        // 基线取 Agent 这一轮读到的那一版。没读过就留空，`baseline_of` 会退回当前版本。
        op.observed_read = match &object_id {
            Some(id) => baseline_from_read(conn, run_key.as_str(), id)?,
            None => None,
        };
        op.side_effects = destination_key(ctx, intent)
            .and_then(|new_path| serde_json::to_string(&SideEffect { new_path }).ok());

        match changeset::add_op(conn, &cs.id, &ctx.vaults, &op)? {
            Ok(_) => paths.push(key),
            Err(refusal) => {
                changeset::set_state(conn, &cs.id, super::types::ChangeSetState::Rejected, None)?;
                return Ok(Guarded::Refused {
                    changeset_id: Some(cs.id),
                    refusal,
                });
            }
        }
    }

    let report = changeset::dry_run(conn, &cs.id)?;
    if report.has_conflicts {
        return Ok(Guarded::Conflicted {
            changeset_id: cs.id,
            report,
        });
    }

    changeset::record_decision(conn, &cs.id, true)?;
    Ok(Guarded::Ready(ReadyWrite {
        changeset_id: cs.id,
        paths,
    }))
}

// ── 写之后 / after the write ─────────────────────────────────────────────────

/// 记账 / book the outcome of the real write.
///
/// `outcome` 是 `note_ops` 的返回值：`Ok(())` = 文件已经落盘，`Err(msg)` = 没落盘。
/// 两种都必须报回来。什么都不调的话批次会停在 `approved`，靠
/// `changeset::stale_changesets` 才能发现——那是兜底，不是正常路径。
pub fn settle(conn: &Connection, ready: &ReadyWrite, outcome: Result<(), &str>) -> ObjectResult<()> {
    if let Err(error) = outcome {
        changeset::mark_failed(conn, &ready.changeset_id, error)?;
        return Ok(());
    }

    backfill_landed_content(conn, &ready.changeset_id)?;
    apply_rebinds(conn, &ready.changeset_id)?;
    changeset::record_commit(conn, &ready.changeset_id)?;
    Ok(())
}

/// 把落盘后的真实内容补进 op / read back what actually landed.
///
/// `patch_note` / `apply_edit` / `merge_notes` 的参数里没有最终全文，写之前也算不出
/// 来。写之后文件里那份才是事实，所以在记账前回读一次。
///
/// 不回读的代价不是"少记一版"，而是**记一个假指纹**：`record_commit` 会给对象写一个
/// 空内容的新版本，下一次写入就会撞上一个不存在的 checksum 冲突。
fn backfill_landed_content(conn: &Connection, changeset_id: &str) -> ObjectResult<()> {
    for op in changeset::list_ops(conn, changeset_id)? {
        if op.new_content.is_some() {
            continue;
        }
        // 删除与改名不需要内容：一个变墓碑，一个只换 source_id。
        if matches!(
            op.op_kind,
            ChangeOpKind::Delete | ChangeOpKind::Rename | ChangeOpKind::Move
        ) {
            continue;
        }
        let Some(path) = &op.legacy_path else { continue };
        let Ok(body) = std::fs::read_to_string(path) else {
            continue;
        };
        conn.execute(
            "UPDATE changeset_ops SET new_content = ?2 WHERE id = ?1",
            params![op.id, body],
        )?;
    }
    Ok(())
}

/// 改名后把对象重新绑到新路径 / repoint moved objects at their new file.
///
/// 对象 ID 不变，只有 `source_id` 跟着走。这正是对象身份不能等于 `file_path` 的
/// 理由：改一次名如果换掉身份，evidence、relation、changeset 全指向空气。
fn apply_rebinds(conn: &Connection, changeset_id: &str) -> ObjectResult<()> {
    for op in changeset::list_ops(conn, changeset_id)? {
        if !matches!(op.op_kind, ChangeOpKind::Rename | ChangeOpKind::Move) {
            continue;
        }
        let Some(object_id) = &op.target_object_id else {
            continue;
        };
        let Some(raw) = &op.side_effects else { continue };
        let Ok(effect) = serde_json::from_str::<SideEffect>(raw) else {
            continue;
        };
        object_store::rebind_source(conn, object_id, &SourceRef::file(&effect.new_path))?;
    }
    Ok(())
}




