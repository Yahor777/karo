/**
 * Trace Event Bus pre-publish redaction (task 20.1).
 *
 * Sources:
 *   • design.md → "Desktop Shell" → "Security rules" — no API keys in
 *     persisted trace records.
 *   • design.md → "Trace Event Bus" → "Rules" — full Agent_Trace is
 *     preserved for completed tasks (Requirement 11.7).
 *   • requirements.md → 1.6, 3.7, 4.5.
 *
 * The bus runs every published `TraceRecord` through
 * {@link redactTraceRecord} before persistence and subscriber fan-out
 * so an API-key-shaped substring in `tool_call.input`,
 * `tool_call.output`, or `thought.text` cannot survive into the
 * persisted history or onto an SSE subscriber. These tests pin that
 * contract using the existing in-memory trace store.
 *
 * Validates: Requirements 1.6, 3.7, 4.5.
 */

import { describe, expect, it } from "vitest";

import { redactString } from "@ai-agent-orchestrator/shared-core";

import {
  InMemoryTraceEventStoreBackend,
  TraceEventBus,
  type TraceEvent,
} from "./index.js";
import { redactTraceRecord } from "./redaction.js";

const ISO_AT = "2025-03-01T12:00:00.000Z";
const LEAKED_KEY = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
const REDACTED_KEY = "[REDACTED:api_key:openai]";

/**
 * Pull `n` events from a subscription with a generous timeout. Mirrors
 * the helper in `traceEventBus.test.ts` so the test reads consistently.
 */
async function take(
  iter: AsyncIterable<TraceEvent>,
  n: number,
  timeoutMs = 1_000,
): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  const it = iter[Symbol.asyncIterator]();
  for (let i = 0; i < n; i += 1) {
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`timed out waiting for event ${i + 1}/${n}`),
            ),
          timeoutMs,
        ),
      ),
    ]);
    if (next.done) {
      throw new Error(`subscription ended after ${out.length}/${n} events`);
    }
    out.push(next.value);
  }
  await it.return?.();
  return out;
}

describe("redactTraceRecord (pure helper)", () => {
  it("redacts API keys in tool_call.input and tool_call.output", () => {
    const record = redactTraceRecord({
      kind: "tool_call",
      tool: "web_search",
      input: { query: "lookup", apiKey: LEAKED_KEY },
      output: { headers: { authorization: `Bearer ${LEAKED_KEY}` } },
      at: ISO_AT,
    });

    expect(record.kind).toBe("tool_call");
    if (record.kind === "tool_call") {
      expect(record.input).toEqual({
        query: "lookup",
        apiKey: REDACTED_KEY,
      });
      // The OpenAI `sk-…` rule fires before the Bearer rule, so the
      // key inside the header is masked first; the literal `Bearer `
      // prefix is preserved. Either way no key material survives.
      expect(record.output).toEqual({
        headers: { authorization: `Bearer ${REDACTED_KEY}` },
      });
    }
  });

  it("redacts inline secrets inside thought.text", () => {
    const record = redactTraceRecord({
      kind: "thought",
      text: `try ${LEAKED_KEY} next`,
      at: ISO_AT,
    });
    expect(record.kind).toBe("thought");
    if (record.kind === "thought") {
      expect(record.text).toBe(redactString(`try ${LEAKED_KEY} next`));
      expect(record.text).not.toContain(LEAKED_KEY);
    }
  });

  it("returns artifact_change and status records unchanged", () => {
    const change = redactTraceRecord({
      kind: "artifact_change",
      artifactId: "a-1",
      version: 2,
      at: ISO_AT,
    });
    expect(change).toEqual({
      kind: "artifact_change",
      artifactId: "a-1",
      version: 2,
      at: ISO_AT,
    });

    const status = redactTraceRecord({
      kind: "status",
      status: "started",
      at: ISO_AT,
    });
    expect(status).toEqual({
      kind: "status",
      status: "started",
      at: ISO_AT,
    });
  });
});

