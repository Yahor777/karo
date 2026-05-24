/**
 * Device id generation and persistence.
 *
 * The Desktop Shell exposes `getDeviceId()` (see `types.ts`). Per
 * Requirement 1.4 the value must be stable across launches: generated
 * once on first launch, persisted, and returned identically on every
 * subsequent call.
 *
 * Constraints driven by the parallel implementation of task 3.2
 * (Local Encrypted Storage):
 *
 * - The device id is **not** a secret. It is a coarse, per-install
 *   identifier used by the Auth Service for `Scope: { kind: "local",
 *   deviceId }`. We therefore do **not** route it through
 *   `encryptLocalSecret` — that is owned by 3.2 and would couple this
 *   module to encryption internals it does not need.
 * - We persist the value through a small key-value storage interface
 *   (`DeviceIdStorage`). The default implementation uses
 *   `readLocalSetting` / `writeLocalSetting` from the Desktop Shell,
 *   which 3.2 can re-implement on top of encrypted SQLite without
 *   touching this file.
 * - The module is also dependency-injectable for tests: pass any
 *   in-memory `DeviceIdStorage` and a deterministic `randomUuid()`.
 *
 * Validates: Requirements 1.4, 1.6.
 */

/**
 * Storage key under which the persisted device id is stored. Kept
 * here (not in nativeBindings) because it is a logical setting name,
 * not a Tauri command name.
 */
export const DEVICE_ID_SETTING_KEY = "shell.deviceId";

/**
 * Minimal key-value contract used by the device id resolver. This is
 * a subset of `DesktopShell` deliberately — the device id needs no
 * encryption and no IPC of its own.
 */
export interface DeviceIdStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/**
 * Source of randomness. `crypto.randomUUID()` is available in modern
 * browser/Node runtimes and inside Tauri's WebView. The interface is
 * stubbed out so tests can inject a deterministic generator without
 * monkey-patching `globalThis.crypto`.
 */
export type RandomUuidSource = () => string;

/**
 * Default UUID v4 generator. Falls back to a hand-rolled RFC 4122
 * v4 implementation when `crypto.randomUUID` is unavailable so the
 * module also works inside the older test harnesses we ship with.
 */
export const defaultRandomUuid: RandomUuidSource = () => {
  const cryptoRef =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (cryptoRef !== undefined && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  if (cryptoRef !== undefined && typeof cryptoRef.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoRef.getRandomValues(bytes);
    return formatUuidV4(bytes);
  }
  // Last-resort fallback. `Math.random` is cryptographically weak,
  // but the device id is non-secret so this is acceptable for the
  // narrow case where neither `randomUUID` nor `getRandomValues`
  // is available (e.g. an old jsdom build in CI).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return formatUuidV4(bytes);
};

/**
 * Formats 16 random bytes as a canonical UUID v4 string. Sets the
 * version (bits 12-15 of `time_hi_and_version`) and variant (bits
 * 6-7 of `clock_seq_hi_and_reserved`) per RFC 4122 §4.4.
 */
function formatUuidV4(bytes: Uint8Array): string {
  // Set version 4.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  // Set IETF variant.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, "0"));
  }
  return (
    `${hex.slice(0, 4).join("")}-` +
    `${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-` +
    `${hex.slice(8, 10).join("")}-` +
    `${hex.slice(10, 16).join("")}`
  );
}

/**
 * Validates that a stored value matches the canonical UUID v4 shape.
 * Used to reject corrupted entries on read so the next call regenerates
 * a clean value rather than propagating garbage to the rest of the
 * system.
 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

/**
 * Options for `createDeviceIdResolver`. All fields are optional;
 * defaults are used in production, overrides are used in tests.
 */
export type DeviceIdResolverOptions = {
  readonly storage: DeviceIdStorage;
  readonly randomUuid?: RandomUuidSource;
  readonly key?: string;
};

/**
 * Returns a function that resolves to the persistent device id.
 *
 * Behaviour:
 *
 * 1. Read the value from storage.
 * 2. If a valid UUID v4 is present, return it.
 * 3. Otherwise generate a fresh UUID v4, persist it and return it.
 *
 * The returned resolver memoises the result for the lifetime of the
 * resolver instance so concurrent callers during boot don't generate
 * competing ids. The first in-flight call wins; any concurrent calls
 * await the same promise.
 */
export function createDeviceIdResolver(
  options: DeviceIdResolverOptions,
): () => Promise<string> {
  const storage = options.storage;
  const randomUuid = options.randomUuid ?? defaultRandomUuid;
  const key = options.key ?? DEVICE_ID_SETTING_KEY;

  let pending: Promise<string> | null = null;

  return function getDeviceId(): Promise<string> {
    if (pending !== null) {
      return pending;
    }
    pending = (async () => {
      try {
        const stored = await storage.read(key);
        if (isValidDeviceId(stored)) {
          return stored;
        }
        const fresh = randomUuid();
        await storage.write(key, fresh);
        return fresh;
      } catch (error) {
        // Reset memoisation on failure so the next caller can retry.
        pending = null;
        throw error;
      }
    })();
    return pending;
  };
}

/**
 * Adapter that exposes a `DesktopShell`-shaped object as a
 * `DeviceIdStorage`. Used by the application shell to hand the
 * resolver a storage backed by the renderer ↔ shell bridge.
 *
 * Only the two settings methods are required, which keeps this
 * adapter compatible with any future storage swap performed by
 * task 3.2.
 */
export interface SettingsStorageLike {
  readLocalSetting<T = unknown>(key: string): Promise<T | null>;
  writeLocalSetting(key: string, value: unknown): Promise<void>;
}

/**
 * Wraps a `DesktopShell`-shaped object as a `DeviceIdStorage`. The
 * adapter is permissive about read shapes: any non-string is treated
 * as a missing entry and triggers regeneration.
 */
export function deviceIdStorageFromSettings(
  settings: SettingsStorageLike,
  key: string = DEVICE_ID_SETTING_KEY,
): DeviceIdStorage {
  return {
    async read(): Promise<string | null> {
      const raw = await settings.readLocalSetting<unknown>(key);
      return typeof raw === "string" ? raw : null;
    },
    async write(_key, value): Promise<void> {
      await settings.writeLocalSetting(key, value);
    },
  };
}
