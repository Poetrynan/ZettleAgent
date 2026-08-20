//! 共享的 `[[wikilink]]` 解析与归一化解析表。
//! Shared `[[wikilink]]` parsing and link resolution.
//!
//! ## 为什么单独成一个模块 / Why this is its own module
//!
//! Three features answer the same question — "which note does `[[X]]` point at?"
//! — and each used to answer it differently:
//!
//! * `commands::file_commands::get_backlinks` (sidebar backlink panel) did an
//!   exact `content.contains("[[title]]")` substring test, so `[[标题|别名]]` and
//!   `[[标题#小节]]` were invisible to it.
//! * `db::search::build_graph_data_uncached` (knowledge graph) normalised the raw
//!   text *between* the brackets. `normalize_title` drops `|` and `#` but keeps
//!   what follows, so `标题|别名` became `标题别名` — which matches no note
//!   either. It then fell back to a `filename_norm.contains(link_norm)` fuzzy
//!   test, a substring match that can attach a link to the wrong note entirely.
//! * `db::notes_overview` (health desk) split off `|alias` / `#heading` *before*
//!   normalising, and was the only one of the three that got it right.
//!
//! Net effect: one `[[标题|别名]]` was counted by the health desk, missed by the
//! backlink panel, and missed by the graph — same data, three different numbers.
//! The parser and the resolver now live here and all three call this module, so
//! "同一条链接 ⇒ 同一个答案 / same link ⇒ same answer" is a property of the code
//! rather than a coincidence.
//!
//! `db/search.rs` was rejected as the home: it is already 2k+ lines of FTS,
//! vector, rerank and graph code, and `commands::file_commands` should not have
//! to reach into search internals for a text-parsing helper. `normalize_title`
//! deliberately stays in `db::search` (several unrelated call sites already
//! import it from there) and is used from here, so key derivation also has
//! exactly one definition.
//!
//! ## 去重不在这里 / De-duplication is NOT shared
//!
//! The three callers legitimately differ: `get_backlinks` de-dupes by source
//! path (one row per linking note), `notes_overview` counts a `HashSet` of
//! sources, and the graph builder emits one edge per resolved link and de-dupes
//! by `(source, target, type, label)` later. Only *parsing and matching* is
//! shared; each caller keeps its own de-dupe policy.
//!
//! ## UTF-8 铁律 / The UTF-8 iron rule
//!
//! Every slice below is taken at a byte offset returned by `find` on an ASCII
//! delimiter (`[[`, `]]`, `|`, `#`), which is always a char boundary, so
//! `[[中文标题|别名]]` cannot panic. Callers that truncate the surrounding text
//! (the backlink `context` snippet) must use `chars().take(n)`, never byte
//! slicing.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::db::search::normalize_title;

/// 文件名（去掉 `.md`，小写）。Filename without the `.md` extension, lowercased.
///
/// Shared so that the resolver's stem key and the callers' own stem handling
/// cannot drift apart.
pub fn file_stem_lower(path: &str) -> String {
    let norm = path.replace('\\', "/");
    let base = norm.rsplit('/').next().unwrap_or(&norm).to_lowercase();
    base.strip_suffix(".md").unwrap_or(&base).to_string()
}

/// Turn a raw link target — or a note title, or a file stem — into the key both
/// sides of a match are compared on.
///
/// `normalize_title` already lowercases; the explicit `to_lowercase` is kept
/// because the three original call sites all did it and dropping it would be a
/// silent semantic change for anything locale-sensitive.
pub fn link_key(raw: &str) -> String {
    normalize_title(&raw.to_lowercase())
}

/// Strip the decorations off the inside of a `[[…]]` and return the link target.
///
/// Handles Obsidian's four shapes: `[[标题]]`, `[[标题|别名]]`, `[[标题#小节]]`
/// and `[[标题|别名#小节]]`. Leading `[[` / trailing `]]` are tolerated so this
/// also accepts the bracketed strings stored in `card_meta.links`.
///
/// Returns `None` for an empty target (`[[]]`, `[[#小节]]`), which is not a link.
pub fn parse_link_target(raw: &str) -> Option<String> {
    let inner = raw.trim();
    let inner = inner.strip_prefix("[[").unwrap_or(inner);
    let inner = inner.strip_suffix("]]").unwrap_or(inner);
    // `|` first: in `[[标题|别名#小节]]` the heading belongs to the alias, and in
    // `[[标题#小节|别名]]` it belongs to the title. Cutting at `|` then at `#`
    // yields the bare title in both orders.
    let target = inner.split('|').next().unwrap_or(inner);
    let target = target.split('#').next().unwrap_or(target).trim();
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

/// 一处 wikilink 命中 / One `[[wikilink]]` occurrence together with its line.
///
/// The line is carried because `get_backlinks` has to show the user *where* the
/// link is; re-deriving it with a second, differently-written scan is exactly how
/// the three implementations drifted apart in the first place.
pub struct WikilinkHit<'a> {
    /// Link target with `|alias` / `#heading` already stripped, not normalised.
    pub target: String,
    /// The source line the link appeared on, untrimmed.
    pub line: &'a str,
}

/// Scan note text for wikilinks, one hit per occurrence, in document order.
///
/// Scanning is **per line** on purpose: Obsidian wikilinks never span lines, and
/// a line-local scan both keeps an unclosed `[[` from swallowing the next line's
/// `]]` and hands `get_backlinks` its context line for free.
pub fn wikilink_hits(content: &str) -> Vec<WikilinkHit<'_>> {
    let mut out = Vec::new();
    for line in content.lines() {
        let mut cursor = 0usize;
        while let Some(open_rel) = line[cursor..].find("[[") {
            let open = cursor + open_rel;
            let Some(close_rel) = line[open..].find("]]") else { break };
            let close = open + close_rel;
            if let Some(target) = parse_link_target(&line[open + 2..close]) {
                out.push(WikilinkHit { target, line });
            }
            cursor = close + 2;
        }
    }
    out
}

/// Just the targets, for callers that do not need the context line.
pub fn wikilink_targets(content: &str) -> Vec<String> {
    wikilink_hits(content).into_iter().map(|h| h.target).collect()
}

