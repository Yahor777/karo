/**
 * History-trimming helpers used by {@link AgentRunner} (task 14.1).
 *
 * Sources:
 * - requirements.md → 10.7 ("Orchestrator passes Agent the full
 *   message history bounded by the latest 200 messages or 8 MB total").
 * - design.md → "Agent Runtime" — agents receive the bounded history
 *   plus their own system prompt.
 *
 * The bounding rule combines two caps applied in this order:
 *
 *   1. Drop oldest messages until the count is ≤ {@link AGENT_HISTORY_MAX_MESSAGES}.
 *   2. Drop oldest messages until the total serialised size is ≤
 *      {@link AGENT_HISTORY_MAX_BYTES}.
 *
 * Oldest-first dropping preserves recency, which matches the intent of
 * the requirement (the agent should always see the most recent
 * messages). The orchestrator's design prescribes preserving system
 * prompts under trimming; in this codebase the system prompt is a
 * field of {@link AgentDefinition} and is passed to the model adapter
 * separately from the message history (see `ModelInvokeOptions.systemPrompt`),
 * so it is structurally outside the trim window and survives any
 * truncation by construction.
 *
 * If a single message on its own exceeds the byte budget we keep it
 * anyway: dropping the most recent message would violate Requirement
 * 10.7's intent of always handing the agent the latest context, and
 * the per-message 1 MB cap from Requirement 10.4 already bounds the
 * worst case far below the 8 MB total.
 */

import type { AgentMessage } from "@ai-agent-orchestrator/validation";

import {
  AGENT_HISTORY_MAX_BYTES,
  AGENT_HISTORY_MAX_MESSAGES,
} from "./types.js";

/**
 * Estimate the on-the-wire serialised byte size of an Agent_Message.
 *
 * The estimate is intentionally conservative — we count the raw bytes
 * of every payload variant plus a fixed per-message overhead for the
 * envelope (taskId / sender / recipient / type / timestamp / flags). It
 * is not exact JSON size, but it sits within the same order of
 * magnitude and is monotonic in the payload size, which is all the 8 MB
 * cap needs to be meaningful. Using a precise serialiser here would
 * pull the runner into the JSON encoding hot path and add no
 * correctness benefit for the requirement.
 */
const utf8Encoder = new TextEncoder();

const MESSAGE_ENVELOPE_OVERHEAD_BYTES = 256;

export function estimateAgentMessageSize(message: AgentMessage): number {
  let size = MESSAGE_ENVELOPE_OVERHEAD_BYTES;
  size += utf8Encoder.encode(message.taskId).byteLength;
  size += utf8Encoder.encode(message.sender).byteLength;
  size += utf8Encoder.encode(message.recipient).byteLength;
  size += utf8Encoder.encode(message.type).byteLength;
  size += utf8Encoder.encode(message.timestamp).byteLength;

  switch (message.payload.kind) {
    case "text":
      size += utf8Encoder.encode(message.payload.text).byteLength;
      break;
    case "json":
      try {
        const serialised = JSON.stringify(message.payload.value);
        size += serialised === undefined
          ? 0
          : utf8Encoder.encode(serialised).byteLength;
      } catch {
        // Unserialisable JSON values cannot reach a persisted
        // message in the first place (the runner wraps them as
        // `type: "error"` before append). Treat them as oversized
        // so any leaked values are pruned aggressively.
        size += AGENT_HISTORY_MAX_BYTES;
      }
      break;
    case "binary":
      size += message.payload.bytes.byteLength;
      break;
  }

  if (message.rawOriginal !== undefined) {
    try {
      const serialised = JSON.stringify(message.rawOriginal);
      size += serialised === undefined
        ? 0
        : utf8Encoder.encode(serialised).byteLength;
    } catch {
      // Unserialisable rawOriginal: count it as the per-message cap so
      // the whole message is treated as bulky and gets dropped first.
      size += AGENT_HISTORY_MAX_BYTES;
    }
  }

  return size;
}

/**
 * Trim `history` to satisfy the 200-message and 8 MB caps from
 * Requirement 10.7, preserving the most recent messages.
 *
 * Pure function: does not mutate `history`. Returns a new array
 * containing references to the original messages (the runner clones
 * them downstream where needed).
 */
export function boundAgentHistory(
  history: readonly AgentMessage[],
): readonly AgentMessage[] {
  // Step 1: cap by message count, dropping the oldest.
  const countTrimmed: readonly AgentMessage[] =
    history.length > AGENT_HISTORY_MAX_MESSAGES
      ? history.slice(history.length - AGENT_HISTORY_MAX_MESSAGES)
      : history;

  // Step 2: cap by total bytes, again dropping the oldest until we
  // fit. We accumulate from the tail so the most recent messages are
  // always kept; only the prefix gets shaved.
  let total = 0;
  let firstKeptIndex = countTrimmed.length;
  for (let i = countTrimmed.length - 1; i >= 0; i -= 1) {
    const msg = countTrimmed[i];
    if (msg === undefined) continue;
    const size = estimateAgentMessageSize(msg);

    // Special case: if the single most recent message is itself larger
    // than the cap, keep it anyway — see file-level comment.
    if (i === countTrimmed.length - 1 && size > AGENT_HISTORY_MAX_BYTES) {
      total = size;
      firstKeptIndex = i;
      break;
    }

    if (total + size > AGENT_HISTORY_MAX_BYTES) {
      break;
    }
    total += size;
    firstKeptIndex = i;
  }

  return firstKeptIndex === 0
    ? countTrimmed
    : countTrimmed.slice(firstKeptIndex);
}
