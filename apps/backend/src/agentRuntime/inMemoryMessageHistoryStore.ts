/**
 * In-memory {@link MessageHistoryStore} (task 14.1).
 *
 * Used by:
 *
 *   • Vitest unit tests for `AgentRunner`.
 *   • Early backend bring-up before persistent storage (encrypted
 *     SQLite for local scope, SQL for cloud scope) is wired in.
 *
 * Production replaces this with a SQL-backed backend; both implement
 * the same {@link MessageHistoryStore} port so callers ({@link AgentRunner},
 * the orchestrator pipeline driver in task 15.1, the Final_Report
 * builder in task 15.2) do not change.
 *
 * Storage layout: one append-only array of {@link AgentMessage}s per
 * `taskId`. The runner appends in chronological order; the store
 * preserves the order it received messages in.
 *
 * Validates: Requirements 10.6, 10.7.
 */

import type {
  AgentMessage,
} from "@ai-agent-orchestrator/validation";
import type { TaskId } from "@ai-agent-orchestrator/shared-core";

import type { MessageHistoryStore } from "./types.js";

/**
 * Defensive deep clone for an `AgentMessage`.
 *
 * `JSON.parse(JSON.stringify(...))` would lose `Uint8Array` shape on
 * binary payloads. We clone the structure manually so the bytes
 * survive intact.
 *
 * `rawOriginal` is best-effort cloned via `structuredClone` because it
 * carries arbitrary user-supplied data; it falls back to the original
 * reference for inputs `structuredClone` cannot copy (e.g. functions,
 * symbols) — those values cannot be serialised anyway, so the runner
 * has already wrapped the offending message as `type: "error"` by the
 * time it reaches us.
 */
function clonePayload(
  payload: AgentMessage["payload"],
): AgentMessage["payload"] {
  switch (payload.kind) {
    case "text":
      return { kind: "text", text: payload.text };
    case "json":
      return { kind: "json", value: structuredCloneSafe(payload.value) };
    case "binary":
      return {
        kind: "binary",
        mime: payload.mime,
        // `slice()` returns a fresh Uint8Array backed by a fresh
        // ArrayBuffer so caller-side mutation cannot reach into the
        // persisted record.
        bytes: payload.bytes.slice(),
      };
  }
}

function cloneMessage(message: AgentMessage): AgentMessage {
  return {
    taskId: message.taskId,
    sender: message.sender,
    recipient: message.recipient,
    type: message.type,
    payload: clonePayload(message.payload),
    timestamp: message.timestamp,
    ...(message.normalized !== undefined
      ? { normalized: message.normalized }
      : {}),
    ...(message.rawOriginal !== undefined
      ? { rawOriginal: structuredCloneSafe(message.rawOriginal) }
      : {}),
  };
}

function structuredCloneSafe(value: unknown): unknown {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
}

/** Map-backed in-memory implementation. Constructed empty. */
export class InMemoryMessageHistoryStore implements MessageHistoryStore {
  private readonly entries = new Map<TaskId, AgentMessage[]>();

  public append(taskId: TaskId, message: AgentMessage): Promise<void> {
    // Defensive clone on write: from this point the store is the
    // source of truth.
    const stored = cloneMessage(message);
    const log = this.entries.get(taskId);
    if (log === undefined) {
      this.entries.set(taskId, [stored]);
    } else {
      log.push(stored);
    }
    return Promise.resolve();
  }

  public list(taskId: TaskId): Promise<readonly AgentMessage[]> {
    const log = this.entries.get(taskId);
    if (log === undefined) return Promise.resolve([]);
    // Hand back fresh clones so iterating the result cannot mutate
    // persisted state.
    return Promise.resolve(log.map(cloneMessage));
  }

  /**
   * Test helper: removes every entry. Production code MUST NOT call this —
   * mirrors the `clearAll` hatch on the trace and artifact backends.
   */
  public clearAll(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}
