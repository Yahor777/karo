/**
 * Unit tests for the renderer ↔ shell bridge.
 *
 * These tests pin down the bridge contract:
 *
 * 1. Without an installed shell or wired native invoke, every method
 *    rejects with `DesktopShellNotImplementedError` — this is the
 *    "scaffold is alive but not wired" signal.
 * 2. `installDesktopShell` swaps the active implementation, and the
 *    facade always reads through `getDesktopShell()` so the swap takes
 *    effect on calls that have already destructured the facade.
 * 3. `setInvoke` / `resetInvoke` route calls through a fake invoker
 *    using the documented Tauri command names from
 *    `DESKTOP_SHELL_COMMANDS`.
 *
 * Validates: Requirements 1.3, 1.4, 1.6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_SHELL_COMMANDS,
  DesktopShellNotImplementedError,
  desktopShell,
  installDesktopShell,
  nativeDesktopShell,
  resetInvoke,
  setInvoke,
  type DesktopShell,
  type EncryptedBlob,
} from "./index.js";

/**
 * Type-erased shape of the Tauri `invoke` binding.
 * Vitest's `vi.fn` cannot model generic call signatures directly, so
 * the helper below produces a generic adapter from any unary or binary
 * async function.
 */
function makeInvoke(
  fn: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> {
  return <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    fn(cmd, args) as Promise<T>;
}

describe("nativeDesktopShell (no invoke wired)", () => {
  beforeEach(() => {
    resetInvoke();
    installDesktopShell(nativeDesktopShell);
  });

  it("rejects getDeviceId with NotImplemented", async () => {
    await expect(desktopShell.getDeviceId()).rejects.toBeInstanceOf(
      DesktopShellNotImplementedError,
    );
  });

  it("tags the failing command name on the error", async () => {
    try {
      await desktopShell.encryptLocalSecret("api-key");
      throw new Error("expected encryptLocalSecret to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopShellNotImplementedError);
      expect((error as DesktopShellNotImplementedError).command).toBe(
        DESKTOP_SHELL_COMMANDS.encryptLocalSecret,
      );
    }
  });
});

describe("nativeDesktopShell (with fake invoke)", () => {
  afterEach(() => {
    resetInvoke();
    installDesktopShell(nativeDesktopShell);
  });

  it("forwards getDeviceId to the configured Tauri command", async () => {
    const inner = vi.fn(async (cmd: string) => {
      expect(cmd).toBe(DESKTOP_SHELL_COMMANDS.getDeviceId);
      return "device-abc";
    });
    setInvoke(makeInvoke(inner));

    await expect(desktopShell.getDeviceId()).resolves.toBe("device-abc");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("forwards readLocalSetting with the key argument", async () => {
    const inner = vi.fn(
      async (cmd: string, args?: Record<string, unknown>) => {
        expect(cmd).toBe(DESKTOP_SHELL_COMMANDS.readLocalSetting);
        expect(args).toEqual({ key: "preferences.theme" });
        return "dark";
      },
    );
    setInvoke(makeInvoke(inner));

    await expect(
      desktopShell.readLocalSetting<string>("preferences.theme"),
    ).resolves.toBe("dark");
  });

  it("serialises Uint8Array bytes as a number array for exportFile", async () => {
    const inner = vi.fn(
      async (cmd: string, args?: Record<string, unknown>) => {
        expect(cmd).toBe(DESKTOP_SHELL_COMMANDS.exportFile);
        expect(args).toEqual({
          suggestedFileName: "report.txt",
          bytes: [1, 2, 3, 4],
        });
        return { savedPath: "C:/tmp/report.txt" };
      },
    );
    setInvoke(makeInvoke(inner));

    await expect(
      desktopShell.exportFile({
        suggestedFileName: "report.txt",
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    ).resolves.toEqual({ savedPath: "C:/tmp/report.txt" });
  });

  it("returns the EncryptedBlob shape from the native side as-is", async () => {
    const blob: EncryptedBlob = {
      algorithm: "aes-256-gcm",
      ciphertext: "AAAA",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const inner = vi.fn(async (cmd: string) => {
      expect(cmd).toBe(DESKTOP_SHELL_COMMANDS.encryptLocalSecret);
      return blob;
    });
    setInvoke(makeInvoke(inner));

    await expect(desktopShell.encryptLocalSecret("secret")).resolves.toEqual(
      blob,
    );
  });

  it("forwards buildTaskContext to the shell_build_task_context Tauri command", async () => {
    const contextPackage = {
      projectRoot: "D:/repo",
      prompt: "explain",
      fileTreeSummary: [],
      selectedFiles: [],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 80000,
      createdAt: "now",
      warnings: [],
      scannedFilesCount: 1,
      selectedFilesCount: 0,
    };
    const inner = vi.fn(
      async (cmd: string, args?: Record<string, unknown>) => {
        expect(cmd).toBe(DESKTOP_SHELL_COMMANDS.shellBuildTaskContext);
        expect(args).toEqual({
          projectPath: "D:/repo",
          prompt: "explain",
          options: { maxFiles: 3 },
        });
        return contextPackage;
      },
    );
    setInvoke(makeInvoke(inner));

    await expect(
      desktopShell.shell_build_task_context!("D:/repo", "explain", { maxFiles: 3 }),
    ).resolves.toEqual(contextPackage);
  });
});

describe("installDesktopShell", () => {
  afterEach(() => {
    resetInvoke();
    installDesktopShell(nativeDesktopShell);
  });

  it("routes facade calls through the installed shell", async () => {
    const fake: DesktopShell = {
      getDeviceId: vi.fn(async () => "fake-device"),
      readLocalSetting: vi.fn(async () => null),
      writeLocalSetting: vi.fn(async () => undefined),
      deleteLocalSetting: vi.fn(async () => undefined),
      encryptLocalSecret: vi.fn(async () => ({
        algorithm: "fake",
        ciphertext: "",
        createdAt: "2025-01-01T00:00:00.000Z",
      })),
      decryptLocalSecret: vi.fn(async () => ""),
      writeLocalLog: vi.fn(async () => undefined),
      exportFile: vi.fn(async () => ({ savedPath: "" })),
      showNotification: vi.fn(async () => undefined),
      probeProvider: vi.fn(async () => ({ status: 200, ok: true, body: "" })),
    };

    installDesktopShell(fake);
    await expect(desktopShell.getDeviceId()).resolves.toBe("fake-device");
    expect(fake.getDeviceId).toHaveBeenCalledTimes(1);
  });

  it("routes context engine facade calls through the installed shell", async () => {
    const contextPackage = {
      projectRoot: "D:/repo",
      prompt: "Apply Changes",
      fileTreeSummary: [],
      selectedFiles: [],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 80000,
      createdAt: "now",
      warnings: [],
      scannedFilesCount: 10,
      selectedFilesCount: 2,
    };
    const fake: DesktopShell = {
      getDeviceId: vi.fn(async () => "fake-device"),
      readLocalSetting: vi.fn(async () => null),
      writeLocalSetting: vi.fn(async () => undefined),
      deleteLocalSetting: vi.fn(async () => undefined),
      encryptLocalSecret: vi.fn(async () => ({
        algorithm: "fake",
        ciphertext: "",
        createdAt: "2025-01-01T00:00:00.000Z",
      })),
      decryptLocalSecret: vi.fn(async () => ""),
      writeLocalLog: vi.fn(async () => undefined),
      exportFile: vi.fn(async () => ({ savedPath: "" })),
      showNotification: vi.fn(async () => undefined),
      probeProvider: vi.fn(async () => ({ status: 200, ok: true, body: "" })),
      shell_build_task_context: vi.fn(async () => contextPackage),
    };

    installDesktopShell(fake);
    await expect(
      desktopShell.shell_build_task_context!("D:/repo", "Apply Changes"),
    ).resolves.toEqual(contextPackage);
    expect(fake.shell_build_task_context).toHaveBeenCalledWith(
      "D:/repo",
      "Apply Changes",
      undefined,
    );
  });

  it("respects swaps performed after the facade was destructured", async () => {
    const { getDeviceId } = desktopShell;

    installDesktopShell({
      ...nativeDesktopShell,
      getDeviceId: async () => "swapped-device",
    });

    await expect(getDeviceId()).resolves.toBe("swapped-device");
  });
});
