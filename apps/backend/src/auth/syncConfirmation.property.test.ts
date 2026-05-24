/**
 * Property test for the sync-confirmation gate on
 * `AuthService.createLocalSession` (task 4.5).
 *
 * **Property 8: Local settings never sync to cloud without explicit user
 * confirmation.**
 *
 * Validates: Requirements 2.8, 3.7.
 *
 * Source:
 *  - design.md → "Testing Strategy" → "Property-based tests" → property 8.
 *  - tasks.md → task 4.5 ("Write property test for sync confirmation
 *    gate").
 *  - requirements.md →
 *      2.8 ("THE system SHALL NOT sync API_Key to cloud without explicit
 *           user confirmation"),
 *      3.7 ("THE Settings_Store SHALL store API_Key in encrypted form and
 *           SHALL hand the plaintext only to an authorized server-side
 *           component").
 *
 * Property statement
 * ------------------
 * For every input value that is structurally valid except that
 * `confirmedByUser !== true`, `AuthService.createLocalSession`:
 *
 *   1. rejects with a `LocalSessionError` whose `code` is exactly
 *      `"missing_confirmation"`;
 *   2. NEVER invokes the local-storage sink — i.e. plaintext is not
 *      handed off to encrypted storage at all.
 *
 * The sink in this test stands in for the Local Encrypted Storage path
 * (Desktop Shell). Reaching the sink would be the first step of any
 * downstream sync (local store → upgrade-to-cloud), so proving the sink
 * is untouched proves the broader "never sync without explicit
 * confirmation" invariant at its earliest possible boundary.
 *
 * The test deliberately runs both the gate-rejection path (above) and a
 * positive control: a single `confirmedByUser: true` call must succeed
 * and invoke the sink exactly once. Without the positive arm the
 * property would be vacuously satisfied by an `AuthService` that
 * rejected every call — so we explicitly check that the gate is the
 * *only* thing rejecting.
 *
 * Generator design
 * ----------------
 *  - `arbitraryNonConfirmation` produces every value the runtime might
 *    plausibly receive in `confirmedByUser` *other* than the literal
 *    `true`: primitives (false, numbers, strings including "true",
 *    bigints), `null`/`undefined`, arrays, plain objects, typed arrays,
 *    symbols and a literal Boolean object (`new Boolean(true)`). The
 *    string `"true"`, the number `1`, an object such as `{}`, and the
 *    array `[true]` are explicitly listed in tasks.md for task 4.5.
 *  - `arbitraryNonEmptyString` is reused for `deviceId`, `provider` and
 *    `apiKey` so the rest of the input is structurally valid; the only
 *    thing that varies is the confirmation flag. If we generated junk
 *    for those fields too, the service could legitimately reject with
 *    `"invalid_input"` and we would not actually be testing the
 *    confirmation gate.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  AuthService,
  LocalSessionError,
  type CreateLocalSessionInput,
  type LocalApiKeySink,
  type ProviderProbe,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * Recording sink used to assert the persistence contract under fast-check.
 *
 * The whole point of Property 8 is that the sink MUST NOT be called when
 * `confirmedByUser !== true`. We therefore record every call so the
 * property body can assert `calls.length === 0` after each rejection.
 */
class RecordingSink implements LocalApiKeySink {
  public readonly calls: Array<{
    deviceId: string;
    provider: string;
    apiKey: string;
  }> = [];

  public async persistApiKey(input: {
    readonly deviceId: string;
    readonly provider: string;
    readonly apiKey: string;
  }): Promise<void> {
    this.calls.push({
      deviceId: input.deviceId,
      provider: input.provider,
      apiKey: input.apiKey,
    });
  }
}

/** Stub probe — `validateApiKey` is exercised in `authService.test.ts`. */
const noopProbe: ProviderProbe = {
  provider: "openai",
  async probe() {
    return { kind: "ok" };
  },
};

const FIXED_NOW = new Date("2025-02-03T12:34:56.789Z");

