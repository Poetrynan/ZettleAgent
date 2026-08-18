//! Secret storage for the LLM API key, backed by the OS credential store.
//!
//! ## Why this module exists
//!
//! Until now the API key lived in two plaintext places: the WebView's
//! `localStorage` under `zettelagent-llm`, and `settings.json` written by
//! `tauri-plugin-store`. Both are world-readable to anything running as the
//! user — another Electron app, a malicious npm postinstall, a synced backup.
//! For a local-first app the key is the single most valuable thing on disk
//! (it is billable), so it belongs in the platform's credential vault:
//!
//! * Windows → Credential Manager (DPAPI-protected per user)
//! * macOS   → Keychain (ACL-gated per application)
//! * Linux   → Secret Service (gnome-keyring / KWallet over D-Bus)
//!
//! ## Degradation is explicit, never silent
//!
//! Headless Linux, a locked keyring, or a container with no D-Bus session all
//! make the credential store unreachable. Silently writing plaintext there
//! would be *worse than the status quo*, because the UI would claim the key is
//! protected. Instead the fallback is a separate file whose very name says what
//! it is, and every read/status call reports `protected: false` so the settings
//! UI can put a warning in front of the user.
//!
//! ## The value never crosses back into the frontend
//!
//! There is deliberately **no** `#[tauri::command]` that returns the secret.
//! The frontend can store, probe, delete and ask about protection status; only
//! Rust can read the bytes, via [`resolve_api_key`].
//!
//! ## Two sources, one precedence rule
//!
//! A migrated user's key lives only here; an unmigrated user's key still rides
//! along in the command request. [`resolve_api_key_with_override`] is the single
//! place that reconciles the two — request first, credential store second — and
//! [`RequestApiKey`] exists so the compiler refuses any construction site that
//! tries to bypass it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Credential-store "service" namespace. Changing this orphans stored keys, so
/// it is a hard-coded constant rather than anything derived from runtime state.
const KEYRING_SERVICE: &str = "com.zettelagent.app";

/// Credential-store account name for the one LLM API key the app holds.
const LLM_API_KEY_ACCOUNT: &str = "llm_api_key";

/// Fallback file name. Named to be alarming on sight in a file listing — if a
/// user ever sees this file, the credential store was unavailable.
const FALLBACK_FILE: &str = "UNPROTECTED-secrets.json";

/// Human-readable banner written into the fallback file itself, so the warning
/// travels with the data even if it is copied out of the app directory.
const FALLBACK_BANNER: &str = "This file holds an API key that could NOT be placed in the operating system credential store. It is NOT encrypted. Delete it once the system keyring is available. 本文件中的 API key 未能写入操作系统凭据库，未加密，请在凭据库可用后尽快删除。";

/// Where a secret physically ended up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretBackend {
    /// The OS credential store. This is the only protected outcome.
    OsKeyring,
    /// Plaintext fallback file. Reported to the UI so it can warn.
    UnprotectedFile,
    /// Nothing stored anywhere.
    None,
}

impl SecretBackend {
    /// Whether the OS is actually guarding the bytes.
    pub fn is_protected(self) -> bool {
        matches!(self, SecretBackend::OsKeyring)
    }
}

/// What the settings UI needs to render an honest status line.
///
/// Note the absence of the secret itself — this struct is safe to serialize to
/// the frontend and safe to log.
#[derive(Debug, Clone, Serialize)]
pub struct SecretStatus {
    pub backend: SecretBackend,
    /// `true` only for [`SecretBackend::OsKeyring`].
    pub protected: bool,
    /// Whether a key is stored at all.
    pub has_key: bool,
    /// Why the credential store was not used, when it was not. Scrubbed.
    pub fallback_reason: Option<String>,
}

/// Outcome of migrating a legacy plaintext key.
#[derive(Debug, Clone, Serialize)]
pub struct MigrationOutcome {
    /// `true` if this call is what moved the value in.
    pub migrated: bool,
    pub backend: SecretBackend,
    /// The caller may delete its plaintext copy **only** when this is `true`.
    /// It is set after the new location has been read back and verified, so a
    /// half-failed migration can never lose the user's key.
    pub plaintext_can_be_deleted: bool,
    pub protected: bool,
    pub detail: Option<String>,
}

