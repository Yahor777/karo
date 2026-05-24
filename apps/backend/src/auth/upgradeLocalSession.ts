/**
 * Local-to-cloud session upgrade with merge report (task 17.3).
 *
 * Sources:
 *   • design.md → "Auth Service" → `AuthService.upgradeLocalSessionToGoogle`
 *     signature and `MergeReport` shape (under "Settings Store").
 *   • design.md → "Session Modes" → "Local-to-cloud upgrade mode":
 *       1. user has local API-key-only session;
 *       2. user chooses Gmail OAuth;
 *       3. app asks whether to sync local settings to cloud;
 *       4. user can confirm or decline;
 *       5. if confirmed, settings_store merges local settings into cloud;
 *       6. API keys are synced only with explicit confirmation;
 *       7. session becomes cloud session.
 *   • design.md → "Session Modes" → "Conflict policy":
 *       – cloud settings win over local settings for same provider;
 *       – local custom agents are copied if names do not conflict;
 *       – conflicting custom agents preserved as local-only until resolved;
 *       – local pending changes are stored in sync_outbox if cloud sync fails.
 *   • requirements.md →
 *       2.7 ("WHEN user with API-key-only session signs in with Gmail, the
 *             Settings_Store SHALL предложить перенести ранее сохранённые
 *             локально настройки в Cloud_Settings_Store … после
 *             подтверждения пользователя"),
 *       2.8 ("THE system SHALL NOT sync API_Key to cloud without explicit
 *             user confirmation"),
 *       3.6 ("IF при синхронизации настроек … происходит сбой … THEN
 *             Settings_Store SHALL вернуть пользователю описательную ошибку
 *             и сохранить локально внесённые в текущей сессии изменения").
 *   • tasks.md → 17.3 sub-bullets.
 *
 * What this module ships
 * ----------------------
 *   • {@link MergeReport}                     — return type matching the
 *     task brief verbatim:
 *       - apiKeys: { copiedToCloud, cloudWonOver, preservedLocalOnly };
 *       - customAgents: { copiedToCloud, conflicts: { agentId, reason }[] };
 *       - preferences: { copiedToCloud, cloudWon }.
 *   • {@link UpgradeLocalSessionInput}        — input shape; explicit
 *     `syncSettings` and `syncApiKeys` confirmation flags gate the
 *     respective merge operations (Requirements 2.7, 2.8).
 *   • {@link UpgradeLocalSessionResult}       — result bundles the
 *     completed cloud `Session` with the {@link MergeReport}.
 *   • {@link upgradeLocalSessionToGoogle}     — orchestration function:
 *       1. completes Gmail OAuth via {@link GoogleOAuthService} (task 17.1);
 *       2. resolves the cloud `userId` from the resulting Session;
 *       3. when `syncApiKeys === true`, merges local API keys into cloud
 *          (cloud wins for same provider);
 *       4. when `syncSettings === true`, merges local custom agents and
 *          preferences into cloud (cloud wins on collisions);
 *       5. returns the cloud Session and a populated {@link MergeReport}.
 *
 * Boundaries
 * ----------
 *   • This file does NOT touch `authService.ts` or `googleOAuth.ts`. It
 *     composes them through their existing public surfaces.
 *   • This file does NOT decrypt any API keys. The merge of API keys is
 *     done by reading local-scope encrypted blobs and writing them as new
 *     local-plaintext-via-cipher cloud records — but the plaintext is
 *     read through a decrypt sink that is normally wired to the same
 *     {@link SecretCipher} or the {@link SecretGateway} component-token
 *     flow (task 6.3). For the test path, an injectable
 *     {@link LocalApiKeySecretReader} is used so the test never has to
 *     materialise a cipher; production composition wires this to the
 *     local-scope cipher inverse of `ApiKeyService.upsertApiKey`.
 *   • This file does NOT implement a sync_outbox. Failures in the merge
 *     surface as thrown errors with the cloud session NOT promoted; the
 *     gateway/UI layer is the one that decides whether to retry.
 *
 * Validates: Requirements 2.7, 2.8, 3.6.
 */

import type {
  AgentId,
  ProviderId,
  Scope,
  Session,
} from "@ai-agent-orchestrator/shared-core";
import type { CustomAgent } from "@ai-agent-orchestrator/validation";

