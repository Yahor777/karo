/**
 * Application-level Desktop Shell decorator.
 *
 * The native bindings module (`nativeBindings.ts`) is a thin pass-through
 * to Tauri commands. This module wraps it with two pieces of policy
 * that belong on the renderer side:
 *
 * 1. **Device id resolution.** `getDeviceId` is memoised here through
 *    `createDeviceIdResolver`. The resolver persists the value via
 *    the shell's setting API on first launch and returns the same
 *    UUID v4 on every subsequent call — implementing Requirement 1.4
 *    without coupling to the encrypted storage that task 3.2 owns.
 *
 * 2. **Log redaction.** Every `writeLocalLog` call is run through
 *    `redactLogEntry` before it crosses the IPC boundary, so the Rust
 *    handler — and ultimately the on-disk log file — only ever sees
 *    redacted message and context fields. This implements the Desktop
 *    Shell security rule "sensitive logs must redact API keys" from
 *    `design.md`.
 *
 * The decorator is plugged in by `main.ts` via `installDesktopShell`,
 * keeping the rest of the renderer agnostic of these concerns.
 *
 * Validates: Requirements 1.4, 1.6.
 */

import type {
  DesktopShell,
  EncryptedBlob,
  ExportFileInput,
  ExportFileResult,
  LocalLogEntry,
  ShowNotificationInput,
  ApplyResult,
  TaskInternalPersistent,
  BuildTaskContextOptions,
  TaskContextPackage,
  RuntimeTaskRun,
  RuntimeEvent,
  RuntimeArtifactRecord,
  RuntimeValidationRecord,
} from "./types.js";
import type {
  TraceEvent,
  ArtifactVersion,
  ArtifactMetadata,
} from "../orchestration/types.js";
import {
  createDeviceIdResolver,
  deviceIdStorageFromSettings,
  type DeviceIdStorage,
  type RandomUuidSource,
} from "./deviceId.js";
import { redactLogEntry } from "./redaction.js";

/**
 * Configuration accepted by `createApplicationShell`.
 *
 * The `inner` field is the underlying `DesktopShell` whose calls are
 * decorated; in production this is `nativeDesktopShell`, in tests it
 * can be a fake.
 *
 * `deviceIdStorage` and `randomUuid` are optional overrides used by
 * tests; defaults derive the storage from `inner`'s setting API and
 * use `crypto.randomUUID()`.
 */
export type ApplicationShellOptions = {
  readonly inner: DesktopShell;
  readonly deviceIdStorage?: DeviceIdStorage;
  readonly randomUuid?: RandomUuidSource;
};

/**
 * Builds the application-level `DesktopShell` decorator.
 *
 * Pure function — performs no I/O. The first IO happens lazily on the
 * first `getDeviceId()` call.
 */
