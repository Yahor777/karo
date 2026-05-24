/**
 * Renderer-side `LoginGateway` implementation for the desktop and web
 * shells.
 *
 * Background — why this lives in `client-sdk` rather than in
 * `apps/desktop-windows`:
 *
 *   • The same code path is needed by the web shell (task 18.2) and
 *     by the desktop shell (task 4.3 / 17.4). Centralising it keeps a
 *     single, reviewable transport implementation.
 *   • The shell-specific persistence concern (Local Encrypted Storage
 *     on desktop, an HTTP backend call on web) is injected through
 *     {@link LocalApiKeySink}, so the gateway itself is portable.
 *
 * Transport — IMPORTANT:
 *
 *   The gateway's `http` port is intentionally injectable. The default
 *   {@link fetchProbeClient} uses `globalThis.fetch` and is suitable
 *   for the web shell, where the browser handles CORS naturally.
 *   The desktop shell MUST NOT use the default — the Tauri WebView
 *   blocks outbound HTTPS to provider domains via CSP and CORS — and
 *   instead injects a transport that round-trips through the
 *   `shell_provider_probe` Tauri command. See
 *   `apps/desktop-windows/src/ui/desktopShellProbeClient.ts`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 4.5.
 */

import {
  PROVIDER_PRESETS,
  findProviderPreset,
  joinProviderPath,
  type ProviderApiShape,
  type ProviderAuthStyle,
  type ProviderId,
  type ProviderPreset,
  type Session,
} from "@ai-agent-orchestrator/shared-core";

/**
 * Shape of the probe response the gateway interprets. Any subset of
 * `Response` is sufficient — the gateway only ever calls `text()` on
 * the body, never `json()`, so a malformed body cannot throw inside
 * the HTTP layer.
 */
export interface ProbeHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * Narrow port the gateway uses to make HTTP calls. Defaults to
 * `globalThis.fetch`. Tests inject a stub.
 */
export interface ProbeHttpClient {
  send(input: {
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }): Promise<ProbeHttpResponse>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const fetchProbeClient: ProbeHttpClient = {
  async send(input) {
    const init: RequestInit = {
      method: input.method,
      headers: { ...input.headers },
    };
    if (input.body !== undefined) {
      init.body = input.body;
    }
    if (input.signal) {
      init.signal = input.signal;
    }
    const response = await fetch(input.url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
    };
  },
};

/**
 * Result of a successful save. Never carries the plaintext key —
 * exactly the same invariant the backend's `Session` enforces.
 */
export type LocalApiKeySinkResult = {
  readonly session: Session;
  /**
   * Stable fingerprint of the persisted key (first 4 + last 4 of a
   * SHA-256 hex digest, for example). The renderer surfaces this in
   * the settings screen so users can recognise which key was stored
   * without ever seeing the plaintext again.
   */
  readonly fingerprint: string;
};

/**
 * Persistence port the gateway uses to save the validated key. The
 * shell wires this to the Local Encrypted Storage primitives (desktop)
 * or to an HTTP `POST /sessions` endpoint (web).
 *
 * Implementations MUST encrypt the key before persisting and MUST NOT
 * return the plaintext or the encrypted blob. `fingerprint` is the
 * only post-save trace the gateway promises to surface.
 */
export interface LocalApiKeySink {
  saveLocalSession(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly modelId?: string;
    readonly confirmedByUser: true;
  }): Promise<LocalApiKeySinkResult>;
}

/**
 * Constructor options for {@link RendererLoginGateway}.
 */
export interface RendererLoginGatewayOptions {
  /** Persistence sink. Required. */
  readonly sink: LocalApiKeySink;
  /** HTTP client. Defaults to global `fetch`. */
  readonly http?: ProbeHttpClient;
  /** Per-probe timeout in ms. Defaults to 10 s. */
  readonly timeoutMs?: number;
  /**
   * Optional custom presets. Defaults to the canonical
   * {@link PROVIDER_PRESETS} list. Tests use this to register an
   * in-memory provider so they can exercise the probe pipeline
   * without depending on the real preset table.
   */
  readonly presets?: readonly ProviderPreset[];
}

/**
 * Public surface — the LoginScreen controller calls
 * `validateApiKey` / `createLocalSession` on this object.
 */
export class RendererLoginGateway {
  private readonly sink: LocalApiKeySink;
  private readonly http: ProbeHttpClient;
  private readonly timeoutMs: number;
  private readonly presets: readonly ProviderPreset[];

  public constructor(options: RendererLoginGatewayOptions) {
    this.sink = options.sink;
    this.http = options.http ?? fetchProbeClient;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.presets = options.presets ?? PROVIDER_PRESETS;
  }

  public async validateApiKey(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly modelId?: string;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly kind: "ok"; readonly modelsCount?: number }
    | {
        readonly kind: "error";
        readonly providerCode: string;
        readonly providerMessage: string;
      }
  > {
    if (input.apiKey.trim().length === 0) {
      return {
        kind: "error",
        providerCode: "invalid_api_key",
        providerMessage: "API key is empty",
      };
    }
    const preset = this.findPreset(input.provider);
    if (preset === undefined) {
      return {
        kind: "error",
        providerCode: "unsupported_provider",
        providerMessage: `No provider preset is configured for "${input.provider}"`,
      };
    }
    const baseUrl = input.baseUrl ?? preset.baseUrl;
    if (baseUrl.trim().length === 0) {
      return {
        kind: "error",
        providerCode: "missing_base_url",
        providerMessage:
          "This provider requires a base URL — paste your gateway endpoint and try again.",
      };
    }
    if (preset.requiresUserModelId && (input.modelId ?? "").trim().length === 0) {
      return {
        kind: "error",
        providerCode: "missing_model_id",
        providerMessage:
          "This provider requires a model id — paste it into the form and try again.",
      };
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let unlinkCallerSignal: (() => void) | null = null;
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        input.signal.addEventListener("abort", onAbort, { once: true });
        unlinkCallerSignal = () =>
          input.signal?.removeEventListener("abort", onAbort);
      }
    }

