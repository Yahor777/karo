/**
 * Auth-related port shapes for shared-ui screens (task 17.4).
 *
 * `shared-ui` cannot import directly from `apps/backend/...` — the screens
 * here therefore depend on the *shapes* defined in this file. Composition
 * adapters in the renderer (and the unit tests) wire the concrete backend
 * services into objects matching these interfaces.
 *
 * The shapes mirror, verbatim, the public contracts already documented in:
 *
 *   • design.md → "Auth Service" →
 *       `beginGoogleOAuth`, `completeGoogleOAuth`,
 *       `upgradeLocalSessionToGoogle`, `MergeReport` (Settings Store);
 *   • apps/backend/src/auth/upgradeLocalSession.ts →
 *       the granular `MergeReport` shape used by the orchestration
 *       function (task 17.3): per-collection sections for `apiKeys`,
 *       `customAgents` (with conflict reasons), and `preferences`;
 *   • requirements.md → Requirements 2.7, 2.8, 3.1, 3.5, 3.6.
 *
 * This file intentionally does NOT re-export the runtime
 * `@ai-agent-orchestrator/validation` package — shared-ui consumers
 * only need static shapes; the renderer adapter that talks to the
 * backend is expected to validate over the wire on its side.
 *
 * Validates: Requirements 2.7, 2.8, 3.1, 3.5, 3.6.
 */

import type {
  AgentId,
  ProviderId,
  Session,
} from "@ai-agent-orchestrator/shared-core";

export type { AgentId, ProviderId, Session };

/**
 * Per-collection merge result returned by `upgradeLocalSessionToGoogle`
 * (task 17.3). Mirrors `apps/backend/src/auth/upgradeLocalSession.ts →
 * MergeReport` exactly so the UI can render every field without an
 * extra mapping step.
 */
export interface UpgradeMergeReport {
  readonly apiKeys: {
    /** Providers whose local key was copied to the (previously empty) cloud slot. */
    readonly copiedToCloud: readonly ProviderId[];
    /** Providers where the cloud already had a key — cloud wins, local is dropped. */
    readonly cloudWonOver: readonly ProviderId[];
    /** Providers preserved as local-only (under "cloud wins" identical to `cloudWonOver`). */
    readonly preservedLocalOnly: readonly ProviderId[];
  };
  readonly customAgents: {
    /** Local agent ids that landed in the cloud scope under the same name. */
    readonly copiedToCloud: readonly AgentId[];
    /** Local agents whose name collided with a builtin or with a cloud agent. */
    readonly conflicts: readonly {
      readonly agentId: AgentId;
      readonly reason: "builtin_name" | "cloud_agent_with_same_name";
    }[];
  };
  readonly preferences: {
    /** Preference keys that did not exist in cloud and were copied verbatim. */
    readonly copiedToCloud: readonly string[];
    /** Preference keys where cloud already had a value — cloud wins. */
    readonly cloudWon: readonly string[];
  };
}

/**
 * Reason codes the OAuth completion can report when it fails with a
 * recoverable failure. The Gmail login screen handles
 * `settings_load_failed` specially per Requirement 3.5 ("предложить
 * пользователю повторить попытку позднее").
 *
 * Other codes flow through the generic "error" branch and the message
 * is surfaced verbatim (the backend's `GoogleOAuthError.code` already
 * conforms to this shape — see
 * `apps/backend/src/auth/googleOAuth.ts → GoogleOAuthErrorCode`).
 */
export type CompleteGoogleOAuthErrorCode =
  | "settings_load_failed"
  | "invalid_state"
  | "expired_state"
  | "state_replayed"
  | "code_exchange_failed"
  | "userinfo_failed"
  | "provider_unreachable"
  | (string & {});

/**
 * Structural shape the Gmail login controller looks for when the
 * gateway rejects. Matches `Error.name === "GoogleOAuthError"` /
 * `error.code` from the backend so adapters can either forward the
 * native error or reconstruct a plain object with the same fields.
 */
export interface CompleteGoogleOAuthErrorLike {
  readonly name?: string;
  readonly code?: CompleteGoogleOAuthErrorCode;
  readonly message: string;
}

/**
 * Type guard for the "settings load failed" branch (Requirement 3.5).
 *
 *   IF Settings_Store не может получить сохранённые настройки и API_Key
 *   из-за сбоя сети или хранилища при входе пользователя через Gmail,
 *   THEN THE Auth_Service SHALL прервать вход и предложить пользователю
 *   повторить попытку позднее.
 *
 * Adapters that do not have a typed error class can simply throw a
 * plain object `{ name: "SettingsLoadError", code: "settings_load_failed",
 * message: "..." }` and this guard will pick it up.
 */
export function isSettingsLoadFailedError(
  err: unknown,
): err is CompleteGoogleOAuthErrorLike & { code: "settings_load_failed" } {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; name?: unknown };
  return e.code === "settings_load_failed";
}

/**
 * Narrow gateway port the {@link GmailLoginScreen} controller uses to
 * talk to the Auth Service. Mirrors the design's `AuthClient` surface
 * but exposes only the methods the screen needs.
 *
 *   • `beginGoogleOAuth` — issued when the user clicks "Continue with
 *     Google". Returns the Google authorization URL the renderer
 *     redirects the user-agent to (Requirement 3.1). The `state` value
 *     is single-use and TTL-bounded by the backend.
 *   • `completeGoogleOAuth` — called from the `/oauth/callback` handler
 *     once the user comes back. The backend validates state, exchanges
 *     the code, find-or-creates the user, and loads cloud settings.
 *     A failure with `code === "settings_load_failed"` triggers the
 *     "retry later" UI per Requirement 3.5.
 */
export interface GmailLoginGateway {
  beginGoogleOAuth(): Promise<{
    readonly authorizationUrl: string;
    readonly state: string;
  }>;

  completeGoogleOAuth(input: {
    readonly code: string;
    readonly state: string;
  }): Promise<Session>;
}

/**
 * Narrow gateway port wrapping `upgradeLocalSessionToGoogle`
 * (task 17.3). The renderer adapter forwards the call to the backend
 * function.
 *
 * The two confirmation flags are independent (Requirement 2.7 + 2.8):
 * a user may opt to sync settings without keys, or vice versa. The
 * gateway MUST forward each flag verbatim so the backend can gate the
 * per-collection merge.
 */
export interface UpgradeGateway {
  upgradeLocalSessionToGoogle(input: {
    readonly localScope: { readonly kind: "local"; readonly deviceId: string };
    readonly code: string;
    readonly state: string;
    readonly syncSettings: boolean;
    readonly syncApiKeys: boolean;
  }): Promise<{
    readonly session: Session;
    readonly mergeReport: UpgradeMergeReport;
  }>;
}

/**
 * Narrow port the renderer uses to perform an outbound navigation to a
 * fully-qualified URL. The Gmail login screen redirects the user-agent
 * to `authorizationUrl` once `beginGoogleOAuth` returns.
 *
 * Production composition wires this to `(url) => { window.location.assign(url); }`.
 * Tests pass a recording stub.
 */
export interface UserAgentRedirector {
  redirect(url: string): void;
}
