/**
 * Provider probe adapters for the backend Auth Service.
 *
 * Source:
 *   • design.md → "Auth Service" → `validateApiKey`.
 *   • requirements.md → Requirements 2.2, 2.3, 4.2, 4.3.
 *
 * One adapter per Provider performs a single, lightweight authenticated
 * request and translates the response into a {@link ValidationResult}.
 *
 * Design rules (apply to every adapter here):
 *
 *   • Adapters MUST NOT throw on any expected failure (network, HTTP
 *     non-2xx, malformed body, timeout, unauthenticated). Every such
 *     case is translated into `kind: "error"` with a Provider-derived
 *     `providerCode`/`providerMessage`. This keeps `AuthService` linear
 *     and makes Requirement 2.3 trivial to honor.
 *   • Adapters MUST treat `apiKey` as a short-lived secret. The key is
 *     used only to populate the request `Authorization`/`x-api-key`
 *     header and is never logged, stored or echoed into the returned
 *     `providerMessage`.
 *   • Adapters time out independently via `AbortController` rather than
 *     trusting the caller's signal alone, so Requirement 2.2 ("validate
 *     before creating session") has a bounded latency even if the caller
 *     forgot to set a timeout.
 *   • The HTTP layer is injected through {@link HttpFetcher}, never
 *     `globalThis.fetch` directly, so tests can stub responses without
 *     touching the network.
 *
 * Validates: Requirements 2.2, 2.3, 4.2, 4.3.
 */

import {
  joinProviderPath,
  type ProviderId,
  type ProviderPreset,
} from "@ai-agent-orchestrator/shared-core";

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  type HttpFetcher,
  type HttpRequest,
  type HttpResponse,
  type ProviderProbe,
  type ValidationResult,
} from "./types.js";

/**
 * Default {@link HttpFetcher} backed by `globalThis.fetch`. Available on
 * Node ≥ 20 (the engines field requires `>=18.18.0`, and all production
 * runtimes ship with `fetch`). Same shape as `search/httpClient.ts`'s
 * `fetchHttpClient`, deliberately duplicated so the auth module has no
 * cross-module dependency on the search module.
 */
export const fetchHttpFetcher: HttpFetcher = {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const init: RequestInit = { method: request.method };
    if (request.headers) {
      init.headers = { ...request.headers };
    }
    if (request.body !== undefined) {
      init.body = request.body;
    }
    if (request.signal) {
      init.signal = request.signal;
    }
    const response = await fetch(request.url, init);
    return {
      status: response.status,
      ok: response.ok,
      text: () => response.text(),
    };
  },
};

/**
 * Common options accepted by every adapter in this file.
 */
export interface ProviderProbeOptions {
  /** HTTP transport. Defaults to {@link fetchHttpFetcher}. */
  readonly httpFetcher?: HttpFetcher;
  /** Per-probe timeout in ms. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/models";
const DEFAULT_ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * Options for {@link OpenAiProbe}. `endpoint` is overridable for tests
 * and for self-hosted OpenAI-compatible deployments.
 */
export interface OpenAiProbeOptions extends ProviderProbeOptions {
  readonly endpoint?: string;
}

/**
 * OpenAI probe.
 *
 * Strategy: `GET /v1/models` with `Authorization: Bearer <key>`. This
 * endpoint authenticates against the user's key, returns 401 on a bad
 * key with a structured error body, and is cheap enough to qualify as
 * a "lightweight test request" per Requirement 2.2. On success the
 * probe also reports the model count so the UI can show "Found N
 * models" feedback (the optional `modelsCount` field in
 * {@link ValidationResult}).
 *
 * OpenAI error body shape:
 *
 * ```json
 * {
 *   "error": {
 *     "message": "Incorrect API key provided: sk-***",
 *     "type": "invalid_request_error",
 *     "code": "invalid_api_key"
 *   }
 * }
 * ```
 */
export class OpenAiProbe implements ProviderProbe {
  public readonly provider: ProviderId = "openai";
  private readonly endpoint: string;
  private readonly httpFetcher: HttpFetcher;
  private readonly timeoutMs: number;

