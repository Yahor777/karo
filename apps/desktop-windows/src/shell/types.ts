/**
 * DesktopShell interface and related value types.
 *
 * Mirrors the contract defined in the design document
 * (`design.md` → "Components and Interfaces" → "Desktop Shell").
 *
 * The renderer process MUST consume these capabilities only through the
 * single secure bridge entrypoint exposed by `./bridge.ts` — it MUST NOT
 * perform IPC or call native bindings directly. This boundary is what
 * keeps API_Key material from leaking back to untrusted UI code after
 * the user confirms saving (see Requirement 1.6 and the Desktop Shell
 * security rules in `design.md`).
 *
 * Validates: Requirements 1.1, 1.3, 1.4, 1.6.
 */

import type {
  TraceEvent,
  ArtifactVersion,
  ArtifactMetadata,
  TaskStateSnapshot,
  FinalReportSummary,
} from "../orchestration/types.js";

export type ApplyResult = {
  readonly success: boolean;
  readonly changedFiles: string[];
  readonly createdFiles: string[];
  readonly overwrittenFiles: string[];
  readonly skippedFiles: string[];
  readonly errors: string[];
};

export type TaskInternalPersistent = {
  readonly state: TaskStateSnapshot;
  readonly trace: TraceEvent[];
  readonly nextSequence: number;
  readonly artifacts: ArtifactVersion[];
  readonly artifactMeta: ArtifactMetadata[];
  readonly finalReport: FinalReportSummary | null;
  readonly applyResult: ApplyResult | null;
};

/**
 * An encrypted secret produced by the Desktop Shell. The Shell decides
 * the algorithm (e.g. AES-GCM with an OS-backed key). Plaintext never
 * leaves the Shell once `encryptLocalSecret` has returned.
 */
export type EncryptedBlob = {
  /** Algorithm tag, e.g. "aes-256-gcm". */
  readonly algorithm: string;
  /** Base64-encoded ciphertext + auth tag + IV (format is shell-defined). */
  readonly ciphertext: string;
  /** ISO 8601 UTC timestamp with millisecond precision. */
  readonly createdAt: string;
};

/**
 * A single local log entry. The Shell is responsible for redacting
 * any API-key-shaped values found in `message` or `context` before
 * persisting (see Requirement 1.6 and Desktop Shell security rules).
 */
export type LocalLogEntry = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly context?: unknown;
  /** ISO 8601 UTC timestamp with millisecond precision. */
  readonly at: string;
};

/**
 * Input shape for `DesktopShell.exportFile`.
 */
export type ExportFileInput = {
  readonly suggestedFileName: string;
  readonly bytes: Uint8Array;
};

/**
 * Result shape for `DesktopShell.exportFile`.
 */
export type ExportFileResult = {
  readonly savedPath: string;
};

/**
 * Input shape for `DesktopShell.showNotification`.
 */
export type ShowNotificationInput = {
  readonly title: string;
  readonly body: string;
};

export type ValidateFolderPathResult =
  | { readonly ok: true; readonly normalizedPath: string }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "not_directory"
        | "permission_denied"
        | "invalid_path";
      readonly message: string;
    };

export type ProjectSummaryFile = {
  readonly path: string;
  readonly kind: "file" | "directory";
};

export type ProjectSummarySnippet = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
};

export type ProjectSummaryResult = {
  readonly rootPath: string;
  readonly files: readonly ProjectSummaryFile[];
  readonly snippets: readonly ProjectSummarySnippet[];
  readonly omitted: readonly string[];
};

export type TerminalStatus = "idle" | "running" | "exited" | "error" | "blocked";

export type TerminalOutputLine = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly at: string;
};

export type TerminalStartResult = {
  readonly sessionId: string;
  readonly status: TerminalStatus;
  readonly allowed: boolean;
  readonly profileId?: string;
  readonly reason?: string;
};

