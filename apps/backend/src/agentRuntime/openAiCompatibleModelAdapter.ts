/**
 * `OpenAiCompatibleModelAdapter` — a single `ModelAdapter` that the
 * agent runtime can use for any provider speaking the OpenAI
 * `chat/completions` API shape (OpenAI itself, Fireworks AI, OpenRouter,
 * a self-hosted Custom OpenAI-compatible gateway, …).
 *
 * Why one adapter for many providers:
 *
 *   • The agent runtime already treats `ModelAdapter` as a single port
 *     — it does not care which provider is behind it. Replicating the
 *     same HTTP plumbing per provider would be pure duplication.
 *   • Per-call routing is driven entirely by the provided
 *     {@link ProviderPreset} + the user's optional `baseUrl` override
 *     persisted alongside the API key. Both come from
 *     `shared-core/providerPresets.ts`, the single source of truth.
 *
 * What this adapter does NOT cover:
 *
 *   • Anthropic — Anthropic uses a different request shape (`/messages`
 *     with `max_tokens` + `system` outside the message array). A
 *     dedicated `AnthropicModelAdapter` would mirror this file with the
 *     Anthropic shape; it is not part of this change.
 *
 * Validates: Requirements 7.1, 10.6, 10.7, 10.8, 10.9.
 */

import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  joinProviderPath,
  type ProviderId,
  type ProviderPreset,
  type Scope,
} from "@ai-agent-orchestrator/shared-core";
import type { AgentMessage } from "@ai-agent-orchestrator/validation";

import type {
  ModelAdapter,
  ModelInvokeOptions,
  SecretRef,
} from "./types.js";
import type { ModelRef } from "@ai-agent-orchestrator/shared-core";

// ---------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------

/**
 * Resolves a decrypted API-key plaintext for a `(scope, provider)`
 * pair. Wired in production to `SettingsStore.resolveApiKeySecret`
 * (server-side, gated by a `ServerComponentToken`). Tests pass a stub.
 */
export interface ProviderKeyResolver {
  resolveApiKey(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<string | null>;
}

/**
 * Resolves the effective baseUrl for a `(scope, provider)` pair. The
 * default implementation falls back to the preset's hard-coded
 * baseUrl; production composition wires this to the Settings_Store
 * `apiKeyMeta` lookup so a user's custom baseUrl (e.g. for a Custom
 * preset) survives across runs.
 */
export interface ProviderBaseUrlResolver {
  resolveBaseUrl(input: {
    readonly scope: Scope;
    readonly provider: ProviderId;
  }): Promise<string | null>;
}

/**
 * Narrow HTTP port mirrored from `auth/providerProbe.ts`.
 *
 * Defined locally so the agent runtime has no dependency on the auth
 * module; tests inject a stub.
 */
export interface ChatHttpClient {
  send(input: {
    readonly url: string;
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    text(): Promise<string>;
  }>;
}

const fetchChatHttpClient: ChatHttpClient = {
  async send(input) {
    const init: RequestInit = {
      method: input.method,
      headers: { ...input.headers },
      body: input.body,
    };
    if (input.signal) init.signal = input.signal;
    const response = await fetch(input.url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
    };
  },
};

// ---------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------

export interface OpenAiCompatibleModelAdapterOptions {
  /** Pluggable HTTP client. Defaults to global `fetch`. */
  readonly http?: ChatHttpClient;
  /** Decrypted-API-key resolver. */
  readonly keyResolver: ProviderKeyResolver;
  /**
   * Optional baseUrl resolver. When omitted, the adapter falls back to
   * the preset's hard-coded `baseUrl` for well-known presets (OpenAI,
   * Fireworks). The Custom preset always requires an explicit resolver
   * because there is no sensible default.
   */
  readonly baseUrlResolver?: ProviderBaseUrlResolver;
  /**
   * Optional override for the preset table. Tests pass a deterministic
   * preset list. Production omits this and the adapter uses
   * {@link PROVIDER_PRESETS}.
   */
  readonly presets?: readonly ProviderPreset[];
  /** Optional default per-call timeout. Defaults to 60s. */
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Implements the {@link ModelAdapter} port for every OpenAI-compatible
 * provider in the registry.
 *
 * Per the `ModelAdapter` contract, normal-failure paths (HTTP non-2xx,
 * timeout, malformed body, missing key) return a structured raw object
 * the runner can normalise into a `type: "error"` Agent_Message;
 * thrown exceptions are reserved for genuinely unexpected failures.
 */
export class OpenAiCompatibleModelAdapter implements ModelAdapter {
  private readonly http: ChatHttpClient;
  private readonly keyResolver: ProviderKeyResolver;
  private readonly baseUrlResolver: ProviderBaseUrlResolver | undefined;
  private readonly presets: readonly ProviderPreset[];
  private readonly defaultTimeoutMs: number;

