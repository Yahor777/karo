/**
 * Unit and property tests for `AesGcmSecretCipher`.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  AES_256_GCM_ALGORITHM,
  AES_256_KEY_LENGTH,
  AesGcmSecretCipher,
} from "./secretCipher.js";
import { InMemoryKeyMaterialProvider } from "./keyProvider.js";

/** Builds a deterministic cipher seeded with a 32-byte key derived from `seed`. */
function makeCipher(seed: number = 0x42): AesGcmSecretCipher {
  const key = new Uint8Array(AES_256_KEY_LENGTH);
  for (let i = 0; i < key.length; i += 1) {
    key[i] = (seed + i * 7) & 0xff;
  }
  return new AesGcmSecretCipher(new InMemoryKeyMaterialProvider(key));
}

describe("AesGcmSecretCipher", () => {
  it("round-trips a plaintext through encrypt/decrypt", async () => {
    const cipher = makeCipher();
    const blob = await cipher.encrypt("sk-test-1234567890");
    expect(blob.algorithm).toBe(AES_256_GCM_ALGORITHM);
    expect(blob.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(new Date(blob.createdAt).toString()).not.toBe("Invalid Date");

    await expect(cipher.decrypt(blob)).resolves.toBe("sk-test-1234567890");
  });

  it("uses a fresh IV for every encryption, so two blobs differ", async () => {
    const cipher = makeCipher();
    const a = await cipher.encrypt("same plaintext");
    const b = await cipher.encrypt("same plaintext");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects blobs encrypted under a different key", async () => {
    const a = makeCipher(0x01);
    const b = makeCipher(0x02);
    const blob = await a.encrypt("api-key");
    await expect(b.decrypt(blob)).rejects.toThrow(/decryption failed/i);
  });

  it("rejects blobs whose ciphertext has been tampered with", async () => {
    const cipher = makeCipher();
    const blob = await cipher.encrypt("api-key");
    // Flip a bit in the middle of the ciphertext payload.
    const tampered = {
      ...blob,
      ciphertext:
        blob.ciphertext.slice(0, 20) +
        (blob.ciphertext[20] === "A" ? "B" : "A") +
        blob.ciphertext.slice(21),
    };
    await expect(cipher.decrypt(tampered)).rejects.toThrow(/decryption failed/i);
  });

  it("rejects blobs declaring an unknown algorithm", async () => {
    const cipher = makeCipher();
    const blob = await cipher.encrypt("api-key");
    const wrongAlgo = { ...blob, algorithm: "rot13" };
    await expect(cipher.decrypt(wrongAlgo)).rejects.toThrow(/unsupported algorithm/i);
  });

  it("rejects key material of the wrong length", async () => {
    // Custom provider that returns a 16-byte buffer; the cipher
    // should refuse to import it and propagate the size error.
    const badProvider = {
      async getKeyBytes() {
        return new Uint8Array(16);
      },
    };
    const cipher = new AesGcmSecretCipher(badProvider);
    await expect(cipher.encrypt("x")).rejects.toThrow(
      /returned 16 bytes; 32 required/,
    );
  });

  it("property: every plaintext round-trips losslessly", async () => {
    const cipher = makeCipher();
    await fc.assert(
      fc.asyncProperty(
        // Real API keys are short ASCII strings; constrain to the same
        // shape so the property exercises the realistic input space.
        fc.string({ minLength: 0, maxLength: 256 }),
        async (plaintext) => {
          const blob = await cipher.encrypt(plaintext);
          const decrypted = await cipher.decrypt(blob);
          return decrypted === plaintext;
        },
      ),
      { numRuns: 50 },
    );
  });
});
