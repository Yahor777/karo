/**
 * Property tests for `normalizeAgentMessage` covering the full
 * Requirement 10.8 / 10.9 contract.
 *
 * **Property 5: Agent_Message normalization always returns valid Agent_Message.**
 *
 * Validates: Requirements 10.8, 10.9.
 *
 * Sources:
 * - design.md → "Testing Strategy" → "Property-based tests" → property 5.
 * - tasks.md → task 14.5 ("Write property test for Agent_Message
 *   normalization invariant"). The notes for that task explicitly require
 *   the property to cover both branches of the contract:
 *     • Requirement 10.8 — malformed but readable agent output is wrapped
 *       into a valid Agent_Message of type "response" with the
 *       normalisation flag set and the original payload preserved;
 *     • Requirement 10.9 — unreadable agent output is wrapped into a valid
 *       Agent_Message of type "error" describing the communication
 *       failure, without disturbing earlier history.
 * - requirements.md → 10.8, 10.9.
 *
 * Why this file lives next to `agent-message.test.ts`
 * ---------------------------------------------------
 * `agent-message.test.ts` (from task 2.3) already covers the totality
 * invariant: "for any input, the output validates against
 * `agentMessageSchema`". That single universal property is necessary but
 * not sufficient — it does not prove that unreadable inputs land in the
 * `type: "error"` branch, nor that malformed-but-readable inputs land in
 * the `type: "response"` branch with `normalized: true` and `rawOriginal`
 * preserved. Without the per-branch properties below, a hypothetical
 * implementation that always returns a hard-coded `type: "response"`
 * message would still satisfy the totality property while violating
 * Requirement 10.9.
 *
 * Generator strategy
 * ------------------
 * We split the input space by **branch of `normalizeAgentMessage`** rather
 * than by JS type, so each property tests exactly one contract clause:
 *
 *  - `arbitraryUnreadableInput` — values that are guaranteed to fall into
 *    the `type: "error"` branch (Requirement 10.9). We construct these by
 *    hand because fast-check's built-in combinators are acyclic and never
 *    produce BigInt/Symbol/function values that would actually break
 *    `JSON.stringify`.
 *  - `arbitraryReadableNonMessageInput` — values that are JSON/text/binary
 *    coercible but do not validate as `AgentMessage`. These exercise the
 *    `type: "response"` wrapping path (Requirement 10.8). We exclude
 *    already-valid messages because for those the function returns the
 *    input verbatim and `normalized` is intentionally absent.
 *  - `arbitraryValidAgentMessage` — already-valid messages, used to
 *    confirm the verbatim-passthrough behaviour (Requirement 10.8 first
 *    sentence: "wrap into a valid Agent_Message" — no wrapping needed if
 *    already valid).
 *  - `arbitraryAnyInput` — the union of all of the above plus a few
 *    free-form JSON values. Used for the totality property.
 *
 * `arbitraryContext` is constrained to satisfy `taskIdSchema`,
 * `agentIdSchema` and `isoTimestampSchema`. The function's contract only
 * promises totality when the context itself is well-formed; feeding it
 * invalid context is out of scope.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  agentMessageSchema,
  normalizeAgentMessage,
  type AgentMessage,
  type NormalizeAgentMessageContext,
} from "./agent-message.js";

// ---------------------------------------------------------------------------
// Context generator
// ---------------------------------------------------------------------------

/**
 * ISO 8601 UTC ms timestamps (`YYYY-MM-DDThh:mm:ss.sssZ`).
 *
 * `noInvalidDate: true` and explicit min/max bounds keep the generator
 * inside the calendar range that `Date#toISOString()` can serialise; near
 * the edges of the representable range some platforms emit `Invalid Date`.
 */
const arbitraryIsoTimestamp = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/** Non-empty agent identifier (matches `agentIdSchema`). */
const arbitraryAgentId = fc.string({ minLength: 1, maxLength: 32 });

/** 1..128 character task identifier (matches `taskIdSchema`). */
const arbitraryTaskId = fc.string({ minLength: 1, maxLength: 128 });

/**
 * Recipient is either an AgentId or the literal `"orchestrator"` per
 * `agentMessageRecipientSchema`.
 */
const arbitraryRecipient = fc.oneof(
  arbitraryAgentId,
  fc.constant("orchestrator"),
);

const arbitraryContext: fc.Arbitrary<NormalizeAgentMessageContext> = fc.record({
  taskId: arbitraryTaskId,
  sender: arbitraryAgentId,
  recipient: arbitraryRecipient,
  timestamp: arbitraryIsoTimestamp,
});