// ── Redaction ───────────────────────────────────────────────────────

/// Run a string through the existing tool-output secret scrubber before it
/// reaches a log sink.
///
/// Reuses `llm::tool_hooks::secret_redaction` rather than re-deriving the
/// pattern list: that function already knows the shapes of OpenAI / Anthropic /
/// GitHub / Slack / AWS credentials and is regression-tested. Keyring backends
/// occasionally echo the attempted value into their error strings, and every
/// error in this module ends up in `log::warn!`.
fn scrub(message: &str) -> String {
    let outcome = crate::llm::tool_hooks::secret_redaction("secrets", message);
    outcome
        .replace_content
        .unwrap_or_else(|| message.to_string())
}

/// Describe a secret for a log line without revealing it: prefix plus length.
///
/// UTF-8 rule: `chars().take(n)`, never a byte slice — a key could in principle
/// be pasted with a multi-byte character and byte slicing would panic.
pub fn fingerprint(secret: &str) -> String {
    let head: String = secret.chars().take(4).collect();
    format!("{}…({} chars)", head, secret.chars().count())
}

// ── Core store ──────────────────────────────────────────────────────

/// Reads and writes the API key, preferring the OS credential store.
///
/// Constructed with an explicit fallback directory rather than reaching for
/// `AppHandle::path()` internally, so the whole thing is unit-testable against
/// a temp directory. `use_keyring` exists for the same reason: a test must be
/// able to exercise the degraded path deterministically without depending on
/// whether the machine running the suite happens to have an unlocked keyring.
pub struct SecretStore {
    fallback_dir: PathBuf,
    use_keyring: bool,
}

impl SecretStore {
    /// Normal construction: try the credential store first.
    pub fn new(fallback_dir: impl Into<PathBuf>) -> Self {
        Self {
            fallback_dir: fallback_dir.into(),
            use_keyring: true,
        }
    }

    /// Force the degraded path. Test-only in practice, but not `#[cfg(test)]`
    /// so a future "user disabled keyring" preference can reuse it.
    pub fn without_keyring(fallback_dir: impl Into<PathBuf>) -> Self {
        Self {
            fallback_dir: fallback_dir.into(),
            use_keyring: false,
        }
    }

    fn fallback_path(&self) -> PathBuf {
        self.fallback_dir.join(FALLBACK_FILE)
    }

    /// Store the key. Returns where it landed.
    ///
    /// On a successful keyring write any stale fallback file is removed — the
    /// whole point of the migration is that the plaintext copy goes away.
    pub fn set(&self, value: &str) -> Result<SecretBackend, String> {
        if value.is_empty() {
            // Empty means "no key"; treat it as a delete so we never leave a
            // zero-length credential behind that `has_key` would count.
            self.delete()?;
            return Ok(SecretBackend::None);
        }

        if self.use_keyring {
            match keyring_set(value) {
                Ok(()) => {
                    // Best-effort: a leftover plaintext file is now redundant
                    // *and* dangerous, so drop it. Failure to remove is logged
                    // but must not fail the write that already succeeded.
                    if let Err(e) = self.fallback_delete() {
                        log::warn!("secrets: keyring write ok but fallback cleanup failed: {}", e);
                    }
                    return Ok(SecretBackend::OsKeyring);
                }
                Err(e) => {
                    log::warn!(
                        "secrets: OS credential store unavailable, degrading to an UNPROTECTED file: {}",
                        scrub(&e)
                    );
                }
            }
        }

        self.fallback_write(value)?;
        Ok(SecretBackend::UnprotectedFile)
    }

    /// Read the key. **Backend-internal**: no Tauri command exposes this.
    pub fn get(&self) -> Option<(String, SecretBackend)> {
        if self.use_keyring {
            match keyring_get() {
                Ok(Some(v)) if !v.is_empty() => return Some((v, SecretBackend::OsKeyring)),
                Ok(_) => {}
                Err(e) => log::warn!("secrets: credential store read failed: {}", scrub(&e)),
            }
        }
        match self.fallback_read() {
            Some(v) if !v.is_empty() => Some((v, SecretBackend::UnprotectedFile)),
            _ => None,
        }
    }

