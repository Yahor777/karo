/**
 * `Agent_Message` schema.
 *
 * Sources:
 * - design.md → "Data Models" → "Agent_Message".
 * - requirements.md →
 *     10.1 (mandatory fields: taskId, sender, recipient, type, payload, timestamp),
 *     10.2 (taskId 1..128 chars),
 *     10.3 (type ∈ {"request","response","error","handoff"}),
 *     10.4 (payload size ≤ 1 MB),
 *     10.5 (ISO 8601 UTC ms timestamp).
 * - tasks.md task 2.2 sub-bullets: payload ≤ 1 MB, ISO 8601 UTC ms.
 *
 * Notes on payload size:
 * Requirement 10.4 caps "payload size" at 1 MB. The design represents payload
 * as a tagged union (`text` | `json` | `binary`). We measure size as the byte
 * length of the serialized payload:
 *  - `text` payloads use UTF-8 byte length of `text`.
 *  - `json` payloads use UTF-8 byte length of `JSON.stringify(value)`.
 *  - `binary` payloads use the byte length of `bytes`.
 *
 * `recipient` is either an AgentId or the literal `"orchestrator"`. The
 * orchestrator is a non-agent recipient that still appears in the message
 * graph (final hand-off, errors).
 *
 * The optional `normalized` flag and `rawOriginal` field exist to support
 * Requirement 10.8 (malformed agent output is wrapped into a valid
 * Agent_Message with normalization flag and original payload preserved). They
 * are not required on the wire; the normalization helper in task 14.1 sets
 * them.
 */

import { z } from "zod";

import {
  agentIdSchema,
  isoTimestampSchema,
  taskIdSchema,
} from "./primitives";

/** Maximum serialized payload size, in bytes. Requirement 10.4 → 1 MB. */
export const AGENT_MESSAGE_PAYLOAD_MAX_BYTES = 1024 * 1024;

/** Allowed Agent_Message types. Requirement 10.3. */
export const agentMessageTypeSchema = z.enum([
  "request",
  "response",
  "error",
  "handoff",
]);

/** A non-agent recipient identifier. The orchestrator is the only one. */
export const orchestratorRecipientSchema = z.literal("orchestrator");

/** Recipient is either an AgentId or `"orchestrator"`. */
export const agentMessageRecipientSchema = z.union([
  agentIdSchema,
  orchestratorRecipientSchema,
]);

/**
 * Payload variants. The discriminator is `kind`.
 * - `text`: human-readable content from agents.
 * - `json`: structured handoffs (e.g., review defect lists).
 * - `binary`: artefact-style transfers (rare; large content should go through
 *   the Artifact Store instead).
 */
export const textPayloadSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

export const jsonPayloadSchema = z.object({
  kind: z.literal("json"),
  value: z.unknown(),
});

export const binaryPayloadSchema = z.object({
  kind: z.literal("binary"),
  mime: z.string().min(1, "binary payload must declare a non-empty mime type"),
  bytes: z.instanceof(Uint8Array),
});

export const agentMessagePayloadSchema = z.discriminatedUnion("kind", [
  textPayloadSchema,
  jsonPayloadSchema,
  binaryPayloadSchema,
]);

/**
 * Compute the serialized byte size of a payload.
 *
 * For `json` payloads we serialize once via `JSON.stringify`; this avoids
 * counting JS-runtime overhead and matches what would actually travel over
 * the wire. If serialization fails (e.g., circular reference), we report
 * `Infinity` so the size check rejects it as oversize.
 *
 * `TextEncoder` is used (not Node's `Buffer`) so this code is portable
 * between the desktop renderer, web browser and Node-based backend without
 * needing platform-specific shims.
 */
const utf8Encoder = new TextEncoder();

