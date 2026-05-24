import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import { ToolCallingModelAdapter } from "./toolCallingModelAdapter.js";
import type { ModelAdapter, ModelInvokeOptions } from "./types.js";
import type { SearchOptions, SearchResult, WebSearchTool } from "../search/index.js";

const MODEL: ModelRef = {
  provider: "openai",
  modelId: "gpt-4o-mini",
  source: "user-api-key",
};

const OPTIONS: ModelInvokeOptions = {
  systemPrompt: "You are a researcher.",
  apiKey: {
    provider: "openai",
    scope: { kind: "local", deviceId: "device-1" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  allowedTools: ["web_search"],
};

const HISTORY: readonly AgentMessage[] = [
  {
    taskId: "task-tools",
    sender: "orchestrator",
    recipient: "researcher",
    type: "handoff",
    payload: { kind: "text", text: "Find current context." },
    timestamp: "2026-01-01T00:00:00.000Z",
  },
];

class SequenceModelAdapter implements ModelAdapter {
  public readonly calls: Array<{
    messages: readonly AgentMessage[];
    options: ModelInvokeOptions;
  }> = [];

  public constructor(private readonly raws: unknown[]) {}

  public invoke(
    _modelRef: ModelRef,
    messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }> {
    this.calls.push({ messages, options });
    const raw = this.raws.shift();
    return Promise.resolve({ raw });
  }
}

class StubWebSearch implements WebSearchTool {
  public readonly calls: Array<{
    query: string;
    options: SearchOptions | undefined;
  }> = [];

  public constructor(private readonly result: SearchResult) {}

  public search(query: string, options?: SearchOptions): Promise<SearchResult> {
    this.calls.push({ query, options });
    return Promise.resolve(this.result);
  }
}

describe("ToolCallingModelAdapter", () => {
  it("executes a web_search JSON request and reinvokes the model with the tool result", async () => {
    const inner = new SequenceModelAdapter([
      {
        tool_call: {
          tool: "web_search",
          query: "Cline Apache license",
          limit: 3,
        },
      },
      { type: "response", text: "Cline is Apache-2.0. Source: https://example.com" },
    ]);
    const search = new StubWebSearch({
      kind: "ok",
      results: [
        {
          title: "Cline",
          url: "https://example.com/cline",
          snippet: "Apache-2.0 license",
        },
      ],
    });
    const adapter = new ToolCallingModelAdapter({
      inner,
      webSearch: search,
      clock: { nowIso: () => "2026-01-01T00:00:01.000Z" },
    });

    const result = await adapter.invoke(MODEL, HISTORY, OPTIONS);

    expect(result.raw).toEqual({
      type: "response",
      text: "Cline is Apache-2.0. Source: https://example.com",
    });
    expect(search.calls).toEqual([{ query: "Cline Apache license", options: { limit: 3 } }]);
    expect(inner.calls).toHaveLength(2);
    expect(inner.calls[0]?.options.systemPrompt).toContain("Runtime tool available: web_search");
    const secondMessages = inner.calls[1]?.messages ?? [];
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[2]?.payload.kind).toBe("text");
    if (secondMessages[2]?.payload.kind !== "text") {
      throw new Error("expected tool result text");
    }
    expect(secondMessages[2].payload.text).toContain("DuckDuckGo web search results");
    expect(secondMessages[2].payload.text).toContain("https://example.com/cline");
  });

  it("does not expose tools when web_search is not allowed", async () => {
    const inner = new SequenceModelAdapter([{ type: "response", text: "no tools" }]);
    const search = new StubWebSearch({ kind: "ok", results: [] });
    const adapter = new ToolCallingModelAdapter({ inner, webSearch: search });

    const result = await adapter.invoke(MODEL, HISTORY, {
      ...OPTIONS,
      allowedTools: ["file_read"],
    });

    expect(result.raw).toEqual({ type: "response", text: "no tools" });
    expect(search.calls).toHaveLength(0);
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]?.options.systemPrompt).toBe("You are a researcher.");
  });

  it("returns a structured error when the model keeps requesting tools past the round limit", async () => {
    const inner = new SequenceModelAdapter([
      '{ "tool_call": { "tool": "web_search", "query": "one" } }',
      '{ "tool_call": { "tool": "web_search", "query": "two" } }',
    ]);
    const search = new StubWebSearch({ kind: "ok", results: [] });
    const adapter = new ToolCallingModelAdapter({
      inner,
      webSearch: search,
      maxToolRounds: 1,
    });

    const result = await adapter.invoke(MODEL, HISTORY, OPTIONS);

    expect(search.calls).toHaveLength(1);
    expect(result.raw).toEqual({
      type: "error",
      providerCode: "tool_loop_limit",
      providerMessage: "web_search tool loop exceeded 1 rounds",
    });
  });
});