export type TerminalOutput = {
  readonly sessionId: string;
  readonly status: TerminalStatus;
  readonly exitCode?: number | null;
  readonly lines: readonly TerminalOutputLine[];
};

export type TerminalStatusResult = {
  readonly sessionId?: string | null;
  readonly status: TerminalStatus;
};

export type TerminalProfile = {
  readonly id: string;
  readonly label: string;
  readonly shell: string;
  readonly available: boolean;
};

export type OpenPreviewFileResult = {
  readonly path: string;
  readonly opened: boolean;
};

/**
 * Input shape for `DesktopShell.probeProvider`.
 *
 * Issuing the request from the Rust side avoids two issues that block
 * a renderer-side `fetch`:
 *
 *   • The Tauri WebView's CSP (`connect-src 'self' ipc: tauri:`) blocks
 *     outbound HTTPS to provider domains by default.
 *   • Provider responses do not carry `Access-Control-Allow-Origin`
 *     headers for arbitrary `tauri://localhost` origins, so even a
 *     permissive CSP would fail the WebView's CORS preflight.
 *
 * The Rust side therefore performs the request via `reqwest` and
 * returns the verbatim status/body so the renderer can apply the same
 * response translation logic as the in-process probe adapters.
 */
export type ProviderProbeRequest = {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
};

/**
 * Result shape returned by `DesktopShell.probeProvider`. The renderer
 * inspects `status`/`ok`/`body` to translate into a structured
 * `ValidationResult` exactly like `auth/providerProbe.ts` does.
 */
export type ProviderProbeResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
};

/**
 * Native integration surface exposed to the renderer through a single
 * secure bridge. Implementations in subsequent tasks (3.2, 3.3, 4.x)
 * back this with encrypted SQLite, OS keychain and Tauri commands.
 */
export interface DesktopShell {
  /**
   * Returns the stable per-device identifier. The Shell generates and
   * persists it on first launch and returns the same value on every
   * subsequent call (Requirement 1.4).
   */
  getDeviceId(): Promise<string>;

  /**
   * Reads a non-secret local setting. Returns `null` when the key is
   * not present.
   */
  readLocalSetting<T = unknown>(key: string): Promise<T | null>;

  /**
   * Writes a non-secret local setting. Secret material MUST be
   * encrypted via `encryptLocalSecret` before storage.
   */
  writeLocalSetting(key: string, value: unknown): Promise<void>;

  /**
   * Removes a local setting. Successful deletion MUST resolve, never
   * reject — see Requirement 4.4.
   */
  deleteLocalSetting(key: string): Promise<void>;

  /**
   * Encrypts a secret using the Shell's OS-backed key material.
   * The plaintext value MUST NOT be retained after this call returns.
   */
  encryptLocalSecret(secret: string): Promise<EncryptedBlob>;

  /**
   * Decrypts a previously produced `EncryptedBlob`. Per the Desktop
   * Shell security rules this should only ever be called from a
   * server-side component that is about to make a Provider request,
   * never from arbitrary UI code.
   */
  decryptLocalSecret(blob: EncryptedBlob): Promise<string>;

  /**
   * Appends a structured entry to the local log file. Implementations
   * MUST redact API-key-shaped substrings before persisting.
   */
  writeLocalLog(entry: LocalLogEntry): Promise<void>;

  /**
   * Saves a binary artifact through the OS save-file dialog and
   * returns the chosen path.
   */
  exportFile(input: ExportFileInput): Promise<ExportFileResult>;

  /**
   * Displays a native desktop notification.
   */
  showNotification(input: ShowNotificationInput): Promise<void>;