/// 只替换标题段，保留 `|别名` 与 `#小节` / Retarget wikilinks, keeping decorations.
///
/// Rewrites the **title segment** of every `[[…]]` in `content` whose target
/// normalises to `from`, replacing it with `to` and leaving `|alias` / `#heading`
/// byte-for-byte intact. Returns the new text and the number of links rewritten.
///
/// ## 为什么必须有这个函数 / Why matching was not enough
///
/// `rename_note` and `merge_notes` used `content.replace("[[old]]", "[[new]]")`
/// (note_ops.rs). That is a *bare-link-only* rewrite: after renaming a note, every
/// `[[老标题|别名]]` and `[[老标题#小节]]` in the vault was left pointing at a title
/// that no longer exists, i.e. a refactor silently manufactured broken links —
/// data loss, not a cosmetic miss. Matching alone (`parse_link_target`) cannot fix
/// it, because the fix has to *preserve* the very parts the parser throws away.
///
/// ## 边界 / Behaviour boundary
///
/// * Comparison is on [`link_key`], so the same normalisation that decides
///   "does `[[X]]` point at this note?" decides "should `[[X]]` be rewritten?".
///   A link the resolver would *not* route to the renamed note is never touched.
/// * `from`/`to` are compared as keys: a rename that only changes punctuation or a
///   leading number (things `normalize_title` discards) is a no-op here, because
///   the old spelling still resolves to the new note anyway.
/// * Whitespace padding inside the brackets is preserved: `[[ 老 ]]` → `[[ 新 ]]`.
/// * `to` is inserted verbatim. Callers pass a file stem, and the OS already
///   rejects `[`, `]`, `|`, `#`… in file names on Windows, so a `to` that would
///   re-break the link is not reachable from `rename_note`/`merge_notes`.
///
/// **UTF-8**: every offset below comes from `find` on an ASCII delimiter or from
/// `trim`, both of which land on char boundaries, so `[[中文标题|别名#小节]]` is
/// rewritten without ever splitting a multi-byte char.
pub fn rewrite_link_targets(content: &str, from: &str, to: &str) -> (String, usize) {
    let from_key = link_key(from);
    // An empty key matches nothing; equal keys mean the link already resolves to
    // the new note, so rewriting would only churn the file.
    if from_key.is_empty() || from_key == link_key(to) {
        return (content.to_string(), 0);
    }

    let mut out = String::with_capacity(content.len());
    let mut count = 0usize;
    let mut cursor = 0usize;

    while let Some(open_rel) = content[cursor..].find("[[") {
        let open = cursor + open_rel;
        let Some(close_rel) = content[open..].find("]]") else { break };
        let close = open + close_rel;
        let inner = &content[open + 2..close];

        // Wikilinks are line-local (same rule as `wikilink_hits`): a stray `[[`
        // must not pair with a `]]` on a later line. Emit the `[[` and move past it.
        if inner.contains('\n') {
            out.push_str(&content[cursor..open + 2]);
            cursor = open + 2;
            continue;
        }

        // Split at the first `|` or `#`, whichever comes first: everything before
        // it is the title segment, everything from it on is the alias/heading tail
        // that must survive untouched.
        let cut = match (inner.find('|'), inner.find('#')) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => inner.len(),
        };
        let (title_seg, tail) = (&inner[..cut], &inner[cut..]);
        let trimmed = title_seg.trim();

        if !trimmed.is_empty() && link_key(trimmed) == from_key {
            // Keep the padding the user wrote. `trim_start`/`trim` return
            // subslices, so these lengths are char-boundary offsets by construction.
            let lead = title_seg.len() - title_seg.trim_start().len();
            out.push_str(&content[cursor..open + 2]);
            out.push_str(&title_seg[..lead]);
            out.push_str(to);
            out.push_str(&title_seg[lead + trimmed.len()..]);
            out.push_str(tail);
            out.push_str("]]");
            count += 1;
        } else {
            out.push_str(&content[cursor..close + 2]);
        }
        cursor = close + 2;
    }

    out.push_str(&content[cursor..]);
    (out, count)
}

/// 目录公共前缀长度 / length of the shared *directory* prefix of two paths.
///
/// Moved here verbatim from `db::schema` (it was private to
/// `find_file_path_for_title_prioritized`) because the same-vault tie-break is
/// now a resolver rule rather than a write-side-only rule. Truncating to the last
/// `/` is what makes it a *directory* comparison: `…/vaultA/a.md` and
/// `…/vaultAB/b.md` share the string `…/vaultA` but no directory, and must not
/// look "near" each other.
///
/// UTF-8: the running length is a byte offset taken from `char_indices`, so the
/// slice below never splits a multi-byte char in a CJK vault path.
fn common_directory_prefix_len(p1: &str, p2: &str) -> usize {
    let p1_clean = p1.replace('\\', "/");
    let p2_clean = p2.replace('\\', "/");
    let mut len = 0;
    for ((byte_idx, c1), c2) in p1_clean.char_indices().zip(p2_clean.chars()) {
        if c1 == c2 {
            len = byte_idx + c1.len_utf8();
        } else {
            break;
        }
    }
    match p1_clean[..len].rfind('/') {
        Some(slash_idx) => slash_idx + 1,
        None => 0,
    }
}

/// `归一化键 -> 笔记路径` / normalised key → note path.
///
/// Built from the whole `files` table, keyed on **both** the note title and the
/// file stem, because users write both spellings.
///
/// ## 冲突裁决 / How a collision is decided
///
/// `normalize_title` discards punctuation and leading numbers, so several notes
/// can share one key. Every candidate is kept, **in `ORDER BY path` order**, and
/// the tie is broken at *read* time by which question is being asked:
///
/// * [`resolve`] — no context: 先写者胜 / first writer wins, i.e. the lowest path.
///   `ORDER BY path` is not cosmetic here: "first writer" is only well defined if
///   the scan order is fixed, and every view must agree on *which* note wins.
/// * [`resolve_near`] — with a `from_path`: 同 vault 优先 / prefer the candidate
///   sharing the longest directory prefix with the linking note, falling back to
///   the rule above. This is the ex-`find_file_path_for_title_prioritized`
///   behaviour, folded in so the *write* side (`note_relations`) and the *read*
///   side (panel/graph/health/related) cannot answer "which 笔记 is `[[X]]`?"
///   differently for a multi-vault user.
pub struct LinkResolver {
    /// Candidates per key, ascending by path. Almost always one element; the
    /// `Vec` exists only so the two tie-break rules above are both expressible.
    by_key: HashMap<String, Vec<String>>,
}

