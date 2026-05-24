/**
 * `LocalKvStore` backed by `window.localStorage`.
 *
 * Used as the persistence layer for the desktop renderer until the
 * Rust side ships SQLCipher (task 3.2 plan). The Tauri WebView2
 * (Edge) on Windows persists `localStorage` inside the per-app
 * `EBWebView` profile under `%LOCALAPPDATA%`, which gives us:
 *
 *   • Persistence across app restarts.
 *   • Per-user / per-install isolation (the WebView profile path is
 *     namespaced by Tauri's app identifier).
 *   • Same-origin restriction — the data is only readable from the
 *     `tauri://localhost` origin of this app.
 *
 * Plaintext API keys never touch this store: callers go through
 * `LocalEncryptedStorage.encryptLocalSecret(...)` first, and only
 * `EncryptedBlob`s land here under the `secret:*` key namespace.
 *
 * Validates: Requirements 1.4, 1.6, 4.5.
 */

import type { LocalKvStore } from "./types.js";

const NAMESPACE_PREFIX = "aiao::";

/**
 * Storage abstraction matching the subset of the Web Storage API the
 * store needs. Decoupled so tests can pass a `Map`-backed shim.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Keys we own — used by `clear` to scope deletion to our namespace. */
  readonly length: number;
  key(index: number): string | null;
}

export interface BrowserLocalStorageKvStoreOptions {
  /** Defaults to `globalThis.localStorage`. */
  readonly storage?: WebStorageLike;
  /**
   * Optional namespace to prepend to every key. Defaults to the
   * `aiao::` prefix so the store coexists peacefully with anything
   * else the WebView might persist in localStorage in the future.
   */
  readonly namespace?: string;
}

/**
 * Persistent JSON store backed by the WebView's `localStorage`.
 *
 * Reads / writes go through `JSON.parse` / `JSON.stringify` so the
 * stored value round-trips cleanly. Non-string values stored under
 * a key are returned unchanged; missing keys return `null`.
 */
export class BrowserLocalStorageKvStore implements LocalKvStore {
  private readonly storage: WebStorageLike;
  private readonly namespace: string;

  public constructor(options: BrowserLocalStorageKvStoreOptions = {}) {
    const fallback: WebStorageLike | undefined =
      typeof globalThis !== "undefined" &&
      "localStorage" in globalThis
        ? (globalThis as unknown as { localStorage: WebStorageLike }).localStorage
        : undefined;
    const resolved = options.storage ?? fallback;
    if (resolved === undefined) {
      throw new Error(
        "BrowserLocalStorageKvStore: no localStorage is available. " +
          "Pass `options.storage` for non-WebView hosts.",
      );
    }
    this.storage = resolved;
    this.namespace = options.namespace ?? NAMESPACE_PREFIX;
  }

  public read<T = unknown>(key: string): Promise<T | null> {
    const raw = this.storage.getItem(this.namespace + key);
    if (raw === null) {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(JSON.parse(raw) as T);
    } catch {
      // Corrupted entry — treat as missing rather than rejecting so
      // a single bad row does not lock the user out of the app.
      return Promise.resolve(null);
    }
  }

  public write(key: string, value: unknown): Promise<void> {
    this.storage.setItem(this.namespace + key, JSON.stringify(value));
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.storage.removeItem(this.namespace + key);
    return Promise.resolve();
  }

  public clear(): Promise<void> {
    // Only delete keys we own. Iterate in reverse because removeItem
    // shifts indices.
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const k = this.storage.key(i);
      if (k !== null && k.startsWith(this.namespace)) {
        keys.push(k);
      }
    }
    for (const k of keys) {
      this.storage.removeItem(k);
    }
    return Promise.resolve();
  }
}
