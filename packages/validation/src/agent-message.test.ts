/**
 * Property test for `normalizeAgentMessage`.
 *
 * Validates: Requirements 10.8, 10.9.
 *
 * **Property 5: Agent_Message normalization always returns valid Agent_Message.**
 *
 * Source:
 * - design.md → "Testing Strategy" → "Property-based tests" → property 5.
 * - tasks.md → task 2.3 ("Write property test for `Agent_Message`
 *   normalization").
 * - requirements.md →
 *     10.8 (malformed agent output is wrapped into a valid Agent_Message
 *           of type "response", with the normalisation flag set and the
 *           original payload preserved),
 *     10.9 (unreadable agent output yields an Agent_Message of type
 *           "error" describing the communication failure, without
 *           disturbing earlier history).
 *
 * The test asserts that for **any** raw input value and **any** orchestrator
 * context that satisfies the primitive schemas, the value returned by
 * `normalizeAgentMessage` survives `agentMessageSchema.parse()`. This is the
 * universal totality property that downstream code (Agent Runtime,
 * persistence, Agent_Trace) relies on: the orchestrator never has to handle
 * an "invalid Agent_Message" branch.
 *
 * Generator design notes:
 *  - `arbitraryRawInput` mixes valid Agent_Message-shaped objects (so case 1
 *    of the function — "passes schema as-is" — is exercised), JSON-coercible
 *    values (case 2 — wrapped as `response` with `normalized: true`), and
 *    explicitly unreadable values such as `undefined`, BigInt, symbols and
 *    structures with circular references (case 3 — wrapped as `error`).
 *    Without all three buckets the property would only cover the easy paths.
 *  - `arbitraryContext` is constrained to satisfy `taskIdSchema`,
 *    `agentIdSchema` and `isoTimestampSchema`. The function's contract only
 *    promises totality when the context is itself well-formed; feeding it
 *    invalid context is out of scope.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  AGENT_MESSAGE_PAYLOAD_MAX_BYTES,
  agentMessageSchema,
  normalizeAgentMessage,
  type NormalizeAgentMessageContext,
} from "./agent-message.js";

/**
 * Arbitrary that produces ISO 8601 UTC ms timestamps.
 *
 * fast-check's `date()` covers a wide range; we map through `toISOString()`
 * which always emits the `YYYY-MM-DDThh:mm:ss.sssZ` shape required by
 * `isoTimestampSchema`. The bounds skip `NaN` dates that some platforms
 * produce at the extreme edges of representable time.
 */
const arbitraryIsoTimestamp = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/** Arbitrary AgentId — non-empty short string. */
const arbitraryAgentId = fc.string({ minLength: 1, maxLength: 32 });

/** Arbitrary TaskId — 1..128 character string per `taskIdSchema`. */
const arbitraryTaskId = fc.string({ minLength: 1, maxLength: 128 });

/** Recipient is either an AgentId or the literal "orchestrator". */
const arbitraryRecipient = fc.oneof(
  arbitraryAgentId,
  fc.constant("orchestrator"),
);

/** Orchestrator-provided context for normalisation. */
const arbitraryContext: fc.Arbitrary<NormalizeAgentMessageContext> = fc.record({
  taskId: arbitraryTaskId,
  sender: arbitraryAgentId,
  recipient: arbitraryRecipient,
  timestamp: arbitraryIsoTimestamp,
});

/**
 * Arbitrary that builds an already-valid Agent_Message. Covers branch 1 of
 * `normalizeAgentMessage` (the input is returned verbatim).
 *
 * We restrict text payloads to a comfortably small size to keep generators
 * fast; the schema's 1 MB cap is exercised separately by the broad
 * `arbitraryRawInput` arm.
 */
const arbitraryValidAgentMessage = fc.record(
  {
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
  },
  { requiredKeys: ["taskId", "sender", "recipient", "type", "payload", "timestamp"] },
);

/**
 * Builder for a value with a circular reference. fast-check's combinators
 * stay acyclic by default, so we construct the cycle by hand to exercise
 * case 3 (`JSON.stringify` throws).
 */
const arbitraryCircular = fc.constant(null).map(() => {
  const obj: Record<string, unknown> = { name: "cycle" };
  obj.self = obj;
  return obj;
});

