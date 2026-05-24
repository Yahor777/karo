/**
 * `TraceEventBus.publish` / `subscribe` (task 11.1).
 *
 * Implements the in-process half of design.md → "Trace Event Bus" →
 * "Interface". The SSE/WebSocket streaming endpoint (task 11.2) and the
 * UI panel (task 11.3) layer on top of this bus without changing it.
 *
 * Behaviour summary:
 *
 *   • Every {@link PublishTraceInput} becomes a persisted
 *     {@link TraceEvent} with a per-task monotonic `sequence` (1, 2, 3, …).
 *   • Persistence happens through the {@link TraceEventStoreBackend} port;
 *     the bus does not own its storage layout. The in-memory backend is
 *     used by tests and bring-up, encrypted SQLite plugs in later.
 *   • Subscribers receive only events published _after_ they subscribe.
 *     Historical replay is composed by the orchestrator (`listEvents` +
 *     `subscribe`) so the bus avoids re-delivery hazards on the
 *     boundary between the historical and live windows.
 *   • `subscribe` returns an `AsyncIterable<TraceEvent>`. Cancelling the
 *     iterator (e.g. with `break` inside `for await`) detaches the
 *     subscriber and frees its internal queue.
 *
 * Out of scope for task 11.1 (handled by later tasks):
 *   • HTTP transports for trace streaming → task 11.2.
 *   • UI panel and "Updating…" indicator → task 11.3.
 *   • Cross-process replication / fan-out across multiple backend nodes.
 *
 * Validates: Requirements 9.5, 11.2, 11.7.
 */

import type { AgentId, TaskId } from "@ai-agent-orchestrator/shared-core";

import { redactTraceRecord } from "./redaction.js";
import type {
  PublishTraceInput,
  SubscribeTraceInput,
  TraceEvent,
  TraceEventBus as TraceEventBusInterface,
  TraceEventStoreBackend,
  TraceRecord,
} from "./types.js";

/**
 * Constructor options for {@link TraceEventBus}.
 *
 * The backend is required. Everything else is intentionally minimal — the
 * bus is small enough that introducing more knobs at this stage would
 * obscure the real shape of the abstraction.
 */
export interface TraceEventBusOptions {
  readonly backend: TraceEventStoreBackend;
}

/**
 * Internal bookkeeping for one active subscriber.
 *
 * The subscriber holds a bounded queue of pending events and a single
 * resolver promise that is resolved whenever a new event arrives. The
 * bus pushes into the queue and triggers the resolver; the iterator
 * pops from the queue and re-arms the resolver. When `closed` flips to
 * true, the iterator drains any queued events then terminates.
 */
interface Subscriber {
  readonly taskId: TaskId;
  readonly agentId: AgentId | undefined;
  readonly queue: TraceEvent[];
  closed: boolean;
  /** Resolved by `publish` when there is something for the iterator to read. */
  signal: (() => void) | null;
}

/**
 * Implements `TraceEventBus.publish` / `subscribe` / `listEvents`.
 *
 * The class is deliberately small — it owns no transport or framework
 * concerns. Higher layers (`Web_Search_Tool` in task 13.2, agent runtimes
 * in task 14.x, the orchestrator pipeline in task 15.1) call `publish`
 * with their own `TraceRecord`s; the SSE/WebSocket adapter in task 11.2
 * calls `subscribe`.
 */
export class TraceEventBus implements TraceEventBusInterface {
  private readonly backend: TraceEventStoreBackend;

  /**
   * Highest sequence number assigned per task, in memory. The backend's
   * `latestSequence` is consulted lazily on first publish for a task to
   * recover state across restarts.
   */
  private readonly counters = new Map<TaskId, number>();

  /**
   * Per-task serialisation queues. Concurrent `publish` calls for the
   * same `taskId` are chained on one promise so `getNextSequence` /
   * `backend.append` stay atomic without requiring a transactional
   * backend. Different tasks proceed in parallel.
   */
  private readonly inFlight = new Map<TaskId, Promise<unknown>>();

  /**
   * Active subscribers indexed by taskId. We keep the lookup keyed by
   * taskId only — agentId filtering happens in the dispatch loop —
   * because per-task fan-out is the dominant access pattern (one
   * subscriber per UI viewer, one subscriber per task overview, etc.).
   */
  private readonly subscribers = new Map<TaskId, Set<Subscriber>>();

  public constructor(options: TraceEventBusOptions) {
    this.backend = options.backend;
  }

  /**
   * Persist a {@link TraceRecord} as a {@link TraceEvent} and broadcast it
   * to every active subscriber whose filter matches `(taskId, agentId)`.
   *
   * Sequence assignment is serialised per task: the next value is read
   * from the in-memory counter (initialised lazily from
   * `backend.latestSequence`), incremented, and persisted as part of the
   * same critical section. This guarantees the sequence stream is
   * gap-free and strictly monotonic within a task even under concurrent
   * publishers.
   */
  public async publish(input: PublishTraceInput): Promise<TraceEvent> {
    validatePublishInput(input);

    const queueKey = input.taskId;
    const previous = this.inFlight.get(queueKey) ?? Promise.resolve();
    const next = previous.then(() => this.publishLocked(input));

    // Chain entry swallows errors so one failure does not poison the
    // chain for subsequent callers — each caller still sees the real
    // outcome via the returned `next` promise.
    const chainEntry = next.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(queueKey, chainEntry);

    void chainEntry.then(() => {
      if (this.inFlight.get(queueKey) === chainEntry) {
        this.inFlight.delete(queueKey);
      }
    });
    return next;
  }

