/**
 * In-process Local Encrypted Storage backend.
 *
 * Provides a fully working implementation of the five storage-related
 * `DesktopShell` methods:
 *
 *   • `encryptLocalSecret`
 *   • `decryptLocalSecret`
 *   • `readLocalSetting`
 *   • `writeLocalSetting`
 *   • `deleteLocalSetting`
 *
 * It is composed of three pluggable pieces — `SecretCipher`,
 * `KeyMaterialProvider`, `LocalKvStore` — and exposed in two flavours:
 *
 *   1. `LocalEncryptedStorage` — a typed object methods can be called
 *      on directly (used by the in-process shell, by `Settings_Store`
 *      tests, and any non-Tauri host).
 *   2. `createInvokeForLocalStorage` — adapts the same backend to the
 *      Tauri `invoke` shape so it can be plugged into the renderer
 *      bridge via `setInvoke(...)`. This is what unit tests use to
 *      drive the real `nativeDesktopShell` end-to-end without booting
 *      Tauri.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import type {
  EncryptedBlob,
  ExportFileResult,
  LocalLogEntry,
} from "../shell/types.js";
import { DESKTOP_SHELL_COMMANDS } from "../shell/nativeBindings.js";
import {
  AesGcmSecretCipher,
} from "./secretCipher.js";
import { RandomInMemoryKeyMaterialProvider } from "./keyProvider.js";
import { InMemoryLocalKvStore } from "./localKvStore.js";
import type {
  KeyMaterialProvider,
  LocalKvStore,
  SecretCipher,
} from "./types.js";

/**
 * Settings keys reserved for cipher-encrypted secrets.
 *
 * Production callers (`Settings_Store.upsertApiKey`, task 6.1) build
 * keys like `secret:openai` after running the plaintext through
 * `encryptLocalSecret`. The convention is enforced by `Settings_Store`,
 * not by the storage layer itself — the storage layer only ever sees
 * already-encrypted blobs and treats them as opaque JSON.
 */
export const ENCRYPTED_SETTING_PREFIX = "secret:";

/**
 * Configuration accepted by {@link LocalEncryptedStorage}.
 */
export interface LocalEncryptedStorageOptions {
  /** AEAD cipher used to wrap/unwrap secrets. */
  readonly cipher: SecretCipher;
  /** Persistent JSON store for non-secret settings and wrapped blobs. */
  readonly kv: LocalKvStore;
}

/**
 * Backing object implementing the storage half of `DesktopShell`.
 *
 * The instance owns its `cipher` and `kv` — callers should not share
 * a `cipher` between processes that don't share the same key, because
 * blobs are not portable across keys (this is intentional; see
 * Requirement 1.6: secrets are tied to the device).
 */
export class LocalEncryptedStorage {
  public readonly cipher: SecretCipher;
  public readonly kv: LocalKvStore;

  public constructor(options: LocalEncryptedStorageOptions) {
    this.cipher = options.cipher;
    this.kv = options.kv;
  }

  /**
   * Encrypts a plaintext secret. The caller is expected to immediately
   * persist the returned blob (typically by passing it to
   * `writeLocalSetting` under a `secret:` key) and discard the
   * plaintext.
   */
  public async encryptLocalSecret(plaintext: string): Promise<EncryptedBlob> {
    return this.cipher.encrypt(plaintext);
  }

  /**
   * Decrypts a previously encrypted blob. Per the design rules this
   * is intended for server-side components only (`SettingsStore.
   * resolveApiKeySecret`); it is exposed here so those components
   * can call it through the bridge.
   */
  public async decryptLocalSecret(blob: EncryptedBlob): Promise<string> {
    return this.cipher.decrypt(blob);
  }

  /**
   * Reads a setting. Encrypted blobs are returned as-is — decryption
   * MUST be performed via `decryptLocalSecret` by the authorised
   * server-side caller.
   */
  public async readLocalSetting<T = unknown>(key: string): Promise<T | null> {
    return this.kv.read<T>(key);
  }