impl LinkResolver {
    /// One pass over `files`. Small and cheap: two `HashMap` inserts per note.
    pub fn from_files(conn: &Connection) -> rusqlite::Result<Self> {
        let mut by_key: HashMap<String, Vec<String>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT path, title FROM files ORDER BY path")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (path, title) = row?;
            let mut push = |key: String, path: &str| {
                if key.is_empty() {
                    return;
                }
                let slot = by_key.entry(key).or_default();
                // A note whose title and stem normalise alike must not appear twice.
                if !slot.iter().any(|p| p == path) {
                    slot.push(path.to_string());
                }
            };
            if let Some(t) = title.as_deref() {
                push(link_key(t), &path);
            }
            push(link_key(&file_stem_lower(&path)), &path);
        }
        Ok(Self { by_key })
    }

    /// Resolve a raw link target (as returned by [`parse_link_target`]) to the
    /// one note it points at, or `None` for a broken link.
    pub fn resolve(&self, raw_target: &str) -> Option<&str> {
        self.candidates(raw_target).first().map(|s| s.as_str())
    }

    /// Resolve with the linking note as context: 同 vault 优先 / same-vault first.
    ///
    /// Only the *tie-break* differs from [`resolve`] — an unambiguous key resolves
    /// identically either way, so this is safe to use anywhere. `from_path`
    /// `None` degrades to exactly [`resolve`].
    pub fn resolve_near(&self, raw_target: &str, from_path: Option<&str>) -> Option<&str> {
        let candidates = self.candidates(raw_target);
        let Some(from) = from_path else {
            return candidates.first().map(|s| s.as_str());
        };
        candidates
            .iter()
            // `max_by_key` returns the *last* maximum, so compare on
            // `(prefix_len, index-descending)` to keep the lowest path on a tie.
            .enumerate()
            .max_by_key(|(idx, p)| (common_directory_prefix_len(p, from), usize::MAX - idx))
            .map(|(_, p)| p.as_str())
    }

    fn candidates(&self, raw_target: &str) -> &[String] {
        let key = link_key(raw_target);
        if key.is_empty() {
            return &[];
        }
        self.by_key.get(&key).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Does `raw_target` resolve to exactly `path`? The question `get_backlinks`
    /// asks, phrased so the caller cannot accidentally compare against a
    /// differently-normalised path.
    pub fn resolves_to(&self, raw_target: &str, path: &str) -> bool {
        self.resolve(raw_target) == Some(path)
    }


    /// Does any wikilink in `content` resolve to `path`?
    pub fn content_links_to(&self, content: &str, path: &str) -> bool {
        wikilink_hits(content)
            .iter()
            .any(|h| self.resolves_to(&h.target, path))
    }

    /// The first line of `content` carrying a wikilink that resolves to `path`.
    /// This is the backlink panel's `context` source.
    pub fn first_linking_line<'a>(&self, content: &'a str, path: &str) -> Option<&'a str> {
        wikilink_hits(content)
            .into_iter()
            .find(|h| self.resolves_to(&h.target, path))
            .map(|h| h.line)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// The parser tests below pin the four Obsidian spellings. The `three_way`
