/**
 * Property test for `ApiKeyService.removeApiKey` (task 6.7).
 *
 * **Property 15: Successful key deletion never produces error UI.**
 *
 * Validates: Requirements 4.4.
 *
 * Source: requirements.md → 4.4 ("WHEN пользователь удаляет API_Key, THE
 * Settings_Store SHALL удалить ключ из хранилища ... SHALL не отображать
 * пользователю сообщение об ошибке при успешном удалении.")
 *
 * Strategy
 * --------
 * The property exercises `removeApiKey` against arbitrary key states the user
 * could plausibly hit:
 *
 *   • `existing`     — provider has a stored key prior to deletion.
 *   • `missing`      — provider has never been stored.
 *   • `just_removed` — provider was stored, then deleted, then deletion is
 *                      retried (idempotent re-delete).
 *
 * For every generated scenario we assert:
 *
 *   1. `removeApiKey` never throws.
 *   2. `removeApiKey` returns `undefined` (success). The API surface offers no
 *      error channel other than throwing or returning a non-success value, so
 *      this captures "the API returns a success result".
 *   3. After the call, `listApiKeyMetadata(scope)` does NOT contain the
 *      removed provider — i.e. the deletion is logically applied.
 *   4. Calling `removeApiKey` a second time on the same `(scope, provider)` is
 *      also a successful no-op (idempotency).
 *   5. Other providers in the same scope and entries in unrelated scopes are
 *      untouched (deletion does not over-reach).
 *
 * Generators are constrained intelligently:
 *   • Provider ids are non-empty alphanumeric so they survive the
 *     `apiKeys.ts` precondition (`provider must be a non-empty string`).
 *   • API key plaintexts are non-empty so `upsertApiKey` (which forbids the
 *     empty string upstream) accepts them when seeding state.
 *   • Each scenario picks at most a handful of providers so failures shrink
 *     to a readable counter-example.
 *
 * The test uses a deterministic in-memory store and a trivial reversible
 * cipher so the property focuses on the delete contract rather than crypto.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { ApiKeyService } from "./apiKeys.js";
import { InMemoryApiKeyStoreBackend } from "./inMemoryStore.js";
import type {
  EncryptedBlob,
  ProviderId,
  Scope,
  SecretCipher,
} from "./types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Trivial reversible cipher. Encryption is base64 of the UTF-8 plaintext;
 * decryption reverses it. Sufficient for tests that only care about the
 * round-trip contract — Property 15 doesn't depend on crypto strength.
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

/** Non-empty alphanumeric provider id (1..16 chars). */
const arbitraryProviderId: fc.Arbitrary<ProviderId> = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,16}$/)
  .filter((s) => s.length > 0);

/** Non-empty API-key plaintext (1..32 chars, printable ASCII). */
const arbitraryApiKey: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s.length > 0);

/** A small set of distinct providers, each with an API-key plaintext. */
const arbitrarySeedEntries: fc.Arbitrary<
  ReadonlyArray<{ readonly provider: ProviderId; readonly apiKey: string }>
> = fc
  .uniqueArray(
    fc.record({
      provider: arbitraryProviderId,
      apiKey: arbitraryApiKey,
    }),
    {
      minLength: 0,
      maxLength: 5,
      selector: (entry) => entry.provider,
    },
  );

/** Arbitrary local or cloud scope. */
const arbitraryScope: fc.Arbitrary<Scope> = fc.oneof(
  fc
    .stringMatching(/^[a-zA-Z0-9-]{1,16}$/)
    .filter((s) => s.length > 0)
    .map((deviceId) => ({ kind: "local", deviceId } as const)),
  fc
    .stringMatching(/^[a-zA-Z0-9-]{1,16}$/)
    .filter((s) => s.length > 0)
    .map((userId) => ({ kind: "cloud", userId } as const)),
);

/** Three deletion-target shapes, expressed as discriminated unions. */
type TargetShape =
  | { readonly kind: "existing" }
  | { readonly kind: "missing"; readonly provider: ProviderId }
  | { readonly kind: "just_removed" };