  /**
   * Issues a single HTTP request against a provider on the renderer's
   * behalf. Used for API-key validation probes (Fireworks AI, OpenAI,
   * Anthropic, Custom OpenAI-compatible).
   *
   * The request runs in the Rust process, bypassing the WebView's
   * CORS / CSP restrictions. The handler returns the verbatim status
   * and body so the renderer can translate them into a structured
   * `ValidationResult`.
   *
   * Security: the API key in `request.headers` MUST NOT leak into
   * logs; both the renderer and the Rust handler honour this contract
   * (see `apps/desktop-windows/src-tauri/src/lib.rs`).
   */
  probeProvider(input: ProviderProbeRequest): Promise<ProviderProbeResponse>;

  /**
   * Validates that a user-provided project path exists and is a directory.
   * Optional so older test shells can omit it; production Tauri implements it.
   */
  validateFolderPath?(path: string): Promise<ValidateFolderPathResult>;

  /**
   * Reads a small, read-only project summary for Assist Mode. Must never
   * include node_modules, build output, VCS internals, or secret files.
   */
  readProjectSummary?(path: string): Promise<ProjectSummaryResult>;
  isNativeBridgeWired?(): boolean;

  shell_read_file?(projectPath: string, relativePath: string): Promise<string>;
  shell_write_staged_file?(projectPath: string, taskId: string, relativePath: string, content: string): Promise<void>;
  shell_get_staged_changes?(projectPath: string, taskId: string): Promise<string[]>;
  shell_apply_staged_changes?(projectPath: string, taskId: string, approval: boolean): Promise<ApplyResult>;
  shell_create_task_run?(task: TaskInternalPersistent): Promise<void>;
  shell_update_task_run?(task: TaskInternalPersistent): Promise<void>;
  shell_get_task_run?(taskId: string): Promise<TaskInternalPersistent | null>;
  shell_list_task_runs?(projectPath: string): Promise<TaskInternalPersistent[]>;
  shell_add_agent_run?(taskId: string, agentRun: TraceEvent): Promise<void>;
  shell_add_artifact?(taskId: string, version: ArtifactVersion, meta: ArtifactMetadata): Promise<void>;
  shell_scan_project_context?(projectPath: string): Promise<TaskContextPackage>;
  shell_build_task_context?(projectPath: string, prompt: string, options?: BuildTaskContextOptions): Promise<TaskContextPackage>;
  shell_start_command?(projectRoot: string, command: string, mode: "preview" | "manual", profileId?: string): Promise<TerminalStartResult>;
  shell_stop_command?(sessionId: string): Promise<TerminalOutput>;
  shell_get_command_output?(sessionId: string): Promise<TerminalOutput>;
  shell_clear_command_output?(sessionId: string): Promise<void>;
  shell_get_terminal_status?(): Promise<TerminalStatusResult>;
  shell_get_terminal_profiles?(): Promise<TerminalProfile[]>;
  shell_open_preview_file?(projectPath: string, relativePath: string): Promise<OpenPreviewFileResult>;
}

export type ProjectFileEntry = {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly extension?: string;
  readonly isText: boolean;
  readonly score: number;
  readonly reason: string[];
};

export type ContextFile = {
  readonly relativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly score: number;
  readonly reason: string[];
  readonly truncated: boolean;
};

export type IgnoredSummary = {
  readonly ignoredDirs: number;
  readonly ignoredFiles: number;
  readonly ignoredLargeFiles: number;
  readonly ignoredBinaryFiles: number;
  readonly ignoredSecretFiles: number;
};

export type TaskContextPackage = {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly fileTreeSummary: readonly ProjectFileEntry[];
  readonly selectedFiles: readonly ContextFile[];
  readonly ignoredSummary: IgnoredSummary;
  readonly tokenBudgetHint: number;
  readonly createdAt: string;
  readonly warnings: readonly string[];
  readonly scannedFilesCount: number;
  readonly selectedFilesCount: number;
};

export type BuildTaskContextOptions = {
  readonly maxFiles?: number;
  readonly maxTotalChars?: number;
  readonly includeContent?: boolean;
  readonly includeFileTree?: boolean;
  readonly selectedFiles?: string[];
  readonly currentFile?: string;
};
