/**
 * AES-256-GCM `SecretCipher` implementation backed by WebCrypto.
 *
 * Format of the ciphertext field on `EncryptedBlob`:
 *
 *   base64( IV (12 bytes) || GCM ciphertext+tag )
 *
 * Why this shape:
 *
 *   • 12-byte IV is the AES-GCM standard length — every encryption
 *     uses a fresh random IV, prepended so the decrypt path can find
 *     it without an out-of-band parameter.
 *   • The GCM tag is appended to the ciphertext by WebCrypto, so the
 *     blob carries the authentication tag implicitly.
 *   • Base64 keeps the blob safe to round-trip through JSON, SQLite
 *     TEXT columns and Tauri IPC.
 *
 * The class is constructed with a `KeyMaterialProvider` so production
 * (OS keychain) and tests (deterministic in-memory key) can share the
 * same code path. The CryptoKey is cached after first use to avoid
 * re-importing on every call.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import type { EncryptedBlob } from "../shell/types.js";
import type { KeyMaterialProvider, SecretCipher } from "./types.js";

/**
 * Algorithm tag persisted on every blob. Bump (e.g. to "aes-256-gcm.v2")
 * if the wire format ever changes — `decrypt` checks it and rejects
 * unknown values rather than silently mis-decrypting.
 */
export const AES_256_GCM_ALGORITHM = "aes-256-gcm.v1" as const;

/** Length of the AES-GCM IV (nonce) in bytes. */
export const AES_GCM_IV_LENGTH = 12;

/** Length of the AES-256 key in bytes. */
export const AES_256_KEY_LENGTH = 32;

/**
 * Resolves the `SubtleCrypto` available in the current environment.
 *
 * Node 20+ exposes WebCrypto as `globalThis.crypto.subtle`, so does
 * Tauri's WebView (Edge WebView2 on Windows). We deliberately don't
 * depend on `node:crypto` so the same module loads in jsdom-based
 * Vitest, in the Tauri renderer, and in a future plain Web App build.
 */
function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      "SecretCipher requires WebCrypto (globalThis.crypto.subtle). " +
        "This environment does not provide it.",
    );
  }
  return subtle;
}

/** Resolves a CSPRNG view of `getRandomValues`. */
function getRandomBytes(length: number): Uint8Array<ArrayBuffer> {
  // Backing the view with an explicit `ArrayBuffer` (rather than the
  // implicit `ArrayBufferLike` Uint8Array gives you for `new
  // Uint8Array(n)` under TS 5.9+) keeps the result assignable to
  // `BufferSource` parameters of WebCrypto methods.
  const out = new Uint8Array(new ArrayBuffer(length));
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error(
      "SecretCipher requires globalThis.crypto.getRandomValues for IVs.",
    );
  }
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Concatenates two `Uint8Array`s into a fresh buffer. `Buffer.concat`
 * is Node-only; this keeps the cipher portable.
 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Browser-and-Node-portable Base64 encoder. We avoid `Buffer` so the
 * module works inside jsdom and the renderer.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // `btoa` exists in jsdom and modern Node (>= 16).
  return btoa(binary);
}

/** Inverse of `bytesToBase64`. Throws on invalid input. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Production-ready AES-256-GCM cipher.
 *
 * Construction is cheap (no async work) — the wrapping key is imported
 * lazily on the first `encrypt` / `decrypt` call. The same `CryptoKey`
 * instance is reused thereafter; this is safe per the WebCrypto spec.
 */
export class AesGcmSecretCipher implements SecretCipher {
  private readonly keyProvider: KeyMaterialProvider;
  private cachedKey: CryptoKey | null = null;
  private cachedKeyImport: Promise<CryptoKey> | null = null;

  public constructor(keyProvider: KeyMaterialProvider) {
    this.keyProvider = keyProvider;
  }

