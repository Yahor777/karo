/**
 * Tests for the local Task draft store (KARO MVP).
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5.
 */

import { describe, expect, it, vi } from "vitest";

import {
  TASK_DRAFT_PREFIX,
  createTaskDraftStore,
  isTaskDraft,
} from "./taskDraftStore.js";
import type { DesktopShell } from "../shell/types.js";

function buildShell(): {
  shell: DesktopShell;
  store: Map<string, unknown>;
  writes: Array<{ key: string; value: unknown }>;
  deletes: string[];
} {
  const store = new Map<string, unknown>();
  const writes: Array<{ key: string; value: unknown }> = [];
  const deletes: string[] = [];
  const shell: DesktopShell = {
    getDeviceId: vi.fn(async () => "device-test"),
    readLocalSetting: <T = unknown>(key: string): Promise<T | null> => {
      return Promise.resolve((store.get(key) as T | undefined) ?? null);
    },
    writeLocalSetting: vi.fn(async (key: string, value: unknown) => {
      writes.push({ key, value });
      store.set(key, value);
      return undefined;
    }),
    deleteLocalSetting: vi.fn(async (key: string) => {
      deletes.push(key);
      store.delete(key);
      return undefined;
    }),
    encryptLocalSecret: vi.fn(async () => ({
      algorithm: "fake",
      ciphertext: "",
      createdAt: "2026-05-17T12:00:00.000Z",
    })),
    decryptLocalSecret: vi.fn(async () => ""),
    writeLocalLog: vi.fn(async () => undefined),
    exportFile: vi.fn(async () => ({ savedPath: "" })),
    showNotification: vi.fn(async () => undefined),
    probeProvider: vi.fn(async () => ({ status: 200, ok: true, body: "{}" })),
  };
  return { shell, store, writes, deletes };
}

describe("isTaskDraft", () => {
  it("accepts a valid draft", () => {
    expect(
      isTaskDraft({
        version: 1,
        prompt: "x",
        mode: "auto",
        participants: ["coder"],
        reviewCycles: 2,
        savedAt: "2026-05-17T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(isTaskDraft(null)).toBe(false);
    expect(isTaskDraft("foo")).toBe(false);
    expect(isTaskDraft(42)).toBe(false);
  });

  it("rejects wrong version, mode, or types", () => {
    expect(isTaskDraft({ version: 0 })).toBe(false);
    expect(
      isTaskDraft({
        version: 1,
        prompt: "x",
        mode: "wat",
        participants: [],
        reviewCycles: 2,
        savedAt: "now",
      }),
    ).toBe(false);
    expect(
      isTaskDraft({
        version: 1,
        prompt: "x",
        mode: "auto",
        participants: "not-an-array",
        reviewCycles: 2,
        savedAt: "now",
      }),
    ).toBe(false);
  });
});

describe("createTaskDraftStore", () => {
  it("write persists a versioned record under the per-provider key", async () => {
    const { shell, writes } = buildShell();
    const store = createTaskDraftStore({
      desktopShell: shell,
      now: () => new Date("2026-05-17T12:00:00.000Z"),
    });
    await store.write("fireworks", {
      prompt: "hello",
      mode: "manual",
      participants: ["coder", "reviewer"],
      reviewCycles: 3,
      modelId: "qwen",
    });
    expect(writes).toEqual([
      {
        key: `${TASK_DRAFT_PREFIX}fireworks`,
        value: {
          version: 1,
          prompt: "hello",
          mode: "manual",
          participants: ["coder", "reviewer"],
          reviewCycles: 3,
          modelId: "qwen",
          savedAt: "2026-05-17T12:00:00.000Z",
        },
      },
    ]);
  });

  it("read returns null when missing", async () => {
    const { shell } = buildShell();
    const store = createTaskDraftStore({ desktopShell: shell });
    await expect(store.read("openai")).resolves.toBeNull();
  });

  it("read returns the stored draft round-trip", async () => {
    const { shell } = buildShell();
    const store = createTaskDraftStore({ desktopShell: shell });
    await store.write("fireworks", {
      prompt: "p",
      mode: "auto",
      participants: ["coder"],
      reviewCycles: 1,
    });
    await expect(store.read("fireworks")).resolves.toMatchObject({
      version: 1,
      prompt: "p",
      mode: "auto",
      participants: ["coder"],
      reviewCycles: 1,
    });
  });

  it("read drops corrupted entries", async () => {
    const { shell, store: backing } = buildShell();
    backing.set(`${TASK_DRAFT_PREFIX}fireworks`, { version: 99, broken: true });
    const store = createTaskDraftStore({ desktopShell: shell });
    await expect(store.read("fireworks")).resolves.toBeNull();
  });

  it("delete clears the entry", async () => {
    const { shell, deletes } = buildShell();
    const store = createTaskDraftStore({ desktopShell: shell });
    await store.write("fireworks", {
      prompt: "p",
      mode: "auto",
      participants: ["coder"],
      reviewCycles: 1,
    });
    await store.delete("fireworks");
    expect(deletes).toContain(`${TASK_DRAFT_PREFIX}fireworks`);
    await expect(store.read("fireworks")).resolves.toBeNull();
  });
});