    try {
      const probeResult = await this.runProbe(preset, baseUrl, input.apiKey, controller.signal);
      return probeResult;
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        return {
          kind: "error",
          providerCode: "request_timeout",
          providerMessage: `Request to ${input.provider} timed out after ${String(this.timeoutMs)}ms`,
        };
      }
      return {
        kind: "error",
        providerCode: "provider_unreachable",
        providerMessage: `Could not reach ${input.provider}: ${describeError(err)}`,
      };
    } finally {
      clearTimeout(timeoutHandle);
      unlinkCallerSignal?.();
    }
  }

  public async createLocalSession(input: {
    readonly provider: ProviderId;
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly modelId?: string;
    readonly confirmedByUser: true;
  }): Promise<Session> {
    if (input.confirmedByUser !== true) {
      throw Object.assign(
        new Error("createLocalSession requires confirmedByUser === true."),
        { code: "missing_confirmation" },
      );
    }
    const preset = this.findPreset(input.provider);
    const baseUrl = input.baseUrl ?? preset?.baseUrl ?? "";
    const result = await this.sink.saveLocalSession({
      provider: input.provider,
      apiKey: input.apiKey,
      ...(baseUrl.length > 0 ? { baseUrl } : {}),
      ...(input.modelId !== undefined && input.modelId.length > 0
        ? { modelId: input.modelId }
        : {}),
      confirmedByUser: true,
    });
    return result.session;
  }

  // -----------------------------------------------------------------------

  private findPreset(id: ProviderId): ProviderPreset | undefined {
    return this.presets.find((p) => p.id === id) ?? findProviderPreset(id);
  }

  private async runProbe(
    preset: ProviderPreset,
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<
    | { kind: "ok"; modelsCount?: number }
    | { kind: "error"; providerCode: string; providerMessage: string }
  > {
    const url = joinProviderPath(baseUrl, preset.listModelsPath);
    const headers = buildAuthHeaders(preset.authStyle, apiKey);
    headers["Accept"] = "application/json";

    const method = preset.apiShape === "openai-compatible" ? "GET" : "POST";
    const body =
      preset.apiShape === "anthropic"
        ? JSON.stringify({
            model: preset.defaultModelId ?? "claude-3-5-haiku-latest",
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          })
        : undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["anthropic-version"] = "2023-06-01";
    }

    const response = await this.http.send({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      return mapErrorBody(response.status, text, preset.apiShape);
    }
    if (preset.apiShape === "anthropic") {
      // No model count from a 1-token completion.
      return { kind: "ok" };
    }
    const text = await safeReadText(response);
    const modelsCount = countOpenAiModels(text);
    return modelsCount === undefined
      ? { kind: "ok" }
      : { kind: "ok", modelsCount };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildAuthHeaders(
  style: ProviderAuthStyle,
  apiKey: string,
): Record<string, string> {
  if (style === "x-api-key") {
    return { "x-api-key": apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function mapErrorBody(
  status: number,
  body: string,
  _shape: ProviderApiShape,
):
  | { kind: "ok"; modelsCount?: number }
  | { kind: "error"; providerCode: string; providerMessage: string } {
  const parsed = tryParseJson(body);
  if (parsed && typeof parsed === "object") {
    const errorField = (parsed as { error?: unknown }).error;
    if (errorField && typeof errorField === "object") {
      const e = errorField as Record<string, unknown>;
      const code = stringOr(e["code"], stringOr(e["type"], `http_${String(status)}`));
      const message = stringOr(e["message"], defaultMessageForStatus(status));
      return { kind: "error", providerCode: code, providerMessage: message };
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
    providerCode: `http_${String(status)}`,
    providerMessage: defaultMessageForStatus(status),
  };
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) return "Provider rejected the API key as unauthenticated";
  if (status === 403) return "Provider rejected the API key as forbidden";
  if (status === 429) return "Provider rate limit reached during validation";
  if (status >= 500) return `Provider returned a server error (HTTP ${String(status)})`;
  return `Provider returned HTTP ${String(status)}`;
}

function countOpenAiModels(body: string): number | undefined {
  const parsed = tryParseJson(body);
  if (!parsed || typeof parsed !== "object") return undefined;
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : undefined;
}

async function safeReadText(response: ProbeHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message =
      err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
    return message.length > 0 ? message : err.name;
  }
  if (typeof err === "string") return err;
  return "unknown error";
}

/**
 * Minimal stable fingerprint helper. Returns the first 4 + last 4
 * characters of the API key separated by `…`, e.g. `"sk-a…wxyz"`. The
 * full key never leaves this function. Suitable as a "did I save the
 * right key?" check in the settings UI.
 */
export function fingerprintApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return "•".repeat(Math.max(apiKey.length, 1));
  }
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}