// module is the point of this whole module: it asserts that the backlink panel,
// the health desk and the graph builder return *the same* answer for the same
// link. That property is what was broken.

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// Production runs `setup_database_schema` *and* `migrate_schema_columns`
    /// (db/mod.rs:35). Skipping the second drifts the fixture from the real
    /// schema, which has bitten this repo before.
    fn test_db() -> Connection {
        crate::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        crate::db::schema::migrate_schema_columns(&conn).unwrap();
        conn
    }

    fn add_note(conn: &Connection, path: &str, title: &str, body: &str) {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, 'h', ?2)",
            params![path, title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content, heading_hierarchy, marker_type)
             VALUES (?1, 0, ?2, '', 'user')",
            params![path, body],
        )
        .unwrap();
    }

    /// A note with no chunks — a link *target* that nothing has indexed yet.
    fn add_file_only(conn: &Connection, path: &str, title: &str) {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, 'h', ?2)",
            params![path, title],
        )
        .unwrap();
    }

    // ── Parser: the four Obsidian spellings ─────────────────────────────

    #[test]
    fn strips_alias_and_heading_in_both_orders() {
        assert_eq!(parse_link_target("标题").as_deref(), Some("标题"));
        assert_eq!(parse_link_target("标题|别名").as_deref(), Some("标题"));
        assert_eq!(parse_link_target("标题#小节").as_deref(), Some("标题"));
        // Combined, both orders — this is the shape that used to be missed.
        assert_eq!(parse_link_target("标题|别名#小节").as_deref(), Some("标题"));
        assert_eq!(parse_link_target("标题#小节|别名").as_deref(), Some("标题"));
        // Bracketed input (the `card_meta.links` shape) and stray whitespace.
        assert_eq!(parse_link_target("[[ 有空格 ]]").as_deref(), Some("有空格"));
        // Not links: nothing to point at.
        assert!(parse_link_target("").is_none());
        assert!(parse_link_target("#只有小节").is_none());
        assert!(parse_link_target("|只有别名").is_none());
    }

    #[test]
    fn scans_targets_in_document_order_and_survives_junk() {
        assert_eq!(wikilink_targets("a [[X]] b [[Y|alias]] c"), vec!["X", "Y"]);
        assert_eq!(wikilink_targets("[[笔记#小节]]"), vec!["笔记"]);
        assert_eq!(wikilink_targets("[[A]][[B]]"), vec!["A", "B"]);
        assert!(wikilink_targets("[[]]").is_empty());
        assert!(wikilink_targets("unclosed [[X").is_empty());
        // A `[[` on one line must not swallow a `]]` on the next: Obsidian
        // wikilinks are line-local, and so is the scan.
        assert!(wikilink_targets("open [[X\nY]] close").is_empty());
    }

    /// The UTF-8 iron rule at the parser level: every slice is taken at a byte
    /// offset from `find` on an ASCII delimiter, so CJK inside the brackets — the
    /// exact shape that used to panic elsewhere in this repo — must be fine.
    #[test]
    fn cjk_alias_and_heading_do_not_panic() {
        let hits = wikilink_hits("前文 [[中文标题|别名#小节]] 后文");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].target, "中文标题");
        assert_eq!(hits[0].line, "前文 [[中文标题|别名#小节]] 后文");
    }

    // ── Rewrite: rename/merge must keep alias and heading ───────────────

    /// 三种写法都要跟着改名 / all three decorated spellings follow a rename, with
    /// `|别名` and `#小节` byte-for-byte intact. This is the case
    /// `content.replace("[[old]]", "[[new]]")` silently broke.
    #[test]
    fn rewrite_keeps_alias_and_heading() {
        let body = "\
裸链接 [[老标题]]
别名 [[老标题|别名]]
小节 [[老标题#小节]]
两者 [[老标题|别名#小节]]
反序 [[老标题#小节|别名]]";
        let (out, n) = rewrite_link_targets(body, "老标题", "新标题");
        assert_eq!(n, 5, "every spelling is one replacement");
        assert!(out.contains("[[新标题]]"));
        assert!(out.contains("[[新标题|别名]]"));
        assert!(out.contains("[[新标题#小节]]"));
        assert!(out.contains("[[新标题|别名#小节]]"));
        assert!(out.contains("[[新标题#小节|别名]]"));
        assert!(!out.contains("老标题"), "no trace of the old title: {}", out);
    }

    /// 不指向 `from` 的链接一个字都不许动 / links to other notes are untouched,
    /// including a note whose title merely *contains* the old one.
    #[test]
    fn rewrite_leaves_unrelated_links_alone() {
        let body = "[[老标题]] 与 [[老标题的续集]] 与 [[别的笔记|老标题]] 与 老标题（裸文本）";
        let (out, n) = rewrite_link_targets(body, "老标题", "新标题");
        assert_eq!(n, 1);
        assert!(out.contains("[[新标题]]"));
        assert!(out.contains("[[老标题的续集]]"), "longer title must not be rewritten");
        // `老标题` here is the *alias*, not the target — rewriting it would change
        // what the reader sees while leaving the link pointing elsewhere.
        assert!(out.contains("[[别的笔记|老标题]]"), "alias text is not a target");
        assert!(out.contains("老标题（裸文本）"), "plain prose is not a link");
    }

    /// Whitespace padding survives, and a no-op rename does not touch the file.
    #[test]
    fn rewrite_preserves_padding_and_skips_noop_renames() {
        let (out, n) = rewrite_link_targets("[[ 老标题 ]]", "老标题", "新标题");
        assert_eq!((out.as_str(), n), ("[[ 新标题 ]]", 1));

        // `normalize_title` drops punctuation, so these two keys are equal: the old
        // spelling already resolves to the new note and rewriting is pure churn.
        let (out, n) = rewrite_link_targets("[[老标题]]", "老标题", "老标题！");
        assert_eq!((out.as_str(), n), ("[[老标题]]", 0));

        // Same for a leading-number rename: `normalize_title` strips leading digits,
        // so `202401-note` and `202402-note` share the key `note` and `[[202401-note]]`
        // still resolves to the renamed file. A surprising no-op, but the *consistent*
        // one — the alternative would rewrite links that were never broken.
        let (out, n) = rewrite_link_targets("[[202401-note]]", "202401-note", "202402-note");
        assert_eq!((out.as_str(), n), ("[[202401-note]]", 0));

        // Empty `from` matches nothing.
        let (out, n) = rewrite_link_targets("[[老标题]]", "", "新");
        assert_eq!((out.as_str(), n), ("[[老标题]]", 0));
    }

    /// 畸形输入不 panic / malformed brackets round-trip unchanged rather than
    /// panicking, and a `[[` never pairs with a `]]` on a later line.
    #[test]
    fn rewrite_survives_malformed_input() {
        for junk in [
            "[[]]",
            "[[|只有别名]]",
            "[[#只有小节]]",
            "未闭合 [[老标题",
            "跨行 [[老标题\n]] 结束",
            "]] 倒装 [[",
            "[[[[老标题]]",
        ] {
            let (out, _) = rewrite_link_targets(junk, "老标题", "新标题");
            // The only guarantee for junk is "no panic, no data lost": the text is
            // either unchanged or has the title segment swapped, never truncated.
            assert!(
                out.chars().count() >= junk.chars().count() - "老标题".chars().count(),
                "input {:?} lost text: {:?}",
                junk,
                out
            );
        }
        // Line-locality, stated positively: the cross-line `[[` is not a link, so
        // nothing is replaced.
        let (out, n) = rewrite_link_targets("跨行 [[老标题\n]] 结束", "老标题", "新标题");
        assert_eq!(n, 0);
        assert_eq!(out, "跨行 [[老标题\n]] 结束");
    }

    /// 中文全程 + 长文本 / a CJK title, alias and heading in one line, repeated,
    /// with the rest of the document preserved exactly. A byte-sliced
    /// implementation panics here.
    #[test]
    fn rewrite_is_char_safe_for_cjk() {
        let body = format!(
            "前言{}\n见 [[知识图谱|图谱#定义]] 与 [[知识图谱]]\n结尾{}",
            "补充说明".repeat(30),
            "参考文献".repeat(30)
        );
        let (out, n) = rewrite_link_targets(&body, "知识图谱", "概念地图");
        assert_eq!(n, 2);
        assert!(out.contains("[[概念地图|图谱#定义]]"));
        assert!(out.contains("[[概念地图]]"));
        assert!(out.starts_with(&format!("前言{}", "补充说明".repeat(30))));
        assert!(out.ends_with(&format!("结尾{}", "参考文献".repeat(30))));
    }

    // ── Resolver ────────────────────────────────────────────────────────

    #[test]
    fn resolves_by_title_and_by_file_stem() {
        let conn = test_db();
        // Title and stem disagree on purpose: both spellings must resolve.
        add_file_only(&conn, "d:/vault/202401-note.md", "Completely Different Title");
        let r = LinkResolver::from_files(&conn).unwrap();
        assert_eq!(r.resolve("Completely Different Title"), Some("d:/vault/202401-note.md"));
        assert_eq!(r.resolve("202401-note"), Some("d:/vault/202401-note.md"));
        // A link to nothing stays broken rather than attaching itself somewhere.
        assert_eq!(r.resolve("不存在的笔记"), None);
        assert_eq!(r.resolve(""), None);
    }

    /// 归一化冲突：先写者胜 / normalisation collision: first writer wins.
    ///
    /// `normalize_title` drops punctuation, so `重复` and `重复！` collapse to the
    /// same key. Counting the link for both would invent connectivity, so the
    /// lowest path wins — deterministically, because the resolver scans
    /// `ORDER BY path`.
    #[test]
    fn normalisation_collision_gives_the_link_to_the_first_writer() {
        let conn = test_db();
        add_file_only(&conn, "d:/vault/dup-b.md", "重复！");
        add_file_only(&conn, "d:/vault/dup-a.md", "重复");
        let r = LinkResolver::from_files(&conn).unwrap();
        assert_eq!(r.resolve("重复"), Some("d:/vault/dup-a.md"));
        assert_eq!(r.resolve("重复！"), Some("d:/vault/dup-a.md"));
        // The loser is still reachable by its own file stem, which is unambiguous.
        assert_eq!(r.resolve("dup-b"), Some("d:/vault/dup-b.md"));
    }

    #[test]
    fn content_helpers_answer_for_a_specific_target() {
        let conn = test_db();
        add_file_only(&conn, "d:/vault/知识图谱.md", "知识图谱");
        add_file_only(&conn, "d:/vault/other.md", "Other");
        let r = LinkResolver::from_files(&conn).unwrap();
        let body = "无关的一行\n参见 [[知识图谱|图谱]] 获取定义\n又一行";
        assert!(r.content_links_to(body, "d:/vault/知识图谱.md"));
        assert!(!r.content_links_to(body, "d:/vault/other.md"));
        assert_eq!(
            r.first_linking_line(body, "d:/vault/知识图谱.md"),
            Some("参见 [[知识图谱|图谱]] 获取定义")
        );
        assert_eq!(r.first_linking_line(body, "d:/vault/other.md"), None);
    }

    // ── 多 vault 冲突裁决 / multi-vault collision ────────────────────────

    /// 同 vault 优先，无上下文时按 path 序 / same-vault first, path order otherwise.
    ///
    /// Two vaults each holding a note called 「项目笔记」 is the ordinary
    /// multi-vault case, not an edge case. Before this rule lived in the resolver,
    /// the *write* side (`note_relations`, via
    /// `find_file_path_for_title_prioritized`) preferred the same vault while the
    /// *read* side (panel/graph/health/related) took the lowest path — so for this
    /// exact fixture the two answers were different notes.
    #[test]
    fn resolve_near_prefers_the_linking_notes_own_vault() {
        let conn = test_db();
        add_file_only(&conn, "d:/vaultA/项目笔记.md", "项目笔记");
        add_file_only(&conn, "d:/vaultB/项目笔记.md", "项目笔记");
        add_file_only(&conn, "d:/vaultA/源.md", "源A");
        add_file_only(&conn, "d:/vaultB/源.md", "源B");
        let r = LinkResolver::from_files(&conn).unwrap();

        assert_eq!(
            r.resolve_near("项目笔记", Some("d:/vaultA/源.md")),
            Some("d:/vaultA/项目笔记.md"),
            "a link from vault A resolves inside vault A"
        );
        assert_eq!(
            r.resolve_near("项目笔记", Some("d:/vaultB/源.md")),
            Some("d:/vaultB/项目笔记.md"),
            "a link from vault B resolves inside vault B"
        );
        // No context ⇒ the existing rule, unchanged: lowest path wins.
        assert_eq!(r.resolve("项目笔记"), Some("d:/vaultA/项目笔记.md"));
        assert_eq!(r.resolve_near("项目笔记", None), r.resolve("项目笔记"));
        // A third vault that shares no directory with either candidate falls back
        // to the same deterministic answer rather than picking arbitrarily.
        assert_eq!(
            r.resolve_near("项目笔记", Some("e:/vaultC/源.md")),
            Some("d:/vaultA/项目笔记.md")
        );
    }

    /// 前缀比较是按目录、不是按字符串 / the prefix test is per directory.
    ///
    /// `d:/vaultA/x.md` and `d:/vaultAB/y.md` share the *characters* `d:/vaultA`
    /// but no directory. Comparing raw string prefixes would make them look like
    /// neighbours — the same class of mistake as the `contains` matcher this whole
    /// module replaced.
    #[test]
    fn resolve_near_does_not_treat_a_sibling_prefix_as_the_same_vault() {
        let conn = test_db();
        add_file_only(&conn, "d:/vaultAB/共享笔记.md", "共享笔记");
        add_file_only(&conn, "d:/vaultZ/共享笔记.md", "共享笔记");
        let r = LinkResolver::from_files(&conn).unwrap();
        // Both candidates share only `d:/` with the source, so neither is "nearer"
        // and the path-order rule decides — deterministically.
        assert_eq!(
            r.resolve_near("共享笔记", Some("d:/vaultA/源.md")),
            Some("d:/vaultAB/共享笔记.md")
        );
    }

    // ── 点击链接 / following a link, same answer as every read view ──────

    /// `resolve_wikilink` 不再靠子串猜 / the editor's link-following is exact.
    ///
    /// The old command ended in `normalize_title(&filename).contains(&title_norm)`
    /// with no `ORDER BY`, so clicking `[[笔记]]` opened whichever note whose stem
    /// merely *contained* 「笔记」 SQLite happened to return first. Navigating the
    /// user to the wrong note is the most visible form of this bug in the app.
    #[test]
    fn following_a_link_lands_on_the_note_the_other_views_agree_on() {
        let conn = test_db();
        add_file_only(&conn, "d:/vault/会议笔记.md", "会议笔记");
        add_file_only(&conn, "d:/vault/读书笔记.md", "读书笔记");
        add_file_only(&conn, "d:/vault/202401-stem.md", "完全不同的标题");
        let resolve =
            |t: &str| crate::commands::file_commands::resolve_wikilink_target(&conn, t).unwrap();

        assert_eq!(resolve("会议笔记").as_deref(), Some("d:/vault/会议笔记.md"));
        // Decorated spellings resolve, which the old exact-match scan could not do.
        assert_eq!(resolve("会议笔记|上周").as_deref(), Some("d:/vault/会议笔记.md"));
        assert_eq!(resolve("[[会议笔记#议题]]").as_deref(), Some("d:/vault/会议笔记.md"));
        // The file stem is a key too.
        assert_eq!(resolve("202401-stem").as_deref(), Some("d:/vault/202401-stem.md"));
        // 「笔记」 is a substring of two note names and the name of none: no guess.
        assert_eq!(resolve("笔记"), None, "must not substring-guess a target");
        assert_eq!(resolve(""), None);
        // And it agrees with the resolver every read view uses.
        let r = LinkResolver::from_files(&conn).unwrap();
        for t in ["会议笔记", "会议笔记|上周", "202401-stem", "笔记"] {
            let bare = parse_link_target(t).unwrap_or_default();
            assert_eq!(resolve(t).as_deref(), r.resolve(&bare), "disagreement on {}", t);
        }
    }

// ── 五方一致 / five-way agreement ───────────────────────────────────
    //
    // The reason this module exists. One vault, every wikilink spelling, and the
    // five consumers must agree on the backlink set for the target note:
    //   1. `get_backlinks`             (sidebar panel)      — set of source paths
    //   2. `notes_overview`            (health desk)        — `backlink_count`
    //   3. `build_graph_data_uncached` (graph)              — incoming "link" edges
    //   4. `get_related_notes`         (related-notes panel) — `link` signal sources
    //   5. `execute_get_backlinks`     (Agent / MCP tool)   — `backlinks[].source`
    //
    // Party 5 is the one that made this a five-way test: it was a copy of the
    // *pre-fix* sidebar query (`LIKE '%[[title]]%'`, no self-relation skip, silent
    // `LIMIT 50`), so the AI answered questions from a smaller backlink set than
    // the user could see on screen — and neither side could tell.
    //
    // The vault is built so wikilinks are the *only* edge source: no
    // `card_meta.links`, no `note_relations`, no embeddings ⇒ no semantic edges.
    // That isolates the wikilink path so the answers are directly comparable.
    mod five_way {
        use super::*;
        use std::collections::HashSet;

        const TARGET: &str = "d:/vault/知识图谱.md";

        fn build_vault(conn: &Connection) {
            add_file_only(conn, TARGET, "知识图谱");
            add_note(conn, "d:/vault/s_plain.md",         "P1", "见 [[知识图谱]]");
            add_note(conn, "d:/vault/s_alias.md",         "P2", "见 [[知识图谱|图谱]]");
            add_note(conn, "d:/vault/s_heading.md",       "P3", "见 [[知识图谱#定义]]");
            add_note(conn, "d:/vault/s_alias_heading.md", "P4", "见 [[知识图谱|图谱#定义]]");
            add_note(conn, "d:/vault/s_none.md",          "P6", "见 [[别的笔记]]");
            add_note(conn, "d:/vault/s_twice.md",         "P7", "[[知识图谱|图谱]] 和 [[知识图谱#定义]]");
        }

        fn sidebar_sources(conn: &Connection) -> HashSet<String> {
            crate::commands::file_commands::collect_backlinks(conn, TARGET)
                .unwrap()
                .into_iter()
                .map(|b| b.file_path)
                .collect()
        }

        fn graph_incoming_sources(conn: &Connection) -> HashSet<String> {
            let graph = crate::db::search::get_graph_data(conn).unwrap();
            graph
                .edges
                .iter()
                .filter(|e| e.edge_type == "link" && e.target == TARGET)
                .map(|e| e.source.clone())
                .collect()
        }

        fn health_backlink_count(conn: &Connection) -> usize {
            let o = crate::db::notes_overview::build_overview(conn, "d:/vault", false, 0).unwrap();
            o.rows
                .iter()
                .find(|r| r.path == TARGET)
                .expect("target row")
                .backlink_count
        }

        /// The fourth party: the 「相关笔记 / Related notes」panel's `link` signal.
        ///
        /// `get_related_notes` merges three signals; the fixture has no embeddings
        /// and no `note_relations`, so every hit here can only have come from the
        /// wikilink scan. `limit` is far above the source count so the ranking cut
        /// cannot silently hide a disagreement.
        fn related_link_sources(conn: &Connection) -> HashSet<String> {
            crate::db::search::get_related_notes(conn, TARGET, 100)
                .unwrap()
                .notes
                .into_iter()
                .filter(|n| n.signals.iter().any(|s| s == "link"))
                .map(|n| n.file_path)
                .collect()
        }

        /// 第五方：Agent / MCP 的 `get_backlinks` 工具 / the fifth party.
        ///
        /// Driven through the tool's real entry point — JSON arguments in, JSON out
        /// — so this asserts what the model actually receives, not just that some
        /// helper agrees. The lock is taken *inside* the tool, so the caller must
        /// not be holding it.
        fn agent_tool_sources(db: &std::sync::Arc<std::sync::Mutex<Connection>>) -> HashSet<String> {
            let out = crate::tools::internal_tools::graph_ops::execute_get_backlinks(
                &format!(r#"{{"path":"{}"}}"#, TARGET),
                db,
            )
            .unwrap();
            let v: serde_json::Value = serde_json::from_str(&out).unwrap();
            v["backlinks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["source"].as_str().unwrap().to_string())
                .collect()
        }

        #[test]
        fn all_five_agree_on_the_backlink_set() {
            let db = std::sync::Arc::new(std::sync::Mutex::new(test_db()));
            {
                let conn = db.lock().unwrap();
                build_vault(&conn);
            }

            let (sidebar, graph, related, health) = {
                let conn = db.lock().unwrap();
                (
                    sidebar_sources(&conn),
                    graph_incoming_sources(&conn),
                    related_link_sources(&conn),
                    health_backlink_count(&conn),
                )
            };
            let agent = agent_tool_sources(&db);

            let expected: HashSet<String> = [
                "d:/vault/s_plain.md",
                "d:/vault/s_alias.md",
                "d:/vault/s_heading.md",
                "d:/vault/s_alias_heading.md",
                "d:/vault/s_twice.md",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();

            assert_eq!(sidebar, expected, "sidebar panel disagrees");
            assert_eq!(graph, expected, "graph incoming edges disagree");
            assert_eq!(related, expected, "related-notes link signal disagrees");
            assert_eq!(agent, expected, "Agent get_backlinks tool disagrees");
            assert_eq!(sidebar.len(), health, "health count disagrees with sidebar");
            assert_eq!(graph.len(), health, "health count disagrees with graph");
            assert_eq!(related.len(), health, "health count disagrees with related notes");
            assert_eq!(agent.len(), health, "health count disagrees with the agent tool");
            assert_eq!(health, 5, "5 distinct sources link to the target");
        }

        /// 工具口径回归 / the AI-vs-user regression, stated on its own.
        ///
        /// 60 notes link here as `[[知识图谱|图谱]]` — an alias spelling the old
        /// `LIKE '%[[知识图谱]]%'` could not see at all, and a count above the old
        /// `LIMIT 50` so the silent truncation would show up too. The tool must
        /// return all 60, exactly what the sidebar shows.
        #[test]
        fn agent_tool_is_neither_alias_blind_nor_truncated() {
            let db = std::sync::Arc::new(std::sync::Mutex::new(test_db()));
            {
                let conn = db.lock().unwrap();
                add_file_only(&conn, TARGET, "知识图谱");
                for i in 0..60 {
                    add_note(
                        &conn,
                        &format!("d:/vault/src{:02}.md", i),
                        &format!("S{}", i),
                        "见 [[知识图谱|图谱]]",
                    );
                }
            }
            let agent = agent_tool_sources(&db);
            let sidebar = {
                let conn = db.lock().unwrap();
                sidebar_sources(&conn)
            };
            assert_eq!(agent.len(), 60, "alias links missed or LIMIT still truncating");
            assert_eq!(agent, sidebar, "the AI must see exactly what the user sees");
        }


        /// A link written as the *file stem* while the note's stored title is
        /// something else — the spelling users get from drag-and-drop. All three
        /// must resolve it, or the panel and the graph would silently drop it.
        #[test]
        fn all_three_resolve_a_stem_only_link() {
            let conn = test_db();
            const STEM_TARGET: &str = "d:/vault/202401-note.md";
            add_file_only(&conn, STEM_TARGET, "完全不同的标题");
            add_note(&conn, "d:/vault/ref.md", "R", "参考 [[202401-note#背景]]");

            let sidebar: Vec<String> =
                crate::commands::file_commands::collect_backlinks(&conn, STEM_TARGET)
                    .unwrap()
                    .into_iter()
                    .map(|b| b.file_path)
                    .collect();
            assert_eq!(sidebar, vec!["d:/vault/ref.md".to_string()]);

            let o = crate::db::notes_overview::build_overview(&conn, "d:/vault", false, 0).unwrap();
            let health = o.rows.iter().find(|r| r.path == STEM_TARGET).unwrap().backlink_count;
            assert_eq!(health, 1);

            let graph = crate::db::search::get_graph_data(&conn).unwrap();
            let in_edges = graph
                .edges
                .iter()
                .filter(|e| e.edge_type == "link" && e.target == STEM_TARGET)
                .count();
            assert_eq!(in_edges, 1);
        }

        /// The backlink `context` is the linking line, char-truncated. A long CJK

        /// line with an alias link must be produced intact and never byte-sliced.
        #[test]
        fn sidebar_context_is_the_linking_line_and_char_truncated() {
            let conn = test_db();
            add_file_only(&conn, TARGET, "知识图谱");
            let long_line = format!("参见 [[知识图谱|图谱]] {}", "补充说明".repeat(60));
            add_note(&conn, "d:/vault/long.md", "L", &long_line);

            let backlinks =
                crate::commands::file_commands::collect_backlinks(&conn, TARGET).unwrap();
            let entry = backlinks
                .iter()
                .find(|b| b.file_path == "d:/vault/long.md")
                .unwrap();
            assert_eq!(entry.context.chars().count(), 120, "context is 120 *chars*");
            assert!(long_line.starts_with(&entry.context), "context heads the linking line");
        }

        /// Collision handling is identical across the three: the ambiguous key
        /// goes to the first writer, so a link to it is a backlink for exactly one
        /// of the colliding notes, everywhere.
        #[test]
        fn collision_semantics_are_consistent_across_all_three() {
            let conn = test_db();
            add_file_only(&conn, "d:/vault/dup-a.md", "重复");
            add_file_only(&conn, "d:/vault/dup-b.md", "重复！");
            add_note(&conn, "d:/vault/linker.md", "K", "指向 [[重复]]");

            let has = |target: &str| {
                crate::commands::file_commands::collect_backlinks(&conn, target)
                    .unwrap()
                    .iter()
                    .any(|b| b.file_path == "d:/vault/linker.md")
            };
            assert!(has("d:/vault/dup-a.md") && !has("d:/vault/dup-b.md"), "sidebar: winner takes it");

            let o = crate::db::notes_overview::build_overview(&conn, "d:/vault", false, 0).unwrap();
            let count = |p: &str| o.rows.iter().find(|r| r.path == p).unwrap().backlink_count;
            assert_eq!(count("d:/vault/dup-a.md"), 1, "health: winner counts it");
            assert_eq!(count("d:/vault/dup-b.md"), 0, "health: loser does not");

            let graph = crate::db::search::get_graph_data(&conn).unwrap();
            let to = |p: &str| {
                graph.edges.iter().filter(|e| e.edge_type == "link" && e.target == p).count()
            };
            assert_eq!(to("d:/vault/dup-a.md"), 1, "graph: winner gets the edge");
            assert_eq!(to("d:/vault/dup-b.md"), 0, "graph: loser gets none");
        }

        // ── A: card_meta.links must resolve exactly, never by substring ──
        //
        // Store a `card_meta.links` entry, then assert the graph's `link` edges.
        // This is the whole point of ripping out `filename_norm.contains(link)`:
        // the graph is where a wrong edge does the most damage (PageRank, clusters).

        /// Set `card_meta.links` for a note to a raw JSON array literal — exactly
        /// the shape the reconciler stores (`suggested_links` copied verbatim).
        fn set_links_json(conn: &Connection, path: &str, links_json: &str) {
            conn.execute(
                "INSERT INTO card_meta (file_path, links) VALUES (?1, ?2)
                 ON CONFLICT(file_path) DO UPDATE SET links = ?2",
                params![path, links_json],
            )
            .unwrap();
        }

        fn card_link_edges_to(conn: &Connection, source: &str, target: &str) -> usize {
            let graph = crate::db::search::get_graph_data(conn).unwrap();
            graph
                .edges
                .iter()
                .filter(|e| e.edge_type == "link" && e.source == source && e.target == target)
                .count()
        }

        /// The错连回归 / the wrong-edge regression. Two notes whose titles are in a
        /// prefix relationship (`Rust` ⊂ `Rust进阶笔记`); a `card_meta.links` entry
        /// of `[[Rust]]` must land on `Rust.md` alone. Under the old `contains`
        /// fallback it could attach to `Rust进阶笔记.md` — a fabricated edge.
        #[test]
        fn card_meta_link_resolves_exactly_not_by_substring() {
            let conn = test_db();
            add_file_only(&conn, "d:/vault/Rust.md", "Rust");
            add_file_only(&conn, "d:/vault/Rust进阶笔记.md", "Rust进阶笔记");
            add_file_only(&conn, "d:/vault/src.md", "Src");
            set_links_json(&conn, "d:/vault/src.md", r#"["[[Rust]]"]"#);

            assert_eq!(
                card_link_edges_to(&conn, "d:/vault/src.md", "d:/vault/Rust.md"),
                1,
                "exact title must resolve to Rust.md"
            );
            assert_eq!(
                card_link_edges_to(&conn, "d:/vault/src.md", "d:/vault/Rust进阶笔记.md"),
                0,
                "must NOT substring-match the longer title"
            );
        }

        /// `card_meta.links` entries carrying `|别名` / `#小节` (an LLM copying the
        /// spelling out of the note body) resolve to the bare title, same as the
        /// inline-wikilink path. Both entries point at one note, so after
        /// `(source,target,type,label)` dedup there is exactly one edge.
        #[test]
        fn card_meta_link_strips_alias_and_heading() {
            let conn = test_db();
            add_file_only(&conn, "d:/vault/知识图谱.md", "知识图谱");
            add_file_only(&conn, "d:/vault/src.md", "Src");
            set_links_json(
                &conn,
                "d:/vault/src.md",
                r#"["[[知识图谱|图谱]]", "[[知识图谱#定义]]"]"#,
            );
            assert_eq!(
                card_link_edges_to(&conn, "d:/vault/src.md", "d:/vault/知识图谱.md"),
                1,
                "alias/heading forms resolve to the bare title, deduped to one edge"
            );
        }

        // ── B: related-notes `link` signal sees alias/heading spellings ──

        /// Reading 知识图谱, the 「相关笔记」panel must list notes that link here as
        /// `[[知识图谱|图谱]]` or `[[知识图谱#定义]]` under the `link` signal — the
        /// exact spellings the old `contains("[[title]]")` check dropped.
        #[test]
        fn related_notes_link_signal_sees_alias_and_heading() {
            let conn = test_db();
            add_file_only(&conn, "d:/vault/知识图谱.md", "知识图谱");
            add_note(&conn, "d:/vault/a.md", "A", "见 [[知识图谱|图谱]]");
            add_note(&conn, "d:/vault/b.md", "B", "见 [[知识图谱#定义]]");

            let link_srcs: HashSet<String> =
                crate::db::search::get_related_notes(&conn, "d:/vault/知识图谱.md", 50)
                    .unwrap()
                    .notes
                    .into_iter()
                    .filter(|n| n.signals.iter().any(|s| s == "link"))
                    .map(|n| n.file_path)
                    .collect();
            assert!(link_srcs.contains("d:/vault/a.md"), "alias link missed: {:?}", link_srcs);
            assert!(link_srcs.contains("d:/vault/b.md"), "heading link missed: {:?}", link_srcs);
        }

        // ── C: a self-relation is never a backlink, consistently everywhere ──

        /// Reconciliation can write a `note_relations` row whose source == target.
        /// `notes_overview` always skipped it; `get_backlinks` now does too, so a
        /// note never appears in its own backlink list and the two counts match.
        #[test]
        fn self_relation_is_not_a_backlink_in_any_view() {
            let conn = test_db();
            add_file_only(&conn, "d:/vault/n.md", "N");
            conn.execute(
                "INSERT INTO note_relations (source_path, target_path, relation_type)
                 VALUES ('d:/vault/n.md', 'd:/vault/n.md', 'refines')",
                [],
            )
            .unwrap();

            let sidebar = crate::commands::file_commands::collect_backlinks(&conn, "d:/vault/n.md")
                .unwrap();
            assert!(
                sidebar.iter().all(|b| b.file_path != "d:/vault/n.md"),
                "sidebar: a note is not its own backlink"
            );

            let o = crate::db::notes_overview::build_overview(&conn, "d:/vault", false, 0).unwrap();
            let count = o.rows.iter().find(|r| r.path == "d:/vault/n.md").unwrap().backlink_count;
            assert_eq!(count, 0, "health: self-relation is not counted");
            assert_eq!(sidebar.len(), count, "sidebar and health agree on the self-relation");
        }
    }
}