// ---------------------------------------------------------------------------
// Per-branch input generators
// ---------------------------------------------------------------------------

/**
 * Already-valid `AgentMessage` values.
 *
 * Payload sizes are small so the generator runs fast; the 1 MB cap is
 * exercised separately by the existing tests in `agent-message.test.ts`.
 * Only `text` and `json` payload kinds are produced — `binary` would
 * require a real `Uint8Array` which fast-check supports but adds shrinking
 * cost without exercising new code paths in `normalizeAgentMessage`.
 */
const arbitraryValidAgentMessage: fc.Arbitrary<AgentMessage> = fc.record({
  taskId: arbitraryTaskId,
  sender: arbitraryAgentId,
  recipient: arbitraryRecipient,
  type: fc.constantFrom("request", "response", "error", "handoff"),
  payload: fc.oneof(
    fc.record({
      kind: fc.constant("text" as const),
      text: fc.string({ maxLength: 256 }),
    }),
    fc.record({
      kind: fc.constant("json" as const),
      value: fc.jsonValue(),
    }),
  ),
  timestamp: arbitraryIsoTimestamp,
});

/**
 * Construct values with circular references on demand.
 *
 * `JSON.stringify` throws on cycles, which is exactly the failure mode the
 * `tryCoercePayload` helper in `agent-message.ts` catches when classifying
 * an input as unreadable. fast-check's `fc.anything()` and `fc.jsonValue()`
 * never produce cycles, so we have to build them manually to actually
 * exercise the branch covered by Requirement 10.9.
 *
 * We return a thunk so each shrink step builds a fresh cyclic object —
 * sharing one object across runs would let earlier `JSON.stringify`
 * attempts mutate hidden state on some engines.
 */
const buildCircular = (): Record<string, unknown> => {
  const obj: Record<string, unknown> = { name: "cycle" };
  obj.self = obj;
  return obj;
};

/**
 * Object with a `toJSON` method that always throws — another way to make
 * `JSON.stringify` fail. Catches implementations that only guard against
 * cycles and forget about thrown converters.
 */
const buildThrowOnStringify = (): { toJSON: () => never } => ({
  toJSON: () => {
    throw new Error("toJSON refused");
  },
});

/**
 * Inputs that are guaranteed to land in the `type: "error"` branch of
 * `normalizeAgentMessage`.
 *
 * Each entry corresponds to a clause of `tryCoercePayload`'s "unreadable"
 * classification:
 *  - `undefined`            → "value is undefined"
 *  - `BigInt`               → "value of type bigint cannot be serialised"
 *  - `function`             → "value of type function cannot be serialised"
 *  - `Symbol`               → "value of type symbol cannot be serialised"
 *  - circular object        → "value is not JSON-serialisable"
 *  - throw-on-stringify obj → "value is not JSON-serialisable"
 *
 * `fc.constant` is used for the simple cases so fast-check's reporter
 * shows a meaningful counter-example string instead of `[object Object]`.
 */
const arbitraryUnreadableInput: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.bigInt().map((b) => b as unknown),
  fc.constant(() => "agent-function"),
  fc.constant(Symbol("agent-symbol")),
  fc.constant(null).map(() => buildCircular() as unknown),
  fc.constant(null).map(() => buildThrowOnStringify() as unknown),
);

/**
 * Inputs that are coercible into a payload but do not validate as a
 * full `AgentMessage` — i.e. they should land in the `type: "response"`
 * branch of `normalizeAgentMessage`.
 *
 * We deliberately exclude:
 *  - already-valid messages (handled by `arbitraryValidAgentMessage`),
 *  - oversized payloads (would land in `type: "error"`).
 *
 * Plain `string`, `number`, `boolean`, `null`, `Uint8Array` and small
 * `JsonValue`s all qualify because none of them carry the
 * taskId/sender/recipient/type/payload/timestamp shape that
 * `agentMessageSchema` requires.
 */
