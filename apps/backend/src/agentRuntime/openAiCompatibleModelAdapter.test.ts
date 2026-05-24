/**
 * `OpenAiCompatibleModelAdapter` tests.
 *
 * Pins the contract every Builtin_Agent (Researcher / Coder / Reviewer
 * / Fixer / Boss) ends up using when the user picked Fireworks AI or
 * any other OpenAI-compatible preset:
 *
 *   • Fireworks chat call hits
 *     `https://api.fireworks.ai/inference/v1/chat/completions` with
 *     `Authorization: Bearer <key>` and the right body.
 *   • Custom preset uses the resolved baseUrl rather than the
 *     preset's hard-coded one.
 *   • Anthropic preset is rejected (separate adapter required).
 *   • Resolver returning `null` produces a structured `no_api_key`
 *     raw payload — the agent runtime normalises it into a
 *     `type: "error"` Agent_Message rather than throwing.
 *
 * Validates: Requirements 7.1, 10.6, 10.8, 10.9.
 */

import { describe, expect, it } from "vitest";

import type {
  ModelRef,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";

import {
  OpenAiCompatibleModelAdapter,
  type ChatHttpClient,
  type ProviderBaseUrlResolver,
  type ProviderKeyResolver,
} from "./openAiCompatibleModelAdapter.js";
import type {
  ModelInvokeOptions,
  SecretRef,
} from "./types.js";

const SCOPE: Scope = { kind: "local", deviceId: "device-test" };
const SECRET: SecretRef = {
  provider: "fireworks",
  scope: SCOPE,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

class StubHttp implements ChatHttpClient {
  public readonly calls: Array<{
    url: string;
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }> = [];
  private nextResponse: {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  } = {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "hello from fireworks" } },
          ],
        }),
      ),
  };

  public setNextResponse(r: {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }): void {
    this.nextResponse = r;
  }

  public send(input: {
    url: string;
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }> {
    this.calls.push({
      url: input.url,
      method: input.method,
      headers: { ...input.headers },
      body: input.body,
    });
    return Promise.resolve(this.nextResponse);
  }
}

class StubKeyResolver implements ProviderKeyResolver {
  public constructor(private readonly key: string | null) {}
  public resolveApiKey(): Promise<string | null> {
    return Promise.resolve(this.key);
  }
}

class StubBaseUrlResolver implements ProviderBaseUrlResolver {
  public constructor(private readonly baseUrl: string | null) {}
  public resolveBaseUrl(): Promise<string | null> {
    return Promise.resolve(this.baseUrl);
  }
}

const HISTORY: readonly AgentMessage[] = [
  {
    taskId: "task-1",
    sender: "orchestrator",
    recipient: "agent-researcher",
    type: "handoff",
    payload: { kind: "text", text: "hello" },
    timestamp: "2025-01-01T00:00:00.000Z",
  },
];

const OPTIONS: ModelInvokeOptions = {
  systemPrompt: "You are a helpful assistant.",
  apiKey: SECRET,
  allowedTools: ["web_search"],
};

const FIREWORKS_REF: ModelRef = {
  provider: "fireworks",
  modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  source: "user-api-key",
};

