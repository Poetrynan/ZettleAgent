//! CJK-aware segmentation for the full-text index.
//!
//! ## Why this exists
//! FTS5's `unicode61` tokenizer splits only on separators and punctuation, and
//! treats CJK ideographs as ordinary "letter" characters. So a sentence such as
//! `我们正在构建知识图谱系统` is indexed as **one single token**. A query for
//! `知识图谱` then matches only chunks whose entire punctuation-delimited run is
//! literally `知识图谱`. Mixed text is hit too: `使用BERT模型` is also one token,
//! so even the English query `BERT` misses it.
//!
//! ## The approach: overlapping bigrams (the Lucene `CJKAnalyzer` scheme)
//! For every chunk we derive an index-only text (see [`segment_for_index`]):
//! - every run of ideographs/kana is replaced by its overlapping bigrams
//!   (`知识图谱` → `知识 识图 图谱`), surrounded by spaces so adjacent ASCII words
//!   become separate tokens again;
//! - every character of every multi-char run is also appended once at the end as a
//!   unigram, so single-character queries (`猫`) still match. Unigrams go *after*
//!   all bigrams so bigram positions stay contiguous and phrase queries work.
//!
//! A query run is turned into the same bigrams by [`query_bigrams`]. This needs no
//! dictionary, so it also handles names, jargon and new words (which dictionary
//! segmenters such as jieba split wrongly) at the cost of a larger index. bm25
//! then rewards chunks that share more bigrams with the query.
//!
//! The index text is produced in SQL by the `zettel_cjk_segment(text)` scalar
//! function, which the FTS triggers call. [`register_functions`] must therefore
//! run on every connection that writes `chunks`. `setup_database_schema` does this
//! first, before anything else.
//!
//! ## Traditional and simplified Chinese match each other
//! A note written in traditional characters (`知識圖譜`) and a query typed in
//! simplified ones (`知识图谱`) share no bigram, so neither found the other.
//! Every ideograph is therefore folded to its simplified form ([`fold_han`]) on
//! both sides — when indexing and when building the query — so the bigrams
//! agree whichever script was used. The table is OpenCC's character-level
//! traditional→simplified data (Apache-2.0, see `cjk_fold_table.rs`).
//!
//! Folding is per character, not per word: OpenCC's phrase tables (`乾隆` keeps
//! `乾`) are not applied, so the folded index text is not always correct
//! simplified Chinese. That is fine for matching, because index and query are
//! folded the same way, and the index text is never shown. Words whose two
//! scripts differ by more than character substitution (`軟體`/`软件`) are
//! regional vocabulary, not script, and are out of scope.

use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;

/// Version of the index text [`segment_for_index`] produces. Bump it whenever
/// that output changes: `setup_segmented_fts` then rebuilds the index once,
/// because rows written by the old version would not match new queries.
/// - 1: bigrams + unigrams
/// - 2: + traditional→simplified folding
pub const INDEX_VERSION: i64 = 2;

/// Fold one character to simplified Chinese (identity for everything else).
pub fn fold_han(c: char) -> char {
    use super::cjk_fold_table::TRAD_TO_SIMP;
    match TRAD_TO_SIMP.binary_search_by_key(&c, |&(t, _)| t) {
        Ok(i) => TRAD_TO_SIMP[i].1,
        Err(_) => c,
    }
}

/// Name of the SQL scalar function used by the segmented-FTS triggers.
pub const SEGMENT_FN: &str = "zettel_cjk_segment";

/// True for characters that form CJK "words" with no spaces between them:
/// Han ideographs (incl. Extension A and compatibility forms) and Japanese kana.
///
/// CJK *punctuation* (`，。「」`) and fullwidth forms are deliberately excluded:
/// they separate runs instead of joining them. Hangul is excluded too, because
/// Korean separates words with spaces, which `unicode61` already handles.
pub fn is_cjk_word_char(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}' |   // CJK Unified Ideographs
        '\u{3400}'..='\u{4DBF}' |   // CJK Extension A
        '\u{F900}'..='\u{FAFF}' |   // CJK Compatibility Ideographs
        '\u{3040}'..='\u{309F}' |   // Hiragana
        '\u{30A0}'..='\u{30FF}'     // Katakana
    )
}

/// Overlapping bigrams of one CJK run, folded like the index. A 1-char run
/// yields itself.
pub fn query_bigrams(run: &str) -> Vec<String> {
    let chars: Vec<char> = run.chars().map(fold_han).collect();
    match chars.len() {
        0 => Vec::new(),
        1 => vec![chars[0].to_string()],
        _ => chars.windows(2).map(|w| w.iter().collect()).collect(),
    }
}