export function createApplicationShell(
  options: ApplicationShellOptions,
): DesktopShell {
  const inner = options.inner;
  const storage =
    options.deviceIdStorage ?? deviceIdStorageFromSettings(inner);

  const resolverOptions =
    options.randomUuid !== undefined
      ? { storage, randomUuid: options.randomUuid }
      : { storage };
  const resolveDeviceId = createDeviceIdResolver(resolverOptions);

  return {
    getDeviceId(): Promise<string> {
      return resolveDeviceId();
    },

    readLocalSetting<T = unknown>(key: string): Promise<T | null> {
      return inner.readLocalSetting<T>(key);
    },

    writeLocalSetting(key: string, value: unknown): Promise<void> {
      return inner.writeLocalSetting(key, value);
    },

    deleteLocalSetting(key: string): Promise<void> {
      return inner.deleteLocalSetting(key);
    },

    encryptLocalSecret(secret: string): Promise<EncryptedBlob> {
      return inner.encryptLocalSecret(secret);
    },

    decryptLocalSecret(blob: EncryptedBlob): Promise<string> {
      return inner.decryptLocalSecret(blob);
    },

    writeLocalLog(entry: LocalLogEntry): Promise<void> {
      // Redact before crossing the IPC boundary. The native handler
      // appends the entry verbatim to the on-disk log.
      return inner.writeLocalLog(redactLogEntry(entry));
    },

    exportFile(input: ExportFileInput): Promise<ExportFileResult> {
      return inner.exportFile(input);
    },

    showNotification(input: ShowNotificationInput): Promise<void> {
      return inner.showNotification(input);
    },

    probeProvider(input) {
      return inner.probeProvider(input);
    },

    validateFolderPath(path) {
      return inner.validateFolderPath?.(path) ?? Promise.resolve({
        ok: false,
        reason: "invalid_path" as const,
        message: "Folder validation is unavailable in this runtime.",
      });
    },

    readProjectSummary(path) {
      if (inner.readProjectSummary === undefined) {
        return Promise.reject(
          new Error(
            "Assist cannot inspect files because desktop shell does not expose read-only filesystem access yet.",
          ),
        );
      }
      return inner.readProjectSummary(path);
    },

    shell_read_file(projectPath: string, relativePath: string): Promise<string> {
      return inner.shell_read_file!(projectPath, relativePath);
    },
    shell_write_staged_file(projectPath: string, taskId: string, relativePath: string, content: string): Promise<void> {
      return inner.shell_write_staged_file!(projectPath, taskId, relativePath, content);
    },
    shell_get_staged_changes(projectPath: string, taskId: string): Promise<string[]> {
      return inner.shell_get_staged_changes!(projectPath, taskId);
    },
    shell_apply_staged_changes(projectPath: string, taskId: string, approval: boolean): Promise<ApplyResult> {
      return inner.shell_apply_staged_changes!(projectPath, taskId, approval);
    },
    shell_create_task_run(task: TaskInternalPersistent): Promise<void> {
      return inner.shell_create_task_run!(task);
    },
    shell_update_task_run(task: TaskInternalPersistent): Promise<void> {
      return inner.shell_update_task_run!(task);
    },
    shell_get_task_run(taskId: string): Promise<TaskInternalPersistent | null> {
      return inner.shell_get_task_run!(taskId);
    },
    shell_list_task_runs(projectPath: string): Promise<TaskInternalPersistent[]> {
      return inner.shell_list_task_runs!(projectPath);
    },
    shell_add_agent_run(taskId: string, agentRun: TraceEvent): Promise<void> {
      return inner.shell_add_agent_run!(taskId, agentRun);
    },
    shell_add_artifact(taskId: string, version: ArtifactVersion, meta: ArtifactMetadata): Promise<void> {
      return inner.shell_add_artifact!(taskId, version, meta);
    },
    shell_scan_project_context(projectPath: string): Promise<TaskContextPackage> {
      if (inner.shell_scan_project_context === undefined) {
        return Promise.reject(new Error("shell_scan_project_context is not implemented in this environment"));
      }
      return inner.shell_scan_project_context(projectPath);
    },
    shell_build_task_context(projectPath: string, prompt: string, options?: BuildTaskContextOptions): Promise<TaskContextPackage> {
      if (inner.shell_build_task_context === undefined) {
        return Promise.reject(new Error("shell_build_task_context is not implemented in this environment"));
      }
      return inner.shell_build_task_context(projectPath, prompt, options);
    },
    shell_start_command(projectRoot: string, command: string, mode: "preview" | "manual", profileId?: string) {
      if (inner.shell_start_command === undefined) {
        return Promise.reject(new Error("shell_start_command is not implemented in this environment"));
      }
      return inner.shell_start_command(projectRoot, command, mode, profileId);
    },
    shell_stop_command(sessionId: string) {
      if (inner.shell_stop_command === undefined) {
        return Promise.reject(new Error("shell_stop_command is not implemented in this environment"));
      }
      return inner.shell_stop_command(sessionId);
    },
    shell_get_command_output(sessionId: string) {
      if (inner.shell_get_command_output === undefined) {
        return Promise.reject(new Error("shell_get_command_output is not implemented in this environment"));
      }
      return inner.shell_get_command_output(sessionId);
    },
    shell_clear_command_output(sessionId: string) {
      if (inner.shell_clear_command_output === undefined) {
        return Promise.reject(new Error("shell_clear_command_output is not implemented in this environment"));
      }
      return inner.shell_clear_command_output(sessionId);
    },
    shell_get_terminal_status() {
      if (inner.shell_get_terminal_status === undefined) {
        return Promise.reject(new Error("shell_get_terminal_status is not implemented in this environment"));
      }
      return inner.shell_get_terminal_status();
    },
    shell_get_terminal_profiles() {
      if (inner.shell_get_terminal_profiles === undefined) {
        return Promise.resolve([]);
      }
      return inner.shell_get_terminal_profiles();
    },
    shell_open_preview_file(projectPath: string, relativePath: string) {
      if (inner.shell_open_preview_file === undefined) {
        return Promise.reject(new Error("shell_open_preview_file is not implemented in this environment"));
      }
      return inner.shell_open_preview_file(projectPath, relativePath);
    },

    runtime_detect_project_kind(projectPath: string) {
      if (inner.runtime_detect_project_kind === undefined) {
        return Promise.resolve({
          projectRoot: projectPath,
          projectKind: "generic" as const,
          signals: [],
          validationCommands: ["git status"],
          previewKind: "validation_evidence" as const,
        });
      }
      return inner.runtime_detect_project_kind(projectPath);
    },
    runtime_create_run(run: RuntimeTaskRun) {
      if (inner.runtime_create_run === undefined) return Promise.resolve();
      return inner.runtime_create_run(run);
    },
    runtime_update_run(run: RuntimeTaskRun) {
      if (inner.runtime_update_run === undefined) return Promise.resolve();
      return inner.runtime_update_run(run);
    },
    runtime_get_run(runId: string) {
      if (inner.runtime_get_run === undefined) return Promise.resolve(null);
      return inner.runtime_get_run(runId);
    },
    runtime_list_runs(projectPath: string) {
      if (inner.runtime_list_runs === undefined) return Promise.resolve([]);
      return inner.runtime_list_runs(projectPath);
    },
    runtime_append_event(runId: string, event: RuntimeEvent) {
      if (inner.runtime_append_event === undefined) {
        return Promise.reject(new Error("runtime_append_event is not implemented in this environment"));
      }
      return inner.runtime_append_event(runId, event);
    },
    runtime_record_artifact(runId: string, artifact: RuntimeArtifactRecord) {
      if (inner.runtime_record_artifact === undefined) {
        return Promise.reject(new Error("runtime_record_artifact is not implemented in this environment"));
      }
      return inner.runtime_record_artifact(runId, artifact);
    },
    runtime_record_validation(runId: string, validation: RuntimeValidationRecord) {
      if (inner.runtime_record_validation === undefined) {
        return Promise.reject(new Error("runtime_record_validation is not implemented in this environment"));
      }
      return inner.runtime_record_validation(runId, validation);
    },
    runtime_get_recovery_state(runId: string) {
      if (inner.runtime_get_recovery_state === undefined) return Promise.resolve(null);
      return inner.runtime_get_recovery_state(runId);
    },
    runtime_apply_run_artifacts(projectPath: string, runId: string, approval: boolean) {
      if (inner.runtime_apply_run_artifacts === undefined) {
        return inner.shell_apply_staged_changes!(projectPath, runId, approval);
      }
      return inner.runtime_apply_run_artifacts(projectPath, runId, approval);
    },

    isNativeBridgeWired(): boolean {
      return inner.isNativeBridgeWired ? inner.isNativeBridgeWired() : false;
    },
  };
}
