/**
 * Unit tests for the device id resolver.
 *
 * Per Requirement 1.4 the value returned by `DesktopShell.getDeviceId`
 * must be stable across launches: generated once on first launch,
 * persisted, and returned identically on every subsequent call. These
 * tests pin down that contract through the dependency-injectable
 * `createDeviceIdResolver` factory:
 *
 *   • a fresh UUID v4 is generated and persisted on first call;
 *   • subsequent calls return the same memoised value without
 *     hitting storage again;
 *   • a freshly constructed resolver re-reads the persisted value,
 *     so the id survives a renderer restart;
 *   • concurrent first calls share a single in-flight promise.
 *
 * Validates: Requirements 1.4, 1.6.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEVICE_ID_SETTING_KEY,
  createDeviceIdResolver,
  defaultRandomUuid,
  deviceIdStorageFromSettings,
  isValidDeviceId,
  type DeviceIdStorage,
} from "./deviceId.js";

/**
 * Minimal in-memory storage for the resolver. Records every read and
 * write so tests can assert on call counts and ordering.
 */
function makeMemoryStorage(initial?: Map<string, string>): DeviceIdStorage & {
  readonly reads: string[];
  readonly writes: Array<[string, string]>;
  readonly state: Map<string, string>;
} {
  const state = initial ?? new Map<string, string>();
  const reads: string[] = [];
  const writes: Array<[string, string]> = [];
  return {
    state,
    reads,
    writes,
    async read(key: string): Promise<string | null> {
      reads.push(key);
      return state.has(key) ? (state.get(key) as string) : null;
    },
    async write(key: string, value: string): Promise<void> {
      writes.push([key, value]);
      state.set(key, value);
    },
  };
}