    /// Remove the key from *both* locations. Deleting only the active one would
    /// leave a shadow copy that a later degraded read would resurrect.
    pub fn delete(&self) -> Result<(), String> {
        let mut first_error = None;
        if self.use_keyring {
            if let Err(e) = keyring_delete() {
                first_error = Some(scrub(&e));
            }
        }
        if let Err(e) = self.fallback_delete() {
            first_error = first_error.or(Some(e));
        }
        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Everything the UI needs, and nothing it must not have.
    pub fn status(&self) -> SecretStatus {
        match self.get() {
            Some((_, SecretBackend::OsKeyring)) => SecretStatus {
                backend: SecretBackend::OsKeyring,
                protected: true,
                has_key: true,
                fallback_reason: None,
            },
            Some((_, backend)) => SecretStatus {
                backend,
                protected: false,
                has_key: true,
                // Re-probe so the reason is current rather than remembered from
                // whatever happened at write time.
                fallback_reason: Some(self.degradation_reason()),
            },
            None => SecretStatus {
                backend: SecretBackend::None,
                protected: false,
                has_key: false,
                fallback_reason: None,
            },
        }
    }

    /// Why the credential store is not in use, phrased for a warning banner.
    fn degradation_reason(&self) -> String {
        if !self.use_keyring {
            return "The OS credential store is disabled for this session.".to_string();
        }
        match keyring_probe() {
            Ok(()) => "The key predates credential-store support; re-save it in Settings to move it.".to_string(),
            Err(e) => scrub(&e),
        }
    }

    /// Move a legacy plaintext key into the credential store.
    ///
    /// Ordering is the whole point: **write new, verify, only then tell the
    /// caller it may delete the old copy.** A failure at any step leaves the
    /// plaintext where it is — an exposed key is bad, a lost key is worse and
    /// unrecoverable.
    ///
    /// Idempotent: if a key is already stored, the plaintext is declared
    /// redundant without being re-written. The stored value wins, because it is
    /// the one the user last saved through the hardened path.
    pub fn migrate_plaintext(&self, plaintext: &str) -> MigrationOutcome {
        if plaintext.is_empty() {
            return MigrationOutcome {
                migrated: false,
                backend: SecretBackend::None,
                plaintext_can_be_deleted: true, // nothing to lose
                protected: false,
                detail: Some("No plaintext key to migrate.".to_string()),
            };
        }

        // Already migrated (possibly on an earlier launch) ⇒ no write, but the
        // old copy is safe to drop.
        if let Some((_, backend)) = self.get() {
            return MigrationOutcome {
                migrated: false,
                backend,
                plaintext_can_be_deleted: true,
                protected: backend.is_protected(),
                detail: Some("A key is already stored; the plaintext copy is redundant.".to_string()),
            };
        }

        let backend = match self.set(plaintext) {
            Ok(b) => b,
            Err(e) => {
                return MigrationOutcome {
                    migrated: false,
                    backend: SecretBackend::None,
                    plaintext_can_be_deleted: false, // keep the only copy
                    protected: false,
                    detail: Some(scrub(&e)),
                }
            }
        };

        // Read-back verification. Without this a backend that accepts a write
        // and silently drops it would make us delete the user's only copy.
        let verified = matches!(self.get(), Some((v, _)) if v == plaintext);
        if !verified {
            log::warn!(
                "secrets: migration read-back mismatch for {}; keeping the plaintext copy",
                fingerprint(plaintext)
            );
            return MigrationOutcome {
                migrated: false,
                backend,
                plaintext_can_be_deleted: false,
                protected: backend.is_protected(),
                detail: Some("Stored value did not read back identically.".to_string()),
            };
        }

        MigrationOutcome {
            migrated: true,
            backend,
            plaintext_can_be_deleted: true,
            protected: backend.is_protected(),
            detail: None,
        }
    }

    // ── Fallback file I/O ───────────────────────────────────────────
    //
    // The fallback is JSON, not raw text, so the alarming banner rides along
    // with the value and survives a copy-paste of the file elsewhere.

    fn fallback_write(&self, value: &str) -> Result<(), String> {
        std::fs::create_dir_all(&self.fallback_dir)
            .map_err(|e| format!("create fallback dir: {}", e))?;
        let path = self.fallback_path();
        let doc = serde_json::json!({
            "_warning": FALLBACK_BANNER,
            "llm_api_key": value,
        });
        let body = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("serialize fallback: {}", e))?;
        std::fs::write(&path, body).map_err(|e| format!("write fallback: {}", e))?;
        restrict_permissions(&path);
        Ok(())
    }

