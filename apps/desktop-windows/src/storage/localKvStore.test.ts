/**
 * Unit tests for `LocalKvStore` implementations.
 *
 * Validates: Requirements 1.6, 4.5.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InMemoryLocalKvStore,
  JsonFileLocalKvStore,
} from "./localKvStore.js";

describe("InMemoryLocalKvStore", () => {
  it("returns null for missing keys", async () => {
    const kv = new InMemoryLocalKvStore();
    await expect(kv.read("missing")).resolves.toBeNull();
  });

  it("round-trips JSON-shaped values", async () => {
    const kv = new InMemoryLocalKvStore();
    const value = { provider: "openai", count: 3, list: ["a", "b"] };
    await kv.write("preferences", value);
    await expect(kv.read("preferences")).resolves.toEqual(value);
  });

  it("returns deep clones so callers cannot mutate stored state", async () => {
    const kv = new InMemoryLocalKvStore();
    const stored = { theme: "dark", flags: { beta: true } };
    await kv.write("preferences", stored);

    const first = (await kv.read<typeof stored>("preferences")) as typeof stored;
    first.theme = "light";
    first.flags.beta = false;

    const second = await kv.read<typeof stored>("preferences");
    expect(second).toEqual({ theme: "dark", flags: { beta: true } });
  });

  it("delete is idempotent and does not throw on missing keys", async () => {
    const kv = new InMemoryLocalKvStore();
    await expect(kv.delete("missing")).resolves.toBeUndefined();

    await kv.write("k", "v");
    await kv.delete("k");
    await expect(kv.read("k")).resolves.toBeNull();
  });

  it("clear removes every entry", async () => {
    const kv = new InMemoryLocalKvStore();
    await kv.write("a", 1);
    await kv.write("b", 2);
    await kv.clear();
    await expect(kv.read("a")).resolves.toBeNull();
    await expect(kv.read("b")).resolves.toBeNull();
  });
});

describe("JsonFileLocalKvStore", () => {
  let tmpDir: string;
  let storePath: string;

  beforeAll(async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "kv-store-test-"),
    );
    storePath = path.join(tmpDir, "settings.json");
  });

  afterAll(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    const kv = new JsonFileLocalKvStore(storePath);
    await expect(kv.read("anything")).resolves.toBeNull();
  });

  it("persists writes across instances", async () => {
    const a = new JsonFileLocalKvStore(storePath);
    await a.write("preferences.theme", "dark");
    await a.write("secret:openai", {
      algorithm: "aes-256-gcm.v1",
      ciphertext: "AAAA",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const b = new JsonFileLocalKvStore(storePath);
    await expect(b.read("preferences.theme")).resolves.toBe("dark");
    await expect(b.read("secret:openai")).resolves.toEqual({
      algorithm: "aes-256-gcm.v1",
      ciphertext: "AAAA",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("delete removes only the requested key", async () => {
    const kv = new JsonFileLocalKvStore(storePath);
    await kv.write("a", 1);
    await kv.write("b", 2);
    await kv.delete("a");
    await expect(kv.read("a")).resolves.toBeNull();
    await expect(kv.read("b")).resolves.toBe(2);
  });

  it("serialises concurrent writes without losing updates", async () => {
    const kv = new JsonFileLocalKvStore(storePath);
    await kv.clear();

    // Schedule N independent writes; the queue must apply them all.
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) => kv.write(`k${i}`, i)),
    );

    for (let i = 0; i < N; i += 1) {
      await expect(kv.read(`k${i}`)).resolves.toBe(i);
    }
  });
});
