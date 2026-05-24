/**
 * Per-agent settings store for the KARO workbench.
 *
 * Persists the user's per-agent enabled/model preferences via
 * `desktopShell.writeLocalSetting`. Settings are scoped per provider
 * so a future multi-provider workspace doesn't mix Fireworks-specific
 * model ids into another provider's run.
 *
 * The store deliberately does NOT touch encrypted secrets — only
 * non-sensitive metadata (`provider`, `agentId`, `enabled`, `modelId`).
 *
 * Validates: Requirements 1.6, 12.x (custom-agent-style overrides for
 * builtin agents in the MVP).
 */

import type {
  BuiltinAgentRole,
  ProviderId,
} from "@ai-agent-orchestrator/shared-core";

import type { DesktopShell } from "../shell/types.js";

export const AGENT_SETTINGS_PREFIX = "agentSettings:";

export interface AgentSetting {
  readonly enabled: boolean;
  readonly modelId?: string;
}

export type AgentSettingsMap = {
  readonly [K in BuiltinAgentRole]?: AgentSetting;
};

export interface AgentSettingsStoreOptions {
  readonly desktopShell: DesktopShell;
}

export interface AgentSettingsStore {
  read(provider: ProviderId): Promise<AgentSettingsMap>;
  write(provider: ProviderId, settings: AgentSettingsMap): Promise<void>;
}

/**
 * Defensive shape check — `readLocalSetting` may return arbitrary
 * JSON if a future version ever wrote a different shape.
 */
function isAgentSettingsMap(value: unknown): value is AgentSettingsMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>;
    if (typeof o.enabled !== "boolean") return false;
    if (o.modelId !== undefined && typeof o.modelId !== "string") return false;
  }
  return true;
}

export function createAgentSettingsStore(
  options: AgentSettingsStoreOptions,
): AgentSettingsStore {
  const shell = options.desktopShell;
  return {
    async read(provider: ProviderId): Promise<AgentSettingsMap> {
      const raw = await shell.readLocalSetting<unknown>(
        `${AGENT_SETTINGS_PREFIX}${provider}`,
      );
      if (raw === null) return {};
      return isAgentSettingsMap(raw) ? raw : {};
    },
    async write(
      provider: ProviderId,
      settings: AgentSettingsMap,
    ): Promise<void> {
      await shell.writeLocalSetting(
        `${AGENT_SETTINGS_PREFIX}${provider}`,
        settings,
      );
    },
  };
}
