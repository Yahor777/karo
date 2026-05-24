/**
 * `LocalKvStore` implementations.
 *
 * Two concrete stores ship with this package:
 *
 *   • {@link InMemoryLocalKvStore} — Map-backed store used by unit and
 *     property tests. Reads return JSON-cloned snapshots so the test
 *     can mutate returned objects without affecting stored state.
 *   • {@link JsonFileLocalKvStore} — append-on-write JSON file store
 *     (Node only, behind a dynamic import). Suitable for headless dev
 *     runs of the renderer outside Tauri.
 *
 * Production uses encrypted SQLite (SQLCipher) on the Rust side, behind
 * the `shell_*` Tauri commands. Neither of these TS-side stores ever
 * sees a raw secret — secrets pass through `SecretCipher` first and
 * land here as opaque {@link EncryptedBlob}s under settings keys like
 * `secret:{provider}`.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import type * as FsPromises from "node:fs/promises";
import type * as NodePath from "node:path";

import type { LocalKvStore } from "./types.js";

/**
 * Round-trips a value through JSON so the caller cannot mutate stored
 * state by holding on to the returned reference. `null` is returned
 * untouched because `JSON.parse(JSON.stringify(null))` is `null`.
 */
function deepCloneJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory `LocalKvStore`. The default backend for tests and for the
 * Vitest-based fast-check property tests.
 */
export class InMemoryLocalKvStore implements LocalKvStore {
  private readonly entries = new Map<string, unknown>();

  public read<T = unknown>(key: string): Promise<T | null> {
    if (!this.entries.has(key)) {
      return Promise.resolve(null);
    }
    return Promise.resolve(deepCloneJson(this.entries.get(key) as T));
  }

  public write(key: string, value: unknown): Promise<void> {
    // Defensive clone so later mutation by the caller cannot alter
    // what's "persisted".
    this.entries.set(key, deepCloneJson(value));
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  public clear(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}

/**
 * Node-only JSON-file `LocalKvStore`. Loads the entire file on every
 * read/write — fine for the small settings volume the desktop shell
 * deals with (a handful of API keys, custom agents, preferences).
 *
 * Stored on disk as a single JSON object:
 *
 * ```json
 * {
 *   "preferences.theme": "dark",
 *   "secret:openai": { "algorithm": "...", "ciphertext": "...", "createdAt": "..." }
 * }
 * ```
 *
 * Concurrent writes within a single process are serialised through an
 * internal promise queue; cross-process concurrency is out of scope
 * because the desktop shell runs as a single OS process.
 */
export class JsonFileLocalKvStore implements LocalKvStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async read<T = unknown>(key: string): Promise<T | null> {
    const all = await this.loadAll();
    if (!Object.prototype.hasOwnProperty.call(all, key)) {
      return null;
    }
    return deepCloneJson(all[key] as T);
  }

  public async write(key: string, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.loadAll();
      all[key] = deepCloneJson(value);
      await this.saveAll(all);
    });
  }

  public async delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.loadAll();
      if (Object.prototype.hasOwnProperty.call(all, key)) {
        delete all[key];
        await this.saveAll(all);
      }
    });
  }

  public async clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.saveAll({});
    });
  }

  /**
   * Loads the entire file. Missing files behave as an empty store —
   * this is what the bootstrap experience needs on first launch.
   */
  private async loadAll(): Promise<Record<string, unknown>> {
    const fs = await loadFs();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        // Treat malformed root as empty — protects against corruption.
        return {};
      }
      return { ...(parsed as Record<string, unknown>) };
    } catch (err) {
      if (isFileNotFound(err)) {
        return {};
      }
      throw err;
    }
  }

  private async saveAll(all: Record<string, unknown>): Promise<void> {
    const fs = await loadFs();
    const path = await loadPath();
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    // Atomic write: write to a temp file, then rename.
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(all, null, 2), "utf8");
    await fs.rename(tmpPath, this.filePath);
  }

  /** Serialises writes/deletes/clears to avoid lost updates. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    // Swallow rejection on the chain so a failed write doesn't poison
    // future writes; the rejection is still observed by the caller of
    // this `enqueue` invocation.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Lazy import of `node:fs/promises` so this module type-checks under
 * jsdom. The function is only ever called inside `JsonFileLocalKvStore`
 * methods, which by definition only run when the host has Node.
 */
async function loadFs(): Promise<typeof FsPromises> {
  return import("node:fs/promises");
}

/** Lazy import of `node:path` (see `loadFs`). */
async function loadPath(): Promise<typeof NodePath> {
  return import("node:path");
}

/** True when the error represents a missing file (ENOENT). */
function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