    fn fallback_read(&self) -> Option<String> {
        let body = std::fs::read_to_string(self.fallback_path()).ok()?;
        let doc: serde_json::Value = serde_json::from_str(&body).ok()?;
        doc.get("llm_api_key")?.as_str().map(|s| s.to_string())
    }

    fn fallback_delete(&self) -> Result<(), String> {
        let path = self.fallback_path();
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove fallback: {}", e)),
        }
    }
}

/// Best-effort `0600` on the fallback file so at least same-machine other users
/// can't read it. No-op on Windows, where the per-user profile ACL already
/// restricts it and Unix mode bits don't apply.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        log::warn!("secrets: could not tighten fallback file permissions: {}", e);
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

// ── keyring backend wrappers ────────────────────────────────────────
//
// Thin adapters over the `keyring` crate. Kept private and free of any logging
// of the value so the secret path stays auditable in one place.

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, LLM_API_KEY_ACCOUNT)
        .map_err(|e| format!("open credential entry: {}", e))
}

fn keyring_set(value: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(value)
        .map_err(|e| format!("credential store write: {}", e))
}

fn keyring_get() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        // "no entry" is the normal empty state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("credential store read: {}", e)),
    }
}

fn keyring_delete() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("credential store delete: {}", e)),
    }
}

/// Reachability probe for the credential store, used only to phrase the
/// degradation reason — never to gate a write.
///
/// Deliberately a *read* rather than just constructing an `Entry`: on most
/// platforms `Entry::new` succeeds even when the backing store is unreachable,
/// so it would report health that doesn't exist.
fn keyring_probe() -> Result<(), String> {
    keyring_get().map(|_| ())
}


// ── Tauri command surface ───────────────────────────────────────────
//
// These are the ONLY entry points the frontend has. Note what is missing:
// there is no command that returns the key. `resolve_api_key` is Rust-only.

/// Resolve the app's fallback directory. Isolated so both the commands and any
/// future caller build the `SecretStore` the same way.
fn store_for(app: &tauri::AppHandle) -> Result<SecretStore, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {}", e))?;
    Ok(SecretStore::new(dir))
}

/// Store (or clear, if empty) the LLM API key. Returns where it landed so the
/// UI can immediately reflect protected vs. unprotected.
#[tauri::command]
pub fn set_api_key(app: tauri::AppHandle, key: String) -> Result<SecretStatus, String> {
    let store = store_for(&app)?;
    store.set(&key)?;
    Ok(store.status())
}

/// Report whether a key is stored and whether the OS is protecting it. Never
/// returns the key itself.
#[tauri::command]
pub fn get_api_key_status(app: tauri::AppHandle) -> Result<SecretStatus, String> {
    Ok(store_for(&app)?.status())
}

/// Forget the key entirely (both backends).
#[tauri::command]
pub fn delete_api_key(app: tauri::AppHandle) -> Result<(), String> {
    store_for(&app)?.delete()
}

/// One-shot migration of a plaintext key handed up from the frontend's legacy
/// `localStorage` / `settings.json`. The frontend deletes its plaintext copy
/// only if `plaintext_can_be_deleted` comes back `true`.
#[tauri::command]
pub fn migrate_api_key(
    app: tauri::AppHandle,
    plaintext: String,
) -> Result<MigrationOutcome, String> {
    Ok(store_for(&app)?.migrate_plaintext(&plaintext))
}

/// Backend-only accessor for outgoing LLM / embedding requests.
///
/// This is what lets the key stop round-tripping through the WebView: request
/// builders call here instead of receiving `apiKey` as a command argument.
pub fn resolve_api_key(app: &tauri::AppHandle) -> Option<String> {
    store_for(app).ok()?.get().map(|(v, _)| v)
}

// ── Request-vs-stored precedence ────────────────────────────────────
//
// Once `loadLlmConfig` stopped returning `apiKey`, every command that copied
// `request.api_key` straight into an `LlmConfig` started sending `None`, so no
// `Authorization` header went out and every cloud provider answered 401. The
// fix is not "read the store instead" — a user who has not migrated yet still
// ships the key in the request and must keep working. Both sources have to be
// consulted, in a fixed order, from one place.

