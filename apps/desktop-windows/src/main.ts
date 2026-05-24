/**
 * Renderer entry point for the Windows Desktop App main window.
 *
 * Boot sequence:
 *
 * 1. Wire the Tauri `invoke` binding into the native bindings layer
 *    so calls flow Renderer → bridge → nativeBindings → Tauri command
 *    → Rust handler. This is the only place where Tauri's API is
 *    imported directly.
 * 2. Wrap the raw `invoke` with a renderer-side handler for the
 *    storage / encryption / device-id commands that the Rust side has
 *    not implemented yet (see `apps/desktop-windows/src-tauri/src/lib.rs`
 *    — every `shell_*_local_*` and `shell_*_secret` handler returns
 *    `NotImplemented` until SQLCipher + keyring lands). The renderer
 *    has a fully-working `LocalEncryptedStorage` so the user can
 *    save API keys today; the Rust side becomes the source of truth
 *    when it's wired.
 *    `shell_provider_probe` keeps using the real Tauri command so
 *    HTTP requests bypass the WebView CORS / CSP restrictions.
 * 3. Install the resulting `DesktopShell` into the bridge so the rest
 *    of the renderer can simply `import { desktopShell } from "./shell"`.
 * 4. Hand control to `bootstrapUi`, which renders the login screen.
 *
 * Validates: Requirements 1.1, 1.3, 1.4, 1.6, 2.5, 4.5.
 */

import { bootstrapUi } from "./ui/bootstrap.js";
import {
  createApplicationShell,
  installDesktopShell,
  nativeDesktopShell,
  setInvoke,
  DESKTOP_SHELL_COMMANDS,
} from "./shell/index.js";
import {
  AesGcmSecretCipher,
  BrowserLocalStorageKvStore,
  LocalEncryptedStorage,
  createInvokeForLocalStorage,
  type InvokeFn,
} from "./storage/index.js";

if (typeof document !== "undefined") {
  document.title = "KARO AI Agent Orchestrator";
}

/**
 * Detects whether the renderer is running inside the Tauri shell. The
 * Tauri runtime injects `__TAURI_INTERNALS__` on `window` before any
 * user code runs.
 */
function isRunningInTauri(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(window, "__TAURI_INTERNALS__") ||
    "__TAURI_IPC__" in window ||
    "__TAURI__" in window
  );
}

/**
 * Loads the Tauri `invoke` binding. Returns `null` when the package
 * is not installed (e.g. running renderer tests outside Tauri).
 */
async function loadTauriInvoke(): Promise<InvokeFn | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - the package is only available when Tauri is installed.
    const mod = (await import("@tauri-apps/api/core")) as {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
    return mod.invoke;
  } catch (error) {
     
    console.error("Failed to load @tauri-apps/api/core", error);
    return null;
  }
}

const KEY_MATERIAL_STORAGE_KEY = "shell:keyMaterial";

/**
 * Builds the renderer-side `LocalEncryptedStorage` used to satisfy the
 * `shell_*_local_*` and `shell_*_secret` commands while the Rust side
 * is still stubbed out.
 *
 *   • The KV layer is `BrowserLocalStorageKvStore` — the WebView's
 *     `localStorage`, which Edge persists in
 *     `%LOCALAPPDATA%\<bundle id>\EBWebView`. That gives us
 *     restart-stable storage scoped to this Windows user, which is
 *     exactly the design's "local-only, device-bound" requirement.
 *   • The cipher is AES-256-GCM with a 32-byte key minted on first
 *     launch and persisted (also in `localStorage`) under
 *     `shell:keyMaterial`. The key never leaves the renderer process;
 *     the encrypted-blob format mirrors what the future Rust side
 *     will produce so a user's data will roundtrip when SQLCipher
 *     replaces this layer.
 */
function createRendererLocalStorage(): LocalEncryptedStorage {
  const kv = new BrowserLocalStorageKvStore();
  // Cipher key bootstrap: try to read a saved hex string first so the
  // cipher survives reloads. If absent, generate a fresh key and save
  // it. The key is base64url-encoded to keep `localStorage` clean.
  let keyBytes: Uint8Array;
  const saved =
    typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
          KEY_MATERIAL_STORAGE_KEY,
        )
      : null;
  if (saved !== null) {
    try {
      keyBytes = base64ToBytes(saved);
    } catch {
      keyBytes = mintKey();
      saveKey(keyBytes);
    }
  } else {
    keyBytes = mintKey();
    saveKey(keyBytes);
  }
  const provider = new (class {
    private readonly bytes: Uint8Array;
    public constructor(b: Uint8Array) {
      this.bytes = b;
    }
    public getKeyBytes(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array(this.bytes));
    }
  })(keyBytes);

  return new LocalEncryptedStorage({
    cipher: new AesGcmSecretCipher(provider),
    kv,
  });
}

function mintKey(): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error(
      "main: globalThis.crypto.getRandomValues is required to mint a local encryption key.",
    );
  }
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

