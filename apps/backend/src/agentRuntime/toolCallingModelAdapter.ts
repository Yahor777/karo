/**
 * ModelAdapter decorator that lets agents call runtime tools through a
 * small, provider-agnostic JSON protocol.
 *
 * The current provider adapter intentionally stays simple: it sends a
 * normal chat/completions request and returns raw model text. This
 * decorator adds the missing tool loop without depending on provider-
 * specific function-calling APIs. Any agent whose `allowedTools` includes
 * `web_search` may return one of these shapes as its whole response:
 *
 *   { "tool_call": { "tool": "web_search", "query": "...", "limit": 5 } }
 *   { "type": "tool_call", "tool": "web_search", "query": "..." }
 *
 * The decorator executes the DuckDuckGo-backed `WebSearchTool`, appends a
 * synthetic tool-result message to the model context, and calls the inner
 * adapter again. The caller receives only the final model response.
 */

import type { AgentMessage } from "@ai-agent-orchestrator/validation";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

import type { ModelAdapter, ModelInvokeOptions } from "./types.js";
import type { SearchResult, WebSearchTool } from "../search/index.js";

export interface ToolCallingModelAdapterClock {
  nowIso(): string;
}

export interface ToolCallingModelAdapterOptions {
  readonly inner: ModelAdapter;
  readonly webSearch: WebSearchTool;
  readonly clock?: ToolCallingModelAdapterClock;
  /** Maximum number of tool-call rounds before returning a structured error. */
  readonly maxToolRounds?: number;
  /** Default search limit used when the model omits `limit`. */
  readonly defaultSearchLimit?: number;
}

const DEFAULT_MAX_TOOL_ROUNDS = 2;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

const systemClock: ToolCallingModelAdapterClock = {
  nowIso: () => new Date().toISOString(),
};

const WEB_SEARCH_PROTOCOL_PROMPT = [
  "",
  "Runtime tool available: web_search.",
  "When you need current web context, reply with ONLY one compact JSON object:",
  '{ "tool_call": { "tool": "web_search", "query": "search query", "limit": 5 } }',
  "After the tool result is provided, answer the user's task normally.",
  "Do not invent search results. Use this tool only when fresh or external information matters.",
].join("\n");

export class ToolCallingModelAdapter implements ModelAdapter {
  private readonly inner: ModelAdapter;
  private readonly webSearch: WebSearchTool;
  private readonly clock: ToolCallingModelAdapterClock;
  private readonly maxToolRounds: number;
  private readonly defaultSearchLimit: number;

  public constructor(options: ToolCallingModelAdapterOptions) {
    this.inner = options.inner;
    this.webSearch = options.webSearch;
    this.clock = options.clock ?? systemClock;
    this.maxToolRounds = clampInteger(options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS, 0, 5);
    this.defaultSearchLimit = clampInteger(
      options.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    );
  }

  public async invoke(
    modelRef: ModelRef,
    messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }> {
    if (!options.allowedTools.includes("web_search")) {
      return this.inner.invoke(modelRef, messages, options);
    }

    const toolAwareOptions: ModelInvokeOptions = {
      ...options,
      systemPrompt: appendToolProtocol(options.systemPrompt),
    };

    let context: readonly AgentMessage[] = messages;
    let result = await this.inner.invoke(modelRef, context, toolAwareOptions);

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const request = parseWebSearchRequest(result.raw, this.defaultSearchLimit);
      if (request === null) {
        return result;
      }

      const searchResult = await this.webSearch.search(request.query, {
        limit: request.limit,
      });

      context = [
        ...context,
        buildAssistantToolCallMessage(context, result.raw, this.clock.nowIso()),
        buildToolResultMessage(context, request, searchResult, this.clock.nowIso()),
      ];

      result = await this.inner.invoke(modelRef, context, toolAwareOptions);
    }

    return {
      raw: {
        type: "error",
        providerCode: "tool_loop_limit",
        providerMessage: `web_search tool loop exceeded ${String(this.maxToolRounds)} rounds`,
      },
    };
  }
}

