/**
 * Provider presets — single source of truth for provider metadata
 * shared by the login screen, the model selection screen, the model
 * catalog adapters, and the agent runtime model adapter.
 *
 * Source:
 *   • design.md → "Provider and Model" — providers and their auth
 *     conventions.
 *   • requirements.md → Requirement 2.1 (entry-point UI), Requirement
 *     5.x (model catalog).
 *
 * Why this lives in `shared-core`:
 *
 *   • Both the renderer (`shared-ui` login + model screens) and the
 *     backend (`auth/providerProbe.ts`, `models/catalog.ts`, agent
 *     runtime model adapter) need the same per-provider URL + auth
 *     header convention. Centralising the presets here means a
 *     misconfiguration in one place cannot drift from another.
 *   • The list is intentionally small and explicit. Adding a new
 *     "well-known" provider is a one-line append; users with a
 *     self-hosted gateway pick the {@link CUSTOM_PROVIDER_ID} preset
 *     and supply their own `baseUrl`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 4.2, 5.1.
 */

import type { ProviderId } from "./types/provider.js";

/**
 * Identifier for the user-supplied "Custom OpenAI-compatible" preset.
 * Distinct from a real provider id so adapters can branch on it
 * without parsing display names.
 */
export const CUSTOM_PROVIDER_ID = "custom-openai" as const;

/**
 * Authentication style a provider expects.
 *
 *   • `"bearer"`   — `Authorization: Bearer <key>`. Used by OpenAI,
 *     Fireworks, OpenRouter and the vast majority of OpenAI-compatible
 *     gateways.
 *   • `"x-api-key"` — `x-api-key: <key>`. Used by Anthropic.
 */
export type ProviderAuthStyle = "bearer" | "x-api-key";

/**
 * API "shape" the backend / agent runtime should use to talk to this
 * provider.
 *
 *   • `"openai-compatible"` — `POST <baseUrl>/chat/completions` with
 *     the OpenAI message-array body. Validation probes hit
 *     `<baseUrl>/models` (GET).
 *   • `"anthropic"`         — `POST <baseUrl>/messages` with the
 *     Anthropic body shape. No equivalent free model-list endpoint;
 *     validation issues a 1-token completion.
 */
export type ProviderApiShape = "openai-compatible" | "anthropic";

/**
 * Static description of a provider. Carries everything a probe or a
 * model adapter needs to talk to the provider: base URL, the relative
 * paths for "list models" and "chat completions", the auth header
 * style, an optional default model id (used as a placeholder, NEVER
 * forced — the user always picks).
 */
export interface ProviderPreset {
  /** Stable id used as `ModelRef.provider` and `ApiKey.provider`. */
  readonly id: ProviderId;
  /** Human-readable name surfaced in the UI dropdown. */
  readonly displayName: string;
  /** Base URL of the API root (no trailing slash). */
  readonly baseUrl: string;
  /** API shape the agent runtime should use. */
  readonly apiShape: ProviderApiShape;
  /** Authentication header style. */
  readonly authStyle: ProviderAuthStyle;
  /** Path appended to `baseUrl` for the validation/list-models call. */
  readonly listModelsPath: string;
  /** Path appended to `baseUrl` for chat completion calls. */
  readonly chatCompletionsPath: string;
  /**
   * Suggested default model id. Used only as a placeholder/example;
   * the login flow does NOT pin the user to this model. `null` for
   * presets where there is no widely-used default (e.g. Custom).
   */
  readonly defaultModelId: string | null;
  /**
   * `true` when the user must explicitly supply a `baseUrl` (custom
   * gateways) or override the model id at login time. The UI surfaces
   * extra fields when this is set.
   */
  readonly requiresUserBaseUrl: boolean;
  /**
   * `true` when the user must supply a model id (because the listing
   * endpoint cannot be relied upon to return a curated default). For
   * Fireworks AI the model catalog returns hundreds of models, so we
   * ask the user to pick one upfront. For OpenAI the listing is
   * curated enough to skip this prompt.
   */
  readonly requiresUserModelId: boolean;
}

/**
 * Presets for the well-known providers we ship out of the box.
 *
 * Order matters — this is the order the UI dropdown renders.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiShape: "openai-compatible",
    authStyle: "bearer",
    listModelsPath: "/models",
    chatCompletionsPath: "/chat/completions",
    defaultModelId: "gpt-4o-mini",
    requiresUserBaseUrl: false,
    requiresUserModelId: false,
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiShape: "anthropic",
    authStyle: "x-api-key",
    // Anthropic has no free list-models endpoint. The probe uses a
    // 1-token POST against /messages instead — see `AnthropicProbe`.
    listModelsPath: "/messages",
    chatCompletionsPath: "/messages",
    defaultModelId: "claude-3-5-haiku-latest",
    requiresUserBaseUrl: false,
    requiresUserModelId: false,
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiShape: "openai-compatible",
    authStyle: "bearer",
    listModelsPath: "/models",
    chatCompletionsPath: "/chat/completions",
    // Fireworks hosts hundreds of community models; pinning a default
    // would mislead users. Pick a small/cheap one as a starter
    // placeholder, but require the user to confirm or change it.
    defaultModelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    requiresUserBaseUrl: false,
    requiresUserModelId: true,
  },
  {
    id: CUSTOM_PROVIDER_ID,
    displayName: "Custom OpenAI-compatible",
    baseUrl: "",
    apiShape: "openai-compatible",
    authStyle: "bearer",
    listModelsPath: "/models",
    chatCompletionsPath: "/chat/completions",
    defaultModelId: null,
    requiresUserBaseUrl: true,
    requiresUserModelId: true,
  },
] as const;

/** O(1) lookup helper. Returns `undefined` for unknown ids. */
export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Resolves the effective baseUrl for a `(providerId, userOverride)`
 * pair. When the preset is a Custom one, the user override is
 * required; otherwise the override (when present) replaces the
 * default for that one session — useful for staging gateways that
 * front the same provider.
 *
 * Returns `null` when a baseUrl is required but missing — callers
 * surface this as a structured "missing_base_url" validation error.
 */
export function resolveBaseUrl(
  presetId: string,
  userOverride: string | null,
): string | null {
  const preset = findProviderPreset(presetId);
  if (preset === undefined) return userOverride ?? null;
  const trimmed = (userOverride ?? "").trim();
  if (preset.requiresUserBaseUrl) {
    return trimmed.length > 0 ? trimNoTrailingSlash(trimmed) : null;
  }
  return trimmed.length > 0
    ? trimNoTrailingSlash(trimmed)
    : preset.baseUrl;
}

/**
 * Compose the full URL for a given provider + relative path.
 *
 *   • Strips a trailing `/` on the base.
 *   • Ensures the relative path begins with a single `/`.
 *
 * Pure — useful from probes, adapters, and validators alike.
 */
export function joinProviderPath(baseUrl: string, path: string): string {
  const base = trimNoTrailingSlash(baseUrl);
  const rel = path.startsWith("/") ? path : `/${path}`;
  return `${base}${rel}`;
}

function trimNoTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
