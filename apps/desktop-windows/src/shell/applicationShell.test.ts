/**
 * Unit tests for `createApplicationShell`.
 *
 * The application shell is a thin decorator around the native shell
 * (today: `nativeDesktopShell`, in tests: any in-memory fake) that
 * adds two pieces of renderer-side policy:
 *
 *   • `getDeviceId` is memoised through `createDeviceIdResolver`,
 *     so the value generated on first launch is reused on every
 *     subsequent call (Requirement 1.4);
 *   • `writeLocalLog` runs the entry through `redactLogEntry` before
 *     forwarding to the inner shell, so API-key-shaped substrings
 *     never reach the on-disk log file (Requirement 1.6).
 *
 * The tests below exercise both behaviours against a fully fake
 * `DesktopShell`. Pass-through methods are also covered so the
 * decorator does not silently drop any part of the contract.
 *
 * Validates: Requirements 1.4, 1.6.
 */

import { describe, expect, it, vi } from "vitest";

import { createApplicationShell } from "./applicationShell.js";
import type {
  DesktopShell,
  EncryptedBlob,
  LocalLogEntry,
} from "./types.js";

/**
 * Builds a fake `DesktopShell` whose settings methods are backed by an
 * in-memory map and whose other methods are `vi.fn`s the test can
 * inspect. Returns the shell plus the underlying state for assertions.
 */
