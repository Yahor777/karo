/**
 * Public surface of the desktop shell.
 *
 * Renderer code consumes the shell exclusively through this barrel:
 *
 * ```ts
 * import { desktopShell } from "../shell";
 * ```
 *
 * The native bindings module is intentionally re-exported as well so
 * `main.ts` can call `setInvoke` once at boot, but UI code should
 * never use it directly.
 *
 * Validates: Requirements 1.3, 1.4, 1.6.
 */

export type {
  DesktopShell,
  EncryptedBlob,
  ExportFileInput,
  ExportFileResult,
  LocalLogEntry,
  ProjectSummaryFile,
  ProjectSummaryResult,
  ProjectSummarySnippet,
  ProviderProbeRequest,
  ProviderProbeResponse,
  ProjectKind,
  RuntimeArtifactRecord,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeProjectProfile,
  RuntimeRecoveryState,
  RuntimeRunMode,
  RuntimeRunStatus,
  RuntimeTaskRun,
  RuntimeValidationRecord,
  ShowNotificationInput,
  ValidateFolderPathResult,
} from "./types.js";

export {
  desktopShell,
  getDesktopShell,
  installDesktopShell,
} from "./bridge.js";

export {
  DESKTOP_SHELL_COMMANDS,
  DESKTOP_SHELL_ERROR_TAG,
  DesktopShellNotImplementedError,
  nativeDesktopShell,
  resetInvoke,
  setInvoke,
} from "./nativeBindings.js";

export {
  createApplicationShell,
  type ApplicationShellOptions,
} from "./applicationShell.js";

export {
  DEVICE_ID_SETTING_KEY,
  createDeviceIdResolver,
  defaultRandomUuid,
  deviceIdStorageFromSettings,
  isValidDeviceId,
  type DeviceIdResolverOptions,
  type DeviceIdStorage,
  type RandomUuidSource,
  type SettingsStorageLike,
} from "./deviceId.js";

export {
  redactLogEntry,
  redactString,
  redactValue,
} from "./redaction.js";
