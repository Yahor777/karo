/**
 * Local Task draft store for the KARO MVP.
 *
 * Persists a tiny `TaskDraft` shape via `desktopShell.writeLocalSetting`
 * so the user can fill in the Task Builder, click "Save draft", close
 * the app, and find their work intact on next launch. The store is
 * intentionally minimal — we do NOT replicate `Task` / `TaskState` /
 * persistence here. The full Task pipeline lands when the orchestrator
 * transport is wired (task 18.2). This is a stop-gap so the Task
 * Builder screen feels real instead of being a placeholder.
 *
 * Storage layout:
 *
 *   taskDraft:<provider>     → TaskDraft (JSON)
 *
 * Drafts are namespaced per-provider so a user signed in to multiple
 * providers in succession does not see a draft from a previous account
 * leak across sign-outs. Sign-out path in `workspaceShell.ts` deletes
 * the draft alongside the secret + metadata.
 *
 * The draft NEVER carries the API key or any decrypted secret — it is
 * just the user's work-in-progress prompt + agent picks. The
 * `confirmedFallback` flag is also not stored (forces re-confirmation
 * if a fallback is ever offered).
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5.
 */

import type {
  BuiltinAgentRole,
  ProviderId,
} from "@ai-agent-orchestrator/shared-core";

import type { DesktopShell } from "../shell/types.js";

/** Storage key prefix for per-provider drafts. */
export const TASK_DRAFT_PREFIX = "taskDraft:";

/** UI mode discriminant — mirrors the shared-ui Task Builder. */
export type TaskDraftMode = "auto" | "manual";

/**
 * Persisted shape. Versioned so we can migrate the format later
 * without breaking existing drafts on disk.
 */
export interface TaskDraft {
  readonly version: 1;
  readonly prompt: string;
  readonly mode: TaskDraftMode;
  readonly participants: readonly BuiltinAgentRole[];
  readonly reviewCycles: number;
  /**
   * Snapshot of the model id the user had selected at draft time. We
   * record it so the screen can render a meaningful "Model:" line on
   * next launch even if the user has since changed their default.
   */
  readonly modelId?: string;
  readonly savedAt: string;
}

/** Options for {@link createTaskDraftStore}. */
export interface TaskDraftStoreOptions {
  readonly desktopShell: DesktopShell;
  /** Clock used to stamp `savedAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Narrow store contract. Simple read / write / delete — no listing
 * (a single user is signed in to a single provider at a time today).
 */
export interface TaskDraftStore {
  read(provider: ProviderId): Promise<TaskDraft | null>;
  write(
    provider: ProviderId,
    draft: Omit<TaskDraft, "version" | "savedAt">,
  ): Promise<TaskDraft>;
  delete(provider: ProviderId): Promise<void>;
}

/**
 * Returns `true` when `value` looks like a `TaskDraft`. Defensive —
 * the localStorage backend may surface arbitrary JSON if a future
 * version corrupts the entry.
 */
export function isTaskDraft(value: unknown): value is TaskDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1) return false;
  if (typeof v["prompt"] !== "string") return false;
  if (v["mode"] !== "auto" && v["mode"] !== "manual") return false;
  if (!Array.isArray(v["participants"])) return false;
  if (typeof v["reviewCycles"] !== "number") return false;
  if (typeof v["savedAt"] !== "string") return false;
  if (v["modelId"] !== undefined && typeof v["modelId"] !== "string") {
    return false;
  }
  return true;
}

/**
 * Builds a {@link TaskDraftStore} backed by `desktopShell.writeLocalSetting`.
 */
export function createTaskDraftStore(
  options: TaskDraftStoreOptions,
): TaskDraftStore {
  const shell = options.desktopShell;
  const now = options.now ?? (() => new Date());

  return {
    async read(provider: ProviderId): Promise<TaskDraft | null> {
      const raw = await shell.readLocalSetting<unknown>(
        `${TASK_DRAFT_PREFIX}${provider}`,
      );
      if (raw === null || raw === undefined) return null;
      if (!isTaskDraft(raw)) return null;
      return raw;
    },
    async write(
      provider: ProviderId,
      draft: Omit<TaskDraft, "version" | "savedAt">,
    ): Promise<TaskDraft> {
      const stored: TaskDraft = {
        version: 1,
        prompt: draft.prompt,
        mode: draft.mode,
        participants: [...draft.participants],
        reviewCycles: draft.reviewCycles,
        ...(draft.modelId !== undefined && draft.modelId.length > 0
          ? { modelId: draft.modelId }
          : {}),
        savedAt: now().toISOString(),
      };
      await shell.writeLocalSetting(`${TASK_DRAFT_PREFIX}${provider}`, stored);
      return stored;
    },
    async delete(provider: ProviderId): Promise<void> {
      await shell.deleteLocalSetting(`${TASK_DRAFT_PREFIX}${provider}`);
    },
  };
}
