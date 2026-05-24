/**
 * Integration tests for the Local Encrypted Storage abstraction.
 *
 * These tests exercise:
 *
 *   • `LocalEncryptedStorage` directly (encrypt / decrypt /
 *     read / write / delete);
 *   • the same backend behind the renderer ↔ shell bridge via
 *     `createInvokeForLocalStorage` + `setInvoke`, proving that the
 *     renderer's `desktopShell` facade works end-to-end against a real
 *     in-process implementation;
 *   • the safety invariant that plaintext secrets never appear in the
 *     persistent store.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  desktopShell,
  installDesktopShell,
  nativeDesktopShell,
  resetInvoke,
  setInvoke,
} from "../shell/index.js";
import {
  ENCRYPTED_SETTING_PREFIX,
  InMemoryLocalKvStore,
  RandomInMemoryKeyMaterialProvider,
  AesGcmSecretCipher,
  LocalEncryptedStorage,
  createInMemoryEncryptedStorage,
  createInvokeForLocalStorage,
  isEncryptedBlob,
} from "./index.js";

describe("LocalEncryptedStorage (direct)", () => {
  it("encrypts a plaintext, persists only the blob, and decrypts on demand", async () => {
    const kv = new InMemoryLocalKvStore();
    const cipher = new AesGcmSecretCipher(
      new RandomInMemoryKeyMaterialProvider(),
    );
    const storage = new LocalEncryptedStorage({ cipher, kv });

    const plaintext = "sk-test-VERYSECRET-1234567890ABCDEF";
    const blob = await storage.encryptLocalSecret(plaintext);
    await storage.writeLocalSetting(`${ENCRYPTED_SETTING_PREFIX}openai`, blob);

    // The key in the underlying store must be an EncryptedBlob, not
    // the plaintext.
    const stored = await kv.read(`${ENCRYPTED_SETTING_PREFIX}openai`);
    expect(isEncryptedBlob(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(plaintext);

    // Decryption returns the original plaintext.
    const recovered = await storage.decryptLocalSecret(blob);
    expect(recovered).toBe(plaintext);
  });

  it("refuses to write a non-EncryptedBlob value under a `secret:` key", async () => {
    const storage = createInMemoryEncryptedStorage();
    await expect(
      storage.writeLocalSetting(`${ENCRYPTED_SETTING_PREFIX}openai`, {
        apiKey: "sk-plaintext",
      }),
    ).rejects.toThrow(/refusing to persist a non-EncryptedBlob/i);
  });

  it("allows non-secret settings to round-trip unchanged", async () => {
    const storage = createInMemoryEncryptedStorage();
    await storage.writeLocalSetting("preferences.theme", "dark");
    await expect(storage.readLocalSetting("preferences.theme")).resolves.toBe(
      "dark",
    );
  });

  it("delete resolves successfully whether or not the key exists", async () => {
    const storage = createInMemoryEncryptedStorage();
    await expect(storage.deleteLocalSetting("missing")).resolves.toBeUndefined();

    await storage.writeLocalSetting("preferences.theme", "dark");
    await expect(
      storage.deleteLocalSetting("preferences.theme"),
    ).resolves.toBeUndefined();
    await expect(
      storage.readLocalSetting("preferences.theme"),
    ).resolves.toBeNull();
  });
});

describe("Local Encrypted Storage via the renderer bridge", () => {
  // Each test resets the invoke binding and re-installs the native
  // shell so the global module state is clean between tests.
  beforeEach(() => {
    resetInvoke();
    installDesktopShell(nativeDesktopShell);
  });
  afterEach(() => {
    resetInvoke();
    installDesktopShell(nativeDesktopShell);
  });

  it("the desktopShell facade encrypts/decrypts through the bridge", async () => {
    const storage = createInMemoryEncryptedStorage();
    setInvoke(createInvokeForLocalStorage({ storage }));

    const blob = await desktopShell.encryptLocalSecret("api-key-42");
    expect(blob.algorithm).toMatch(/^aes-256-gcm/);
    await expect(desktopShell.decryptLocalSecret(blob)).resolves.toBe(
      "api-key-42",
    );
  });

  it("readLocalSetting / writeLocalSetting / deleteLocalSetting flow through the bridge", async () => {
    const storage = createInMemoryEncryptedStorage();
    setInvoke(createInvokeForLocalStorage({ storage }));

    await desktopShell.writeLocalSetting("preferences.theme", "dark");
    await expect(
      desktopShell.readLocalSetting<string>("preferences.theme"),
    ).resolves.toBe("dark");

    await desktopShell.deleteLocalSetting("preferences.theme");
    await expect(
      desktopShell.readLocalSetting<string>("preferences.theme"),
    ).resolves.toBeNull();
  });

  it("end-to-end: save an encrypted secret and never persist plaintext", async () => {
    const kv = new InMemoryLocalKvStore();
    const storage = new LocalEncryptedStorage({
      cipher: new AesGcmSecretCipher(new RandomInMemoryKeyMaterialProvider()),
      kv,
    });
    setInvoke(createInvokeForLocalStorage({ storage }));

    const plaintext = "sk-prod-DO-NOT-LEAK-7777777";

    // 1) UI layer encrypts the API key via the bridge.
    const blob = await desktopShell.encryptLocalSecret(plaintext);
    expect(blob.ciphertext).not.toContain(plaintext);

    // 2) UI layer persists the blob under a `secret:` key.
    await desktopShell.writeLocalSetting(
      `${ENCRYPTED_SETTING_PREFIX}openai`,
      blob,
    );

    // 3) Inspect the underlying KV store and confirm plaintext is
    //    nowhere to be found in the persisted state.
    const dump = await kv.read(`${ENCRYPTED_SETTING_PREFIX}openai`);
    expect(dump).toBeTruthy();
    expect(JSON.stringify(dump)).not.toContain(plaintext);

    // 4) An authorised server-side caller can recover the plaintext.
    const recovered = await desktopShell.decryptLocalSecret(blob);
    expect(recovered).toBe(plaintext);
  });
});