const arbitraryTargetShape: fc.Arbitrary<TargetShape> = fc.oneof(
  fc.constant({ kind: "existing" } as const),
  arbitraryProviderId.map(
    (provider) => ({ kind: "missing", provider } as const),
  ),
  fc.constant({ kind: "just_removed" } as const),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Fixture {
  readonly service: ApiKeyService;
  readonly backend: InMemoryApiKeyStoreBackend;
}

function makeFixture(): Fixture {
  const backend = new InMemoryApiKeyStoreBackend();
  const cipher = new IdentityCipher();
  const service = new ApiKeyService({ backend, cipher });
  return { service, backend };
}

/**
 * Resolves the provider that the property will attempt to delete, applying
 * any necessary state mutations beforehand so the named scenario actually
 * holds at the moment of deletion.
 *
 * Returns `null` when the chosen scenario degenerates (e.g. `existing` was
 * picked but the seed is empty); the caller skips those iterations so the
 * property's claim is never trivially satisfied by an empty store.
 */
async function prepareTarget(
  service: ApiKeyService,
  scope: Scope,
  seed: ReadonlyArray<{ provider: ProviderId; apiKey: string }>,
  shape: TargetShape,
): Promise<ProviderId | null> {
  switch (shape.kind) {
    case "existing": {
      if (seed.length === 0) return null;
      // First seeded provider is the one we'll delete. It is guaranteed to
      // exist in the store because we just upserted it above.
      return seed[0]!.provider;
    }
    case "missing": {
      // Pick a provider id that is NOT in the seed. If by chance it collides,
      // signal "no useful target" and skip — preserving the semantic that
      // this branch tests deletion of a never-stored provider.
      const collides = seed.some((e) => e.provider === shape.provider);
      return collides ? null : shape.provider;
    }
    case "just_removed": {
      if (seed.length === 0) return null;
      const target = seed[0]!.provider;
      await service.removeApiKey(scope, target);
      return target;
    }
  }
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("ApiKeyService.removeApiKey", () => {
  it(
    "Property 15: successful deletion never produces error UI " +
      "(Validates: Requirements 4.4)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryScope,
          arbitrarySeedEntries,
          arbitraryTargetShape,
          arbitraryScope,
          arbitraryProviderId,
          arbitraryApiKey,
          async (scope, seed, shape, otherScope, otherProvider, otherKey) => {
            const { service, backend } = makeFixture();

            // Seed primary scope with the chosen entries. Keeps the property
            // honest: deletion has to leave non-target entries alone.
            for (const entry of seed) {
              await service.upsertApiKey(scope, entry);
            }

            // Seed an unrelated scope so we can later assert deletion did not
            // bleed across scopes. Skip when the unrelated scope happens to
            // equal `scope` (shape-wise) to keep the assertion meaningful.
            const scopesMatch =
              otherScope.kind === scope.kind &&
              ((otherScope.kind === "local" &&
                scope.kind === "local" &&
                otherScope.deviceId === scope.deviceId) ||
                (otherScope.kind === "cloud" &&
                  scope.kind === "cloud" &&
                  otherScope.userId === scope.userId));
            if (!scopesMatch) {
              await service.upsertApiKey(otherScope, {
                provider: otherProvider,
                apiKey: otherKey,
              });
            }

            const target = await prepareTarget(service, scope, seed, shape);
            if (target === null) {
              // Scenario degenerated; nothing to assert this iteration.
              return;
            }

            // (1) Never throws, (2) returns a success result (undefined).
            const result = await service.removeApiKey(scope, target);
            expect(result).toBeUndefined();

            // (3) Logical effect: target is not present in the metadata
            //     listing. Holds for `existing` (it was removed), `missing`
            //     (it was never there), and `just_removed` (idempotent).
            const remaining = await service.listApiKeyMetadata(scope);
            expect(remaining.some((m) => m.provider === target)).toBe(false);

            // (4) Idempotency: a second delete on the same coordinate is
            //     still successful and produces no observable change.
            const repeat = await service.removeApiKey(scope, target);
            expect(repeat).toBeUndefined();
            const afterRepeat = await service.listApiKeyMetadata(scope);
            expect(afterRepeat).toEqual(remaining);

            // (5) Non-target seed entries in `scope` survive deletion of the
            //     target. The `existing` / `just_removed` paths drop the
            //     first seed entry; the rest must remain.
            const expectedSurvivors = seed
              .filter((e) => e.provider !== target)
              .map((e) => e.provider)
              .sort();
            const actualSurvivors = remaining
              .map((m) => m.provider)
              .slice()
              .sort();
            expect(actualSurvivors).toEqual(expectedSurvivors);

            // (5b) Unrelated scope is untouched.
            if (!scopesMatch) {
              const otherListing = await service.listApiKeyMetadata(otherScope);
              expect(
                otherListing.some((m) => m.provider === otherProvider),
              ).toBe(true);
            }

            // Sanity: the backend's raw `get` agrees with the metadata view.
            // If a stale record persisted under the deleted coordinate, the
            // metadata listing might still hide it but the backend would
            // not — so we check the backend directly too.
            const raw = await backend.get(scope, target);
            expect(raw).toBeNull();
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