  /**
   * Writes a setting. Refuses to persist anything that "looks like"
   * a raw secret under a `secret:` key — only `EncryptedBlob`-shaped
   * values are accepted there. This is a defence-in-depth check on
   * top of the `Settings_Store` contract: a buggy caller cannot
   * accidentally persist a plaintext API key.
   */
  public async writeLocalSetting(key: string, value: unknown): Promise<void> {
    if (key.startsWith(ENCRYPTED_SETTING_PREFIX) && !isEncryptedBlob(value)) {
      throw new Error(
        `LocalEncryptedStorage: refusing to persist a non-EncryptedBlob value ` +
          `under key "${key}". Encrypt with encryptLocalSecret first.`,
      );
    }
    return this.kv.write(key, value);
  }

  /** Deletes a setting. Resolves whether or not the key existed. */
  public async deleteLocalSetting(key: string): Promise<void> {
    return this.kv.delete(key);
  }
}

/**
 * Builds a default in-process storage suitable for tests, fast-check
 * property tests and headless runs of the renderer.
 *
 * Provides:
 *   • `RandomInMemoryKeyMaterialProvider` — fresh per-instance key.
 *   • `AesGcmSecretCipher`               — real AES-256-GCM via WebCrypto.
 *   • `InMemoryLocalKvStore`             — Map-backed JSON store.
 */
export function createInMemoryEncryptedStorage(options?: {
  keyProvider?: KeyMaterialProvider;
  kv?: LocalKvStore;
}): LocalEncryptedStorage {
  const keyProvider =
    options?.keyProvider ?? new RandomInMemoryKeyMaterialProvider();
  return new LocalEncryptedStorage({
    cipher: new AesGcmSecretCipher(keyProvider),
    kv: options?.kv ?? new InMemoryLocalKvStore(),
  });
}

/**
 * Checks whether a value matches the public `EncryptedBlob` shape.
 *
 * The check is intentionally structural rather than nominal so the
 * value can come from anywhere (e.g. parsed from a JSON file written
 * by an earlier session) and still pass.
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v["algorithm"] === "string" &&
    typeof v["ciphertext"] === "string" &&
    typeof v["createdAt"] === "string"
  );
}

/**
 * Tauri `invoke` shape — duplicated locally to avoid importing the
 * real type from `@tauri-apps/api`, which is optional at build time.
 */
export type InvokeFn = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * Configuration for {@link createInvokeForLocalStorage}. Other
 * desktop-shell commands (device id, log writer, file export,
 * notifications) are stubbed — passing real handlers here lets tests
 * exercise the full command surface against an in-memory backend.
 */
export interface InvokeAdapterOptions {
  readonly storage: LocalEncryptedStorage;
  /** Returns the device id. Defaults to a fixed test value. */
  readonly getDeviceId?: () => Promise<string> | string;
  /** Receives writes from `writeLocalLog`. Defaults to a no-op. */
  readonly writeLocalLog?: (entry: LocalLogEntry) => Promise<void> | void;
  /** Handles `exportFile`. Defaults to throwing — tests opt in. */
  readonly exportFile?: (input: {
    suggestedFileName: string;
    bytes: number[];
  }) => Promise<ExportFileResult> | ExportFileResult;
  /** Handles `showNotification`. Defaults to a no-op. */
  readonly showNotification?: (input: {
    title: string;
    body: string;
  }) => Promise<void> | void;
  /**
   * Handles `shell_provider_probe`. Defaults to a stub that returns
   * an empty 200 OK body so tests that don't care about the probe
   * still get a valid response shape.
   */
  readonly probeProvider?: (request: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }) =>
    | Promise<{ status: number; ok: boolean; body: string }>
    | { status: number; ok: boolean; body: string };
}

/**
 * Adapts a {@link LocalEncryptedStorage} (and optional auxiliary
 * handlers) to the Tauri `invoke(cmd, args)` shape.
 *
 * Tests use this to drive the real `nativeDesktopShell` end-to-end
 * without standing up Tauri:
 *
 * ```ts
 * const storage = createInMemoryEncryptedStorage();
 * setInvoke(createInvokeForLocalStorage({ storage }));
 * await desktopShell.encryptLocalSecret("api-key");  // works
 * ```
 *
 * The function recognises only commands defined in
 * `DESKTOP_SHELL_COMMANDS`; unknown commands reject so missing
 * handlers are visible.
 */
