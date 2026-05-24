/**
 * Property test for `ApiKeyService.listApiKeyMetadata` (task 6.5).
 *
 * **Property 9: API_Key is never returned by metadata listing.**
 *
 * Validates: Requirements 3.7.
 *
 * Sources:
 *   - design.md → "Testing Strategy" → "Property-based tests" → Property 9.
 *   - design.md → "Settings Store" → `ApiKeyMetadata` shape; rules:
 *     "Decrypted API_Key must not be returned to client",
 *     "`resolveApiKeySecret` requires explicit server component request".
 *   - tasks.md → 6.5 ("API_Key is never returned by metadata listing").
 *   - requirements.md → 3.7 ("THE Settings_Store SHALL хранить API_Key
 *     пользователя в зашифрованном виде и SHALL предоставлять его в
 *     открытом виде только в ответ на явный запрос серверного
 *     компонента, выполняющего вызов Provider от имени пользователя.").
 *
 * Property statement
 * ------------------
 * Drive `ApiKeyService` with an arbitrary sequence of `upsertApiKey` /
 * `removeApiKey` calls across one or more `Scope`s, then for every output
 * of `listApiKeyMetadata(scope)` assert two things hold for every
 * metadata entry it returns:
 *
 *   (A) The JSON serialization of the entry does NOT contain any of the
 *       plaintext API-key strings that were inserted along the way as a
 *       substring.
 *   (B) No metadata field carries a "key-shaped value" — concretely,
 *       (B.1) the entry exposes ONLY the design-permitted property names
 *             (`provider`, `fingerprint`, `createdAt`, `lastValidatedAt`),
 *       (B.2) no field value equals or contains any inserted plaintext, and
 *       (B.3) no field value equals or contains the encrypted blob's
 *             ciphertext that the backend persists for the same record.
 *
 * Together (A) and (B) capture the design rule that the "metadata" view
 * leaks neither the plaintext (Requirement 3.7) nor the encrypted blob
 * (which would let any client reconstruct a fingerprint-vs-record mapping
 * outside the `resolveApiKeySecret` gateway). They also forbid sneaking a
 * leak through a future "extra" field — (B.1) keeps the metadata surface
 * frozen to design.md.
 *
 * Generator design
 * ----------------
 *  - `arbitraryApiKey` is constrained to begin with `"sk-"` and otherwise
 *    contain at least one non-hex character. That eliminates accidental
 *    substring collisions with the 12-hex-character fingerprint, so a
 *    pass means the metadata genuinely doesn't carry the plaintext, not
 *    that the random plaintext happened to look like a fingerprint.
 *  - Provider ids and scope identifiers are short alphanumerics so that
 *    counter-examples shrink to readable strings.
 *  - The action stream is bounded (≤ 12 actions, ≤ 4 distinct scopes)
 *    to keep individual property runs fast while still exercising
 *    sequences with overwrites and deletions.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { ApiKeyService } from "./apiKeys.js";
import { InMemoryApiKeyStoreBackend } from "./inMemoryStore.js";
import type {
  ApiKeyMetadata,
  EncryptedBlob,
  ProviderId,
  Scope,
  SecretCipher,
} from "./types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Reversible base64 cipher. Property 9 doesn't depend on cryptographic
 * strength — it only requires that:
 *   - encryption produces a deterministic, plaintext-derived ciphertext we
 *     can later check absence of inside the metadata view, and
 *   - the cipher round-trips so the rest of `ApiKeyService` behaves
 *     normally during the run.
 *
 * Determinism here means a given plaintext always yields the same
 * ciphertext; that lets us assert "this exact ciphertext never appears in
 * metadata" without bookkeeping per-call IVs.
 */
class IdentityCipher implements SecretCipher {
  public async encrypt(plaintext: string): Promise<EncryptedBlob> {
    return {
      algorithm: "identity.v1",
      ciphertext: Buffer.from(plaintext, "utf8").toString("base64"),
      createdAt: "2025-01-01T00:00:00.000Z",
    };
  }

  public async decrypt(blob: EncryptedBlob): Promise<string> {
    return Buffer.from(blob.ciphertext, "base64").toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty alphanumeric provider id (1..12 chars). */
const arbitraryProviderId: fc.Arbitrary<ProviderId> = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,12}$/)
  .filter((s) => s.length > 0);