function makeFakeShell(): {
  readonly shell: DesktopShell;
  readonly settings: Map<string, unknown>;
  readonly logs: LocalLogEntry[];
  readonly fns: {
    readonly encryptLocalSecret: ReturnType<typeof vi.fn>;
    readonly decryptLocalSecret: ReturnType<typeof vi.fn>;
    readonly exportFile: ReturnType<typeof vi.fn>;
    readonly showNotification: ReturnType<typeof vi.fn>;
  };
} {
  const settings = new Map<string, unknown>();
  const logs: LocalLogEntry[] = [];
  const fns = {
    encryptLocalSecret: vi.fn(
      async (secret: string): Promise<EncryptedBlob> => ({
        algorithm: "fake",
        ciphertext: `enc(${secret})`,
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
    ),
    decryptLocalSecret: vi.fn(
      async (blob: EncryptedBlob): Promise<string> =>
        blob.ciphertext.replace(/^enc\(|\)$/g, ""),
    ),
    exportFile: vi.fn(async () => ({ savedPath: "C:/tmp/x.bin" })),
    showNotification: vi.fn(async () => undefined),
  };

  const shell: DesktopShell = {
    getDeviceId: vi.fn(async () => {
      throw new Error(
        "inner.getDeviceId must not be called when the resolver is in front",
      );
    }),
    async readLocalSetting<T = unknown>(key: string): Promise<T | null> {
      return settings.has(key) ? (settings.get(key) as T) : null;
    },
    async writeLocalSetting(key: string, value: unknown): Promise<void> {
      settings.set(key, value);
    },
    async deleteLocalSetting(key: string): Promise<void> {
      settings.delete(key);
    },
    encryptLocalSecret: fns.encryptLocalSecret,
    decryptLocalSecret: fns.decryptLocalSecret,
    async writeLocalLog(entry: LocalLogEntry): Promise<void> {
      logs.push(entry);
    },
    exportFile: fns.exportFile,
    showNotification: fns.showNotification,
    probeProvider: vi.fn(async () => ({ status: 200, ok: true, body: "" })),
  };

  return { shell, settings, logs, fns };
}

describe("createApplicationShell — getDeviceId", () => {
  it("memoises the device id through the resolver", async () => {
    const inner = makeFakeShell();
    const fixed = "11111111-2222-4333-8444-555555555555";
    const randomUuid = vi.fn(() => fixed);

    const app = createApplicationShell({
      inner: inner.shell,
      randomUuid,
    });

    const a = await app.getDeviceId();
    const b = await app.getDeviceId();
    const c = await app.getDeviceId();

    expect(a).toBe(fixed);
    expect(b).toBe(fixed);
    expect(c).toBe(fixed);
    // Generated exactly once.
    expect(randomUuid).toHaveBeenCalledTimes(1);
    // The inner shell's `getDeviceId` is never invoked — the resolver
    // owns this concern.
    expect(inner.shell.getDeviceId).not.toHaveBeenCalled();
  });

  it("persists the device id through the inner shell's settings API", async () => {
    const inner = makeFakeShell();
    const fixed = "11111111-2222-4333-8444-555555555555";

    const app = createApplicationShell({
      inner: inner.shell,
      randomUuid: () => fixed,
    });

    const id = await app.getDeviceId();

    // Some setting-like key holds the persisted id. We do not pin the
    // exact key here — that is a deviceId.test.ts concern. We do
    // assert that exactly one entry was written and that it equals the
    // resolved id.
    const entries = Array.from(inner.settings.entries());
    expect(entries).toHaveLength(1);
    const [, storedValue] = entries[0]!;
    expect(storedValue).toBe(id);
  });

  it("uses an explicit deviceIdStorage when one is provided", async () => {
    const inner = makeFakeShell();
    const reads: string[] = [];
    const writes: Array<[string, string]> = [];
    const fixed = "11111111-2222-4333-8444-555555555555";

    const app = createApplicationShell({
      inner: inner.shell,
      randomUuid: () => fixed,
      deviceIdStorage: {
        async read(key) {
          reads.push(key);
          return null;
        },
        async write(key, value) {
          writes.push([key, value]);
        },
      },
    });

    await app.getDeviceId();

    expect(writes).toEqual([["shell.deviceId", fixed]]);
    expect(reads).toEqual(["shell.deviceId"]);
    // The inner shell's settings API is bypassed entirely.
    expect(inner.settings.size).toBe(0);
  });
});

describe("createApplicationShell — writeLocalLog", () => {
  it("redacts the entry before passing it to the inner shell", async () => {
    const inner = makeFakeShell();
    const app = createApplicationShell({ inner: inner.shell });

    await app.writeLocalLog({
      level: "warn",
      message: "auth failed for sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      context: {
        provider: "openai",
        apiKey: "sk-ZYXWVUTSRQPONMLKJIHGFEDCBA",
        contact: "alice@example.com",
      },
      at: "2025-01-01T00:00:00.000Z",
    });

    expect(inner.logs).toHaveLength(1);
    const captured = inner.logs[0]!;
    expect(captured).toEqual({
      level: "warn",
      message: "auth failed for [REDACTED:api_key:openai]",
      context: {
        provider: "openai",
        apiKey: "[REDACTED:api_key:openai]",
        contact: "[REDACTED:email]",
      },
      at: "2025-01-01T00:00:00.000Z",
    });
  });

  it("forwards entries without context unchanged in their non-sensitive fields", async () => {
    const inner = makeFakeShell();
    const app = createApplicationShell({ inner: inner.shell });

    await app.writeLocalLog({
      level: "info",
      message: "hello world",
      at: "2025-01-01T00:00:00.000Z",
    });

    expect(inner.logs).toEqual([
      {
        level: "info",
        message: "hello world",
        at: "2025-01-01T00:00:00.000Z",
      },
    ]);
  });
});

describe("createApplicationShell — pass-through methods", () => {
  it("forwards encrypt/decrypt/export/notify/setting calls verbatim", async () => {
    const inner = makeFakeShell();
    const app = createApplicationShell({ inner: inner.shell });

    const blob = await app.encryptLocalSecret("api-key");
    expect(blob.ciphertext).toBe("enc(api-key)");
    await expect(app.decryptLocalSecret(blob)).resolves.toBe("api-key");

    await app.writeLocalSetting("preferences.theme", "dark");
    await expect(app.readLocalSetting<string>("preferences.theme")).resolves.toBe(
      "dark",
    );
    await app.deleteLocalSetting("preferences.theme");
    await expect(
      app.readLocalSetting<string>("preferences.theme"),
    ).resolves.toBeNull();

    await expect(
      app.exportFile({
        suggestedFileName: "x.bin",
        bytes: new Uint8Array([1, 2]),
      }),
    ).resolves.toEqual({ savedPath: "C:/tmp/x.bin" });
    expect(inner.fns.exportFile).toHaveBeenCalledTimes(1);

    await app.showNotification({ title: "t", body: "b" });
    expect(inner.fns.showNotification).toHaveBeenCalledWith({
      title: "t",
      body: "b",
    });
  });
});