export const measurePayloadSize = (
  payload: z.infer<typeof agentMessagePayloadSchema>,
): number => {
  switch (payload.kind) {
    case "text":
      return utf8Encoder.encode(payload.text).byteLength;
    case "json":
      try {
        const serialized = JSON.stringify(payload.value);
        if (serialized === undefined) {
          // `value` is itself `undefined`; it has no JSON representation but
          // semantically carries no bytes either.
          return 0;
        }
        return utf8Encoder.encode(serialized).byteLength;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    case "binary":
      return payload.bytes.byteLength;
  }
};

/**
 * Full `Agent_Message` schema.
 *
 * `superRefine` is used for the payload size check because the limit applies
 * to the serialized form of the payload, not to a single field.
 */
export const agentMessageSchema = z
  .object({
    taskId: taskIdSchema,
    sender: agentIdSchema,
    recipient: agentMessageRecipientSchema,
    type: agentMessageTypeSchema,
    payload: agentMessagePayloadSchema,
    timestamp: isoTimestampSchema,
    normalized: z.boolean().optional(),
    rawOriginal: z.unknown().optional(),
  })
  .superRefine((msg, ctx) => {
    const size = measurePayloadSize(msg.payload);
    if (size > AGENT_MESSAGE_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: `payload size ${size} bytes exceeds limit of ${AGENT_MESSAGE_PAYLOAD_MAX_BYTES} bytes (1 MB)`,
      });
    }
  });

export type AgentMessageType = z.infer<typeof agentMessageTypeSchema>;
export type AgentMessageRecipient = z.infer<typeof agentMessageRecipientSchema>;
export type AgentMessagePayload = z.infer<typeof agentMessagePayloadSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/**
 * Context that the Orchestrator provides when normalizing a raw agent
 * output into a valid Agent_Message.
 *
 * These fields cannot be inferred from the raw output itself: the
 * orchestrator is the authority on which task/sender/recipient/timestamp the
 * synthesised message belongs to. Requirements 10.6 and 10.7 require these
 * to be populated even when the agent output is malformed, so the message
 * still slots into the Task history at the right position.
 */
export interface NormalizeAgentMessageContext {
  /** Task this message belongs to (1..128 characters). */
  taskId: string;
  /** Agent that produced the raw output. */
  sender: string;
  /** Intended recipient — another agent or the orchestrator itself. */
  recipient: string;
  /**
   * ISO 8601 UTC ms timestamp captured by the orchestrator at the moment
   * the agent output was received. The orchestrator owns the clock so the
   * timestamp is trustworthy even if the agent itself produced garbage.
   */
  timestamp: string;
}

/** Result of attempting to coerce raw output into an Agent_Message payload. */
type PayloadCoercion =
  | { ok: true; payload: AgentMessagePayload }
  | { ok: false; reason: string };

/**
 * Try to build a valid `AgentMessagePayload` from arbitrary raw output.
 *
 * Decision tree:
 *  - `string` → text payload (after size check).
 *  - `Uint8Array` → binary payload with a generic mime type. We treat this
 *     as "the agent already handed us bytes" rather than serialising the
 *     typed array as a JSON object, which would be lossy.
 *  - JSON-serialisable value (object, array, number, boolean, null) → json
 *     payload. We pre-measure the serialised size to avoid emitting a json
 *     payload that the schema would reject.
 *  - anything else (`undefined`, `function`, `symbol`, `bigint`,
 *     circular structure, `toJSON` that throws) → unreadable; caller will
 *     wrap as `type: "error"`.
 *
 * The size pre-check mirrors `measurePayloadSize` so a successful coercion
 * is guaranteed to satisfy the 1 MB cap that `agentMessageSchema` enforces.
 */
