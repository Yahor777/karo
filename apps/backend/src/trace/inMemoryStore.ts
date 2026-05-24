/**
 * In-memory {@link TraceEventStoreBackend} (task 11.1).
 *
 * Used by:
 *   • Vitest unit tests for `TraceEventBus`.
 *   • The property test in task 11.4 ("Task history remains ordered by
 *     timestamp/sequence", Property 12).
 *   • Early backend bring-up before encrypted SQLite is wired in.
 *
 * Production replaces this with a SQL-backed backend; both implement the
 * same {@link TraceEventStoreBackend} port so callers ({@link TraceEventBus},
 * later SSE/WebSocket adapter, Final_Report builder) do not change.
 *
 * Storage layout: one append-only array of {@link TraceEvent}s per
 * `taskId`. The bus assigns sequence numbers, so this backend simply pushes
 * events as they arrive — preserving the order in which it received them.
 */

import type { TaskId } from "@ai-agent-orchestrator/shared-core";

import type {
  TraceEvent,
  TraceEventStoreBackend,
} from "./types.js";

/**
 * Defensive deep clone for `TraceEvent`.
 *
 * `JSON.parse(JSON.stringify(...))` would lose `Uint8Array` shape if a
 * future trace variant carried bytes. We keep the clone explicit so the
 * shape stays correct regardless of the variant.
 *
 * The discriminated union is exhausted by its `kind` field; the default
 * branch is unreachable at runtime but kept as a guard so adding a new
 * variant produces a type error here.
 */
function cloneRecord(record: TraceEvent["record"]): TraceEvent["record"] {
  switch (record.kind) {
    case "thought":
      return { kind: "thought", text: record.text, at: record.at };
    case "tool_call":
      return {
        kind: "tool_call",
        tool: record.tool,
        // `input` and `output` are typed as `unknown`. We do a structured
        // clone to defend against caller mutation; falling back to the
        // original reference if structuredClone is unavailable.
        input: structuredCloneSafe(record.input),
        output: structuredCloneSafe(record.output),
        at: record.at,
      };
    case "artifact_change":
      return {
        kind: "artifact_change",
        artifactId: record.artifactId,
        version: record.version,
        at: record.at,
      };
    case "status":
      return { kind: "status", status: record.status, at: record.at };
  }
}

function cloneEvent(event: TraceEvent): TraceEvent {
  return {
    taskId: event.taskId,
    agentId: event.agentId,
    record: cloneRecord(event.record),
    sequence: event.sequence,
  };
}

/**
 * Best-effort `structuredClone` wrapper. Falls back to the original value
 * for inputs the runtime cannot clone (e.g. functions, symbols).
 *
 * `tool_call.input` / `tool_call.output` are typed as `unknown` and the
 * agent runtime is expected to pass plain JSON-shaped values; we still
 * guard against the rare case where a caller hands us something exotic so
 * the trace bus never throws inside the storage layer.
 */
function structuredCloneSafe(value: unknown): unknown {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
  // Older Node falls back to a JSON round-trip for clonable shapes.
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
}

/** Map-backed in-memory implementation. Constructed empty. */
export class InMemoryTraceEventStoreBackend
  implements TraceEventStoreBackend
{
  private readonly entries = new Map<TaskId, TraceEvent[]>();

  public append(event: TraceEvent): Promise<void> {
    const log = this.entries.get(event.taskId);
    // Defensive clone on write: the caller still owns the object it
    // handed us; from this point the store is the source of truth.
    const stored = cloneEvent(event);
    if (log === undefined) {
      this.entries.set(event.taskId, [stored]);
    } else {
      log.push(stored);
    }
    return Promise.resolve();
  }

  public list(taskId: TaskId): Promise<readonly TraceEvent[]> {
    const log = this.entries.get(taskId);
    if (log === undefined) return Promise.resolve([]);
    // Hand back fresh clones so iterating the result cannot mutate
    // persisted state.
    return Promise.resolve(log.map(cloneEvent));
  }

  public latestSequence(taskId: TaskId): Promise<number> {
    const log = this.entries.get(taskId);
    if (log === undefined || log.length === 0) return Promise.resolve(0);
    // The bus appends in ascending order, so the tail is the highest
    // sequence. Avoid scanning so this stays O(1) for hot tasks.
    return Promise.resolve(log[log.length - 1]?.sequence ?? 0);
  }

  /**
   * Test helper: removes every entry. Production code MUST NOT call this —
   * mirrors the `clearAll` hatch on `InMemoryArtifactStoreBackend`.
   */
  public clearAll(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}