/// A key exactly as it arrived from the WebView — **unresolved**.
///
/// Deliberately *not* `Option<String>`. Request structs declare this type so
/// that `api_key: request.api_key` inside an `LlmConfig` literal is a *compile
/// error*: the inner value is private to this module, and the only way out is
/// [`resolve_api_key_with_override`], which applies the precedence rule. That
/// turns "someone reintroduced the raw pass-through" from a silent 401 into a
/// build failure.
///
/// `#[serde(transparent)]` keeps the wire format identical to the plain
/// `Option<String>` it replaces (`"sk-…"`, `null`, or the field omitted when the
/// declaring field carries `#[serde(default)]`), so no frontend call site or
/// `invoke` payload changes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct RequestApiKey(Option<String>);

impl RequestApiKey {
    /// Test-only seam. Command handlers never need it — serde builds theirs —
    /// and keeping it `#[cfg(test)]` means no production code can mint an
    /// "unresolved key" out of thin air and hand it somewhere unresolved.
    #[cfg(test)]
    pub fn from_raw(value: Option<String>) -> Self {
        Self(value)
    }
}

/// Treat blank as absent.
///
/// `Some("")` is the dangerous case: it is what an unmigrated-but-empty settings
/// field sends, and it would satisfy `if let Some(key)` in the request builders
/// and emit a literal `Authorization: Bearer ` header — a 401 that looks like a
/// revoked key rather than a missing one. Whitespace-only is folded in for the
/// same reason: a pasted-then-cleared input can leave a stray space, and no real
/// provider key is whitespace.
///
/// A value that merely *has* surrounding whitespace is passed through byte-for-
/// byte. We decide presence here, we do not rewrite a key the user gave us.
fn blank_as_absent(key: Option<String>) -> Option<String> {
    key.filter(|k| !k.trim().is_empty())
}

/// The precedence rule, as a pure function so it can be tested without a
/// running Tauri app (`AppHandle` cannot be constructed outside one).
///
/// **Request key wins; the stored key only fills a gap.** The request is the
/// not-yet-migrated user, and that legacy path has to keep working — if the
/// WebView still holds a key, it is by definition the one the user just typed
/// into Settings, and it must not be shadowed by a stale credential-store copy.
///
/// `None` is a valid, non-error outcome: local providers (Ollama) need no key,
/// and the request builders simply omit the header.
fn choose_api_key(request_key: Option<String>, stored_key: Option<String>) -> Option<String> {
    blank_as_absent(request_key).or_else(|| blank_as_absent(stored_key))
}

