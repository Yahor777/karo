/**
 * In-memory {@link TaskStateStore} implementation.
 *
 * Used by:
 *
 *   • Vitest unit tests for {@link Orchestrator.createTask} (task 8.2).
 *   • Early bring-up of the desktop pipeline before durable storage lands.
 *
 * Production composes a SQLite (desktop) or Postgres (cloud) backed store
 * implementing the same `TaskStateStore` port; switching does not require
 * changes to the orchestrator.
 *
 * The store keeps a defensive deep copy of every saved state so caller-side
 * mutation cannot leak back into persisted data — same convention used by
 * `InMemoryApiKeyStoreBackend` in the settings module.
 */

import type { TaskState } from "@ai-agent-orchestrator/validation";

import type { TaskStateStore } from "./createTask.js";

/** JSON deep-clone — every field on `TaskState` is JSON-safe. */
function cloneState(state: TaskState): TaskState {
  return JSON.parse(JSON.stringify(state)) as TaskState;
}

/**
 * Map-backed {@link TaskStateStore}, keyed by `state.id`. Constructed empty.
 *
 * Exposes a few read helpers (`get`, `size`) intended for tests; they are
 * not part of the {@link TaskStateStore} contract because production code
 * paths don't need them yet (task 8.2 only writes; tasks 9.x and 15.1 will
 * extend the port with read methods when they need them).
 */
export class InMemoryTaskStateStore implements TaskStateStore {
  private readonly entries = new Map<string, TaskState>();

  public save(state: TaskState): Promise<void> {
    this.entries.set(state.id, cloneState(state));
    return Promise.resolve();
  }

  public load(id: string): Promise<TaskState | null> {
    return Promise.resolve(this.get(id));
  }

  /** Test helper: returns a defensive copy or `null` if absent. */
  public get(id: string): TaskState | null {
    const v = this.entries.get(id);
    return v === undefined ? null : cloneState(v);
  }

  /** Test helper: number of persisted task states. */
  public size(): number {
    return this.entries.size;
  }

  /** Test helper: removes every entry. */
  public clear(): void {
    this.entries.clear();
  }
}
