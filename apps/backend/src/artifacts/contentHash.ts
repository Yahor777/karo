/**
 * Content hashing for File_Artifact bytes (task 10.1).
 *
 * The Artifact Store identifies "same content" by SHA-256 of the raw
 * `Uint8Array` payload, encoded as lowercase hex. Two consequences:
 *
 *   • A repeated `writeArtifact` call carrying byte-identical content for
 *     the same `(taskId, artifactId)` is a no-op — design.md → "Artifact
 *     Store" → "Rules": "Same contentHash for same artifact is no-op and
 *     does not increment version".
 *   • `FileArtifactVersion.contentHash` is publicly observable on the wire
 *     (it appears in metadata, diff requests and Final_Report references)
 *     and must be deterministic across processes and machines.
 *
 * SHA-256 is the obvious fit: collision resistance is comfortably more
 * than required for "are these two byte arrays the same?" and Node's
 * native `crypto` module supports it out of the box, no extra
 * dependency.
 *
 * The function is exported as a pure helper so tests, the Final_Report
 * builder (task 15.2), and any future migration tooling all compute the
 * same hash without having to know the internals.
 */

import { createHash } from "node:crypto";

/**
 * SHA-256 of `bytes`, lowercase hex.
 *
 * `bytes` is hashed as-is — no normalisation, no encoding assumptions.
 * Callers that want to hash a string MUST encode it (e.g. UTF-8) before
 * calling so the same logical content always produces the same hash
 * regardless of where it was constructed.
 */
export function computeContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
