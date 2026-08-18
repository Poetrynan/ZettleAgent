// `zettel://` resource URI encoding.
//
// MCP resources are addressed by an opaque URI. We map every note to
// `zettel:///<percent-encoded-path>`, where the payload is exactly the string
// `files.path` stores (an absolute, forward-slash path — see
// `helpers::normalize_db_path`). Keeping the *stored* path in the URI, rather
// than inventing a vault-relative form, means the round-trip is loss-free and
// `resources/read` can hand the decoded value straight to `read_note`, whose
// `resolve_path_multi_vault` already knows how to validate an absolute path for
// vault containment. No second path convention, no second validator.
//
// Encoding rule: RFC-3986 percent-encoding of the raw UTF-8 bytes, leaving the
// "unreserved" set plus `/` untouched so the path stays human-readable in a
// client's resource list. Everything else — spaces, CJK, `#`, `?`, `%` — is
// escaped. This is what makes a filename like `会议 记录.md` survive the trip.

/// Bytes that never need escaping: RFC-3986 unreserved plus the path separator.
/// `/` is deliberately preserved so the URI reads as a path, not one opaque blob.
fn is_unreserved(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/')
}

/// The scheme prefix. Three slashes = empty authority, so the whole payload is
/// the URI path component (mirrors `file:///`).
const SCHEME_PREFIX: &str = "zettel:///";

/// Encode a stored note path into a `zettel://` URI.
///
/// Backslashes are normalized to `/` first so a Windows path and its DB-stored
/// twin (which `normalize_db_path` already forward-slashes) produce the same URI.
pub fn encode_note_uri(stored_path: &str) -> String {
    let normalized = stored_path.replace('\\', "/");
    let mut out = String::with_capacity(SCHEME_PREFIX.len() + normalized.len());
    out.push_str(SCHEME_PREFIX);
    for &b in normalized.as_bytes() {
        if is_unreserved(b) {
            out.push(b as char);
        } else {
            // Uppercase hex per RFC-3986 §2.1 so the encoding is canonical and
            // the round-trip test is deterministic.
            out.push('%');
            out.push(hex_digit(b >> 4));
            out.push(hex_digit(b & 0x0F));
        }
    }
    out
}

/// Decode a `zettel://` URI back into the stored path string.
///
/// Returns `None` when the scheme is wrong or a `%` escape is malformed — the
/// caller turns that into a JSON-RPC `-32602` rather than guessing. Accepts both
/// `zettel:///path` and the two-slash `zettel://path` form some clients emit.
pub fn decode_note_uri(uri: &str) -> Option<String> {
    let payload = uri
        .strip_prefix(SCHEME_PREFIX)
        .or_else(|| uri.strip_prefix("zettel://"))?;

    let bytes = payload.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                // Need exactly two hex digits after the '%'.
                let hi = bytes.get(i + 1).and_then(|&c| from_hex(c))?;
                let lo = bytes.get(i + 2).and_then(|&c| from_hex(c))?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    // The decoded bytes must be valid UTF-8: we only ever encoded UTF-8 in the
    // first place, so anything else is a hand-crafted / corrupt URI.
    String::from_utf8(out).ok()
}

fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

fn from_hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_ascii_path() {
        let p = "C:/vault/notes/hello.md";
        let uri = encode_note_uri(p);
        assert!(uri.starts_with("zettel:///"));
        assert_eq!(decode_note_uri(&uri).as_deref(), Some(p));
    }

    #[test]
    fn round_trips_cjk_and_spaces() {
        // The whole point of percent-encoding: a filename with Chinese and a
        // space must survive list → read unchanged. Regression guard for the
        // "6 Chinese panics" class of bug — here it's an encoding, not a slice.
        let p = "D:/知识库/会议 记录/2026 年计划.md";
        let uri = encode_note_uri(p);
        // The space and CJK bytes must be escaped, never left raw.
        assert!(!uri.contains(' '));
        assert!(uri.contains('%'));
        assert_eq!(decode_note_uri(&uri).as_deref(), Some(p));
    }

    #[test]
    fn normalizes_backslashes_before_encoding() {
        let win = r"D:\vault\note.md";
        let uri = encode_note_uri(win);
        assert_eq!(decode_note_uri(&uri).as_deref(), Some("D:/vault/note.md"));
    }

    #[test]
    fn rejects_wrong_scheme_and_bad_escape() {
        assert_eq!(decode_note_uri("file:///etc/passwd"), None);
        assert_eq!(decode_note_uri("zettel:///bad%2"), None); // truncated escape
        assert_eq!(decode_note_uri("zettel:///bad%ZZ"), None); // non-hex
    }

    #[test]
    fn two_slash_form_is_accepted() {
        // Some clients drop the empty-authority slash.
        assert_eq!(decode_note_uri("zettel://a/b.md").as_deref(), Some("a/b.md"));
    }
}
