/**
 * Settings-related port shapes for shared-ui screens (task 6.4).
 *
 * `shared-ui` cannot import directly from `apps/backend/...` — that would
 * couple the UI package to backend internals and to its build graph. The
 * controllers under `screens/settings/` therefore depend on the *shapes*
 * defined here. Composition adapters in the renderer (and in tests) wire
 * concrete backend services into objects matching these interfaces.
 *
 * The shapes mirror, verbatim, the public contracts already documented in:
 *
 *   • design.md → "Settings Store" (ApiKeyMetadata, Scope, ProviderId).
 *   • design.md → "Auth Service" (ValidationResult).
 *   • design.md → "Data Models" → "Agent" (CustomAgent, CustomAgentInput).
 *
 * This file deliberately only re-states the public contract. It does NOT
 * pull from `@ai-agent-orchestrator/validation` (which is a runtime Zod
 * schema package); shared-ui consumers only need static types, and lifting
 * the runtime dependency keeps the bundle smaller.
 */

import type { Scope, ProviderId, ToolId, ModelRef } from "@ai-agent-orchestrator/shared-core";

export type { Scope, ProviderId, ToolId, ModelRef } from "@ai-agent-orchestrator/shared-core";

/**
 * Public, UI-safe view of a stored API key.
 *
 * Mirrors `apps/backend/src/settings/types.ts` → `ApiKeyMetadata`. MUST NOT
 * grow fields that could carry the plaintext or the encrypted blob —
 * Property 9 / Requirement 3.7. Listed here so shared-ui doesn't import
 * the backend type.
 */
export interface ApiKeyMetadata {
  readonly provider: ProviderId;
  /** SHA-256 of the plaintext, truncated to the first 12 hex chars. */
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly lastValidatedAt: string;
}

/**
 * Outcome of `AuthService.validateApiKey`. Mirrors
 * `apps/backend/src/auth/types.ts → ValidationResult` and design.md →
 * "Auth Service" verbatim. `kind: "error"` carries the Provider's verbatim
 * code/message so the UI can surface the cause (Requirements 2.3, 4.3).
 */
export type ValidationResult =
  | { readonly kind: "ok"; readonly modelsCount?: number }
  | {
      readonly kind: "error";
      readonly providerCode: string;
      readonly providerMessage: string;
    };

/**
 * Custom_Agent input shape — fields the user supplies on the editor form.
 * Mirrors `packages/validation/src/custom-agent.ts → CustomAgentInput`. We
 * re-state it here to avoid importing the Zod schema package at the
 * shared-ui layer; the renderer adapter that talks to the backend is
 * expected to validate via Zod before forwarding.
 */
export interface CustomAgentInputShape {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: ModelRef;
  readonly allowedTools: readonly ToolId[];
}

/**
 * Persisted Custom_Agent record. Mirrors
 * `packages/validation/src/custom-agent.ts → CustomAgent` and design.md →
 * "Data Models" → "Agent" → CustomAgent. `ownerScope` is included so the
 * editor can guard against showing records that belong to a different
 * scope when the screen is reused after a session change.
 */
export interface CustomAgentShape {
  readonly id: string;
  readonly kind: "custom";
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: ModelRef;
  readonly allowedTools: readonly ToolId[];
  readonly ownerScope: Scope;
}

/**
 * Sentinel error contract for Custom_Agent name conflicts.
 *
 * The backend throws a class-based `CustomAgentNameConflictError`
 * (`apps/backend/src/settings/customAgents.ts`). Renderer adapters either
 * forward that instance directly (in-process composition) or reconstruct an
 * object that satisfies this shape (over an IPC boundary where class
 * identity doesn't survive). The controller checks for the structural
 * shape, so both wirings work.
 */
export interface CustomAgentNameConflict {
  readonly name: "CustomAgentNameConflictError";
  readonly conflictWith: "builtin" | "custom";
  readonly message: string;
}

/**
 * Type guard for the structural conflict-error shape. Used by the custom
 * agents controller to render the appropriate message variant
 * (Requirement 12.3 — "conflicts with builtin" vs "conflicts with another
 * custom agent").
 */
export function isCustomAgentNameConflict(
  err: unknown,
): err is CustomAgentNameConflict {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; conflictWith?: unknown };
  if (e.name !== "CustomAgentNameConflictError") return false;
  return e.conflictWith === "builtin" || e.conflictWith === "custom";
}