import type { CloudSettingsStore } from "../settings/cloudSettingsStore.js";
import {
  CustomAgentNameConflictError,
  type CustomAgentService,
} from "../settings/customAgents.js";
import type { ApiKeyService } from "../settings/apiKeys.js";

import type { GoogleOAuthService } from "./googleOAuth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-collection merge result returned by {@link upgradeLocalSessionToGoogle}.
 *
 * Shape mirrors task 17.3's "Return MergeReport" bullet exactly; design.md
 * has a slightly different tally-only `MergeReport` under Settings Store, but
 * the task brief calls for the more granular shape so debugging the merge
 * (and surfacing it to UI) doesn't require a second round-trip.
 */
export interface MergeReport {
  readonly apiKeys: {
    /** Providers whose local key was copied to the (previously empty) cloud slot. */
    readonly copiedToCloud: readonly ProviderId[];
    /** Providers where the cloud already had a key — cloud wins, local is dropped. */
    readonly cloudWonOver: readonly ProviderId[];
    /**
     * Providers that the policy preserves as local-only. With the "cloud
     * wins" rule that's the same set as `cloudWonOver`; the field is kept
     * separate so future policy changes (e.g. "preserve local under a
     * different provider id") can populate it independently.
     */
    readonly preservedLocalOnly: readonly ProviderId[];
  };
  readonly customAgents: {
    /** Local agent ids that landed in the cloud scope under the same name. */
    readonly copiedToCloud: readonly AgentId[];
    /**
     * Local agents whose name collided with a builtin or with an existing
     * cloud agent and were therefore left as local-only in the report.
     */
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
 * Read-only port the upgrade uses to enumerate the local-scope collections.
 *
 * Production composition wires:
 *   • `apiKeys`         to a thin adapter over `ApiKeyStoreBackend.list` plus
 *                       a decrypting reader (or, for the production cloud
 *                       path, a copy that re-encrypts under the cloud
 *                       cipher). The adapter must NOT log plaintext.
 *   • `customAgents`    to `CustomAgentService.listCustomAgents`.
 *   • `preferences`     to a local-scope adapter over `PreferencesBackend`.
 *
 * Why a custom port: the upgrade routine does not need full CRUD over the
 * local store and we want to keep the local <-> cloud direction explicit at
 * the type level (no risk of accidentally writing back to local).
 */
export interface LocalScopeReader {
  /**
   * Returns the local plaintext API key for `(deviceId, provider)`, or null
   * if no key is configured. Implementations MUST NOT log the plaintext and
   * SHOULD treat it as a short-lived secret that is dropped from memory as
   * soon as the upgrade routine returns.
   */
  readApiKey(deviceId: string, provider: ProviderId): Promise<string | null>;

  /** Returns the providers stored in the local scope. */
  listLocalProviders(deviceId: string): Promise<readonly ProviderId[]>;

  /** Returns the local custom agents. */
  listLocalCustomAgents(deviceId: string): Promise<readonly CustomAgent[]>;

  /** Returns the local preferences as a plain key/value snapshot. */
  listLocalPreferences(
    deviceId: string,
  ): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Input to {@link upgradeLocalSessionToGoogle}.
 *
 * Field semantics:
 *
 *   • `localScope`   — the existing local API-key-only scope to upgrade
 *     from. The upgrade reads from this scope only (never writes back).
 *   • `code`/`state` — Gmail OAuth callback values. Forwarded to
 *     {@link GoogleOAuthService.completeGoogleOAuth}.
 *   • `cloudUserId`  — explicit override for tests and for callers that
 *     have already resolved the user. When present the upgrade uses this
 *     id instead of the one returned by the Google OAuth completion. In
 *     production the field is normally absent and the cloud user is
 *     derived from the OAuth flow.
 *   • `syncSettings` — explicit confirmation that the user wants their
 *     local custom agents and preferences merged into the cloud. Without
 *     this flag those collections are NOT touched.
 *   • `syncApiKeys`  — explicit confirmation that the user wants their
 *     local API keys merged into the cloud. Without this flag the API
 *     keys collection is NOT touched (Requirement 2.8).
 *
 * Both confirmation flags are independent — a user can opt to sync
 * settings without syncing keys, or vice versa.
 */
export interface UpgradeLocalSessionInput {
  readonly localScope: { readonly kind: "local"; readonly deviceId: string };
  readonly code: string;
  readonly state: string;
  readonly cloudUserId?: string;
  readonly syncSettings: boolean;
  readonly syncApiKeys: boolean;
}

/**
 * Bundled result: the completed cloud {@link Session} plus the merge
 * report describing what was actually copied.
 */
export interface UpgradeLocalSessionResult {
  readonly session: Session;
  readonly mergeReport: MergeReport;
}

/**
 * Construction options for {@link createUpgradeLocalSessionToGoogle}.
 */
export interface UpgradeLocalSessionDependencies {
  readonly googleOAuthService: GoogleOAuthService;
  readonly cloudSettingsStore: CloudSettingsStore;
  /**
   * Cloud-scoped {@link CustomAgentService}. Used to inspect cloud-side
   * collisions before issuing an `upsertCustomAgent` so we can classify
   * collisions in the {@link MergeReport} rather than letting the
   * underlying service throw.
   */
  readonly cloudCustomAgentService: CustomAgentService;
  /**
   * Cloud-scoped {@link ApiKeyService}. Optional; when present the upgrade
   * uses it directly so the merge does not have to instantiate a cipher
   * round-trip. When absent the upgrade falls back to
   * `cloudSettingsStore.upsertApiKey` / `listApiKeyMetadata`.
   */
  readonly cloudApiKeyService?: ApiKeyService;
  readonly localReader: LocalScopeReader;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Executes the full local-to-cloud upgrade and produces a
 * {@link MergeReport}.
 *
 * Flow:
 *
 *   1. Complete Google OAuth — validates `state`, exchanges `code`, mints
 *      a cloud `Session`. State validation runs FIRST so a forged or
 *      replayed callback never reaches the merge stage.
 *   2. Resolve `cloudUserId`: prefer the explicit input, fall back to
 *      the Session's `userId`. Throwing if neither is available is a
 *      defensive guardrail — a cloud session without a `userId` would
 *      indicate a bug in the OAuth service.
 *   3. If `syncApiKeys === true`, merge API keys (`mergeApiKeys`).
 *      Otherwise the api-keys section of the report is empty.
 *   4. If `syncSettings === true`, merge custom agents
 *      (`mergeCustomAgents`) and preferences (`mergePreferences`).
 *      Otherwise both sections of the report are empty.
 *   5. Return the cloud Session and the populated MergeReport.
 *
 * Confirmation gating (Requirements 2.7, 2.8):
 *   • Each collection has its own boolean. Collections without their flag
 *     ARE NOT TOUCHED — neither read for diff, nor written. The upgrade
 *     therefore can't leak local plaintext into the cloud through partial
 *     reads even on the unconfirmed path.
 *
 * Error handling (Requirement 3.6):
 *   • The function intentionally does not catch backend failures from
 *     `cloudSettingsStore.upsertApiKey` / `setPreference`. A genuine
 *     storage failure surfaces to the caller and the cloud session is
 *     considered "not promoted" — the gateway/UI layer is the one that
 *     decides whether to retry. Logical name conflicts on custom agents
 *     are NOT failures: they are tracked in `mergeReport.customAgents.
 *     conflicts` so the UI can surface them and the user can rename
 *     locally.
 */
export function createUpgradeLocalSessionToGoogle(
  deps: UpgradeLocalSessionDependencies,
): (input: UpgradeLocalSessionInput) => Promise<UpgradeLocalSessionResult> {
  return async function upgradeLocalSessionToGoogle(input) {
    if (
      typeof input.localScope?.deviceId !== "string" ||
      input.localScope.deviceId.length === 0
    ) {
      throw new Error(
        "upgradeLocalSessionToGoogle: localScope.deviceId must be non-empty.",
      );
    }

    // 1. Complete Gmail OAuth. Any failure here (invalid_state, expired_state,
    //    code_exchange_failed, ...) propagates to the caller as the typed
    //    GoogleOAuthError; the merge stage never runs.
    const session = await deps.googleOAuthService.completeGoogleOAuth({
      code: input.code,
      state: input.state,
    });

    // 2. Resolve cloudUserId.
    const cloudUserId = input.cloudUserId ?? session.userId;
    if (typeof cloudUserId !== "string" || cloudUserId.length === 0) {
      throw new Error(
        "upgradeLocalSessionToGoogle: cloud Session has no userId; OAuth flow did not produce a cloud user.",
      );
    }

    // Build the empty report up front so each branch only has to
    // populate its collection.
    const apiKeysCopied: ProviderId[] = [];
    const apiKeysCloudWonOver: ProviderId[] = [];
    const apiKeysPreservedLocalOnly: ProviderId[] = [];
    const customAgentsCopied: AgentId[] = [];
    const customAgentsConflicts: {
      agentId: AgentId;
      reason: "builtin_name" | "cloud_agent_with_same_name";
    }[] = [];
    const preferencesCopied: string[] = [];
    const preferencesCloudWon: string[] = [];

    // 3. Merge API keys when explicitly confirmed.
    if (input.syncApiKeys === true) {
      await mergeApiKeys({
        deps,
        deviceId: input.localScope.deviceId,
        cloudUserId,
        copied: apiKeysCopied,
        cloudWonOver: apiKeysCloudWonOver,
        preservedLocalOnly: apiKeysPreservedLocalOnly,
      });
    }

    // 4. Merge settings (custom agents + preferences) when explicitly confirmed.
    if (input.syncSettings === true) {
      await mergeCustomAgents({
        deps,
        deviceId: input.localScope.deviceId,
        cloudUserId,
        copied: customAgentsCopied,
        conflicts: customAgentsConflicts,
      });
      await mergePreferences({
        deps,
        deviceId: input.localScope.deviceId,
        cloudUserId,
        copied: preferencesCopied,
        cloudWon: preferencesCloudWon,
      });
    }

    return {
      session,
      mergeReport: {
        apiKeys: {
          copiedToCloud: apiKeysCopied,
          cloudWonOver: apiKeysCloudWonOver,
          preservedLocalOnly: apiKeysPreservedLocalOnly,
        },
        customAgents: {
          copiedToCloud: customAgentsCopied,
          conflicts: customAgentsConflicts,
        },
        preferences: {
          copiedToCloud: preferencesCopied,
          cloudWon: preferencesCloudWon,
        },
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Internal merge helpers
// ---------------------------------------------------------------------------

/**
 * Merges local API keys into cloud.
 *
 * Conflict policy: cloud wins for the same provider. The local plaintext is
 * only read for providers that DO NOT yet have a cloud entry, so for
 * providers where cloud already wins the local plaintext is never touched
 * by this routine.
 *
 * Validates: Requirements 2.7, 2.8.
 */
async function mergeApiKeys(args: {
  deps: UpgradeLocalSessionDependencies;
  deviceId: string;
  cloudUserId: string;
  copied: ProviderId[];
  cloudWonOver: ProviderId[];
  preservedLocalOnly: ProviderId[];
}): Promise<void> {
  const { deps, deviceId, cloudUserId } = args;

  const localProviders = await deps.localReader.listLocalProviders(deviceId);
  const cloudMetadata = await deps.cloudSettingsStore.listApiKeyMetadata(
    cloudUserId,
  );
  const cloudProviders = new Set(cloudMetadata.map((m) => m.provider));

  for (const provider of localProviders) {
    if (cloudProviders.has(provider)) {
      // Same provider exists in cloud — cloud wins. Per the task brief,
      // also surface the provider as `preservedLocalOnly` so callers know
      // the local entry is still present in the local scope. We do not
      // touch the local store here; the local API key remains where it
      // was, and the next session migration step will decide what to do
      // with it (typical UX: surface "your local key for X is no longer
      // used; remove it locally?" toast).
      args.cloudWonOver.push(provider);
      args.preservedLocalOnly.push(provider);
      continue;
    }

    // Cloud has no key for this provider — copy from local. Read the
    // plaintext only at this point so we touch the secret for the
    // shortest possible time.
    const plaintext = await deps.localReader.readApiKey(deviceId, provider);
    if (plaintext === null) {
      // listLocalProviders said the provider exists, but readApiKey
      // can't find it. Treat as local-only and continue rather than
      // throwing — this can happen if a concurrent local delete races
      // with the upgrade.
      continue;
    }

    if (deps.cloudApiKeyService !== undefined) {
      await deps.cloudApiKeyService.upsertApiKey(
        cloudScopeFor(cloudUserId),
        { provider, apiKey: plaintext },
      );
    } else {
      await deps.cloudSettingsStore.upsertApiKey(cloudUserId, {
        provider,
        apiKey: plaintext,
      });
    }
    args.copied.push(provider);
  }
}

/**
 * Merges local custom agents into cloud.
 *
 * Conflict policy:
 *   • If a builtin agent (researcher, coder, reviewer, fixer, boss) exists
 *     with the same normalized name → record `"builtin_name"` conflict.
 *   • If a cloud Custom_Agent with the same normalized name exists →
 *     record `"cloud_agent_with_same_name"` conflict.
 *   • Otherwise copy the local agent into cloud and record the local
 *     `agentId` under `copiedToCloud`.
 *
 * The conflict check is done by inspecting the cloud-side custom agent
 * list ahead of upsert and by attempting the upsert (which will reject a
 * builtin-name collision via {@link CustomAgentNameConflictError}). The
 * defensive try/catch around `upsertCustomAgent` handles both branches
 * uniformly: if the underlying service rejects, we surface the agent as
 * a conflict regardless of which branch fired.
 *
 * Validates: Requirements 2.7.
 */
async function mergeCustomAgents(args: {
  deps: UpgradeLocalSessionDependencies;
  deviceId: string;
  cloudUserId: string;
  copied: AgentId[];
  conflicts: {
    agentId: AgentId;
    reason: "builtin_name" | "cloud_agent_with_same_name";
  }[];
}): Promise<void> {
  const { deps, deviceId, cloudUserId } = args;

  const localAgents = await deps.localReader.listLocalCustomAgents(deviceId);
  const cloudAgents = await deps.cloudCustomAgentService.listCustomAgents(
    cloudScopeFor(cloudUserId),
  );
  const cloudNames = new Set(cloudAgents.map((a) => normalizeAgentName(a.name)));

  for (const local of localAgents) {
    const normalized = normalizeAgentName(local.name);

    if (cloudNames.has(normalized)) {
      args.conflicts.push({
        agentId: local.id,
        reason: "cloud_agent_with_same_name",
      });
      continue;
    }

    try {
      await deps.cloudCustomAgentService.upsertCustomAgent(
        cloudScopeFor(cloudUserId),
        {
          name: local.name,
          systemPrompt: local.systemPrompt,
          ...(local.model !== undefined ? { model: local.model } : {}),
          allowedTools: local.allowedTools,
        },
      );
      args.copied.push(local.id);
      // Track newly-copied name so a second local agent with the same
      // normalized name (within the same upgrade run) becomes a
      // cloud-side conflict rather than silently overwriting.
      cloudNames.add(normalized);
    } catch (err) {
      if (err instanceof CustomAgentNameConflictError) {
        args.conflicts.push({
          agentId: local.id,
          reason:
            err.conflictWith === "builtin"
              ? "builtin_name"
              : "cloud_agent_with_same_name",
        });
        continue;
      }
      // Anything else is a real failure (storage, validation), bubble up.
      throw err;
    }
  }
}

/**
 * Merges local preferences into cloud.
 *
 * Conflict policy: cloud wins on collisions; non-conflicting local
 * preferences are copied into cloud.
 *
 * Validates: Requirements 2.7.
 */
async function mergePreferences(args: {
  deps: UpgradeLocalSessionDependencies;
  deviceId: string;
  cloudUserId: string;
  copied: string[];
  cloudWon: string[];
}): Promise<void> {
  const { deps, deviceId, cloudUserId } = args;

  const localPrefs = await deps.localReader.listLocalPreferences(deviceId);
  const cloudPrefs = await deps.cloudSettingsStore.listPreferences(cloudUserId);

  for (const key of Object.keys(localPrefs)) {
    if (Object.prototype.hasOwnProperty.call(cloudPrefs, key)) {
      args.cloudWon.push(key);
      continue;
    }
    await deps.cloudSettingsStore.setPreference(cloudUserId, key, localPrefs[key]);
    args.copied.push(key);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a cloud {@link Scope} for `userId`. */
function cloudScopeFor(userId: string): Scope {
  return { kind: "cloud", userId };
}

/**
 * Same normalization as `customAgents.ts` so collision checks here line up
 * with the underlying service's checks. Trim then lowercase.
 */
function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}