/**
 * Broad raw-input arbitrary. Mixes:
 *  - already-valid Agent_Message objects;
 *  - JSON-coercible values (covers branch 2 of normalisation);
 *  - explicit "unreadable" cases — undefined, function, symbol, BigInt,
 *    circular structures (covers branch 3);
 *  - typed arrays (binary payload branch).
 *
 * The mix is chosen so the property exercises every code path in
 * `normalizeAgentMessage`. Without the unreadable arm the test would
 * silently miss the type-"error" wrapping path described by Requirement
 * 10.9.
 */
const arbitraryRawInput: fc.Arbitrary<unknown> = fc.oneof(
  arbitraryValidAgentMessage,
  fc.string({ maxLength: 1024 }),
  fc.jsonValue(),
  fc.uint8Array({ maxLength: 256 }),
  fc.constant(undefined),
  fc.constant(null),
  fc.bigInt(),
  fc.constant(Symbol("agent-symbol")),
  fc.constant(() => "agent-function"),
  arbitraryCircular,
);

describe("normalizeAgentMessage", () => {
  it("Property 5: always returns a value that passes agentMessageSchema (Validates: Requirements 10.8, 10.9)", () => {
    fc.assert(
      fc.property(arbitraryRawInput, arbitraryContext, (rawInput, context) => {
        const message = normalizeAgentMessage(rawInput, context);
        // The contract: every output is a valid Agent_Message. Use
        // `safeParse` so a failure surfaces the Zod issues alongside the
        // counter-example fast-check prints.
        const parsed = agentMessageSchema.safeParse(message);
        if (!parsed.success) {
          throw new Error(
            `normalizeAgentMessage produced an invalid Agent_Message: ${JSON.stringify(
              parsed.error.issues,
            )}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("preserves a valid Agent_Message verbatim (Requirement 10.8)", () => {
    const original = {
      taskId: "task-123",
      sender: "researcher",
      recipient: "coder",
      type: "handoff" as const,
      payload: { kind: "text" as const, text: "hello" },
      timestamp: "2024-01-02T03:04:05.006Z",
    };
    const result = normalizeAgentMessage(original, {
      // Context should be ignored when the raw input already validates.
      taskId: "ignored-task",
      sender: "ignored-sender",
      recipient: "orchestrator",
      timestamp: "2099-12-31T23:59:59.999Z",
    });
    expect(result.taskId).toBe("task-123");
    expect(result.sender).toBe("researcher");
    expect(result.recipient).toBe("coder");
    expect(result.type).toBe("handoff");
    expect(result.normalized).toBeUndefined();
  });

  it("wraps malformed-but-readable output as type 'response' with rawOriginal preserved (Requirement 10.8)", () => {
    const raw = "free-form agent reply";
    const result = normalizeAgentMessage(raw, {
      taskId: "task-9",
      sender: "coder",
      recipient: "reviewer",
      timestamp: "2024-06-15T12:00:00.000Z",
    });
    expect(result.type).toBe("response");
    expect(result.normalized).toBe(true);
    expect(result.rawOriginal).toBe(raw);
    expect(result.payload).toEqual({ kind: "text", text: raw });
  });

  it("wraps unreadable output as type 'error' (Requirement 10.9)", () => {
    const cycle: Record<string, unknown> = { name: "cycle" };
    cycle.self = cycle;
    const result = normalizeAgentMessage(cycle, {
      taskId: "task-9",
      sender: "coder",
      recipient: "orchestrator",
      timestamp: "2024-06-15T12:00:00.000Z",
    });
    expect(result.type).toBe("error");
    expect(result.normalized).toBe(true);
    if (result.payload.kind !== "text") {
      throw new Error("error payload must be text");
    }
    expect(result.payload.text).toMatch(/could not be interpreted/i);
  });

  it("rejects oversized text payloads via the 'error' path (Requirement 10.9)", () => {
    // Construct a string just over the 1 MB cap. ASCII-only so byte length
    // equals character length.
    const oversized = "a".repeat(AGENT_MESSAGE_PAYLOAD_MAX_BYTES + 1);
    const result = normalizeAgentMessage(oversized, {
      taskId: "task-big",
      sender: "coder",
      recipient: "orchestrator",
      timestamp: "2024-06-15T12:00:00.000Z",
    });
    expect(result.type).toBe("error");
    expect(agentMessageSchema.safeParse(result).success).toBe(true);
  });
});
