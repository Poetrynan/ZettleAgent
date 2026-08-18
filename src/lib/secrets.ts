/**
 * Frontend gateway to the OS-credential-store-backed API key.
 *
 * ## Why this file exists
 *
 * The LLM API key used to be persisted in plaintext in two places the WebView
 * could read: `localStorage['zettelagent-llm']` and the Tauri Store's
 * `settings.json`. This module is the frontend half of moving that key into the
 * platform credential vault (Windows Credential Manager / macOS Keychain /
 * Linux Secret Service), managed by the Rust `secrets` module.
 *
 * ## The contract
 *
 * The frontend can *store*, *probe*, *delete* and *migrate* the key — it can
 * never *read* it back. There is deliberately no `getApiKey()`: the raw value
 * only exists in Rust, which is what stops it from re-accumulating in the
 * WebView's storage. Backend request builders resolve it themselves via
 * `secrets::resolve_api_key_with_override`, which prefers a key still supplied
 * in the request (the not-yet-migrated user) and otherwise reads this store.
 *
 * All calls are thin wrappers over Tauri commands that the app registers in
 * `lib.rs` (see the delivery report for the exact `invoke` names).
 */

import { invoke } from '@tauri-apps/api/core';

/** Where the key physically lives. Mirrors the Rust `SecretBackend` enum. */
export type SecretBackend = 'os-keyring' | 'unprotected-file' | 'none';

/** Safe-to-render status. Never carries the secret itself. */
export interface SecretStatus {
  backend: SecretBackend;
  /** `true` only when the OS credential store is guarding the key. */
  protected: boolean;
  has_key: boolean;
  /** Present when `protected` is false — a human-readable reason to warn about. */
  fallback_reason: string | null;
}

/** Result of the one-shot legacy-plaintext migration. */
export interface MigrationOutcome {
  migrated: boolean;
  backend: SecretBackend;
  /**
   * The frontend may delete its plaintext copy ONLY when this is `true`.
   * The backend sets it after reading the stored value back, so a half-failed
   * migration can never make us drop the user's only copy.
   */
  plaintext_can_be_deleted: boolean;
  protected: boolean;
  detail: string | null;
}

/**
 * Store (or clear, when `key` is empty) the LLM API key in the OS credential
 * store. Returns the resulting status so callers can immediately reflect
 * whether protection actually took effect.
 */
export async function setApiKey(key: string): Promise<SecretStatus> {
  return invoke<SecretStatus>('set_api_key', { key });
}

/** Ask whether a key is stored and whether the OS is protecting it. */
export async function getApiKeyStatus(): Promise<SecretStatus> {
  return invoke<SecretStatus>('get_api_key_status');
}

/** Forget the key entirely, in every backend. */
export async function deleteApiKey(): Promise<void> {
  await invoke('delete_api_key');
}

/**
 * Hand a legacy plaintext key to the backend for one-shot migration.
 * Returns the outcome; the caller decides whether to delete its plaintext copy
 * based on `plaintext_can_be_deleted`.
 */
export async function migrateApiKey(plaintext: string): Promise<MigrationOutcome> {
  return invoke<MigrationOutcome>('migrate_api_key', { plaintext });
}
