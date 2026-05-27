/**
 * Native bindings.
 *
 * This module is the ONLY place in the renderer that talks to the
 * underlying native shell (Tauri commands today, Electron IPC if the
 * fallback is ever taken). All higher layers — including
 * `bridge.ts` — go through this module so we have a single auditable
 * boundary to attach security checks.
 *
 * Validates: Requirements 1.3, 1.4, 1.6.
 */

import type {
  DesktopShell,
  EncryptedBlob,
  ExportFileInput,
  ExportFileResult,
  LocalLogEntry,
  ProviderProbeRequest,
  ProviderProbeResponse,
  ShowNotificationInput,
  ApplyResult,
  TaskInternalPersistent,
  BuildTaskContextOptions,
  TaskContextPackage,
  RuntimeTaskRun,
  RuntimeEvent,
  RuntimeArtifactRecord,
  RuntimeValidationRecord,
  RuntimeRecoveryState,
  RuntimeProjectProfile,
} from "./types.js";
import type {
  TraceEvent,
  ArtifactVersion,
  ArtifactMetadata,
} from "../orchestration/types.js";

/** Symbol used to identify shell-related runtime errors. */
export const DESKTOP_SHELL_ERROR_TAG = "DesktopShellError" as const;

/**
 * Error type raised by stub bindings while the native side is not yet
 * implemented.
 */
export class DesktopShellNotImplementedError extends Error {
  public readonly tag: typeof DESKTOP_SHELL_ERROR_TAG = DESKTOP_SHELL_ERROR_TAG;
  public readonly command: string;

  public constructor(command: string) {
    super(
      `DesktopShell command "${command}" is not implemented yet. ` +
        `It will be wired to the native side in subsequent tasks.`,
    );
    this.name = "DesktopShellNotImplementedError";
    this.command = command;
  }
}

/**
 * Tauri `invoke` shape.
 */
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: TauriInvoke | null = null;

export function setInvoke(impl: TauriInvoke): void {
  invokeImpl = impl;
}

export function resetInvoke(): void {
  invokeImpl = null;
}

async function callNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (invokeImpl === null) {
    throw new DesktopShellNotImplementedError(command);
  }
  return invokeImpl<T>(command, args);
}

