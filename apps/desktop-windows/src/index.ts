/**
 * Public package surface for `@ai-agent-orchestrator/desktop-windows`.
 *
 * The application itself boots from `src/main.ts` (loaded by
 * `index.html` / Tauri). This barrel exists so other workspace
 * packages — and tests — can import the desktop shell contract.
 */

export const desktopAppName = "AI Agent Orchestrator";

export type {
  DesktopShell,
  EncryptedBlob,
  ExportFileInput,
  ExportFileResult,
  LocalLogEntry,
  ShowNotificationInput,
} from "./shell/index.js";

export {
  desktopShell,
  getDesktopShell,
  installDesktopShell,
  nativeDesktopShell,
  setInvoke,
  resetInvoke,
  DESKTOP_SHELL_COMMANDS,
  DESKTOP_SHELL_ERROR_TAG,
  DesktopShellNotImplementedError,
  createApplicationShell,
  DEVICE_ID_SETTING_KEY,
  createDeviceIdResolver,
  defaultRandomUuid,
  deviceIdStorageFromSettings,
  isValidDeviceId,
  redactLogEntry,
  redactString,
  redactValue,
} from "./shell/index.js";

export type {
  KeyMaterialProvider,
  LocalKvStore,
  SecretCipher,
  InvokeAdapterOptions,
  InvokeFn,
  LocalEncryptedStorageOptions,
} from "./storage/index.js";

export {
  AES_256_GCM_ALGORITHM,
  AES_256_KEY_LENGTH,
  AES_GCM_IV_LENGTH,
  AesGcmSecretCipher,
  ENCRYPTED_SETTING_PREFIX,
  InMemoryKeyMaterialProvider,
  InMemoryLocalKvStore,
  JsonFileLocalKvStore,
  LocalEncryptedStorage,
  RandomInMemoryKeyMaterialProvider,
  createInMemoryEncryptedStorage,
  createInvokeForLocalStorage,
  isEncryptedBlob,
} from "./storage/index.js";