function saveKey(bytes: Uint8Array): void {
  if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
    return;
  }
  (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
    KEY_MATERIAL_STORAGE_KEY,
    bytesToBase64(bytes),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Builds the hybrid `invoke` that the renderer registers via
 * `setInvoke`.
 *
 * Routing:
 *
 *   • `shell_provider_probe` — forwarded to the real Tauri invoke so
 *     the HTTP probe runs in Rust (avoids WebView CORS/CSP).
 *   • Every storage / encryption / device-id command — handled by
 *     `createInvokeForLocalStorage` against the renderer-side
 *     `LocalEncryptedStorage`.
 *   • Anything else — forwarded to the Tauri invoke if available, or
 *     a clear "command not implemented yet" error if not.
 */
function createHybridInvoke(tauriInvoke: InvokeFn | null): InvokeFn {
  const storage = createRendererLocalStorage();
  // Stable per-install device id, persisted in the same KV store so
  // it survives restarts. The renderer's `applicationShell` decorator
  // memoises this through its own resolver, so we just need to read /
  // write a single key here.
  const localStorageInvoke = createInvokeForLocalStorage({
    storage,
    getDeviceId: async () => {
      // Use the same setting key the application shell's
      // `createDeviceIdResolver` uses so a direct `shell_get_device_id`
      // invocation and the resolver agree on a single value.
      const existing = await storage.readLocalSetting<string>(
        "shell.deviceId",
      );
      if (typeof existing === "string" && existing.length > 0) {
        return existing;
      }
      const generated =
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `device-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
      await storage.writeLocalSetting("shell.deviceId", generated);
      return generated;
    },
    writeLocalLog: () => undefined,
    showNotification: () => undefined,
  });

  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    // The provider-probe command must hit Rust — that's the whole
    // reason it exists (HTTP from inside the WebView is blocked by
    // CORS).
    if (
      cmd === DESKTOP_SHELL_COMMANDS.probeProvider ||
      cmd === DESKTOP_SHELL_COMMANDS.validateFolderPath ||
      cmd === DESKTOP_SHELL_COMMANDS.readProjectSummary ||
      cmd === DESKTOP_SHELL_COMMANDS.shellReadFile ||
      cmd === DESKTOP_SHELL_COMMANDS.shellWriteStagedFile ||
      cmd === DESKTOP_SHELL_COMMANDS.shellGetStagedChanges ||
      cmd === DESKTOP_SHELL_COMMANDS.shellApplyStagedChanges ||
      cmd === DESKTOP_SHELL_COMMANDS.shellCreateTaskRun ||
      cmd === DESKTOP_SHELL_COMMANDS.shellUpdateTaskRun ||
      cmd === DESKTOP_SHELL_COMMANDS.shellGetTaskRun ||
      cmd === DESKTOP_SHELL_COMMANDS.shellListTaskRuns ||
      cmd === DESKTOP_SHELL_COMMANDS.shellAddAgentRun ||
      cmd === DESKTOP_SHELL_COMMANDS.shellAddArtifact ||
      cmd === DESKTOP_SHELL_COMMANDS.shellScanProjectContext ||
      cmd === DESKTOP_SHELL_COMMANDS.shellBuildTaskContext ||
      cmd === DESKTOP_SHELL_COMMANDS.shellStartCommand ||
      cmd === DESKTOP_SHELL_COMMANDS.shellStopCommand ||
      cmd === DESKTOP_SHELL_COMMANDS.shellGetCommandOutput ||
      cmd === DESKTOP_SHELL_COMMANDS.shellClearCommandOutput ||
      cmd === DESKTOP_SHELL_COMMANDS.shellGetTerminalStatus
    ) {
      if (tauriInvoke === null) {
        throw new Error(
          `${cmd} is not available because the Tauri runtime is missing.`,
        );
      }
      return tauriInvoke<T>(cmd, args);
    }

    // Storage / encryption / device-id / log / notification — handled
    // entirely in the renderer. This is the "stop-gap" half of the
    // hybrid: the Rust handlers are still `NotImplemented`, but the
    // renderer has a fully working in-process implementation.
    try {
      return await localStorageInvoke<T>(cmd, args);
    } catch (rendererErr) {
      // Unknown command for the renderer-side adapter — try the real
      // Tauri invoke as a last resort so future commands route there.
      if (
        tauriInvoke !== null &&
        rendererErr instanceof Error &&
        /unknown command/i.test(rendererErr.message)
      ) {
        return tauriInvoke<T>(cmd, args);
      }
      throw rendererErr;
    }
  };
}

/**
 * Application bootstrap. Errors during shell wiring are not fatal —
 * the UI renders a clear "shell unavailable" notice so the developer
 * can see what failed.
 */
async function main(): Promise<void> {
  let tauriInvoke: InvokeFn | null = null;
  if (isRunningInTauri()) {
    tauriInvoke = await loadTauriInvoke();
  }
  setInvoke(createHybridInvoke(tauriInvoke));

  installDesktopShell(createApplicationShell({ inner: nativeDesktopShell }));

  bootstrapUi(document.getElementById("app"));
}

void main();