describe("OpenAiCompatibleModelAdapter", () => {
  it("Fireworks chat-completions call hits the correct URL with Bearer auth", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("fw-key-test"),
    });

    const result = await adapter.invoke(FIREWORKS_REF, HISTORY, OPTIONS);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe(
      "https://api.fireworks.ai/inference/v1/chat/completions",
    );
    expect(http.calls[0]?.headers["Authorization"]).toBe("Bearer fw-key-test");
    // The body must include the user's chosen modelId verbatim.
    const body = JSON.parse(http.calls[0]?.body ?? "{}") as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(
      "accounts/fireworks/models/llama-v3p1-8b-instruct",
    );
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toBe("You are a helpful assistant.");
    // Successful response is unwrapped to a `{ type: "response", text }` shape.
    expect(result.raw).toEqual({
      type: "response",
      text: "hello from fireworks",
    });
  });

  it("OpenAI uses the same Bearer style at api.openai.com", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("sk-openai-test"),
    });
    const ref: ModelRef = {
      provider: "openai",
      modelId: "gpt-4o-mini",
      source: "user-api-key",
    };
    await adapter.invoke(ref, HISTORY, {
      ...OPTIONS,
      apiKey: { ...SECRET, provider: "openai" },
    });
    expect(http.calls[0]?.url).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(http.calls[0]?.headers["Authorization"]).toBe(
      "Bearer sk-openai-test",
    );
  });

  it("Anthropic preset is rejected — separate adapter required", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("anth-key"),
    });
    const ref: ModelRef = {
      provider: "anthropic",
      modelId: "claude-3-5-haiku-latest",
      source: "user-api-key",
    };
    const result = await adapter.invoke(ref, HISTORY, {
      ...OPTIONS,
      apiKey: { ...SECRET, provider: "anthropic" },
    });
    // Adapter returns a structured raw error rather than throwing —
    // the agent runtime normalises this into a `type: "error"`
    // Agent_Message (Requirement 10.9).
    expect(http.calls).toHaveLength(0);
    expect(result.raw).toEqual({
      type: "error",
      providerCode: "wrong_api_shape",
      providerMessage: expect.stringContaining("openai-compatible") as string,
    });
  });

  it("Custom preset uses the resolved baseUrl from the resolver", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("custom-key"),
      baseUrlResolver: new StubBaseUrlResolver(
        "https://my-gateway.example.com/v1",
      ),
    });
    const ref: ModelRef = {
      provider: "custom-openai",
      modelId: "my-llm",
      source: "user-api-key",
    };
    await adapter.invoke(ref, HISTORY, {
      ...OPTIONS,
      apiKey: { ...SECRET, provider: "custom-openai" },
    });
    expect(http.calls[0]?.url).toBe(
      "https://my-gateway.example.com/v1/chat/completions",
    );
  });

  it("Custom preset rejects when no baseUrl resolver is configured", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("custom-key"),
    });
    const ref: ModelRef = {
      provider: "custom-openai",
      modelId: "my-llm",
      source: "user-api-key",
    };
    const result = await adapter.invoke(ref, HISTORY, {
      ...OPTIONS,
      apiKey: { ...SECRET, provider: "custom-openai" },
    });
    expect(http.calls).toHaveLength(0);
    expect(result.raw).toEqual({
      type: "error",
      providerCode: "missing_base_url",
      providerMessage: expect.stringContaining("base URL") as string,
    });
  });

  it("translates a missing API key into a structured raw error (no throw)", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver(null),
    });
    const result = await adapter.invoke(FIREWORKS_REF, HISTORY, OPTIONS);
    expect(http.calls).toHaveLength(0);
    expect(result.raw).toEqual({
      type: "error",
      providerCode: "no_api_key",
      providerMessage: expect.stringContaining("fireworks") as string,
    });
  });

  it("translates HTTP 401 into a structured raw error", async () => {
    const http = new StubHttp();
    http.setNextResponse({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"code":"unauthorized"}}'),
    });
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("fw-bad"),
    });
    const result = await adapter.invoke(FIREWORKS_REF, HISTORY, OPTIONS);
    expect(result.raw).toMatchObject({
      type: "error",
      providerCode: "http_401",
    });
  });

  it("never echoes the API key into the body or headers it would persist", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("sk-LEAK_GUARD"),
    });
    await adapter.invoke(FIREWORKS_REF, HISTORY, OPTIONS);
    // Body should contain `model` + `messages` only — never the key.
    expect(http.calls[0]?.body).not.toContain("sk-LEAK_GUARD");
    // Header carries the key — that's expected, but only under the
    // Authorization header (not in any custom one that might be logged).
    expect(http.calls[0]?.headers["Authorization"]).toBe("Bearer sk-LEAK_GUARD");
  });
});

// ---------------------------------------------------------------------
// Per-builtin-agent reachability — the contract that ALL five agents
// can be wired against this single adapter without provider-specific
// branches in their own code.
// ---------------------------------------------------------------------

describe("agent runtime can route every Builtin_Agent through OpenAiCompatibleModelAdapter", () => {
  it("returns a usable raw response for an arbitrary builtin role", async () => {
    const http = new StubHttp();
    const adapter = new OpenAiCompatibleModelAdapter({
      http,
      keyResolver: new StubKeyResolver("fw-key"),
    });
    const roles = ["researcher", "coder", "reviewer", "fixer", "boss"] as const;
    for (const role of roles) {
      const ref: ModelRef = {
        provider: "fireworks",
        modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
        source: "user-api-key",
      };
      const result = await adapter.invoke(ref, HISTORY, {
        ...OPTIONS,
        systemPrompt: `You are the ${role}.`,
      });
      expect(result.raw).toEqual({
        type: "response",
        text: "hello from fireworks",
      });
    }
    // 5 calls — one per role — all to the same Fireworks endpoint.
    expect(http.calls).toHaveLength(5);
    for (const c of http.calls) {
      expect(c.url).toBe(
        "https://api.fireworks.ai/inference/v1/chat/completions",
      );
    }
  });
});

// Helper: silence the `_provider` lint complaint when narrowing tests.
export type _Unused = ProviderId;