/// Build the index-only text for one chunk (see the module docs).
///
/// Non-CJK text is passed through unchanged, so English tokenization is exactly
/// what `unicode61` produced before.
pub fn segment_for_index(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut unigrams = String::new();
    let mut run: Vec<char> = Vec::new();

    fn flush(run: &mut Vec<char>, out: &mut String, unigrams: &mut String) {
        if run.is_empty() {
            return;
        }
        out.push(' ');
        if run.len() == 1 {
            out.push(run[0]);
        } else {
            for (i, w) in run.windows(2).enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                out.push(w[0]);
                out.push(w[1]);
            }
            for &c in run.iter() {
                unigrams.push(' ');
                unigrams.push(c);
            }
        }
        out.push(' ');
        run.clear();
    }

    for c in text.chars() {
        if is_cjk_word_char(c) {
            run.push(fold_han(c));
        } else {
            flush(&mut run, &mut out, &mut unigrams);
            out.push(c);
        }
    }
    flush(&mut run, &mut out, &mut unigrams);

    if !unigrams.is_empty() {
        out.push('\n');
        out.push_str(&unigrams);
    }
    out
}

/// Register `zettel_cjk_segment(text)` on this connection.
///
/// Flagged deterministic and innocuous so SQLite allows it inside triggers even
/// when `trusted_schema` is off. NULL input yields NULL.
pub fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        SEGMENT_FN,
        1,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            let text: Option<String> = ctx.get(0)?;
            Ok(text.map(|t| segment_for_index(&t)))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bigrams_of_runs() {
        assert_eq!(query_bigrams("知识图谱"), vec!["知识", "识图", "图谱"]);
        assert_eq!(query_bigrams("猫"), vec!["猫"]);
        assert!(query_bigrams("").is_empty());
    }

    #[test]
    fn segment_splits_cjk_from_ascii_and_appends_unigrams() {
        let s = segment_for_index("使用BERT模型");
        // ASCII word is now its own token.
        assert!(s.contains(" BERT "), "{s:?}");
        assert!(s.contains("使用"));
        assert!(s.contains("模型"));
        // Unigrams appended after the bigram body.
        let (body, tail) = s.split_once('\n').unwrap();
        assert!(!body.contains(" 使 "));
        assert!(tail.contains('使') && tail.contains('型'));
    }

    #[test]
    fn punctuation_breaks_runs() {
        let s = segment_for_index("知识，图谱");
        // No bigram may straddle the fullwidth comma.
        assert!(!s.contains("识图"), "{s:?}");
        assert!(s.contains("知识") && s.contains("图谱"));
    }

    #[test]
    fn plain_english_is_unchanged() {
        assert_eq!(segment_for_index("nomic-embed v1.5"), "nomic-embed v1.5");
    }

    #[test]
    fn traditional_and_simplified_produce_the_same_index_text() {
        assert_eq!(segment_for_index("知識圖譜"), segment_for_index("知识图谱"));
        assert_eq!(query_bigrams("知識圖譜"), query_bigrams("知识图谱"));
        // Mixed scripts in one run fold too; ASCII is untouched.
        assert_eq!(segment_for_index("用BERT構建軟件"), segment_for_index("用BERT构建软件"));
        assert_eq!(fold_han('A'), 'A');
        assert_eq!(fold_han('猫'), '猫');
    }

    #[test]
    fn fold_table_is_sorted_idempotent_and_never_identity() {
        use super::super::cjk_fold_table::TRAD_TO_SIMP;
        assert!(TRAD_TO_SIMP.len() > 3000, "table looks truncated");
        assert!(TRAD_TO_SIMP.windows(2).all(|w| w[0].0 < w[1].0), "binary search needs sorted keys");
        for &(t, s) in TRAD_TO_SIMP {
            assert_ne!(t, s);
            assert_eq!(fold_han(s), s, "{t} → {s} must not fold again");
        }
    }

    #[test]
    fn common_traditional_characters_fold() {
        for (t, s) in [('後', '后'), ('發', '发'), ('裡', '里'), ('體', '体'), ('識', '识'), ('譜', '谱'), ('與', '与')] {
            assert_eq!(fold_han(t), s, "{t}");
        }
    }

    #[test]
    fn single_char_run_is_not_duplicated_as_unigram() {
        let s = segment_for_index("a 猫 b");
        assert!(!s.contains('\n'), "{s:?}");
        assert_eq!(s.matches('猫').count(), 1);
    }
}