/**
 * Plaintext API key: prefixed `sk-` plus 8..40 chars from a printable-ASCII
 * alphabet that includes uppercase letters and `_-`. The `sk-` prefix
 * (lowercase 'k' is not a hex digit) guarantees no plaintext can collide
 * with a fingerprint, which is 12 lowercase hex chars.
 */
const arbitraryApiKey: fc.Arbitrary<string> = fc
  .stringMatching(/^sk-[A-Za-z0-9_-]{8,40}$/)
  .filter((s) => s.startsWith("sk-") && s.length >= 11);

/** Local-or-cloud scope with a short identifier. */
const arbitraryScope: fc.Arbitrary<Scope> = fc.oneof(
  fc
    .stringMatching(/^[a-zA-Z0-9-]{1,12}$/)
    .filter((s) => s.length > 0)
    .map((deviceId) => ({ kind: "local", deviceId } as const)),
  fc
    .stringMatching(/^[a-zA-Z0-9-]{1,12}$/)
    .filter((s) => s.length > 0)
    .map((userId) => ({ kind: "cloud", userId } as const)),
);

type Action =
  | {
      readonly kind: "upsert";
      readonly scope: Scope;
      readonly provider: ProviderId;
      readonly apiKey: string;
    }
  | {
      readonly kind: "remove";
      readonly scope: Scope;
      readonly provider: ProviderId;
    };

const arbitraryUpsertAction: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant("upsert" as const),
  scope: arbitraryScope,
  provider: arbitraryProviderId,
  apiKey: arbitraryApiKey,
});

const arbitraryRemoveAction: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant("remove" as const),
  scope: arbitraryScope,
  provider: arbitraryProviderId,
});

/**
 * Action stream: weighted toward `upsert` (3:1) so the resulting state
 * tends to contain at least one record. Bounded length keeps each fast-check
 * shrink cheap.
 */