/** Builds an `AuthService` paired with a fresh recording sink. */
function build(): { service: AuthService; sink: RecordingSink } {
  const sink = new RecordingSink();
  let n = 0;
  const service = new AuthService({
    probes: [noopProbe],
    localApiKeySink: sink,
    clock: { now: () => FIXED_NOW },
    sessionIdSource: {
      next: () => {
        n += 1;
        return `session-${String(n)}`;
      },
    },
  });
  return { service, sink };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Non-empty trimmed string. Matches the structural contract enforced by
 * `createLocalSession` for `deviceId`, `provider` and `apiKey`. Using a
 * minimum length of 1 *after* a synthetic non-whitespace prefix
 * guarantees the string is never all-whitespace, which would also be
 * rejected (`invalid_input`) and confound the property.
 */
const arbitraryNonEmptyString = fc
  .string({ minLength: 1, maxLength: 32 })
  .map((s) => `x${s}`);

/**
 * Arbitrary that produces values which are NOT the literal boolean `true`.
 *
 * Coverage rationale:
 *
 *  - `false`, `0`, `1`, `""`, `"true"`, `"false"` — common JS truthiness
 *    pitfalls explicitly listed in tasks.md task 4.5.
 *  - `null`, `undefined`                          — typical "missing"
 *    representations across JSON/RPC.
 *  - bigints, numbers, integers                   — every numeric type
 *    that could appear after deserialisation.
 *  - arbitrary strings                            — including `"true"`
 *    which is truthy but must still be rejected (the service uses
 *    strict `=== true`).
 *  - empty/non-empty objects, arrays              — `{}` is truthy in
 *    JS; `[true]` is truthy but is not the literal `true`.
 *  - typed arrays, symbols                        — values that come
 *    from native bridges (Tauri/Electron) or from V8 internals.
 *  - `new Boolean(true)`                          — boxed Boolean is the
 *    classic "loose-equals true but not strict-equals" trap.
 *
 * The generator is the union of all of those, filtered so the literal
 * `true` itself is never produced.
 */
const arbitraryNonConfirmation: fc.Arbitrary<unknown> = fc
  .oneof(
    fc.constant(false),
    fc.constant(undefined),
    fc.constant(null),
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.bigInt(),
    fc.string(),
    fc.constant("true"),
    fc.constant("false"),
    fc.constant(""),
    fc.constant(0),
    fc.constant(1),
    fc.constant({}),
    fc.constant([true]),
    fc.array(fc.anything(), { maxLength: 4 }),
    fc.object({ maxDepth: 2, maxKeys: 4 }),
    fc.uint8Array({ maxLength: 8 }),
    fc.constant(Symbol("not-confirmed")),
    fc.constant(new Boolean(true)), // boxed Boolean — loose-equals true.
    fc.constant(new Boolean(false)),
  )
  .filter((v) => v !== true);

/**
 * Arbitrary that builds the full `createLocalSession` input but with a
 * non-confirming `confirmedByUser`. We type-cast through `unknown` so the
 * compile-time literal `true` constraint does not block the test
 * generators — the whole point is to model what JS callers and RPC
 * unmarshalling can deliver at runtime.
 */
const arbitraryNonConfirmingInput: fc.Arbitrary<CreateLocalSessionInput> =
  fc.record({
    deviceId: arbitraryNonEmptyString,
    provider: arbitraryNonEmptyString,
    apiKey: arbitraryNonEmptyString,
    confirmedByUser: arbitraryNonConfirmation,
  }) as unknown as fc.Arbitrary<CreateLocalSessionInput>;

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("AuthService.createLocalSession sync-confirmation gate", () => {
  it("Property 8: any non-`true` confirmation rejects with 'missing_confirmation' and never touches the local-storage sink (Validates: Requirements 2.8, 3.7)", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryNonConfirmingInput, async (input) => {
        const { service, sink } = build();

        let caught: unknown;
        try {
          await service.createLocalSession(input);
        } catch (err) {
          caught = err;
        }

        // (1) The rejection must be a typed LocalSessionError whose code
        //     is precisely "missing_confirmation". Any other code (e.g.
        //     "invalid_input", "storage_failed") would mean the gate
        //     fired for the wrong reason or didn't fire at all.
        if (!(caught instanceof LocalSessionError)) {
          throw new Error(
            `expected LocalSessionError, got ${typeof caught}: ${String(caught)}`,
          );
        }
        if (caught.code !== "missing_confirmation") {
          throw new Error(
            `expected code "missing_confirmation", got "${caught.code}"`,
          );
        }

        // (2) The local-storage sink — the first hop on the eventual
        //     local→cloud sync path — must be untouched. This is the
        //     core invariant of Property 8.
        if (sink.calls.length !== 0) {
          throw new Error(
            `sink was invoked ${String(sink.calls.length)} times; ` +
              "expected 0 (local plaintext must never reach storage " +
              "without explicit confirmation)",
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("positive control: confirmedByUser === true persists exactly once and returns a local Session", async () => {
    const { service, sink } = build();
    const session = await service.createLocalSession({
      deviceId: "device-positive",
      provider: "openai",
      apiKey: "sk-positive-control",
      confirmedByUser: true,
    });

    // Without this control the gate could trivially "satisfy" Property 8
    // by rejecting *every* call. We assert the happy path actually
    // reaches the sink exactly once and produces a local-kind Session.
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({
      deviceId: "device-positive",
      provider: "openai",
      apiKey: "sk-positive-control",
    });
    expect(session.kind).toBe("local");
    expect(session.deviceId).toBe("device-positive");
    expect(session.userId).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain("sk-positive-control");
  });
});