const tryCoercePayload = (raw: unknown): PayloadCoercion => {
  if (typeof raw === "string") {
    const size = utf8Encoder.encode(raw).byteLength;
    if (size > AGENT_MESSAGE_PAYLOAD_MAX_BYTES) {
      return { ok: false, reason: "text payload exceeds 1 MB limit" };
    }
    return { ok: true, payload: { kind: "text", text: raw } };
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength > AGENT_MESSAGE_PAYLOAD_MAX_BYTES) {
      return { ok: false, reason: "binary payload exceeds 1 MB limit" };
    }
    return {
      ok: true,
      payload: {
        kind: "binary",
        mime: "application/octet-stream",
        bytes: new Uint8Array(raw),
      },
    };
  }
  if (raw === undefined) {
    return { ok: false, reason: "value is undefined" };
  }
  if (
    typeof raw === "function" ||
    typeof raw === "symbol" ||
    typeof raw === "bigint"
  ) {
    return {
      ok: false,
      reason: `value of type ${typeof raw} cannot be serialised as JSON`,
    };
  }
  // At this point raw is null, number, boolean, or object/array. Probe
  // serialisability via JSON.stringify; this rejects circular references and
  // values whose toJSON throws.
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `value is not JSON-serialisable: ${msg}` };
  }
  if (serialised === undefined) {
    // JSON.stringify returns undefined for top-level symbol/function/undefined
    // — those are already handled above, but guard defensively.
    return { ok: false, reason: "value has no JSON representation" };
  }
  if (utf8Encoder.encode(serialised).byteLength > AGENT_MESSAGE_PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: "json payload exceeds 1 MB limit" };
  }
  return { ok: true, payload: { kind: "json", value: raw } };
};

/**
 * Normalise an arbitrary agent output into a valid `AgentMessage`.
 *
 * Sources:
 * - requirements.md →
 *     10.8 (malformed output → wrap into Agent_Message of type "response",
 *           default missing fields, set normalisation flag, preserve raw),
 *     10.9 (unreadable output → Agent_Message of type "error" describing
 *           the communication failure, without disturbing earlier history).
 * - design.md → "Data Models" → "Agent_Message" (`normalized` and
 *   `rawOriginal` fields), and "Agent errors" (invalid output → normalised;
 *   unreadable → `error`).
 *
 * Behaviour:
 *  1. If `rawInput` already parses as a valid Agent_Message, return the
 *     parsed value verbatim. No `normalized` flag is set in that case
 *     because no normalisation actually happened.
 *  2. Otherwise, try to coerce `rawInput` into a payload (text, binary or
 *     json). On success, build a `type: "response"` message using the
 *     orchestrator-supplied `context` for taskId/sender/recipient/timestamp,
 *     mark `normalized: true`, and stash the original input under
 *     `rawOriginal` so downstream tooling can audit the agent's actual
 *     output.
 *  3. On unrecoverable inputs (undefined, BigInt, symbol, function,
 *     circular references, oversized payloads, …), build a
 *     `type: "error"` message whose payload is a short textual description
 *     of the failure cause. Requirement 10.9 explicitly forbids dropping
 *     the message, so this branch must always succeed.
 *
 * The function is **total**: for any `rawInput` and any `context` whose
 * fields satisfy the primitive schemas, the returned value passes
 * `agentMessageSchema.parse()`. That invariant is exercised by Property 5
 * in `agent-message.test.ts`.
 */
export const normalizeAgentMessage = (
  rawInput: unknown,
  context: NormalizeAgentMessageContext,
): AgentMessage => {
  // Case 1: input already conforms to the contract.
  const direct = agentMessageSchema.safeParse(rawInput);
  if (direct.success) {
    return direct.data;
  }

  // Case 2: input is parseable as text/JSON/binary but missing fields.
  const coerced = tryCoercePayload(rawInput);
  if (coerced.ok) {
    return {
      taskId: context.taskId,
      sender: context.sender,
      recipient: context.recipient,
      type: "response",
      payload: coerced.payload,
      timestamp: context.timestamp,
      normalized: true,
      rawOriginal: rawInput,
    };
  }

  // Case 3: input is unreadable. Emit a structured error message.
  return {
    taskId: context.taskId,
    sender: context.sender,
    recipient: context.recipient,
    type: "error",
    payload: {
      kind: "text",
      text: `Agent output could not be interpreted: ${coerced.reason}`,
    },
    timestamp: context.timestamp,
    normalized: true,
  };
};