  public constructor(options: OpenAiProbeOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_OPENAI_ENDPOINT;
    this.httpFetcher = options.httpFetcher ?? fetchHttpFetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  public async probe(input: {
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult> {
    return runProbe({
      timeoutMs: this.timeoutMs,
      callerSignal: input.signal,
      provider: this.provider,
      send: (signal) =>
        this.httpFetcher.send({
          url: this.endpoint,
          method: "GET",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            Accept: "application/json",
          },
          signal,
        }),
      onSuccess: async (response) => {
        const text = await safeReadText(response);
        const modelsCount = countOpenAiModels(text);
        if (modelsCount === undefined) {
          return { kind: "ok" };
        }
        return { kind: "ok", modelsCount };
      },
    });
  }
}

/**
 * Options for {@link AnthropicProbe}. `endpoint` and `anthropicVersion`
 * are overridable for tests and for future API version pinning.
 */
export interface AnthropicProbeOptions extends ProviderProbeOptions {
  readonly endpoint?: string;
  readonly anthropicVersion?: string;
}

/**
 * Anthropic probe.
 *
 * Anthropic does not expose a free "list models" or "ping" endpoint that
 * authenticates a key without billing. The cheapest authenticated call
 * is a 1-token completion against a small model (`claude-3-5-haiku`),
 * which still validates the key without producing meaningful billing.
 *
 * Strategy: `POST /v1/messages` with `x-api-key`, `anthropic-version`,
 * and a 1-token request. We treat any 2xx as `kind: "ok"` (no
 * `modelsCount` because we didn't list models). 401/403 with an error
 * body becomes `kind: "error"` carrying Anthropic's native error type
 * and message.
 *
 * Anthropic error body shape:
 *
 * ```json
 * { "type": "error", "error": { "type": "authentication_error", "message": "..." } }
 * ```
 */
export class AnthropicProbe implements ProviderProbe {
  public readonly provider: ProviderId = "anthropic";
  private readonly endpoint: string;
  private readonly anthropicVersion: string;
  private readonly httpFetcher: HttpFetcher;
  private readonly timeoutMs: number;

  public constructor(options: AnthropicProbeOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ANTHROPIC_ENDPOINT;
    this.anthropicVersion =
      options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.httpFetcher = options.httpFetcher ?? fetchHttpFetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  public probe(input: {
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult> {
    const body = JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });

    return runProbe({
      timeoutMs: this.timeoutMs,
      callerSignal: input.signal,
      provider: this.provider,
      send: (signal) =>
        this.httpFetcher.send({
          url: this.endpoint,
          method: "POST",
          headers: {
            "x-api-key": input.apiKey,
            "anthropic-version": this.anthropicVersion,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal,
        }),
      onSuccess: () => Promise.resolve({ kind: "ok" }),
    });
  }
}

/**
 * Options for {@link GenericProbe}. The generic adapter is used for any
 * Provider that follows the bearer-token + JSON-models-endpoint
 * convention (most OpenAI-compatible self-hosts, some open-source LLM
 * gateways). Callers pick the `provider` ID and the endpoint URL.
 */
export interface GenericProbeOptions extends ProviderProbeOptions {
  readonly provider: ProviderId;
  readonly endpoint: string;
  /**
   * Header used to carry the API key. Defaults to `"Authorization"`
   * with a `Bearer` prefix. Set `headerName` to switch to a custom
   * header (e.g. `"x-api-key"`); when a custom header is used the value
   * is the raw key with no prefix.
   */
  readonly headerName?: string;
  /**
   * HTTP method. Defaults to `"GET"`; some gateways expose only `POST`.
   */
  readonly method?: "GET" | "POST";
  /** Optional request body (only used when `method` is `"POST"`). */
  readonly body?: string;
}

/**
 * Builds a {@link GenericProbe} from a {@link ProviderPreset} from
 * `shared-core/providerPresets.ts`. The preset carries the auth style
 * + path conventions so the auth service can support a new provider
 * with one line of composition.
 *
 * Validates: Requirements 2.2, 2.3, 4.2, 4.3, 5.1.
 */
export function createOpenAiCompatibleProbe(input: {
  readonly preset: ProviderPreset;
  readonly httpFetcher?: HttpFetcher;
  readonly timeoutMs?: number;
  /** Optional override for the base URL (Custom presets, staging gateways). */
  readonly baseUrl?: string;
}): GenericProbe {
  const baseUrl = input.baseUrl ?? input.preset.baseUrl;
  const headerName = input.preset.authStyle === "x-api-key" ? "x-api-key" : "Authorization";
  return new GenericProbe({
    provider: input.preset.id,
    endpoint: joinProviderPath(baseUrl, input.preset.listModelsPath),
    headerName,
    method: "GET",
    ...(input.httpFetcher !== undefined ? { httpFetcher: input.httpFetcher } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
}

/**
 * Generic Provider probe.
 *
 * Sufficient for any OpenAI-compatible deployment that exposes a
 * lightweight authenticated endpoint. Behaves like {@link OpenAiProbe}
 * but with caller-supplied `provider`, endpoint and header style.
 */
export class GenericProbe implements ProviderProbe {
  public readonly provider: ProviderId;
  private readonly endpoint: string;
  private readonly headerName: string;
  private readonly method: "GET" | "POST";
  private readonly body: string | undefined;
  private readonly httpFetcher: HttpFetcher;
  private readonly timeoutMs: number;

  public constructor(options: GenericProbeOptions) {
    this.provider = options.provider;
    this.endpoint = options.endpoint;
    this.headerName = options.headerName ?? "Authorization";
    this.method = options.method ?? "GET";
    this.body = options.body;
    this.httpFetcher = options.httpFetcher ?? fetchHttpFetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  public async probe(input: {
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.headerName.toLowerCase() === "authorization") {
      headers["Authorization"] = `Bearer ${input.apiKey}`;
    } else {
      headers[this.headerName] = input.apiKey;
    }
    if (this.method === "POST" && this.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    return runProbe({
      timeoutMs: this.timeoutMs,
      callerSignal: input.signal,
      provider: this.provider,
      send: (signal) => {
        const req: HttpRequest = {
          url: this.endpoint,
          method: this.method,
          headers,
          signal,
        };
        if (this.method === "POST" && this.body !== undefined) {
          return this.httpFetcher.send({ ...req, body: this.body });
        }
        return this.httpFetcher.send(req);
      },
      onSuccess: async (response) => {
        const text = await safeReadText(response);
        const modelsCount = countOpenAiModels(text);
        if (modelsCount === undefined) {
          return { kind: "ok" };
        }
        return { kind: "ok", modelsCount };
      },
    });
  }
}

/**
 * Shared probe-execution scaffolding.
 *
 * Handles, in this order:
 *   1. Composing a per-probe timeout signal (linked to the caller's
 *      signal when present so external cancellation also works).
 *   2. Catching transport errors and translating them into a
 *      `kind: "error"` result with `provider_unreachable` /
 *      `request_timeout` codes.
 *   3. Reading the body for non-2xx responses and translating any
 *      Provider-native `code` and `message` into a structured result
 *      (Requirement 2.3, 4.3 — surface Provider's reason).
 *   4. Delegating successful responses to the caller's `onSuccess`
 *      transform, again wrapping any thrown error.
 */
async function runProbe(args: {
  readonly timeoutMs: number;
  readonly callerSignal: AbortSignal | undefined;
  readonly provider: ProviderId;
  readonly send: (signal: AbortSignal) => Promise<HttpResponse>;
  readonly onSuccess: (response: HttpResponse) => Promise<ValidationResult>;
}): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, args.timeoutMs);

  // Forward caller cancellation into our controller so the underlying
  // fetch is actually aborted, not just our timer.
  let unlinkCallerSignal: (() => void) | null = null;
  if (args.callerSignal) {
    if (args.callerSignal.aborted) {
      controller.abort();
    } else {
      const onAbort = (): void => {
        controller.abort();
      };
      args.callerSignal.addEventListener("abort", onAbort, { once: true });
      unlinkCallerSignal = () =>
        args.callerSignal?.removeEventListener("abort", onAbort);
    }
  }

  let response: HttpResponse;
  try {
    response = await args.send(controller.signal);
  } catch (err: unknown) {
    if (isAbortError(err) || controller.signal.aborted) {
      return {
        kind: "error",
        providerCode: "request_timeout",
        providerMessage: `Request to ${args.provider} timed out after ${String(args.timeoutMs)}ms`,
      };
    }
    return {
      kind: "error",
      providerCode: "provider_unreachable",
      providerMessage: `Could not reach ${args.provider}: ${describeError(err)}`,
    };
  } finally {
    clearTimeout(timeoutHandle);
    unlinkCallerSignal?.();
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    return mapErrorBody(response.status, text);
  }

  try {
    return await args.onSuccess(response);
  } catch (err: unknown) {
    return {
      kind: "error",
      providerCode: "invalid_response",
      providerMessage: `Could not interpret ${args.provider} response: ${describeError(err)}`,
    };
  }
}

/**
 * Translates a non-2xx Provider response body into a structured
 * `kind: "error"` result. Recognises both the OpenAI shape
 * (`{ error: { code, message, type } }`) and the Anthropic shape
 * (`{ error: { type, message } }` or `{ type: "error", error: { ... } }`).
 *
 * When the body is not JSON or carries no recognisable error fields,
 * falls back to a stable HTTP-status-derived code (`http_<status>`) and
 * a generic message. Status 401/403 produce `authentication_error` so
 * UI can show a "key invalid" message without parsing the body.
 */
function mapErrorBody(status: number, body: string): ValidationResult {
  const parsed = tryParseJson(body);

  if (parsed && typeof parsed === "object") {
    const errorField = (parsed as { error?: unknown }).error;
    if (errorField && typeof errorField === "object") {
      const e = errorField as Record<string, unknown>;
      const code = stringOr(e["code"], stringOr(e["type"], `http_${status}`));
      const message = stringOr(
        e["message"],
        defaultMessageForStatus(status),
      );
      return {
        kind: "error",
        providerCode: code,
        providerMessage: message,
      };
    }
  }

  if (status === 401 || status === 403) {
    return {
      kind: "error",
      providerCode: "authentication_error",
      providerMessage: defaultMessageForStatus(status),
    };
  }
  return {
    kind: "error",
    providerCode: `http_${status}`,
    providerMessage: defaultMessageForStatus(status),
  };
}

/**
 * Counts entries in OpenAI's `{ data: [...] }` models response. Returns
 * `undefined` when the body is not JSON or lacks a `data` array, in
 * which case the caller falls back to a `kind: "ok"` without
 * `modelsCount`.
 */
function countOpenAiModels(body: string): number | undefined {
  const parsed = tryParseJson(body);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const data = (parsed as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.length;
  }
  return undefined;
}

async function safeReadText(response: HttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) {
    return "Provider rejected the API key as unauthenticated";
  }
  if (status === 403) {
    return "Provider rejected the API key as forbidden";
  }
  if (status === 429) {
    return "Provider rate limit reached during validation";
  }
  if (status >= 500) {
    return `Provider returned a server error (HTTP ${String(status)})`;
  }
  return `Provider returned HTTP ${String(status)}`;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return message.length > 0 ? message : err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}