interface WebSearchRequest {
  readonly query: string;
  readonly limit: number;
}

function appendToolProtocol(systemPrompt: string): string {
  if (systemPrompt.includes("Runtime tool available: web_search")) {
    return systemPrompt;
  }
  return `${systemPrompt}\n${WEB_SEARCH_PROTOCOL_PROMPT}`;
}

function parseWebSearchRequest(raw: unknown, defaultLimit: number): WebSearchRequest | null {
  const value = unwrapRawTextOrJson(raw);
  if (value === null) return null;

  const obj = isRecord(value) ? value : parseToolJsonFromText(value);
  if (obj === null) return null;

  const call = isRecord(obj.tool_call) ? obj.tool_call : obj;
  const tool = stringValue(call.tool);
  const type = stringValue(call.type);
  if (tool !== "web_search" && type !== "web_search") {
    return null;
  }

  const query = stringValue(call.query).trim();
  if (query.length === 0) return null;

  const rawLimit = numberValue(call.limit);
  const limit = clampInteger(rawLimit ?? defaultLimit, 1, MAX_SEARCH_LIMIT);
  return { query, limit };
}

function unwrapRawTextOrJson(raw: unknown): unknown {
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return raw;
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.content === "string") return raw.content;
  if (typeof raw.raw === "string") return raw.raw;
  return raw;
}

function parseToolJsonFromText(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const trimmed = stripJsonFence(value.trim());
  const parsed = tryParseJsonObject(trimmed);
  if (parsed !== null) return parsed;

  const tag = trimmed.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (tag?.[1] !== undefined) {
    return tryParseJsonObject(stripJsonFence(tag[1].trim()));
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseJsonObject(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function stripJsonFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence?.[1]?.trim() ?? text;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildAssistantToolCallMessage(
  context: readonly AgentMessage[],
  raw: unknown,
  timestamp: string,
): AgentMessage {
  return {
    taskId: inferTaskId(context),
    sender: inferAgentId(context),
    recipient: "orchestrator",
    type: "request",
    payload: { kind: "text", text: rawToText(raw) },
    timestamp,
  };
}

function buildToolResultMessage(
  context: readonly AgentMessage[],
  request: WebSearchRequest,
  result: SearchResult,
  timestamp: string,
): AgentMessage {
  return {
    taskId: inferTaskId(context),
    sender: "orchestrator",
    recipient: inferAgentId(context),
    type: "response",
    payload: {
      kind: "text",
      text: formatWebSearchResult(request, result),
    },
    timestamp,
  };
}

function formatWebSearchResult(request: WebSearchRequest, result: SearchResult): string {
  if (result.kind === "error") {
    return [
      `DuckDuckGo web search failed for: ${request.query}`,
      `Reason: ${result.reason}`,
      "Continue with best effort and clearly mark any uncertainty.",
    ].join("\n");
  }

  if (result.results.length === 0) {
    return [
      `DuckDuckGo web search returned zero results for: ${request.query}`,
      "Continue with best effort and clearly mark any uncertainty.",
    ].join("\n");
  }

  const lines = [`DuckDuckGo web search results for: ${request.query}`];
  result.results.slice(0, request.limit).forEach((hit, index) => {
    lines.push(`${String(index + 1)}. ${hit.title}\nURL: ${hit.url}\nSnippet: ${hit.snippet}`);
  });
  lines.push("Use these results as external context. Cite URLs when relevant.");
  return lines.join("\n\n");
}

function inferTaskId(context: readonly AgentMessage[]): string {
  return context[0]?.taskId ?? "tool-call-context";
}

function inferAgentId(context: readonly AgentMessage[]): string {
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const msg = context[i];
    if (msg === undefined) continue;
    if (msg.sender !== "orchestrator") return msg.sender;
    if (msg.recipient !== "orchestrator") return msg.recipient;
  }
  return "agent";
}

function rawToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isRecord(raw)) {
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const int = Math.floor(value);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