const arbitraryReadableNonMessageInput: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 1024 }),
  fc.integer(),
  fc.float({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.uint8Array({ maxLength: 256 }),
  // Small JSON values that are objects/arrays without the AgentMessage
  // discriminator fields. We filter out the rare case where fast-check
  // happens to produce a value that *does* parse as an AgentMessage —
  // that case is covered by `arbitraryValidAgentMessage`.
  fc.jsonValue().filter((v) => !agentMessageSchema.safeParse(v).success),
);

/**
 * Total input space for the totality property. Combines all three buckets
 * so every code path of `normalizeAgentMessage` is exercised in one
 * `fc.assert` run.
 */
const arbitraryAnyInput: fc.Arbitrary<unknown> = fc.oneof(
  arbitraryValidAgentMessage,
  arbitraryReadableNonMessageInput,
  arbitraryUnreadableInput,
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("normalizeAgentMessage — Property 5 (Validates: Requirements 10.8, 10.9)", () => {
  it("totality: any input + valid context yields a value that passes agentMessageSchema (Requirements 10.8, 10.9)", () => {
    fc.assert(
      fc.property(arbitraryAnyInput, arbitraryContext, (rawInput, context) => {
        const message = normalizeAgentMessage(rawInput, context);
        const parsed = agentMessageSchema.safeParse(message);
        if (!parsed.success) {
          // Surface Zod issues alongside fast-check's counter-example so
          // failures are debuggable without re-running the test by hand.
          throw new Error(
            `normalizeAgentMessage produced an invalid Agent_Message. issues=${JSON.stringify(
              parsed.error.issues,
            )} message=${JSON.stringify(message)}`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it("Requirement 10.8: malformed-but-readable inputs are wrapped as type 'response' with normalized=true and rawOriginal preserved", () => {
    fc.assert(
      fc.property(
        arbitraryReadableNonMessageInput,
        arbitraryContext,
        (rawInput, context) => {
          const message = normalizeAgentMessage(rawInput, context);
          // Schema must still hold.
          const parsed = agentMessageSchema.safeParse(message);
          expect(parsed.success).toBe(true);
          // Branch-specific obligations from Requirement 10.8.
          expect(message.type).toBe("response");
          expect(message.normalized).toBe(true);
          // The original payload must be preserved verbatim — same
          // reference for objects, same value for primitives. `Object.is`
          // matches both NaN identity and reference identity.
          expect(Object.is(message.rawOriginal, rawInput)).toBe(true);
          // Context fields must be filled from the orchestrator's
          // authority, not invented from the raw input.
          expect(message.taskId).toBe(context.taskId);
          expect(message.sender).toBe(context.sender);
          expect(message.recipient).toBe(context.recipient);
          expect(message.timestamp).toBe(context.timestamp);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Requirement 10.9: unreadable inputs are wrapped as type 'error' describing the communication failure", () => {
    fc.assert(
      fc.property(
        arbitraryUnreadableInput,
        arbitraryContext,
        (rawInput, context) => {
          const message = normalizeAgentMessage(rawInput, context);
          // Schema must still hold — Requirement 10.9 forbids dropping
          // the message, so the function must always succeed.
          const parsed = agentMessageSchema.safeParse(message);
          expect(parsed.success).toBe(true);
          // Branch-specific obligations from Requirement 10.9.
          expect(message.type).toBe("error");
          expect(message.normalized).toBe(true);
          // Error payload must be a non-empty textual description so
          // downstream UI can show *why* the message could not be parsed.
          expect(message.payload.kind).toBe("text");
          if (message.payload.kind === "text") {
            expect(message.payload.text.length).toBeGreaterThan(0);
            expect(message.payload.text).toMatch(/could not be interpreted/i);
          }
          // Context fields must come from the orchestrator.
          expect(message.taskId).toBe(context.taskId);
          expect(message.sender).toBe(context.sender);
          expect(message.recipient).toBe(context.recipient);
          expect(message.timestamp).toBe(context.timestamp);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Requirement 10.8 (passthrough): already-valid Agent_Messages are returned verbatim with no normalization flag", () => {
    fc.assert(
      fc.property(
        arbitraryValidAgentMessage,
        arbitraryContext,
        (validInput, context) => {
          const message = normalizeAgentMessage(validInput, context);
          // Schema invariant.
          expect(agentMessageSchema.safeParse(message).success).toBe(true);
          // Type must come from the input itself, not be coerced to
          // "response".
          expect(message.type).toBe(validInput.type);
          // Identifying fields must come from the input — context is
          // ignored on the passthrough branch because no normalisation
          // happened. Requirement 10.8 only mandates wrapping for
          // *malformed* output.
          expect(message.taskId).toBe(validInput.taskId);
          expect(message.sender).toBe(validInput.sender);
          expect(message.recipient).toBe(validInput.recipient);
          expect(message.timestamp).toBe(validInput.timestamp);
          // No normalisation occurred → flag must not be set.
          expect(message.normalized).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});
