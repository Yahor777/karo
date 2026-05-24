/**
 * Browser-friendly crypto helpers for the renderer-local orchestrator.
 *
 * Wraps `globalThis.crypto` so the rest of the orchestration module
 * does not have to inline `crypto.subtle` plumbing or repeat the
 * `Uint8Array` ↔ hex string dance.
 *
 * No `node:crypto` imports — the desktop renderer runs in Tauri's
 * WebView2 (Edge), not Node, so only the WebCrypto API is available.
 *
 * Validates: Requirements 1.6 (no plaintext key leaks), 7.4 (atomic
 * artifact writes need a stable content hash).
 */

export function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error(
      "orchestration: globalThis.crypto.randomUUID is required.",
    );
  }
  return globalThis.crypto.randomUUID();
}

const utf8Encoder = new TextEncoder();

/**
 * Lowercase hex SHA-256 digest of a UTF-8 string. Used to derive the
 * `contentHash` field on artifact versions so two byte-identical
 * writes produce the same hash and the in-memory store can deduplicate
 * (Requirement 7.4 idempotency).
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    throw new Error("orchestration: globalThis.crypto.subtle is required.");
  }
  const data: ArrayBuffer =
    typeof input === "string"
      ? toArrayBuffer(utf8Encoder.encode(input))
      : toArrayBuffer(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Copy a Uint8Array into a fresh ArrayBuffer. The structural cast keeps
 * `crypto.subtle.digest` happy under TypeScript 5.6+'s strict
 * `BufferSource` typing — `Uint8Array<ArrayBufferLike>` is not directly
 * assignable to `ArrayBuffer` because `ArrayBufferLike` includes
 * `SharedArrayBuffer`.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i] ?? 0;
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}
