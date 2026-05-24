/**
 * Renderer-side OpenAI-compatible chat client.
 *
 * Routes every request through `desktopShell.probeProvider` so the
 * Tauri WebView's CORS / CSP rules cannot block outbound HTTPS to
 * provider domains — the same mechanism the login validation flow
 * already uses for the `/models` probe.
 *
 * Mirrors the request shape used by
 * `apps/backend/src/agentRuntime/openAiCompatibleModelAdapter.ts`:
 * a `POST <baseUrl>/chat/completions` with the OpenAI message-array
 * body. The renderer-local agents call this directly because they
 * live in the same address space — there is no need to plumb the
 * full backend `ModelAdapter` port through the transport surface.
 *
 * Validates: Requirements 1.6 (key never reaches renderer logs),
 * 7.1 (the agents reach the model), 10.9 (errors surface as
 * structured payloads, not thrown exceptions).
 */

import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  joinProviderPath,
  type ProviderId,
  type ProviderPreset,
} from "@ai-agent-orchestrator/shared-core";

import type { DesktopShell } from "../shell/types.js";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatModelClientOptions {
  readonly desktopShell: DesktopShell;
  /**
   * Per-call timeout, forwarded to the Tauri probe so the Rust side
   * can abort the underlying request if the provider hangs. Defaults
   * to 60 s (matches the agents' soft budget from Requirement 7.2).
   */
  readonly timeoutMs?: number;
  /** Optional preset table override, primarily for tests. */
  readonly presets?: readonly ProviderPreset[];
  /** Retry delay source; tests override this to avoid waiting. */
  readonly retryDelayMs?: () => number;
  /** Sleep primitive; tests override this to keep retry tests instant. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ChatRequest {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export type ChatResponse =
  | { readonly kind: "ok"; readonly text: string }
  | {
      readonly kind: "error";
      readonly providerCode: string;
      readonly providerMessage: string;
      readonly retryCount?: number;
      readonly status?: number;
      readonly bodyPreview?: string;
    };

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MIN_MS = 1_500;
const RETRY_DELAY_MAX_MS = 3_000;
const PROVIDER_BODY_PREVIEW_CHARS = 500;

export class ChatModelClient {
  private readonly desktopShell: DesktopShell;
  private readonly timeoutMs: number;
  private readonly presets: readonly ProviderPreset[];
  private readonly retryDelayMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: ChatModelClientOptions) {
    this.desktopShell = options.desktopShell;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.presets = options.presets ?? PROVIDER_PRESETS;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.sleep = options.sleep ?? defaultSleep;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const preset = this.presets.find((p) => p.id === request.provider);
    if (preset === undefined) {
      return {
        kind: "error",
        providerCode: "unsupported_provider",
        providerMessage: `No preset for "${request.provider}".`,
      };
    }
    if (preset.apiShape !== "openai-compatible") {
      return {
        kind: "error",
        providerCode: "wrong_api_shape",
        providerMessage:
          "This MVP only supports OpenAI-compatible providers. Anthropic adapter is not wired yet.",
      };
    }
    const baseUrl =
      request.baseUrl ??
      (preset.id === CUSTOM_PROVIDER_ID ? "" : preset.baseUrl);
    if (baseUrl.length === 0) {
      return {
        kind: "error",
        providerCode: "missing_base_url",
        providerMessage: `Provider "${request.provider}" has no base URL configured.`,
      };
    }
    if (request.apiKey.length === 0) {
      return {
        kind: "error",
        providerCode: "no_api_key",
        providerMessage: "API key is empty.",
      };
    }

    const url = joinProviderPath(baseUrl, preset.chatCompletionsPath);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (preset.authStyle === "x-api-key") {
      headers["x-api-key"] = request.apiKey;
    } else {
      headers.Authorization = `Bearer ${request.apiKey}`;
    }
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const probeRequest = {
      url,
      method: "POST" as const,
      headers,
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    };

    let response;
    let retryCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.desktopShell.probeProvider(probeRequest);
      } catch (err) {
        const mapped = mapThrownProviderError(
          err,
          request.provider,
          this.timeoutMs,
          request.apiKey,
        );
        if (attempt === 0 && isRetryableProviderError(mapped)) {
          retryCount = 1;
          await this.sleep(this.retryDelayMs());
          continue;
        }
        return retryCount > 0 ? { ...mapped, retryCount } : mapped;
      }

      const mapped = response.ok
        ? null
        : mapHttpProviderError(response.status, response.body, request.apiKey);
      if (mapped === null) break;
      if (attempt === 0 && isRetryableProviderError(mapped)) {
        retryCount = 1;
        await this.sleep(this.retryDelayMs());
        continue;
      }
      return retryCount > 0 ? { ...mapped, retryCount } : mapped;
    }

    if (response === undefined) {
      return {
        kind: "error",
        providerCode: "provider_unreachable",
        providerMessage: `Could not reach ${request.provider}: request did not complete`,
        retryCount,
      };
    }

    const parsed = tryParseJson(response.body);
    if (parsed === null) {
      return {
        kind: "error",
        providerCode: "invalid_response",
        providerMessage: "Provider returned a non-JSON body for chat/completions.",
      };
    }
    const text = extractAssistantText(parsed);
    if (text === null) {
      return {
        kind: "error",
        providerCode: "invalid_response",
        providerMessage:
          "Provider response did not include choices[0].message.content.",
      };
    }
    return { kind: "ok", text };
  }
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function mapHttpProviderError(
  status: number,
  body: string,
  apiKey: string,
): Extract<ChatResponse, { kind: "error" }> {
  const bodyPreview = redactLikelySecrets(
    body.slice(0, PROVIDER_BODY_PREVIEW_CHARS),
    [apiKey],
  );
  const parsed = tryParseJson(body);
  const errField =
    parsed && typeof parsed === "object"
      ? (parsed as { error?: unknown }).error
      : null;
  let providerDetail = "";
  if (errField && typeof errField === "object") {
    const e = errField as Record<string, unknown>;
    providerDetail = stringOr(e.message, stringOr(e.code, stringOr(e.type, "")));
  } else if (bodyPreview.length > 0) {
    providerDetail = bodyPreview;
  }

  const providerCode = codeForHttpStatus(status, errField);
  const base = defaultMessageForStatus(status);
  const providerMessage = providerDetail.length > 0 ? `${base}: ${providerDetail}` : base;
  return {
    kind: "error",
    providerCode,
    providerMessage,
    status,
    ...(bodyPreview.length > 0 ? { bodyPreview } : {}),
  };
}

function codeForHttpStatus(status: number, errField: unknown): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "model_not_found";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return `provider_http_error:${String(status)}`;
  if (errField && typeof errField === "object") {
    const e = errField as Record<string, unknown>;
    const nativeCode = stringOr(e.code, stringOr(e.type, ""));
    if (nativeCode === "model_not_found" || nativeCode === "not_found") {
      return "model_not_found";
    }
  }
  return `provider_http_error:${String(status)}`;
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) return "Authentication error from provider (HTTP 401)";
  if (status === 403) return "Provider rejected the request as forbidden (HTTP 403)";
  if (status === 404) return "Model not found or chat endpoint missing (HTTP 404)";
  if (status === 429) return "Provider rate limit reached (HTTP 429)";
  if (status >= 500) return `Provider server error (HTTP ${String(status)})`;
  return `Provider HTTP error (${String(status)})`;
}

function mapThrownProviderError(
  err: unknown,
  provider: ProviderId,
  timeoutMs: number,
  apiKey: string,
): Extract<ChatResponse, { kind: "error" }> {
  const raw = errorCode(err);
  const message = redactLikelySecrets(describeError(err), [apiKey]);
  const isTimeout = raw === "request_timeout" || raw === "provider_timeout" || isAbortLike(err);
  if (isTimeout) {
    return {
      kind: "error",
      providerCode: "provider_timeout",
      providerMessage: `Request to ${provider} timed out after ${String(timeoutMs)}ms: ${message}`,
    };
  }
  return {
    kind: "error",
    providerCode: "provider_unreachable",
    providerMessage: `Could not reach ${provider}: ${message}`,
  };
}

function isRetryableProviderError(error: Extract<ChatResponse, { kind: "error" }>): boolean {
  if (
    error.providerCode === "provider_unreachable" ||
    error.providerCode === "provider_timeout" ||
    error.providerCode === "provider_rate_limited"
  ) {
    return true;
  }
  return typeof error.status === "number" && error.status >= 500;
}

function errorCode(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function redactLikelySecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/fw-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
}

function defaultRetryDelayMs(): number {
  return Math.floor(
    RETRY_DELAY_MIN_MS + Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS),
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return msg.length > 0 ? msg : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}
