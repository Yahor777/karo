/**
 * `LocalApiKeySink` adapter for the Windows Desktop App.
 *
 * The sink encrypts the plaintext API key via
 * `desktopShell.encryptLocalSecret`, then persists the resulting
 * `EncryptedBlob` plus the user's `(provider, baseUrl, modelId)`
 * metadata under a stable key in `desktopShell.writeLocalSetting`.
 * It also produces a short fingerprint and synthesises a local
 * `Session` for the LoginScreen to display.
 *
 * Why a separate file rather than inlining in `loginBootstrap.ts`:
 * the persistence shape is a fact about the desktop app's storage
 * contract (which cipher, which key naming convention), and tests
 * benefit from being able to drive it independently of the UI mount.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import type {
  LocalApiKeySink,
  LocalApiKeySinkResult,
} from "@ai-agent-orchestrator/client-sdk";
import {
  fingerprintApiKey,
} from "@ai-agent-orchestrator/client-sdk";
import type {
  ProviderId,
  Session,
} from "@ai-agent-orchestrator/shared-core";

import type { DesktopShell } from "../shell/types.js";

/**
 * Settings-key prefix the desktop shell uses for the encrypted
 * `EncryptedBlob` of an API key.
 *
 * Storage layout:
 *
 *   secret:apiKey:<provider>      → EncryptedBlob (cipher.encrypt(plaintext))
 *   apiKeyMeta:<provider>         → ApiKeyMetadata (fingerprint, baseUrl, modelId, savedAt)
 *
 * Splitting the encrypted value from the metadata means the renderer
 * can read the metadata (for the post-save UI) without ever touching
 * the encrypted blob. This mirrors the `Settings_Store` convention
 * the backend uses for the cloud-scoped variants.
 */
export const API_KEY_SECRET_PREFIX = "secret:apiKey:";
export const API_KEY_META_PREFIX = "apiKeyMeta:";

/**
 * Public metadata persisted alongside the encrypted key. Never
 * carries the plaintext; the fingerprint is the only post-save trace.
 */
export interface ApiKeyMetadata {
  readonly provider: ProviderId;
  readonly fingerprint: string;
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly savedAt: string;
}

/** Constructor options for {@link createDesktopApiKeySink}. */
export interface DesktopApiKeySinkOptions {
  readonly desktopShell: DesktopShell;
  /**
   * Optional clock used to stamp the metadata's `savedAt` field.
   * Defaults to `Date.now`. Tests pin a fixed value.
   */
  readonly now?: () => Date;
  /**
   * Optional id source for the `Session.id`. Defaults to
   * `crypto.randomUUID()`. Tests pin a deterministic value.
   */
  readonly sessionIdSource?: () => string;
}

/**
 * Builds a {@link LocalApiKeySink} backed by the Desktop Shell's
 * Local Encrypted Storage primitives.
 */
export function createDesktopApiKeySink(
  options: DesktopApiKeySinkOptions,
): LocalApiKeySink {
  const now = options.now ?? (() => new Date());
  const sessionIdSource =
    options.sessionIdSource ??
    (() => {
      if (typeof globalThis.crypto?.randomUUID !== "function") {
        throw new Error(
          "DesktopApiKeySink requires globalThis.crypto.randomUUID for session ids.",
        );
      }
      return globalThis.crypto.randomUUID();
    });
  const shell = options.desktopShell;

  return {
    async saveLocalSession(input): Promise<LocalApiKeySinkResult> {
      if (input.confirmedByUser !== true) {
        // Defence-in-depth: the gateway already enforces this, but a
        // direct caller (e.g. a future shell adapter) must not be
        // able to bypass the confirmation gate.
        throw Object.assign(
          new Error("DesktopApiKeySink requires confirmedByUser === true."),
          { code: "missing_confirmation" },
        );
      }
      // 1. Encrypt the plaintext via the shell. The plaintext does
      //    not survive past this `await` — we never copy it into a
      //    field, log it, or pass it on after this point.
      const blob = await shell.encryptLocalSecret(input.apiKey);

      // 2. Persist the encrypted blob and the public metadata under
      //    namespaced keys.
      const provider = input.provider;
      await shell.writeLocalSetting(
        `${API_KEY_SECRET_PREFIX}${provider}`,
        blob,
      );
      const fingerprint = fingerprintApiKey(input.apiKey);
      const meta: ApiKeyMetadata = {
        provider,
        fingerprint,
        ...(input.baseUrl !== undefined && input.baseUrl.length > 0
          ? { baseUrl: input.baseUrl }
          : {}),
        ...(input.modelId !== undefined && input.modelId.length > 0
          ? { modelId: input.modelId }
          : {}),
        savedAt: now().toISOString(),
      };
      await shell.writeLocalSetting(
        `${API_KEY_META_PREFIX}${provider}`,
        meta,
      );

      // 3. Synthesize the local Session. The Session intentionally has
      //    no field that could carry the API key (Requirement 2.5).
      const deviceId = await shell.getDeviceId();
      const session: Session = {
        id: sessionIdSource(),
        kind: "local",
        deviceId,
        createdAt: meta.savedAt,
      };
      return { session, fingerprint };
    },
  };
}
