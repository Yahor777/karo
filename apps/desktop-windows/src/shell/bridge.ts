/**
 * Renderer ↔ Shell bridge.
 *
 * Single secure entrypoint used by the renderer to consume the
 * `DesktopShell`. UI code (`src/ui/**`) MUST import from this module
 * instead of poking at `nativeBindings` or Tauri's `invoke` directly,
 * so we have one place to apply security policy:
 *
 * - the bridge is installed once at app boot from `main.ts`;
 * - it can be replaced in tests without monkey-patching globals;
 * - decrypted API_Key material never flows through arbitrary UI code
 *   because UI code only ever sees this interface.
 *
 * Validates: Requirements 1.3, 1.4, 1.6.
 */

import type {
  DesktopShell,
  ApplyResult,
  TaskInternalPersistent,
  BuildTaskContextOptions,
  TaskContextPackage,
} from "./types.js";
import type {
  TraceEvent,
  ArtifactVersion,
  ArtifactMetadata,
} from "../orchestration/types.js";
import { nativeDesktopShell } from "./nativeBindings.js";

/**
 * The currently installed shell. Defaults to the native bindings stub.
 * Tests may override it via `installDesktopShell` to inject a fake.
 */
let currentShell: DesktopShell = nativeDesktopShell;

/**
 * Installs a `DesktopShell` implementation. Called once from `main.ts`
 * after the Tauri `invoke` binding has been wired, and from tests to
 * inject fakes.
 */
export function installDesktopShell(shell: DesktopShell): void {
  currentShell = shell;
}

/**
 * Returns the currently installed `DesktopShell`. UI code uses this
 * accessor (and never the underlying module-level variable) so the
 * test-time override always wins.
 */
export function getDesktopShell(): DesktopShell {
  return currentShell;
}

/**
 * Convenience facade. Methods are bound here so callers can destructure
 * `desktopShell.getDeviceId` without losing `this`. Each method always
 * reads the current implementation from `getDesktopShell()` so swaps
 * during tests take effect immediately.
 */