function normalizeWindowsExtendedPath(path: string): string {
  if (path.startsWith("\\\\?\\")) {
    const withoutPrefix = path.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC\\")) {
      return `\\\\${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  if (path.startsWith("//?/")) {
    const withoutPrefix = path.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC/")) {
      return `//${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  return path;
}

export const DESKTOP_SHELL_COMMANDS = {
  getDeviceId: "shell_get_device_id",
  readLocalSetting: "shell_read_local_setting",
  writeLocalSetting: "shell_write_local_setting",
  deleteLocalSetting: "shell_delete_local_setting",
  encryptLocalSecret: "shell_encrypt_local_secret",
  decryptLocalSecret: "shell_decrypt_local_secret",
  writeLocalLog: "shell_write_local_log",
  exportFile: "shell_export_file",
  showNotification: "shell_show_notification",
  probeProvider: "shell_provider_probe",
  validateFolderPath: "shell_validate_folder_path",
  readProjectSummary: "shell_read_project_summary",
  shellReadFile: "shell_read_file",
  shellWriteStagedFile: "shell_write_staged_file",
  shellGetStagedChanges: "shell_get_staged_changes",
  shellApplyStagedChanges: "shell_apply_staged_changes",
  shellCreateTaskRun: "shell_create_task_run",
  shellUpdateTaskRun: "shell_update_task_run",
  shellGetTaskRun: "shell_get_task_run",
  shellListTaskRuns: "shell_list_task_runs",
  shellAddAgentRun: "shell_add_agent_run",
  shellAddArtifact: "shell_add_artifact",
  shellScanProjectContext: "shell_scan_project_context",
  shellBuildTaskContext: "shell_build_task_context",
  shellStartCommand: "shell_start_command",
  shellStopCommand: "shell_stop_command",
  shellGetCommandOutput: "shell_get_command_output",
  shellClearCommandOutput: "shell_clear_command_output",
  shellGetTerminalStatus: "shell_get_terminal_status",
  shellGetTerminalProfiles: "shell_get_terminal_profiles",
  shellOpenPreviewFile: "shell_open_preview_file",
  runtimeDetectProjectKind: "runtime_detect_project_kind",
  runtimeCreateRun: "runtime_create_run",
  runtimeUpdateRun: "runtime_update_run",
  runtimeGetRun: "runtime_get_run",
  runtimeListRuns: "runtime_list_runs",
  runtimeAppendEvent: "runtime_append_event",
  runtimeRecordArtifact: "runtime_record_artifact",
  runtimeRecordValidation: "runtime_record_validation",
  runtimeGetRecoveryState: "runtime_get_recovery_state",
  runtimeApplyRunArtifacts: "runtime_apply_run_artifacts",
} as const;

export const nativeDesktopShell: DesktopShell = {
  getDeviceId(): Promise<string> {
    return callNative<string>(DESKTOP_SHELL_COMMANDS.getDeviceId);
  },

  async readLocalSetting<T = unknown>(key: string): Promise<T | null> {
    return callNative<T | null>(DESKTOP_SHELL_COMMANDS.readLocalSetting, {
      key,
    });
  },

  writeLocalSetting(key: string, value: unknown): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.writeLocalSetting, {
      key,
      value,
    });
  },

  deleteLocalSetting(key: string): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.deleteLocalSetting, {
      key,
    });
  },

  encryptLocalSecret(secret: string): Promise<EncryptedBlob> {
    return callNative<EncryptedBlob>(DESKTOP_SHELL_COMMANDS.encryptLocalSecret, {
      secret,
    });
  },

  decryptLocalSecret(blob: EncryptedBlob): Promise<string> {
    return callNative<string>(DESKTOP_SHELL_COMMANDS.decryptLocalSecret, {
      blob,
    });
  },

  writeLocalLog(entry: LocalLogEntry): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.writeLocalLog, { entry });
  },

  exportFile(input: ExportFileInput): Promise<ExportFileResult> {
    return callNative<ExportFileResult>(DESKTOP_SHELL_COMMANDS.exportFile, {
      suggestedFileName: input.suggestedFileName,
      bytes: Array.from(input.bytes),
    });
  },

  showNotification(input: ShowNotificationInput): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.showNotification, {
      title: input.title,
      body: input.body,
    });
  },

  probeProvider(input: ProviderProbeRequest): Promise<ProviderProbeResponse> {
    const request: Record<string, unknown> = {
      url: input.url,
      method: input.method,
      headers: input.headers,
    };
    if (input.body !== undefined) request["body"] = input.body;
    if (input.timeoutMs !== undefined) request["timeoutMs"] = input.timeoutMs;
    return callNative<ProviderProbeResponse>(
      DESKTOP_SHELL_COMMANDS.probeProvider,
      { request },
    );
  },

  validateFolderPath(path: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.validateFolderPath, { path });
  },

  readProjectSummary(path: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.readProjectSummary, { path });
  },

  shell_read_file(projectPath: string, relativePath: string): Promise<string> {
    return callNative<string>(DESKTOP_SHELL_COMMANDS.shellReadFile, { projectPath, relativePath });
  },

  shell_write_staged_file(projectPath: string, taskId: string, relativePath: string, content: string): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.shellWriteStagedFile, { projectPath, taskId, relativePath, content });
  },

  shell_get_staged_changes(projectPath: string, taskId: string): Promise<string[]> {
    return callNative<string[]>(DESKTOP_SHELL_COMMANDS.shellGetStagedChanges, { projectPath, taskId });
  },

  shell_apply_staged_changes(projectPath: string, taskId: string, approval: boolean): Promise<ApplyResult> {
    return callNative<ApplyResult>(DESKTOP_SHELL_COMMANDS.shellApplyStagedChanges, { projectPath, taskId, approval });
  },

  shell_create_task_run(task: TaskInternalPersistent): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.shellCreateTaskRun, { task });
  },

  shell_update_task_run(task: TaskInternalPersistent): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.shellUpdateTaskRun, { task });
  },

  shell_get_task_run(taskId: string): Promise<TaskInternalPersistent | null> {
    return callNative<TaskInternalPersistent | null>(DESKTOP_SHELL_COMMANDS.shellGetTaskRun, { taskId });
  },

  shell_list_task_runs(projectPath: string): Promise<TaskInternalPersistent[]> {
    return callNative<TaskInternalPersistent[]>(DESKTOP_SHELL_COMMANDS.shellListTaskRuns, { projectPath });
  },

  shell_add_agent_run(taskId: string, agentRun: TraceEvent): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.shellAddAgentRun, { taskId, agentRun });
  },

  shell_add_artifact(taskId: string, version: ArtifactVersion, meta: ArtifactMetadata): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.shellAddArtifact, { taskId, artifactVersion: version, artifactMeta: meta });
  },

  shell_scan_project_context(projectPath: string): Promise<TaskContextPackage> {
    return callNative<TaskContextPackage>(DESKTOP_SHELL_COMMANDS.shellScanProjectContext, { projectPath });
  },

  shell_build_task_context(projectPath: string, prompt: string, options?: BuildTaskContextOptions): Promise<TaskContextPackage> {
    return callNative<TaskContextPackage>(DESKTOP_SHELL_COMMANDS.shellBuildTaskContext, {
      projectPath: normalizeWindowsExtendedPath(projectPath),
      prompt,
      options,
    });
  },

  shell_start_command(projectRoot: string, command: string, mode: "preview" | "manual", profileId?: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.shellStartCommand, {
      projectRoot: normalizeWindowsExtendedPath(projectRoot),
      command,
      mode,
      ...(profileId !== undefined ? { profileId } : {}),
    });
  },

  shell_stop_command(sessionId: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.shellStopCommand, { sessionId });
  },

  shell_get_command_output(sessionId: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.shellGetCommandOutput, { sessionId });
  },

  shell_clear_command_output(sessionId: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.shellClearCommandOutput, { sessionId });
  },

  shell_get_terminal_status() {
    return callNative(DESKTOP_SHELL_COMMANDS.shellGetTerminalStatus);
  },

  shell_get_terminal_profiles() {
    return callNative(DESKTOP_SHELL_COMMANDS.shellGetTerminalProfiles);
  },

  shell_open_preview_file(projectPath: string, relativePath: string) {
    return callNative(DESKTOP_SHELL_COMMANDS.shellOpenPreviewFile, {
      projectPath: normalizeWindowsExtendedPath(projectPath),
      relativePath,
    });
  },

  runtime_detect_project_kind(projectPath: string): Promise<RuntimeProjectProfile> {
    return callNative<RuntimeProjectProfile>(DESKTOP_SHELL_COMMANDS.runtimeDetectProjectKind, {
      projectPath: normalizeWindowsExtendedPath(projectPath),
    });
  },

  runtime_create_run(run: RuntimeTaskRun): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.runtimeCreateRun, { run });
  },

  runtime_update_run(run: RuntimeTaskRun): Promise<void> {
    return callNative<void>(DESKTOP_SHELL_COMMANDS.runtimeUpdateRun, { run });
  },

  runtime_get_run(runId: string): Promise<RuntimeTaskRun | null> {
    return callNative<RuntimeTaskRun | null>(DESKTOP_SHELL_COMMANDS.runtimeGetRun, { runId });
  },

  runtime_list_runs(projectPath: string): Promise<RuntimeTaskRun[]> {
    return callNative<RuntimeTaskRun[]>(DESKTOP_SHELL_COMMANDS.runtimeListRuns, {
      projectPath: normalizeWindowsExtendedPath(projectPath),
    });
  },

  runtime_append_event(runId: string, event: RuntimeEvent): Promise<RuntimeTaskRun> {
    return callNative<RuntimeTaskRun>(DESKTOP_SHELL_COMMANDS.runtimeAppendEvent, { runId, event });
  },

  runtime_record_artifact(runId: string, artifact: RuntimeArtifactRecord): Promise<RuntimeTaskRun> {
    return callNative<RuntimeTaskRun>(DESKTOP_SHELL_COMMANDS.runtimeRecordArtifact, { runId, artifact });
  },

  runtime_record_validation(runId: string, validation: RuntimeValidationRecord): Promise<RuntimeTaskRun> {
    return callNative<RuntimeTaskRun>(DESKTOP_SHELL_COMMANDS.runtimeRecordValidation, { runId, validation });
  },

  runtime_get_recovery_state(runId: string): Promise<RuntimeRecoveryState | null> {
    return callNative<RuntimeRecoveryState | null>(DESKTOP_SHELL_COMMANDS.runtimeGetRecoveryState, { runId });
  },

  runtime_apply_run_artifacts(projectPath: string, runId: string, approval: boolean): Promise<ApplyResult> {
    return callNative<ApplyResult>(DESKTOP_SHELL_COMMANDS.runtimeApplyRunArtifacts, {
      projectPath: normalizeWindowsExtendedPath(projectPath),
      runId,
      approval,
    });
  },

  isNativeBridgeWired() {
    return invokeImpl !== null;
  },
};
