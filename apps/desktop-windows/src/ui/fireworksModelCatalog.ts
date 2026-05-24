/**
 * Fireworks-AI model catalog — fetches `<baseUrl>/models` through the
 * Tauri shell so the WebView's CORS / CSP rules cannot block the call.
 *
 * Used by the Models screen of the KARO workbench. Produces a plain
 * list of model ids the user can pick without typing them by hand.
 *
 * The API key is decrypted locally and forwarded to the shell, NEVER
 * to the renderer's `fetch`. Logs / UI never display the key.
 *
 * Validates: Requirements 1.6, 5.1, 5.2.
 */

import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  joinProviderPath,
  type ProviderId,
  type ProviderPreset,
} from "@ai-agent-orchestrator/shared-core";

import type { DesktopShell } from "../shell/types.js";

import { API_KEY_SECRET_PREFIX, type ApiKeyMetadata } from "./desktopApiKeySink.js";

export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly displayName: string;
}

export type ModelCatalogResult =
  | { readonly kind: "ok"; readonly models: readonly ModelCatalogEntry[] }
  | {
      readonly kind: "error";
      readonly providerCode: string;
      readonly providerMessage: string;
    };

export interface FetchModelsOptions {
  readonly desktopShell: DesktopShell;
  readonly metadata: ApiKeyMetadata;
  readonly timeoutMs?: number;
  readonly presets?: readonly ProviderPreset[];
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchProviderModels(
  options: FetchModelsOptions,
): Promise<ModelCatalogResult> {
  const presets = options.presets ?? PROVIDER_PRESETS;
  const provider: ProviderId = options.metadata.provider;
  const preset = presets.find((p) => p.id === provider);
  if (preset === undefined) {
    return {
      kind: "error",
      providerCode: "unsupported_provider",
      providerMessage: `Provider "${provider}" is not configured.`,
    };
  }
  if (preset.apiShape !== "openai-compatible") {
    return {
      kind: "error",
      providerCode: "wrong_api_shape",
      providerMessage:
        "Only OpenAI-compatible providers expose a /models endpoint here. Use Fireworks AI or a custom OpenAI gateway.",
    };
  }

  const baseUrl =
    options.metadata.baseUrl ??
    (preset.id === CUSTOM_PROVIDER_ID ? "" : preset.baseUrl);
  if (baseUrl.length === 0) {
    return {
      kind: "error",
      providerCode: "missing_base_url",
      providerMessage: "No base URL configured for this provider.",
    };
  }

  // Decrypt the saved key. NEVER cache or re-emit the plaintext.
  let apiKey: string;
  try {
    const blob = await options.desktopShell.readLocalSetting<{
      algorithm: string;
      ciphertext: string;
      createdAt: string;
    }>(`${API_KEY_SECRET_PREFIX}${provider}`);
    if (blob === null || typeof blob.ciphertext !== "string") {
      return {
        kind: "error",
        providerCode: "no_api_key",
        providerMessage: "No API key stored for this provider.",
      };
    }
    apiKey = await options.desktopShell.decryptLocalSecret(blob);
  } catch (err) {
    return {
      kind: "error",
      providerCode: "decrypt_failed",
      providerMessage: `Could not decrypt the saved API key: ${describeError(err)}`,
    };
  }
  if (apiKey.length === 0) {
    return {
      kind: "error",
      providerCode: "no_api_key",
      providerMessage: "Decrypted API key is empty.",
    };
  }

  const url = joinProviderPath(baseUrl, preset.listModelsPath);
  const headers: Record<string, string> =
    preset.authStyle === "x-api-key"
      ? { "x-api-key": apiKey, Accept: "application/json" }
      : { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  let response;
  try {
    response = await options.desktopShell.probeProvider({
      url,
      method: "GET",
      headers,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      kind: "error",
      providerCode: "provider_unreachable",
      providerMessage: `Could not reach ${provider}: ${describeError(err)}`,
    };
  }

  if (!response.ok) {
    return {
      kind: "error",
      providerCode: `http_${String(response.status)}`,
      providerMessage:
        response.body.length > 0
          ? response.body.slice(0, 256)
          : `Provider returned HTTP ${String(response.status)}`,
    };
  }
  const parsed = tryParseJson(response.body);
  const models = extractModels(parsed);
  return { kind: "ok", models };
}

function extractModels(parsed: unknown): readonly ModelCatalogEntry[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: ModelCatalogEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    if (id === null) continue;
    const displayName =
      typeof obj.display_name === "string" && obj.display_name.length > 0
        ? obj.display_name
        : id;
    out.push({ modelId: id, displayName });
  }
  // Stable sort by display name so the dropdown doesn't reorder
  // between refreshes when the provider returns the same set.
  out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
  );
  return out;
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
