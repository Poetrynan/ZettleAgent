//! 未链接提及 / unlinked mentions.
//!
//! A note's *backlinks* are the notes that link to it with `[[…]]`. Its
//! *unlinked mentions* are the places that name it — by title, file name or a
//! frontmatter alias — without a link. In a Zettelkasten these are the links the
//! author forgot to make, so surfacing them, and turning one into a link with a
//! click, is how a vault densifies over time.
//!
//! This module is the pure core (no I/O): which strings count as the note's
//! names ([`mention_terms`]), where they occur in a source note's text
//! ([`find_mentions`]), and rewriting one occurrence into a link
//! ([`link_occurrence`]). `commands::mention_commands` adds the database and the
//! file system.
//!
//! ## What is a mention
//! - Matching ignores case and traditional/simplified script (the same
//!   [`crate::db::cjk::fold_han`] folding as search), one char to one char, so
//!   positions in the folded text are positions in the original.
//! - A Latin-script name must stand as a whole word (`graph` does not match in
//!   `graphql`); CJK has no word boundaries, so a CJK name matches anywhere
//!   (`知识图谱` in `知识图谱系统`), as in Obsidian.
//! - Text that is already markup is not prose and is skipped: wikilinks and
//!   embeds (`[[…]]`, `![[…]]`), Markdown links and images (`[…](…)`), bare
//!   URLs, inline code, fenced code blocks and the frontmatter block.
//! - When several names overlap at one spot the longest wins, and occurrences
//!   never overlap each other.
//! - Names too short to be specific are dropped ([`is_specific`]): one CJK
//!   character or fewer than three Latin letters would match everywhere.

/// One place in a source note where the target note is named without a link.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Occurrence {
    /// 1-based line number in the source text.
    pub line: usize,
    /// 0-based char offset of the match within the line.
    pub column: usize,
    /// Length of the match in chars.
    pub length: usize,
    /// The matched text exactly as written in the source.
    pub matched: String,
    /// The full source line (untrimmed), for display.
    pub line_text: String,
}

/// Fold one char for matching: lowercase (first char of the lowercase form, so
/// the mapping stays one char to one char) and traditional→simplified.
fn fold(c: char) -> char {
    let lower = c.to_lowercase().next().unwrap_or(c);
    crate::db::cjk::fold_han(lower)
}

fn fold_str(s: &str) -> Vec<char> {
    s.chars().map(fold).collect()
}

fn is_latin_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Is `term` specific enough to look for? A single CJK character or a Latin
/// name shorter than three letters (`AI`, `Go`) would match almost every note.
pub fn is_specific(term: &str) -> bool {
    let t = term.trim();
    if t.is_empty() || t.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || c.is_ascii_punctuation()) {
        return false;
    }
    let cjk = t.chars().filter(|&c| crate::db::cjk::is_cjk_word_char(c)).count();
    let other = t.chars().filter(|c| c.is_alphanumeric() && !crate::db::cjk::is_cjk_word_char(*c)).count();
    cjk >= 2 || other >= 3 || (cjk >= 1 && other >= 1)
}

/// `aliases` / `alias` from a note's YAML frontmatter, in the three shapes
/// people write: `aliases: [a, b]`, a block list (`- a`), or a single scalar.
/// A deliberately small reader: only these keys are needed, and pulling in a
/// YAML parser for them would be the larger risk.
pub fn frontmatter_aliases(content: &str) -> Vec<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Vec::new();
    }
    let unquote = |s: &str| -> String {
        let s = s.trim();
        let s = s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(s);
        let s = s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')).unwrap_or(s);
        s.trim().to_string()
    };
    let mut out = Vec::new();
    let mut in_block = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        if in_block {
            if let Some(item) = trimmed.strip_prefix("- ") {
                out.push(unquote(item));
                continue;
            }
            if trimmed.is_empty() {
                continue;
            }
            in_block = false;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        // Top-level keys only: an indented `alias:` belongs to some other map.
        if key.starts_with(char::is_whitespace) || !matches!(key.trim(), "aliases" | "alias") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            in_block = true;
        } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            out.extend(inner.split(',').map(unquote));
        } else {
            out.push(unquote(value));
        }
    }
    out.retain(|a| !a.is_empty());
    out
}