export function createInvokeForLocalStorage(
  options: InvokeAdapterOptions,
): InvokeFn {
  const {
    storage,
    getDeviceId = () => "test-device",
    writeLocalLog = () => undefined,
    exportFile,
    showNotification = () => undefined,
    probeProvider = () => ({ status: 200, ok: true, body: "" }),
  } = options;

  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    switch (cmd) {
      case DESKTOP_SHELL_COMMANDS.getDeviceId: {
        const id = await Promise.resolve(getDeviceId());
        return id as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.readLocalSetting: {
        const key = requireStringArg(args, "key");
        const value = await storage.readLocalSetting(key);
        return value as T;
      }

      case DESKTOP_SHELL_COMMANDS.writeLocalSetting: {
        const key = requireStringArg(args, "key");
        const value = (args ?? {})["value"];
        await storage.writeLocalSetting(key, value);
        return undefined as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.deleteLocalSetting: {
        const key = requireStringArg(args, "key");
        await storage.deleteLocalSetting(key);
        return undefined as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.encryptLocalSecret: {
        const secret = requireStringArg(args, "secret");
        const blob = await storage.encryptLocalSecret(secret);
        return blob as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.decryptLocalSecret: {
        const blob = (args ?? {})["blob"];
        if (!isEncryptedBlob(blob)) {
          throw new Error(
            `decryptLocalSecret: "blob" argument is not an EncryptedBlob.`,
          );
        }
        const plaintext = await storage.decryptLocalSecret(blob);
        return plaintext as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.writeLocalLog: {
        const entry = (args ?? {})["entry"] as LocalLogEntry | undefined;
        if (entry === undefined) {
          throw new Error(`writeLocalLog: missing "entry" argument.`);
        }
        await Promise.resolve(writeLocalLog(entry));
        return undefined as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.exportFile: {
        if (exportFile === undefined) {
          throw new Error(
            `exportFile: no handler configured in InvokeAdapterOptions.`,
          );
        }
        const suggested = requireStringArg(args, "suggestedFileName");
        const bytes = (args ?? {})["bytes"];
        if (!Array.isArray(bytes)) {
          throw new Error(`exportFile: "bytes" must be an array of numbers.`);
        }
        const result = await Promise.resolve(
          exportFile({
            suggestedFileName: suggested,
            bytes: bytes as number[],
          }),
        );
        return result as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.showNotification: {
        const title = requireStringArg(args, "title");
        const body = requireStringArg(args, "body");
        await Promise.resolve(showNotification({ title, body }));
        return undefined as unknown as T;
      }

      case DESKTOP_SHELL_COMMANDS.probeProvider: {
        const request = (args ?? {})["request"];
        if (
          typeof request !== "object" ||
          request === null ||
          typeof (request as { url?: unknown }).url !== "string" ||
          typeof (request as { method?: unknown }).method !== "string"
        ) {
          throw new Error(
            `probeProvider: missing or malformed "request" argument.`,
          );
        }
        const r = request as {
          url: string;
          method: "GET" | "POST";
          headers?: Record<string, string>;
          body?: string;
          timeoutMs?: number;
        };
        const result = await Promise.resolve(
          probeProvider({
            url: r.url,
            method: r.method,
            headers: r.headers ?? {},
            ...(r.body !== undefined ? { body: r.body } : {}),
            ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
          }),
        );
        return result as unknown as T;
      }

      default:
        throw new Error(`createInvokeForLocalStorage: unknown command "${cmd}".`);
    }
  };
}

/** Validates that `args[name]` is a string. */
function requireStringArg(
  args: Record<string, unknown> | undefined,
  name: string,
): string {
  const value = (args ?? {})[name];
  if (typeof value !== "string") {
    throw new Error(`Argument "${name}" must be a string.`);
  }
  return value;
}