describe("createDeviceIdResolver", () => {
  it("generates a UUID v4 on the first call and persists it", async () => {
    const storage = makeMemoryStorage();
    const fixed = "11111111-2222-4333-8444-555555555555";
    const randomUuid = vi.fn(() => fixed);

    const resolve = createDeviceIdResolver({ storage, randomUuid });
    const id = await resolve();

    expect(id).toBe(fixed);
    expect(isValidDeviceId(id)).toBe(true);
    expect(randomUuid).toHaveBeenCalledTimes(1);
    expect(storage.writes).toEqual([[DEVICE_ID_SETTING_KEY, fixed]]);
    expect(storage.reads).toEqual([DEVICE_ID_SETTING_KEY]);
  });

  it("returns the same id on subsequent calls without reading or generating again", async () => {
    const storage = makeMemoryStorage();
    const randomUuid = vi.fn(() => "11111111-2222-4333-8444-555555555555");

    const resolve = createDeviceIdResolver({ storage, randomUuid });
    const a = await resolve();
    const b = await resolve();
    const c = await resolve();

    expect(a).toBe(b);
    expect(b).toBe(c);
    // Generated once.
    expect(randomUuid).toHaveBeenCalledTimes(1);
    // Storage is touched only on the first call (the subsequent calls
    // hit the in-memory memo).
    expect(storage.reads).toHaveLength(1);
    expect(storage.writes).toHaveLength(1);
  });

  it("re-reads the persisted value after the resolver is re-created", async () => {
    const storage = makeMemoryStorage();
    const fixed = "11111111-2222-4333-8444-555555555555";

    const first = createDeviceIdResolver({
      storage,
      randomUuid: () => fixed,
    });
    const initialId = await first();

    // Simulate a renderer restart: build a fresh resolver against the
    // same persistent storage. It must NOT generate a new UUID.
    const generator = vi.fn(() => "99999999-9999-4999-8999-999999999999");
    const second = createDeviceIdResolver({
      storage,
      randomUuid: generator,
    });
    const restoredId = await second();

    expect(restoredId).toBe(initialId);
    expect(generator).not.toHaveBeenCalled();
  });

  it("regenerates the id when the persisted value is corrupted", async () => {
    const storage = makeMemoryStorage(
      new Map([[DEVICE_ID_SETTING_KEY, "not-a-uuid"]]),
    );
    const fresh = "11111111-2222-4333-8444-555555555555";
    const resolve = createDeviceIdResolver({
      storage,
      randomUuid: () => fresh,
    });

    const id = await resolve();

    expect(id).toBe(fresh);
    expect(storage.state.get(DEVICE_ID_SETTING_KEY)).toBe(fresh);
  });

  it("memoises concurrent first calls onto a single in-flight promise", async () => {
    // Storage that defers `read` until the test releases it. This lets
    // us schedule three concurrent `resolve()` calls before the first
    // I/O completes, and assert that only one UUID is generated.
    let releaseRead: (() => void) | null = null;
    const readGate = new Promise<void>((res) => {
      releaseRead = res;
    });
    const storage: DeviceIdStorage = {
      async read(): Promise<string | null> {
        await readGate;
        return null;
      },
      async write(): Promise<void> {
        // No-op for this test.
      },
    };

    const fresh = "11111111-2222-4333-8444-555555555555";
    const generator = vi.fn(() => fresh);
    const resolve = createDeviceIdResolver({
      storage,
      randomUuid: generator,
    });

    const a = resolve();
    const b = resolve();
    const c = resolve();

    // The resolver must hand back the SAME promise to all three callers
    // while the first I/O is still pending.
    expect(a).toBe(b);
    expect(b).toBe(c);

    // Now let the read complete.
    releaseRead!();

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(fresh);
    expect(rb).toBe(fresh);
    expect(rc).toBe(fresh);

    // And the UUID was generated exactly once.
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it("resets the in-flight promise when the read fails so the next call retries", async () => {
    let attempt = 0;
    const fixed = "11111111-2222-4333-8444-555555555555";
    const storage: DeviceIdStorage = {
      async read(): Promise<string | null> {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("transient i/o failure");
        }
        return null;
      },
      async write(): Promise<void> {
        // No-op for this test.
      },
    };

    const resolve = createDeviceIdResolver({
      storage,
      randomUuid: () => fixed,
    });

    await expect(resolve()).rejects.toThrow(/transient i\/o failure/);
    // Second attempt must not be locked behind the first failed promise.
    await expect(resolve()).resolves.toBe(fixed);
  });

  it("uses a custom storage key when provided", async () => {
    const storage = makeMemoryStorage();
    const fixed = "11111111-2222-4333-8444-555555555555";
    const resolve = createDeviceIdResolver({
      storage,
      randomUuid: () => fixed,
      key: "custom.device-id-key",
    });

    await resolve();
    expect(storage.state.has("custom.device-id-key")).toBe(true);
    expect(storage.state.has(DEVICE_ID_SETTING_KEY)).toBe(false);
  });
});

describe("isValidDeviceId", () => {
  it("accepts canonical UUID v4 strings", () => {
    expect(isValidDeviceId("11111111-2222-4333-8444-555555555555")).toBe(true);
    // Real UUID produced by the default generator must also round-trip.
    expect(isValidDeviceId(defaultRandomUuid())).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isValidDeviceId("not-a-uuid")).toBe(false);
    expect(isValidDeviceId("")).toBe(false);
    expect(isValidDeviceId(undefined)).toBe(false);
    expect(isValidDeviceId(null)).toBe(false);
    expect(isValidDeviceId(123)).toBe(false);
    // Version bits not 4.
    expect(isValidDeviceId("11111111-2222-1333-8444-555555555555")).toBe(false);
    // Variant bits outside the 8/9/a/b range.
    expect(isValidDeviceId("11111111-2222-4333-7444-555555555555")).toBe(false);
  });
});

describe("defaultRandomUuid", () => {
  it("produces canonical UUID v4 values", () => {
    for (let i = 0; i < 5; i += 1) {
      const id = defaultRandomUuid();
      expect(isValidDeviceId(id)).toBe(true);
    }
  });
});

describe("deviceIdStorageFromSettings", () => {
  it("treats non-string settings values as missing entries", async () => {
    let stored: unknown = { unexpected: "shape" };
    const settings = {
      async readLocalSetting<T = unknown>(): Promise<T | null> {
        return stored as T | null;
      },
      async writeLocalSetting(_key: string, value: unknown): Promise<void> {
        stored = value;
      },
    };

    const adapter = deviceIdStorageFromSettings(settings);
    await expect(adapter.read(DEVICE_ID_SETTING_KEY)).resolves.toBeNull();

    // Writing a string value through the adapter passes through to the
    // underlying settings API.
    await adapter.write(DEVICE_ID_SETTING_KEY, "hello");
    expect(stored).toBe("hello");
    await expect(adapter.read(DEVICE_ID_SETTING_KEY)).resolves.toBe("hello");
  });

  it("forwards reads to the configured key", async () => {
    const calls: string[] = [];
    const settings = {
      async readLocalSetting<T = unknown>(key: string): Promise<T | null> {
        calls.push(key);
        return null as T | null;
      },
      async writeLocalSetting(): Promise<void> {
        /* unused */
      },
    };
    const adapter = deviceIdStorageFromSettings(settings, "alt.key");
    await adapter.read("ignored-by-adapter");
    expect(calls).toEqual(["alt.key"]);
  });
});