/// The names a note goes by: its title, its file name and its frontmatter
/// aliases. Unspecific names are dropped and duplicates (after folding) removed,
/// longest first so the longest name wins where names overlap.
pub fn mention_terms(title: Option<&str>, path: &str, target_content: Option<&str>) -> Vec<String> {
    let mut raw: Vec<String> = Vec::new();
    if let Some(t) = title {
        raw.push(t.trim().to_string());
    }
    let norm = path.replace('\\', "/");
    let base = norm.rsplit('/').next().unwrap_or(&norm);
    raw.push(base.strip_suffix(".md").unwrap_or(base).trim().to_string());
    if let Some(content) = target_content {
        raw.extend(frontmatter_aliases(content));
    }

    let mut seen: Vec<Vec<char>> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for term in raw {
        if !is_specific(&term) {
            continue;
        }
        let key = fold_str(&term);
        if !seen.contains(&key) {
            seen.push(key);
            out.push(term);
        }
    }
    out.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()));
    out
}

/// Char ranges of one line that are markup, not prose (see the module docs).
fn masked_ranges(line: &[char]) -> Vec<(usize, usize)> {
    let mut masks: Vec<(usize, usize)> = Vec::new();
    let n = line.len();
    let find = |from: usize, pat: &[char]| -> Option<usize> {
        (from..=n.saturating_sub(pat.len())).find(|&i| i + pat.len() <= n && line[i..i + pat.len()] == *pat)
    };
    let mut i = 0;
    while i < n {
        let c = line[i];
        // Inline code: `…` (also ``…``).
        if c == '`' {
            let ticks = line[i..].iter().take_while(|&&x| x == '`').count();
            let fence: Vec<char> = vec!['`'; ticks];
            if let Some(end) = find(i + ticks, &fence) {
                masks.push((i, end + ticks));
                i = end + ticks;
                continue;
            }
        }
        // Wikilink or embed: [[…]] / ![[…]].
        if c == '[' && line.get(i + 1) == Some(&'[') {
            if let Some(end) = find(i + 2, &[']', ']']) {
                let start = if i > 0 && line[i - 1] == '!' { i - 1 } else { i };
                masks.push((start, end + 2));
                i = end + 2;
                continue;
            }
        }
        // Markdown link or image: [text](url).
        if c == '[' {
            if let Some(close) = find(i + 1, &[']', '(']) {
                if let Some(end) = find(close + 2, &[')']) {
                    let start = if i > 0 && line[i - 1] == '!' { i - 1 } else { i };
                    masks.push((start, end + 1));
                    i = end + 1;
                    continue;
                }
            }
        }
        // Bare URL.
        if c == 'h' {
            let rest: String = line[i..n.min(i + 8)].iter().collect();
            if rest.starts_with("http://") || rest.starts_with("https://") {
                let end = (i..n).find(|&j| line[j].is_whitespace()).unwrap_or(n);
                masks.push((i, end));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    masks
}

/// Every unlinked mention of any of `terms` in `content`, in document order.
pub fn find_mentions(content: &str, terms: &[String]) -> Vec<Occurrence> {
    // Longest first, so the longest name wins at a position.
    let mut keyed: Vec<(Vec<char>, bool)> = terms
        .iter()
        .filter(|t| is_specific(t))
        .map(|t| {
            let latin = t.trim().chars().any(|c| c.is_ascii_alphabetic());
            (fold_str(t.trim()), latin)
        })
        .collect();
    keyed.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    keyed.dedup_by(|a, b| a.0 == b.0);
    if keyed.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut in_frontmatter = false;
    let mut fence: Option<String> = None;
    for (idx, line) in content.lines().enumerate() {
        let trimmed = line.trim_start();
        if idx == 0 && line.trim() == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if matches!(line.trim(), "---" | "...") {
                in_frontmatter = false;
            }
            continue;
        }
        // Fenced code blocks: ``` or ~~~, closed by the same marker.
        let marker: String = trimmed.chars().take_while(|&c| c == '`' || c == '~').collect();
        if marker.len() >= 3 && marker.chars().all(|c| c == marker.chars().next().unwrap()) {
            match &fence {
                Some(open) if marker.starts_with(open.as_str()) => fence = None,
                Some(_) => {}
                None => fence = Some(marker),
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }

        let chars: Vec<char> = line.chars().collect();
        let folded: Vec<char> = chars.iter().map(|&c| fold(c)).collect();
        let masks = masked_ranges(&chars);
        let masked = |s: usize, e: usize| masks.iter().any(|&(ms, me)| s < me && e > ms);

        let mut pos = 0;
        while pos < folded.len() {
            let hit = keyed.iter().find(|(key, latin)| {
                let end = pos + key.len();
                end <= folded.len()
                    && folded[pos..end] == key[..]
                    && !masked(pos, end)
                    && (!latin
                        || ((pos == 0 || !is_latin_word_char(chars[pos - 1]))
                            && (end == chars.len() || !is_latin_word_char(chars[end]))))
            });
            match hit {
                Some((key, _)) => {
                    let len = key.len();
                    out.push(Occurrence {
                        line: idx + 1,
                        column: pos,
                        length: len,
                        matched: chars[pos..pos + len].iter().collect(),
                        line_text: line.to_string(),
                    });
                    pos += len;
                }
                None => pos += 1,
            }
        }
    }
    out
}

/// Why a link could not be inserted.
#[derive(Debug, PartialEq)]
pub enum LinkError {
    /// The text at that position is no longer the mention (the note changed).
    Stale,
}

/// Turn the mention at `line`/`column` into a wikilink.
///
/// `expected` is the text the caller saw there; if the note changed since, the
/// position no longer holds it (or it became markup) and nothing is rewritten.
/// The original wording is kept: `[[target]]` when the mention already *is* the
/// link target, otherwise `[[target|as written]]`.
///
/// Line endings and every other byte of the note are preserved.
pub fn link_occurrence(
    content: &str,
    line: usize,
    column: usize,
    expected: &str,
    link_target: &str,
    target_is_written_form: bool,
) -> Result<String, LinkError> {
    let expected_len = expected.chars().count();
    // Find the byte span of the requested line, keeping its terminator.
    let mut start = 0usize;
    let mut current = 1usize;
    for (i, b) in content.bytes().enumerate() {
        if current == line {
            break;
        }
        if b == b'\n' {
            current += 1;
            start = i + 1;
        }
    }
    if current != line {
        return Err(LinkError::Stale);
    }
    let end = content[start..].find('\n').map(|e| start + e).unwrap_or(content.len());
    let line_str = content[start..end].strip_suffix('\r').unwrap_or(&content[start..end]);

    // Re-verify with the same rules the scan used.
    let still_there = find_mentions(line_str, &[expected.to_string()])
        .into_iter()
        .any(|o| o.column == column && o.length == expected_len && o.matched == expected);
    if !still_there {
        return Err(LinkError::Stale);
    }

    let chars: Vec<char> = line_str.chars().collect();
    let before: String = chars[..column].iter().collect();
    let after: String = chars[column + expected_len..].iter().collect();
    let link = if target_is_written_form {
        format!("[[{expected}]]")
    } else {
        format!("[[{link_target}|{expected}]]")
    };
    let rest = &content[start + line_str.len()..];
    Ok(format!("{}{}{}{}{}", &content[..start], before, link, after, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_plain_mentions_with_position() {
        let found = find_mentions("第一行\n我们在做知识图谱，知识图谱很好用。", &terms(&["知识图谱"]));
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].line, found[0].column, found[0].length), (2, 4, 4));
        assert_eq!(found[1].column, 9);
        assert_eq!(found[0].matched, "知识图谱");
    }

    #[test]
    fn matches_across_case_and_script() {
        let found = find_mentions("我們的知識圖譜 and the Knowledge Graph", &terms(&["知识图谱", "knowledge graph"]));
        let matched: Vec<&str> = found.iter().map(|o| o.matched.as_str()).collect();
        assert_eq!(matched, vec!["知識圖譜", "Knowledge Graph"]);
    }

    #[test]
    fn latin_names_need_word_boundaries_cjk_do_not() {
        let found = find_mentions("graphql and graph; 使用graph模型; 知识图谱系统", &terms(&["graph", "知识图谱"]));
        let cols: Vec<(usize, &str)> = found.iter().map(|o| (o.column, o.matched.as_str())).collect();
        // `graphql` is not `graph`; CJK neighbours are boundaries for Latin names.
        assert_eq!(cols, vec![(12, "graph"), (21, "graph"), (30, "知识图谱")]);
    }

    #[test]
    fn markup_is_not_a_mention() {
        let text = "[[知识图谱]] ![[知识图谱]] [知识图谱](url) `知识图谱` https://x.com/知识图谱 [[别的|知识图谱]]";
        assert!(find_mentions(text, &terms(&["知识图谱"])).is_empty());
    }

    #[test]
    fn frontmatter_and_code_blocks_are_skipped() {
        let text = "---\ntitle: 知识图谱\n---\n```\n知识图谱\n```\n~~~~\n知识图谱\n~~~~\n正文里的知识图谱";
        let found = find_mentions(text, &terms(&["知识图谱"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 10);
    }

    #[test]
    fn longest_name_wins_and_matches_do_not_overlap() {
        let found = find_mentions("知识图谱系统设计", &terms(&["知识图谱", "知识图谱系统"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].matched, "知识图谱系统");
    }

    #[test]
    fn unspecific_names_are_dropped() {
        assert!(!is_specific("猫"));
        assert!(!is_specific("AI"));
        assert!(!is_specific("2024"));
        assert!(is_specific("知识"));
        assert!(is_specific("RAG"));
        assert!(is_specific("AI笔记"));
        assert!(find_mentions("AI is everywhere", &terms(&["AI"])).is_empty());
    }

    #[test]
    fn terms_come_from_title_stem_and_aliases() {
        let fm = "---\ntitle: x\naliases: [KG, \"Knowledge Graph\"]\nalias: 圖譜\n---\nbody";
        let t = mention_terms(Some("知识图谱"), "/v/notes/kg-note.md", Some(fm));
        assert_eq!(t[0], "Knowledge Graph"); // longest first
        assert!(t.contains(&"知识图谱".to_string()));
        assert!(t.contains(&"kg-note".to_string()));
        assert!(t.contains(&"圖譜".to_string()));
        assert!(!t.contains(&"KG".to_string()), "too short");
        // Title equal to stem after folding is not listed twice.
        assert_eq!(mention_terms(Some("Graph"), "graph.md", None), vec!["Graph"]);
    }

    #[test]
    fn block_list_aliases_and_nested_keys() {
        let fm = "---\naliases:\n  - 卡片盒\n  - 'Zettelkasten'\nmeta:\n  alias: nope\n---\n";
        assert_eq!(frontmatter_aliases(fm), vec!["卡片盒", "Zettelkasten"]);
        assert!(frontmatter_aliases("no frontmatter\naliases: [x]").is_empty());
    }

    #[test]
    fn linking_rewrites_only_that_occurrence_and_keeps_line_endings() {
        let text = "a\r\n用知识图谱，再说知识图谱\r\nend";
        let out = link_occurrence(text, 2, 1, "知识图谱", "知识图谱", true).unwrap();
        assert_eq!(out, "a\r\n用[[知识图谱]]，再说知识图谱\r\nend");
        let out = link_occurrence(text, 2, 8, "知识图谱", "知识图谱", true).unwrap();
        assert_eq!(out, "a\r\n用知识图谱，再说[[知识图谱]]\r\nend");
    }

    #[test]
    fn linking_keeps_the_written_form_as_alias() {
        let out = link_occurrence("見知識圖譜", 1, 1, "知識圖譜", "知识图谱", false).unwrap();
        assert_eq!(out, "見[[知识图谱|知識圖譜]]");
    }

    #[test]
    fn linking_a_changed_note_is_refused() {
        // Text moved: the mention is no longer at column 1.
        assert_eq!(link_occurrence("xx知识图谱", 1, 1, "知识图谱", "知识图谱", true), Err(LinkError::Stale));
        // Already linked meanwhile.
        assert_eq!(link_occurrence("[[知识图谱]]", 1, 2, "知识图谱", "知识图谱", true), Err(LinkError::Stale));
        // Line gone.
        assert_eq!(link_occurrence("知识图谱", 3, 0, "知识图谱", "知识图谱", true), Err(LinkError::Stale));
    }
}