  /**
   * Subscribe to events for `taskId`, optionally filtered by `agentId`.
   * Returns an async iterable that yields events in publish order until
   * the consumer stops iterating.
   */
  public subscribe(input: SubscribeTraceInput): AsyncIterable<TraceEvent> {
    validateSubscribeInput(input);

    const subscriber: Subscriber = {
      taskId: input.taskId,
      agentId: input.agentId,
      queue: [],
      closed: false,
      signal: null,
    };

    let bucket = this.subscribers.get(input.taskId);
    if (bucket === undefined) {
      bucket = new Set();
      this.subscribers.set(input.taskId, bucket);
    }
    bucket.add(subscriber);

    const detach = (): void => {
      subscriber.closed = true;
      const set = this.subscribers.get(input.taskId);
      if (set !== undefined) {
        set.delete(subscriber);
        if (set.size === 0) {
          this.subscribers.delete(input.taskId);
        }
      }
      // Wake up a pending reader so the iterator can observe `closed`
      // and terminate cleanly.
      const pending = subscriber.signal;
      subscriber.signal = null;
      if (pending !== null) pending();
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<TraceEvent> {
        return {
          async next(): Promise<IteratorResult<TraceEvent>> {
            // Drain queued events first, then await new ones.
            while (true) {
              const head = subscriber.queue.shift();
              if (head !== undefined) {
                return { value: head, done: false };
              }
              if (subscriber.closed) {
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                subscriber.signal = resolve;
              });
            }
          },
          return(): Promise<IteratorResult<TraceEvent>> {
            detach();
            return Promise.resolve({ value: undefined, done: true });
          },
          throw(err): Promise<IteratorResult<TraceEvent>> {
            detach();
            return Promise.reject(err as Error);
          },
        };
      },
    };
  }

  /**
   * Snapshot of the persisted history for `taskId`. Order matches the
   * order in which the events were published (and therefore the order
   * of their sequence numbers).
   */
  public async listEvents(taskId: TaskId): Promise<readonly TraceEvent[]> {
    assertNonEmptyString(taskId, "taskId");
    return this.backend.list(taskId);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async publishLocked(
    input: PublishTraceInput,
  ): Promise<TraceEvent> {
    const sequence = await this.nextSequence(input.taskId);
    // Pre-publish redaction (task 20.1): mask API-key-shaped material in
    // `tool_call.input` / `tool_call.output` and `thought.text` so the
    // persisted `TraceEvent` and every subscriber's copy stay key-free
    // (Requirements 1.6, 3.7, 4.5). Variants without redactable fields
    // pass through untouched.
    const redactedRecord = redactTraceRecord(input.record);
    const event: TraceEvent = {
      taskId: input.taskId,
      agentId: input.agentId,
      record: redactedRecord,
      sequence,
    };

    // Persist before fan-out. If `backend.append` throws, the counter
    // would already have advanced; we roll it back so a retry can reuse
    // the same sequence number. This keeps the counter and the
    // persisted log in lockstep even on backend errors.
    try {
      await this.backend.append(event);
    } catch (err) {
      this.counters.set(input.taskId, sequence - 1);
      throw err;
    }

    this.dispatch(event);
    return event;
  }

  /**
   * Returns the next per-task sequence value. On the first publish for a
   * task we consult the backend so a restart picks up where the
   * previous process left off; subsequent publishes use the cached
   * counter.
   */
  private async nextSequence(taskId: TaskId): Promise<number> {
    const cached = this.counters.get(taskId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.counters.set(taskId, next);
      return next;
    }
    const persisted = await this.backend.latestSequence(taskId);
    const next = persisted + 1;
    this.counters.set(taskId, next);
    return next;
  }

  private dispatch(event: TraceEvent): void {
    const bucket = this.subscribers.get(event.taskId);
    if (bucket === undefined) return;

    for (const subscriber of bucket) {
      if (subscriber.closed) continue;
      if (
        subscriber.agentId !== undefined &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      subscriber.queue.push(event);
      const pending = subscriber.signal;
      subscriber.signal = null;
      if (pending !== null) pending();
    }
  }
}

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

/**
 * Up-front validation for {@link PublishTraceInput}.
 *
 * Errors here represent programmer mistakes (empty agent id, missing
 * record). The on-the-wire shape is covered by the Zod schemas in
 * `packages/validation`; these checks defend the in-process API from
 * accidental misuse so subscribers never receive a half-formed event.
 */
function validatePublishInput(input: PublishTraceInput): void {
  assertNonEmptyString(input.taskId, "taskId");
  assertNonEmptyString(input.agentId, "agentId");

  const record: TraceRecord | undefined = input.record;
  if (record === undefined || record === null) {
    throw new TypeError(
      "TraceEventBus.publish: record must be a TraceRecord object",
    );
  }
  if (typeof record !== "object") {
    throw new TypeError(
      "TraceEventBus.publish: record must be a TraceRecord object",
    );
  }
}

function validateSubscribeInput(input: SubscribeTraceInput): void {
  assertNonEmptyString(input.taskId, "taskId");
  if (input.agentId !== undefined) {
    assertNonEmptyString(input.agentId, "agentId");
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `TraceEventBus: ${field} must be a non-empty string`,
    );
  }
}

// `AgentId` and `TaskId` are imported only for documentation linkage;
// mark them as type-only references so the runtime bundle stays clean.
export type { AgentId, TaskId };
