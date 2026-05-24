/**
 * Saved-session helpers shared by the boot path and the workbench.
 *
 * Pulled out of the old workspaceShell so the workbench layout (the new
 * primary shell) does not depend on legacy code, and so the unit tests
 * can exercise these helpers in isolation.
 *
 * Validates: Requirements 2.5, 4.4, 4.5.
 */

import type { ProviderId } from "@ai-agent-orchestrator/shared-core";

import {
  API_KEY_META_PREFIX,
  API_KEY_SECRET_PREFIX,
  type ApiKeyMetadata,
} from "./desktopApiKeySink.js";
import { TASK_DRAFT_PREFIX } from "./taskDraftStore.js";
import { AGENT_SETTINGS_PREFIX } from "./agentSettingsStore.js";
import type { DesktopShell } from "../shell/types.js";

/**
 * Probes the four well-known providers for a saved session. Returns
 * `null` when none is on disk.
 */
export async function readSavedSession(
  shell: DesktopShell,
): Promise<{ provider: ProviderId; metadata: ApiKeyMetadata } | null> {
  const candidates: ProviderId[] = [
    "openai",
    "anthropic",
    "fireworks",
    "custom-openai",
  ];
  for (const provider of candidates) {
    const meta = await shell.readLocalSetting<ApiKeyMetadata>(
      `${API_KEY_META_PREFIX}${provider}`,
    );
    if (
      meta !== null &&
      typeof meta === "object" &&
      typeof meta.provider === "string"
    ) {
      return { provider, metadata: meta };
    }
  }
  return null;
}

/**
 * Removes encrypted secret + metadata + draft + per-agent settings for
 * the given provider so the next launch starts from the login screen.
 */
export async function clearSavedSession(
  shell: DesktopShell,
  provider: ProviderId,
): Promise<void> {
  await shell.deleteLocalSetting(`${API_KEY_SECRET_PREFIX}${provider}`);
  await shell.deleteLocalSetting(`${API_KEY_META_PREFIX}${provider}`);
  await shell.deleteLocalSetting(`${TASK_DRAFT_PREFIX}${provider}`);
  await shell.deleteLocalSetting(`${AGENT_SETTINGS_PREFIX}${provider}`);
}
