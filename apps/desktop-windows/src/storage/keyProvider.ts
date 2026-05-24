/**
 * `KeyMaterialProvider` implementations.
 *
 * Two concrete providers ship with this package:
 *
 *   • {@link InMemoryKeyMaterialProvider}    — deterministic, used by
 *     unit and property tests; never persists anything.
 *   • {@link RandomInMemoryKeyMaterialProvider} — generates a fresh
 *     random key per instance; used for in-process scenarios where
 *     the key only needs to live as long as the process.
 *
 * The production Tauri shell uses an OS-keychain-backed provider on
 * the Rust side (DPAPI on Windows, macOS Keychain, libsecret on
 * Linux). That side does not go through this module at all — the TS
 * `nativeBindings` simply forwards to a Tauri command which performs
 * the OS keychain lookup before invoking the Rust-side AES-GCM code.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import { AES_256_KEY_LENGTH } from "./secretCipher.js";
import type { KeyMaterialProvider } from "./types.js";

/**
 * Returns a `KeyMaterialProvider` that always yields the supplied
 * 32-byte buffer. The provider clones its input so callers can zero
 * the source buffer afterwards without affecting the cipher.
 *
 * This is the only key provider used in unit tests — it makes
 * encryption deterministic across runs (encryption itself is still
 * non-deterministic because of the random IV, but a cipher built
 * with the same key can decrypt blobs from a previous run).
 */
export class InMemoryKeyMaterialProvider implements KeyMaterialProvider {
  private readonly key: Uint8Array;

  public constructor(keyBytes: Uint8Array) {
    if (keyBytes.length !== AES_256_KEY_LENGTH) {
      throw new Error(
        `InMemoryKeyMaterialProvider requires ${AES_256_KEY_LENGTH} bytes; ` +
          `got ${keyBytes.length}.`,
      );
    }
    // Defensive copy so external mutation can't change the cipher key.
    this.key = new Uint8Array(keyBytes);
  }

  public getKeyBytes(): Promise<Uint8Array> {
    // Return a fresh copy so the consumer cannot mutate our state.
    return Promise.resolve(new Uint8Array(this.key));
  }
}

/**
 * Generates a fresh random 32-byte key once and reuses it for the
 * lifetime of the instance. Useful for ad-hoc desktop runs where the
 * encrypted store does not need to survive a process restart.
 *
 * Production code SHOULD prefer the OS-keychain-backed provider so
 * stored secrets remain decryptable across launches.
 */
export class RandomInMemoryKeyMaterialProvider
  implements KeyMaterialProvider
{
  private readonly key: Uint8Array;

  public constructor() {
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
      throw new Error(
        "RandomInMemoryKeyMaterialProvider requires globalThis.crypto.getRandomValues.",
      );
    }
    const buf = new Uint8Array(AES_256_KEY_LENGTH);
    globalThis.crypto.getRandomValues(buf);
    this.key = buf;
  }

  public getKeyBytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.key));
  }
}
