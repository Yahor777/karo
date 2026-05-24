/**
 * Local Encrypted Storage primitives.
 *
 * The design (see `design.md` → "Desktop Shell" → "Security rules") requires:
 *
 *   1. API_Key plaintext is never persisted.
 *   2. After save, plaintext never re-enters renderer code paths — only
 *      backend/server components may call `decryptLocalSecret` (this is
 *      enforced by `SettingsStore.resolveApiKeySecret`, task 6.3, not by
 *      the bridge itself).
 *   3. `EncryptedBlob` is tied to the device because the wrapping key
 *      lives in OS-backed key storage on the local machine and never
 *      leaves it.
 *
 * To keep the abstraction testable on Node + Vitest without the Rust
 * toolchain, every concern is split into a small pluggable surface:
 *
 *   • {@link KeyMaterialProvider}  — supplies a 32-byte device key.
 *     Production uses an OS-backed implementation (DPAPI on Windows,
 *     macOS Keychain, libsecret); tests use a deterministic in-memory
 *     one.
 *   • {@link SecretCipher}         — AEAD wrapper around the device
 *     key. The default implementation uses AES-256-GCM via WebCrypto.
 *   • {@link LocalKvStore}         — durable key/value backend for
 *     non-secret settings and (already-encrypted) secret blobs. The
 *     production version is encrypted SQLite (SQLCipher); the
 *     in-memory and file-backed JSON variants here back the test path.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import type { EncryptedBlob } from "../shell/types.js";

/**
 * Provides the wrapping key used by `SecretCipher`.
 *
 * Implementations MUST keep the key material on the local device and
 * MUST NOT log or transmit it. Production implementations source the
 * key from the OS keychain (DPAPI / macOS Keychain / libsecret) and
 * cache it in memory for the lifetime of the process. Tests use an
 * {@link InMemoryKeyMaterialProvider}.
 */
export interface KeyMaterialProvider {
  /**
   * Returns a stable 32-byte (AES-256) key for this device. The same
   * call MUST yield the same bytes across calls within and across
   * application launches, so encrypted blobs persisted on previous
   * runs remain decryptable.
   */
  getKeyBytes(): Promise<Uint8Array>;
}

/**
 * AEAD cipher used to wrap secrets before they hit `LocalKvStore`.
 *
 * The interface is deliberately minimal: a `string` plaintext in (the
 * only secrets we persist are API keys and tokens, which are short
 * UTF-8 strings) and an opaque {@link EncryptedBlob} out. Implementations
 * MUST:
 *
 *   • use a fresh random IV for every `encrypt` call;
 *   • include an authentication tag so tampering produces a decrypt
 *     failure (never silent corruption);
 *   • populate `algorithm` with a stable identifier so a future cipher
 *     bump can be detected on read.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob): Promise<string>;
}

/**
 * Durable string-keyed JSON value store for the desktop shell.
 *
 * The store DOES NOT itself encrypt values — secret material is wrapped
 * by `SecretCipher` first and persisted as an `EncryptedBlob`. Storing
 * cleartext secrets here is forbidden by the security rules in the
 * design document.
 */
export interface LocalKvStore {
  /** Returns the JSON-typed value for `key`, or `null` if absent. */
  read<T = unknown>(key: string): Promise<T | null>;
  /** Persists `value` under `key`, replacing any prior value. */
  write(key: string, value: unknown): Promise<void>;
  /** Removes the entry for `key`. Resolving when no entry exists is OK. */
  delete(key: string): Promise<void>;
  /** Removes all entries. Used by tests; production code must not call. */
  clear(): Promise<void>;
}