  public async encrypt(plaintext: string): Promise<EncryptedBlob> {
    const key = await this.getKey();
    const iv = getRandomBytes(AES_GCM_IV_LENGTH);
    const subtle = getSubtle();

    const plainBytesView = new TextEncoder().encode(plaintext);
    // Ensure the buffer-backing is `ArrayBuffer` (not `ArrayBufferLike`)
    // so TS 5.9's tightened `BufferSource` typing accepts it.
    const plainBytes = new Uint8Array(new ArrayBuffer(plainBytesView.length));
    plainBytes.set(plainBytesView);
    const cipherBuf = await subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plainBytes,
    );
    const cipherBytes = new Uint8Array(cipherBuf);

    return {
      algorithm: AES_256_GCM_ALGORITHM,
      ciphertext: bytesToBase64(concatBytes(iv, cipherBytes)),
      createdAt: new Date().toISOString(),
    };
  }

  public async decrypt(blob: EncryptedBlob): Promise<string> {
    if (blob.algorithm !== AES_256_GCM_ALGORITHM) {
      // Refuse to silently mis-decrypt under a different algorithm.
      // A future migration can branch on `blob.algorithm` here.
      throw new Error(
        `SecretCipher: unsupported algorithm "${blob.algorithm}". ` +
          `Expected "${AES_256_GCM_ALGORITHM}".`,
      );
    }

    const combined = base64ToBytes(blob.ciphertext);
    if (combined.length <= AES_GCM_IV_LENGTH) {
      throw new Error("SecretCipher: ciphertext is too short to contain an IV.");
    }
    // `slice` preserves the backing buffer's `ArrayBufferLike` type
    // generic, which TS 5.9 refuses to widen to the strict
    // `BufferSource = ArrayBufferView<ArrayBuffer>` shape WebCrypto
    // expects. Copy into fresh `ArrayBuffer`-backed views so the
    // types line up without an `as` cast.
    const iv = new Uint8Array(new ArrayBuffer(AES_GCM_IV_LENGTH));
    iv.set(combined.subarray(0, AES_GCM_IV_LENGTH));
    const cipherBytes = new Uint8Array(
      new ArrayBuffer(combined.length - AES_GCM_IV_LENGTH),
    );
    cipherBytes.set(combined.subarray(AES_GCM_IV_LENGTH));

    const key = await this.getKey();
    const subtle = getSubtle();
    // WebCrypto throws an opaque DOMException on tag-mismatch; we
    // re-throw a plain Error with a stable message so callers can
    // distinguish "wrong key" / "tampered blob" from input errors.
    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        cipherBytes,
      );
    } catch (cause) {
      const error = new Error(
        "SecretCipher: decryption failed (key mismatch or tampered blob).",
      );
      (error as { cause?: unknown }).cause = cause;
      throw error;
    }
    return new TextDecoder().decode(plainBuf);
  }

  /**
   * Imports the AES key from the underlying provider exactly once and
   * returns the cached `CryptoKey` thereafter.
   */
  private async getKey(): Promise<CryptoKey> {
    if (this.cachedKey !== null) {
      return this.cachedKey;
    }
    if (this.cachedKeyImport === null) {
      this.cachedKeyImport = this.importKey();
    }
    this.cachedKey = await this.cachedKeyImport;
    return this.cachedKey;
  }

  private async importKey(): Promise<CryptoKey> {
    const rawView = await this.keyProvider.getKeyBytes();
    if (rawView.length !== AES_256_KEY_LENGTH) {
      throw new Error(
        `SecretCipher: KeyMaterialProvider returned ${rawView.length} bytes; ` +
          `${AES_256_KEY_LENGTH} required for AES-256-GCM.`,
      );
    }
    // Re-back with a fresh `ArrayBuffer` so WebCrypto's strict
    // `BufferSource` typing is satisfied regardless of how the
    // provider materialised its bytes.
    const raw = new Uint8Array(new ArrayBuffer(rawView.length));
    raw.set(rawView);
    return getSubtle().importKey(
      "raw",
      raw,
      { name: "AES-GCM", length: 256 },
      false, // not extractable — keep the key inside the cipher
      ["encrypt", "decrypt"],
    );
  }
}