/// The one helper every `LlmConfig` construction site calls to fill `api_key`.
///
/// Precedence lives entirely in [`choose_api_key`]; this function's only job is
/// to supply the stored side of it. The credential store is read even when the
/// request already carried a key, so that the precedence rule exists in exactly
/// one place rather than being half-encoded as a short-circuit here. That costs
/// one keyring read per command invocation — the same unconditional read
/// `fetch_custom_embeddings` already does per embedding batch — and the value is
/// dropped without being logged when the request wins.
///
/// Returns the key by value because that is what `LlmConfig.api_key` needs; it
/// is never logged, echoed, or handed back across the command boundary.
pub fn resolve_api_key_with_override(
    app: &tauri::AppHandle,
    request_key: RequestApiKey,
) -> Option<String> {
    choose_api_key(request_key.0, resolve_api_key(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative-looking key so the redaction assertions are meaningful.
    const FAKE_KEY: &str = "sk-testtesttesttesttesttest1234567890";

    /// Unique scratch dir — the suite runs in parallel in one process.
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zettel_secrets_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every test uses the keyring-disabled store: the degraded path is the one
    /// that has interesting logic, and it is the only one that behaves
    /// identically on a dev box, a headless CI runner and a container.
    fn degraded(tag: &str) -> (SecretStore, PathBuf) {
        let dir = temp_dir(tag);
        (SecretStore::without_keyring(&dir), dir)
    }

    // (1) The degraded path must work, and must say out loud that it is degraded.
    #[test]
    fn fallback_round_trips_and_reports_itself_as_unprotected() {
        let (store, dir) = degraded("fallback");

        let backend = store.set(FAKE_KEY).unwrap();
        assert_eq!(backend, SecretBackend::UnprotectedFile);

        let (value, from) = store.get().expect("the key must read back");
        assert_eq!(value, FAKE_KEY);
        assert_eq!(from, SecretBackend::UnprotectedFile);

        let status = store.status();
        assert!(status.has_key);
        assert!(
            !status.protected,
            "a plaintext fallback must NEVER report itself as protected"
        );
        assert_eq!(status.backend, SecretBackend::UnprotectedFile);
        assert!(
            status.fallback_reason.is_some(),
            "the UI needs a reason to show the user"
        );

        // The file itself carries the warning, so it stays obvious even if the
        // file is copied out of the app directory.
        let on_disk = std::fs::read_to_string(dir.join(FALLBACK_FILE)).unwrap();
        assert!(on_disk.contains("NOT encrypted"));
        assert!(on_disk.contains("未加密"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (2) A fresh store has nothing, and says so without inventing a backend.
    #[test]
    fn empty_store_reports_no_key() {
        let (store, dir) = degraded("empty");
        let status = store.status();
        assert!(!status.has_key);
        assert!(!status.protected);
        assert_eq!(status.backend, SecretBackend::None);
        assert!(status.fallback_reason.is_none());
        assert!(store.get().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // (3) Saving an empty string is a delete, not a zero-length credential.
    #[test]
    fn setting_an_empty_value_clears_the_key() {
        let (store, dir) = degraded("clear");
        store.set(FAKE_KEY).unwrap();
        assert!(store.get().is_some());

        assert_eq!(store.set("").unwrap(), SecretBackend::None);
        assert!(store.get().is_none());
        assert!(
            !dir.join(FALLBACK_FILE).exists(),
            "clearing must remove the plaintext file, not blank it"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (4) The migration contract: only greenlight deleting the old copy after
    //     the new location has been verified.
    #[test]
    fn migration_verifies_before_allowing_plaintext_deletion() {
        let (store, dir) = degraded("migrate");

        let first = store.migrate_plaintext(FAKE_KEY);
        assert!(first.migrated, "the first call is what moves the value");
        assert!(
            first.plaintext_can_be_deleted,
            "read-back succeeded, so the legacy copy is now redundant"
        );
        assert!(!first.protected, "degraded store is not protected");
        assert_eq!(store.get().unwrap().0, FAKE_KEY);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (5) Idempotence: re-running migration on every launch must be harmless
    //     and must not overwrite the value the user last saved properly.
    #[test]
    fn migration_is_idempotent_and_keeps_the_stored_value() {
        let (store, dir) = degraded("idempotent");
        store.set("sk-the-one-the-user-saved-properly-0001").unwrap();

        let second = store.migrate_plaintext(FAKE_KEY);
        assert!(!second.migrated, "nothing to move — a key is already stored");
        assert!(
            second.plaintext_can_be_deleted,
            "the legacy copy is redundant and should be cleaned up"
        );
        assert_eq!(
            store.get().unwrap().0,
            "sk-the-one-the-user-saved-properly-0001",
            "the already-stored value must win over the legacy plaintext"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (6) Nothing to migrate is a success, not an error — otherwise every
    //     new install would log a scary failure on first launch.
    #[test]
    fn migrating_an_empty_plaintext_is_a_noop() {
        let (store, dir) = degraded("noop");
        let out = store.migrate_plaintext("");
        assert!(!out.migrated);
        assert!(out.plaintext_can_be_deleted);
        assert_eq!(out.backend, SecretBackend::None);
        assert!(store.get().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // (7) Delete must clear the fallback too, or a degraded read would
    //     resurrect a key the user thought they removed.
    #[test]
    fn delete_removes_the_fallback_copy() {
        let (store, dir) = degraded("delete");
        store.set(FAKE_KEY).unwrap();
        store.delete().unwrap();
        assert!(store.get().is_none());
        assert!(!dir.join(FALLBACK_FILE).exists());
        // Deleting again is not an error.
        store.delete().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // (8) Log hygiene: neither helper may emit the raw secret.
    #[test]
    fn log_helpers_never_emit_the_raw_secret() {
        let printed = fingerprint(FAKE_KEY);
        assert!(!printed.contains(FAKE_KEY));
        assert!(printed.starts_with("sk-t"));
        assert!(printed.contains(&format!("{} chars", FAKE_KEY.chars().count())));


        let scrubbed = scrub(&format!("credential store write failed for {}", FAKE_KEY));
        assert!(
            !scrubbed.contains(FAKE_KEY),
            "an error string echoing the key must be scrubbed: {}",
            scrubbed
        );
        assert!(scrubbed.contains("[API_KEY_REDACTED]"));
    }

    // (9) UTF-8 rule: fingerprinting must count characters, not bytes, and must
    //     not panic on a multi-byte value.
    #[test]
    fn fingerprint_is_utf8_safe() {
        let multibyte = "密钥令牌值";
        let printed = fingerprint(multibyte);
        assert!(printed.starts_with("密钥令牌"));
        assert!(printed.contains("5 chars"));

        // Shorter than the 4-char prefix — must not over-take.
        assert!(fingerprint("键").starts_with("键"));
        assert!(fingerprint("").contains("0 chars"));
    }

    // (10) Only the OS keyring counts as protection.
    #[test]
    fn only_the_os_keyring_is_considered_protected() {
        assert!(SecretBackend::OsKeyring.is_protected());
        assert!(!SecretBackend::UnprotectedFile.is_protected());
        assert!(!SecretBackend::None.is_protected());
    }

    // ── Request-vs-stored precedence ────────────────────────────────
    //
    // `resolve_api_key_with_override` needs an `AppHandle`, which cannot be
    // built outside a running Tauri app, so the precedence logic is factored
    // into the pure `choose_api_key` and tested here directly. Same tactic as
    // `search_commands`'s tests, which exercise a command's delegated
    // primitives rather than the command.

    const STORED_KEY: &str = "sk-from-the-os-credential-store-0001";
    const REQUEST_KEY: &str = "sk-typed-into-settings-just-now-0002";

    // (11) The regression this whole mechanism exists to prevent: a migrated
    //      user has no request key, so the stored one must be what goes out.
    //      Before the fix this resolved to `None` and every request went out
    //      with no `Authorization` header → 401 from every cloud provider.
    #[test]
    fn stored_key_is_used_when_the_request_has_none() {
        assert_eq!(
            choose_api_key(None, Some(STORED_KEY.to_string())),
            Some(STORED_KEY.to_string())
        );
    }

    // (12) The legacy path must keep working, and must keep *winning*: a user
    //      who has not migrated still ships the key in the request, and that
    //      value is fresher than anything in the store.
    #[test]
    fn request_key_wins_over_the_stored_key() {
        assert_eq!(
            choose_api_key(Some(REQUEST_KEY.to_string()), Some(STORED_KEY.to_string())),
            Some(REQUEST_KEY.to_string()),
            "the request is the not-yet-migrated user and must not be shadowed"
        );
    }

    // (13) `Some("")` must fall through rather than win. If it won, the request
    //      builders' `if let Some(key)` would emit a literal `Authorization:
    //      Bearer ` and the 401 would look like a revoked key.
    #[test]
    fn an_empty_request_string_falls_through_to_the_stored_key() {
        assert_eq!(
            choose_api_key(Some(String::new()), Some(STORED_KEY.to_string())),
            Some(STORED_KEY.to_string())
        );
    }

    // (14) Whitespace-only is absent too — a pasted-then-cleared input can leave
    //      a stray space, and no provider key is whitespace.
    #[test]
    fn a_whitespace_only_request_string_falls_through_to_the_stored_key() {
        assert_eq!(
            choose_api_key(Some("   \t\n".to_string()), Some(STORED_KEY.to_string())),
            Some(STORED_KEY.to_string())
        );
        // Blankness is decided on the *trimmed* value, but a non-blank key is
        // handed on byte-for-byte — we do not rewrite what the user gave us.
        assert_eq!(
            choose_api_key(Some("  sk-padded  ".to_string()), None),
            Some("  sk-padded  ".to_string())
        );
    }

    // (15) A blank stored value is absent as well, so it cannot mask a real
    //      request key or fabricate a header on its own.
    #[test]
    fn a_blank_stored_value_is_treated_as_absent() {
        assert_eq!(
            choose_api_key(None, Some("  ".to_string())),
            None,
            "a blank credential must not become `Authorization: Bearer `"
        );
        assert_eq!(
            choose_api_key(Some(REQUEST_KEY.to_string()), Some(String::new())),
            Some(REQUEST_KEY.to_string())
        );
    }

    // (16) Nothing anywhere is a valid, non-error state: Ollama and other local
    //      providers need no key and the header is simply omitted.
    #[test]
    fn no_key_anywhere_stays_none_rather_than_erroring() {
        assert_eq!(choose_api_key(None, None), None);
        assert_eq!(choose_api_key(Some(String::new()), Some(String::new())), None);
        assert_eq!(choose_api_key(Some(" ".to_string()), None), None);
    }

    // (17) The newtype's wire format must be indistinguishable from the
    //      `Option<String>` it replaced, or every existing `invoke` payload
    //      would start failing to deserialize.
    #[test]
    fn request_api_key_deserializes_like_an_optional_string() {
        #[derive(Deserialize)]
        struct Probe {
            #[serde(default)]
            api_key: RequestApiKey,
        }

        let present: Probe = serde_json::from_str(r#"{"api_key":"sk-abc"}"#).unwrap();
        assert_eq!(present.api_key.0.as_deref(), Some("sk-abc"));

        let null: Probe = serde_json::from_str(r#"{"api_key":null}"#).unwrap();
        assert_eq!(null.api_key.0, None);

        // Omitted entirely — this is why every declaring field carries
        // `#[serde(default)]`; without it serde would reject the payload.
        let missing: Probe = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.api_key.0, None);
    }

    // (18) `from_raw` is the test-only seam; confirm it feeds the same logic the
    //      commands go through, so these tests are not asserting about a
    //      parallel universe.
    #[test]
    fn from_raw_round_trips_through_the_precedence_rule() {
        let request = RequestApiKey::from_raw(Some(REQUEST_KEY.to_string()));
        assert_eq!(
            choose_api_key(request.0, Some(STORED_KEY.to_string())),
            Some(REQUEST_KEY.to_string())
        );

        let blank = RequestApiKey::from_raw(Some(String::new()));
        assert_eq!(
            choose_api_key(blank.0, Some(STORED_KEY.to_string())),
            Some(STORED_KEY.to_string())
        );

        assert_eq!(RequestApiKey::default().0, None);
    }

    // (19) Defence in depth over the type-level guard. `RequestApiKey` already
    //      makes `api_key: request.api_key` a *compile* error, but only for as
    //      long as the field keeps that type. If someone reverts it to a bare
    //      `Option<String>`, the compiler goes quiet again — so this test scans
    //      the command sources directly and fails on the raw pass-through, and
    //      requires the helper's presence in every file that builds an
    //      `LlmConfig` from a request. It is the grep-style guard the fix's
    //      author asked for, kept next to the type-level one deliberately.
    #[test]
    fn command_sites_never_pass_the_request_key_through_raw() {
        // `env!` resolves at compile time to this crate's root, so the test does
        // not depend on the working directory the suite is launched from.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");

        // Every file that constructs an `LlmConfig` from a command request. If a
        // new such command is added, add it here — an omission is caught the
        // first time that command 401s in the wild, which is exactly the class
        // of bug this test exists to prevent, so keep the list honest.
        let files = [
            "chat_commands.rs",
            "scheduler_commands.rs",
            "graph_commands.rs",
        ];

        // The forbidden shapes: the field assigned straight from the deserialized
        // request without going through the precedence helper.
        let forbidden = [
            "api_key: request.api_key",
            "api_key: request.api_key.clone()",
        ];

        for file in files {
            let path = root.join(file);
            let src = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));

            for pat in forbidden {
                assert!(
                    !src.contains(pat),
                    "{} reintroduced a raw `{}` - route it through \
                     secrets::resolve_api_key_with_override so the migrated \
                     user's key is not dropped",
                    file,
                    pat
                );
            }

            assert!(
                src.contains("resolve_api_key_with_override"),
                "{} builds an LlmConfig but never calls \
                 resolve_api_key_with_override; the OS-stored key will be \
                 ignored and cloud requests will 401",
                file
            );
        }
    }
}