const arbitraryActions: fc.Arbitrary<readonly Action[]> = fc.array(
  fc.oneof({ weight: 3, arbitrary: arbitraryUpsertAction }, { weight: 1, arbitrary: arbitraryRemoveAction }),
  { minLength: 1, maxLength: 12 },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable string key for a `Scope`, used to deduplicate / replay scopes. */
function scopeKey(scope: Scope): string {
  return scope.kind === "local"
    ? `local:${scope.deviceId}`
    : `cloud:${scope.userId}`;
}

const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "fingerprint",
  "createdAt",
  "lastValidatedAt",
]);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("ApiKeyService.listApiKeyMetadata", () => {
  it(
    "Property 9: metadata listing never carries plaintext API keys, encrypted blobs, " +
      "or fields outside the design-permitted set " +
      "(Validates: Requirements 3.7)",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryActions, async (actions) => {
          const backend = new InMemoryApiKeyStoreBackend();
          const cipher = new IdentityCipher();
          const service = new ApiKeyService({ backend, cipher });

          // Track every plaintext that has EVER been handed to the service,
          // even if a later remove deletes the corresponding record. The
          // service must not retain any of them in metadata at any later
          // listing — including the case where the same provider gets
          // upserted with a new key (the old plaintext must not linger).
          const insertedPlaintexts = new Set<string>();
          const touchedScopes = new Map<string, Scope>();

          for (const action of actions) {
            touchedScopes.set(scopeKey(action.scope), action.scope);
            if (action.kind === "upsert") {
              insertedPlaintexts.add(action.apiKey);
              await service.upsertApiKey(action.scope, {
                provider: action.provider,
                apiKey: action.apiKey,
              });
            } else {
              await service.removeApiKey(action.scope, action.provider);
            }
          }

          // Snapshot the encrypted ciphertexts the backend currently holds,
          // per scope. We assert later that none of these blobs appear in
          // metadata. Using the backend directly ensures we test the actual
          // stored blob, not a re-encryption of the same plaintext.
          const ciphertextsByScope = new Map<string, Set<string>>();
          for (const [k, scope] of touchedScopes) {
            const records = await backend.list(scope);
            const set = new Set<string>();
            for (const r of records) set.add(r.encryptedKey.ciphertext);
            ciphertextsByScope.set(k, set);
          }

          for (const [k, scope] of touchedScopes) {
            const metadata: ApiKeyMetadata[] =
              await service.listApiKeyMetadata(scope);

            for (const entry of metadata) {
              // (B.1) Surface freeze: only the four design-permitted keys.
              // Catches future regressions that add an "internal" field
              // leaking decrypted state through metadata.
              const ownKeys = Object.keys(entry);
              for (const key of ownKeys) {
                expect(
                  ALLOWED_METADATA_KEYS.has(key),
                  `metadata exposed unexpected field "${key}" — surface should be ${[
                    ...ALLOWED_METADATA_KEYS,
                  ].join(", ")}`,
                ).toBe(true);
              }

              const serialized = JSON.stringify(entry);

              // (A) No plaintext substring appears in the JSON.
              for (const plaintext of insertedPlaintexts) {
                expect(
                  serialized.includes(plaintext),
                  `metadata JSON for provider="${entry.provider}" leaked plaintext "${plaintext}"`,
                ).toBe(false);
              }

              // (B.2) No field VALUE equals or contains a plaintext.
              // JSON.stringify already covers substring containment, but
              // checking field-by-field gives a better failure message and
              // also forbids non-string fields (e.g. a numeric reflection
              // of a key) that JSON.stringify might collapse misleadingly.
              for (const [field, value] of Object.entries(entry)) {
                if (typeof value !== "string") {
                  // Every design-permitted field is a string; if a future
                  // change introduces a non-string here, the (B.1) check
                  // above is still in place to catch it via shape, but we
                  // also fail explicitly to make intent visible.
                  expect(
                    typeof value,
                    `metadata field "${field}" must be a string, got ${typeof value}`,
                  ).toBe("string");
                  continue;
                }
                for (const plaintext of insertedPlaintexts) {
                  expect(
                    value.includes(plaintext),
                    `metadata field "${field}" leaked plaintext "${plaintext}"`,
                  ).toBe(false);
                }
              }

              // (B.3) No field carries the encrypted ciphertext for the
              // record. Checked against the ciphertexts persisted by the
              // backend for the SAME scope (cross-scope contamination is
              // separately impossible because scopes are isolated keys in
              // the in-memory backend, but we still scan all known
              // ciphertexts to be conservative).
              const allCiphertexts = new Set<string>();
              for (const set of ciphertextsByScope.values()) {
                for (const ct of set) allCiphertexts.add(ct);
              }
              for (const ct of allCiphertexts) {
                expect(
                  serialized.includes(ct),
                  `metadata JSON for provider="${entry.provider}" leaked encrypted ciphertext`,
                ).toBe(false);
              }

              // Sanity: fingerprint shape matches design (12 lowercase hex
              // chars). This isn't part of Property 9 itself, but a wrong
              // fingerprint shape (e.g. "sk-..." accidentally reflected)
              // is the most likely shape a real leak would take, and
              // catching it here prevents a regression that would fool the
              // (A) substring check.
              expect(entry.fingerprint).toMatch(/^[0-9a-f]{12}$/);

              // ISO timestamps shouldn't include sk- prefix either; this
              // is a cheap explicit catch-all.
              expect(entry.createdAt).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
              );
              expect(entry.lastValidatedAt).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
              );
            }

            // Also verify the JSON of the WHOLE listing is plaintext-free.
            // This catches a hypothetical leak that hides at the array
            // level (e.g. an extra non-enumerable property reflected by a
            // custom toJSON), not visible per-entry.
            const fullJson = JSON.stringify(metadata);
            for (const plaintext of insertedPlaintexts) {
              expect(
                fullJson.includes(plaintext),
                `full metadata listing for ${k} leaked plaintext "${plaintext}"`,
              ).toBe(false);
            }
            const ciphertextsForScope = ciphertextsByScope.get(k) ?? new Set();
            for (const ct of ciphertextsForScope) {
              expect(
                fullJson.includes(ct),
                `full metadata listing for ${k} leaked encrypted ciphertext`,
              ).toBe(false);
            }
          }
        }),
        { numRuns: 200 },
      );
    },
  );
});