  public constructor(options: OpenAiCompatibleModelAdapterOptions) {
    this.http = options.http ?? fetchChatHttpClient;
    this.keyResolver = options.keyResolver;
    this.baseUrlResolver = options.baseUrlResolver;
    this.presets = options.presets ?? PROVIDER_PRESETS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async invoke(
    modelRef: ModelRef,
    messages: readonly AgentMessage[],
    options: ModelInvokeOptions,
  ): Promise<{ raw: unknown }> {
    const preset = this.presets.find((p) => p.id === modelRef.provider);
    if (preset === undefined) {
      return errorRaw(
        "unsupported_provider",
        `No OpenAI-compatible preset is configured for "${modelRef.provider}".`,
      );
    }
    if (preset.apiShape !== "openai-compatible") {
      return errorRaw(
        "wrong_api_shape",
        `Provider "${modelRef.provider}" expects shape "${preset.apiShape}"; this adapter only handles "openai-compatible". Wire a dedicated adapter.`,
      );
    }

    const baseUrl = await this.resolveBaseUrl(options.apiKey, preset);
    if (baseUrl === null || baseUrl.length === 0) {
      return errorRaw(
        "missing_base_url",
        `Provider "${modelRef.provider}" has no base URL configured. Save a key with a base URL in the Login screen first.`,
      );
    }

    let apiKey: string | null;
    try {
      apiKey = await this.keyResolver.resolveApiKey({
        scope: options.apiKey.scope,
        provider: modelRef.provider,
      });
    } catch (err) {
      return errorRaw(
        "key_resolution_failed",
        `Could not resolve API key for "${modelRef.provider}": ${describeError(err)}`,
      );
    }
    if (apiKey === null || apiKey.length === 0) {
      return errorRaw(
        "no_api_key",
        `No API key is configured for provider "${modelRef.provider}".`,
      );
    }

    const url = joinProviderPath(baseUrl, preset.chatCompletionsPath);
    const body = JSON.stringify(buildChatCompletionsBody(modelRef, messages, options));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (preset.authStyle === "x-api-key") {
      headers["x-api-key"] = apiKey;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.http.send({
        url,
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        return {
          raw: {
            type: "error",
            providerCode: `http_${String(response.status)}`,
            providerMessage: text.length > 0 ? text : `HTTP ${String(response.status)}`,
            provider: modelRef.provider,
          },
        };
      }
      const parsed = tryParseJson(text);
      if (parsed === null) {
        return errorRaw(
          "invalid_response",
          `Provider returned a non-JSON body for chat/completions.`,
        );
      }
      // Surface the raw provider response. The runner normalises this
      // into an Agent_Message via `normalizeAgentMessage`. We extract
      // `choices[0].message.content` as a convenience to keep the
      // payload small; if the field is absent we forward the whole
      // response object so the normaliser sees the original shape.
      const content = extractAssistantText(parsed);
      if (content !== null) {
        return { raw: { type: "response", text: content } };
      }
      return { raw: parsed };
    } catch (err) {
      if (controller.signal.aborted) {
        return errorRaw(
          "request_timeout",
          `Provider "${modelRef.provider}" timed out after ${String(timeoutMs)}ms`,
        );
      }
      return errorRaw(
        "provider_unreachable",
        `Could not reach "${modelRef.provider}": ${describeError(err)}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async resolveBaseUrl(
    secretRef: SecretRef,
    preset: ProviderPreset,
  ): Promise<string | null> {
    if (this.baseUrlResolver !== undefined) {
      const resolved = await this.baseUrlResolver.resolveBaseUrl({
        scope: secretRef.scope,
        provider: preset.id,
      });
      if (resolved !== null && resolved.length > 0) {
        return resolved;
      }
    }
    if (preset.id === CUSTOM_PROVIDER_ID) {
      // Custom provider with no resolver and no override → genuine
      // configuration error. Surface as `null` so the caller emits
      // `missing_base_url`.
      return null;
    }
    return preset.baseUrl;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildChatCompletionsBody(
  modelRef: ModelRef,
  messages: readonly AgentMessage[],
  options: ModelInvokeOptions,
): unknown {
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  out.push({ role: "system", content: options.systemPrompt });
  for (const m of messages) {
    out.push({
      role: m.sender === "orchestrator" ? "user" : "assistant",
      content: agentMessageToText(m),
    });
  }
  return {
    model: modelRef.modelId,
    messages: out,
  };
}

function agentMessageToText(m: AgentMessage): string {
  if (m.payload.kind === "text") return m.payload.text;
  if (m.payload.kind === "json") return JSON.stringify(m.payload.value);
  if (m.payload.kind === "binary") {
    return `[binary payload, ${String(m.payload.bytes.byteLength)} bytes]`;
  }
  return "";
}

function extractAssistantText(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (first === null || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return null;
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorRaw(code: string, message: string): { raw: unknown } {
  return { raw: { type: "error", providerCode: code, providerMessage: message } };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return msg.length > 0 ? msg : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}