describe("TraceEventBus — pre-publish redaction (task 20.1)", () => {
  it(
    "redacts API keys carried in tool_call.input/output before " +
      "persistence and before delivering to subscribers",
    async () => {
      const backend = new InMemoryTraceEventStoreBackend();
      const bus = new TraceEventBus({ backend });

      const sub = bus.subscribe({ taskId: "task-redact" });

      const publishing = (async () => {
        await bus.publish({
          taskId: "task-redact",
          agentId: "researcher",
          record: {
            kind: "tool_call",
            tool: "web_search",
            input: {
              query: "search",
              apiKey: LEAKED_KEY,
              auth: `Bearer ${LEAKED_KEY}`,
            },
            output: { provider: "openai", echoedKey: LEAKED_KEY },
            at: ISO_AT,
          },
        });
      })();

      const received = await take(sub, 1);
      await publishing;

      // Subscriber's view is redacted.
      expect(received).toHaveLength(1);
      const subEvent = received[0];
      expect(subEvent).toBeDefined();
      if (subEvent && subEvent.record.kind === "tool_call") {
        expect(subEvent.record.input).toEqual({
          query: "search",
          apiKey: REDACTED_KEY,
          auth: `Bearer ${REDACTED_KEY}`,
        });
        expect(subEvent.record.output).toEqual({
          provider: "openai",
          echoedKey: REDACTED_KEY,
        });
      }
      // No leaked key anywhere in the subscriber payload.
      expect(JSON.stringify(received)).not.toContain(LEAKED_KEY);

      // Persisted record is also redacted.
      const persisted = await bus.listEvents("task-redact");
      expect(JSON.stringify(persisted)).not.toContain(LEAKED_KEY);

      const persistedFirst = persisted[0];
      expect(persistedFirst).toBeDefined();
      if (persistedFirst && persistedFirst.record.kind === "tool_call") {
        expect(persistedFirst.record.input).toEqual({
          query: "search",
          apiKey: REDACTED_KEY,
          auth: `Bearer ${REDACTED_KEY}`,
        });
        expect(persistedFirst.record.output).toEqual({
          provider: "openai",
          echoedKey: REDACTED_KEY,
        });
      }
    },
  );

  it("redacts API-key-shaped substrings in thought.text before persistence", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    await bus.publish({
      taskId: "task-thought",
      agentId: "researcher",
      record: {
        kind: "thought",
        text: `i could try ${LEAKED_KEY} but the user says no`,
        at: ISO_AT,
      },
    });

    const persisted = await bus.listEvents("task-thought");
    expect(JSON.stringify(persisted)).not.toContain(LEAKED_KEY);

    const head = persisted[0];
    expect(head).toBeDefined();
    if (head && head.record.kind === "thought") {
      expect(head.record.text).toBe(
        `i could try ${REDACTED_KEY} but the user says no`,
      );
    }
  });

  it("does not modify the caller's input record", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    const original = {
      kind: "tool_call" as const,
      tool: "web_search" as const,
      input: { apiKey: LEAKED_KEY },
      output: { ok: true },
      at: ISO_AT,
    };
    const before = JSON.stringify(original);

    await bus.publish({
      taskId: "task-immutable",
      agentId: "researcher",
      record: original,
    });

    expect(JSON.stringify(original)).toBe(before);
    expect(original.input.apiKey).toBe(LEAKED_KEY);
  });

  it("redacts artifact_change and status records as no-ops (still no leakage)", async () => {
    const backend = new InMemoryTraceEventStoreBackend();
    const bus = new TraceEventBus({ backend });

    await bus.publish({
      taskId: "task-misc",
      agentId: "coder",
      record: {
        kind: "artifact_change",
        artifactId: "a-1",
        version: 1,
        at: ISO_AT,
      },
    });
    await bus.publish({
      taskId: "task-misc",
      agentId: "coder",
      record: { kind: "status", status: "finished", at: ISO_AT },
    });

    const persisted = await bus.listEvents("task-misc");
    expect(persisted.map((e) => e.record.kind)).toEqual([
      "artifact_change",
      "status",
    ]);
    // Sanity: no key string would have ever made it in, but assert the
    // invariant alongside the other tests for consistency.
    expect(JSON.stringify(persisted)).not.toContain(LEAKED_KEY);
  });
});