export const desktopShell: DesktopShell = {
  getDeviceId() {
    return getDesktopShell().getDeviceId();
  },
  readLocalSetting<T = unknown>(key: string) {
    return getDesktopShell().readLocalSetting<T>(key);
  },
  writeLocalSetting(key, value) {
    return getDesktopShell().writeLocalSetting(key, value);
  },
  deleteLocalSetting(key) {
    return getDesktopShell().deleteLocalSetting(key);
  },
  encryptLocalSecret(secret) {
    return getDesktopShell().encryptLocalSecret(secret);
  },
  decryptLocalSecret(blob) {
    return getDesktopShell().decryptLocalSecret(blob);
  },
  writeLocalLog(entry) {
    return getDesktopShell().writeLocalLog(entry);
  },
  exportFile(input) {
    return getDesktopShell().exportFile(input);
  },
  showNotification(input) {
    return getDesktopShell().showNotification(input);
  },
  probeProvider(input) {
    return getDesktopShell().probeProvider(input);
  },
  isNativeBridgeWired() {
    return getDesktopShell().isNativeBridgeWired ? getDesktopShell().isNativeBridgeWired!() : false;
  },
  validateFolderPath(path) {
    return getDesktopShell().validateFolderPath?.(path) ?? Promise.resolve({
      ok: false,
      reason: "invalid_path" as const,
      message: "Folder validation is unavailable in this runtime.",
    });
  },
  readProjectSummary(path) {
    const shell = getDesktopShell();
    if (shell.readProjectSummary === undefined) {
      return Promise.reject(
        new Error(
          "Assist cannot inspect files because desktop shell does not expose read-only filesystem access yet.",
        ),
      );
    }
    return shell.readProjectSummary(path);
  },

  shell_read_file(projectPath: string, relativePath: string): Promise<string> {
    return getDesktopShell().shell_read_file!(projectPath, relativePath);
  },
  shell_write_staged_file(projectPath: string, taskId: string, relativePath: string, content: string): Promise<void> {
    return getDesktopShell().shell_write_staged_file!(projectPath, taskId, relativePath, content);
  },
  shell_get_staged_changes(projectPath: string, taskId: string): Promise<string[]> {
    return getDesktopShell().shell_get_staged_changes!(projectPath, taskId);
  },
  shell_apply_staged_changes(projectPath: string, taskId: string, approval: boolean): Promise<ApplyResult> {
    return getDesktopShell().shell_apply_staged_changes!(projectPath, taskId, approval);
  },
  shell_create_task_run(task: TaskInternalPersistent): Promise<void> {
    return getDesktopShell().shell_create_task_run!(task);
  },
  shell_update_task_run(task: TaskInternalPersistent): Promise<void> {
    return getDesktopShell().shell_update_task_run!(task);
  },
  shell_get_task_run(taskId: string): Promise<TaskInternalPersistent | null> {
    return getDesktopShell().shell_get_task_run!(taskId);
  },
  shell_list_task_runs(projectPath: string): Promise<TaskInternalPersistent[]> {
    return getDesktopShell().shell_list_task_runs!(projectPath);
  },
  shell_add_agent_run(taskId: string, agentRun: TraceEvent): Promise<void> {
    return getDesktopShell().shell_add_agent_run!(taskId, agentRun);
  },
  shell_add_artifact(taskId: string, version: ArtifactVersion, meta: ArtifactMetadata): Promise<void> {
    return getDesktopShell().shell_add_artifact!(taskId, version, meta);
  },
  shell_scan_project_context(projectPath: string): Promise<TaskContextPackage> {
    const shell = getDesktopShell();
    if (shell.shell_scan_project_context === undefined) {
      return Promise.reject(new Error("shell_scan_project_context is not implemented in this environment"));
    }
    return shell.shell_scan_project_context(projectPath);
  },
  shell_build_task_context(projectPath: string, prompt: string, options?: BuildTaskContextOptions): Promise<TaskContextPackage> {
    const shell = getDesktopShell();
    if (shell.shell_build_task_context === undefined) {
      return Promise.reject(new Error("shell_build_task_context is not implemented in this environment"));
    }
    return shell.shell_build_task_context(projectPath, prompt, options);
  },
  shell_start_command(projectRoot: string, command: string, mode: "preview" | "manual", profileId?: string) {
    const shell = getDesktopShell();
    if (shell.shell_start_command === undefined) {
      return Promise.reject(new Error("shell_start_command is not implemented in this environment"));
    }
    return shell.shell_start_command(projectRoot, command, mode, profileId);
  },
  shell_stop_command(sessionId: string) {
    const shell = getDesktopShell();
    if (shell.shell_stop_command === undefined) {
      return Promise.reject(new Error("shell_stop_command is not implemented in this environment"));
    }
    return shell.shell_stop_command(sessionId);
  },
  shell_get_command_output(sessionId: string) {
    const shell = getDesktopShell();
    if (shell.shell_get_command_output === undefined) {
      return Promise.reject(new Error("shell_get_command_output is not implemented in this environment"));
    }
    return shell.shell_get_command_output(sessionId);
  },
  shell_clear_command_output(sessionId: string) {
    const shell = getDesktopShell();
    if (shell.shell_clear_command_output === undefined) {
      return Promise.reject(new Error("shell_clear_command_output is not implemented in this environment"));
    }
    return shell.shell_clear_command_output(sessionId);
  },
  shell_get_terminal_status() {
    const shell = getDesktopShell();
    if (shell.shell_get_terminal_status === undefined) {
      return Promise.reject(new Error("shell_get_terminal_status is not implemented in this environment"));
    }
    return shell.shell_get_terminal_status();
  },
  shell_get_terminal_profiles() {
    const shell = getDesktopShell();
    if (shell.shell_get_terminal_profiles === undefined) {
      return Promise.resolve([]);
    }
    return shell.shell_get_terminal_profiles();
  },
  shell_open_preview_file(projectPath: string, relativePath: string) {
    const shell = getDesktopShell();
    if (shell.shell_open_preview_file === undefined) {
      return Promise.reject(new Error("shell_open_preview_file is not implemented in this environment"));
    }
    return shell.shell_open_preview_file(projectPath, relativePath);
  },
};
