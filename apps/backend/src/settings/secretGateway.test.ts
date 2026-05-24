/**
 * Unit tests for the server-side secret gateway (task 6.3).
 *
 * Covers:
 *   • Token signer/verifier round-trips (happy path).
 *   • Each {@link TokenVerificationFailure} reason maps to the expected
 *     {@link SecretResolutionError} code.
 *   • Component allowlist narrowing rejects structurally valid tokens
 *     issued for components that are not authorised on this gateway.
 *   • `resolveApiKeySecret` returns plaintext only after verification, lookup,
 *     and decrypt all pass; returns `not_found` when the record is missing;
 *     returns `decrypt_failed` when storage or cipher throws; never returns
 *     plaintext on any failure path.
 *
 * Validates: Requirements 3.7, 4.5.
 */

import { describe, expect, it } from "vitest";

import type { ProviderId, Scope } from "@ai-agent-orchestrator/shared-core";

import type { EncryptedBlob, SecretCipher } from "./types.js";
import {
  createSecretGateway,
  createServerComponentToken,
  SecretResolutionError,
  SERVER_COMPONENTS,
  type ApiKeyEncryptedRecordReader,
  type ServerComponentToken,
  verifyServerComponentToken,
} from "./secretGateway.js";

const SIGNING_SECRET = "test-signing-secret-32-bytes-long-padding";
const FIXED_NOW = new Date("2025-01-01T00:00:00.000Z");

function localScope(deviceId = "device-A"): Scope {
  return { kind: "local", deviceId };
}

/** Stub cipher that returns plaintext keyed by ciphertext, no real crypto. */
class StubCipher implements SecretCipher {
  public encryptCalls = 0;
  public decryptCalls = 0;
  private readonly map = new Map<string, string>();
  private readonly throwOn = new Set<string>();

  public seed(plain: string): EncryptedBlob {
    const ciphertext = `ct:${plain}`;
    this.map.set(ciphertext, plain);
    return {
      algorithm: "stub.v1",
      ciphertext,
      createdAt: FIXED_NOW.toISOString(),
    };
  }

  public throwOnCiphertext(ciphertext: string): void {
    this.throwOn.add(ciphertext);
  }

  public async encrypt(plaintext: string): Promise<EncryptedBlob> {
    this.encryptCalls += 1;
    return this.seed(plaintext);
  }

  public async decrypt(blob: EncryptedBlob): Promise<string> {
    this.decryptCalls += 1;
    if (this.throwOn.has(blob.ciphertext)) {
      throw new Error("simulated cipher failure");
    }
    const plain = this.map.get(blob.ciphertext);
    if (plain === undefined) {
      throw new Error("StubCipher: unknown ciphertext");
    }
    return plain;
  }
}

class StubReader implements ApiKeyEncryptedRecordReader {
  public reads: Array<{ scope: Scope; provider: ProviderId }> = [];
  private record: { encryptedKey: EncryptedBlob } | null = null;
  private err: Error | null = null;

  public set(record: { encryptedKey: EncryptedBlob } | null): void {
    this.record = record;
    this.err = null;
  }

  public throwNext(err: Error): void {
    this.err = err;
  }

  public async read(
    scope: Scope,
    provider: ProviderId,
  ): Promise<{ readonly encryptedKey: EncryptedBlob } | null> {
    this.reads.push({ scope, provider });
    if (this.err) throw this.err;
    return this.record;
  }
}

function freshToken(
  overrides: Partial<{
    component: ServerComponentToken["component"];
    issuedAt: Date;
    ttlMs: number;
    signingSecret: string;
  }> = {},
): ServerComponentToken {
  return createServerComponentToken({
    component: overrides.component ?? "model_catalog",
    issuedAt: overrides.issuedAt ?? FIXED_NOW,
    ttlMs: overrides.ttlMs ?? 60_000,
    signingSecret: overrides.signingSecret ?? SIGNING_SECRET,
  });
}

describe("createServerComponentToken", () => {
  it("issues a token whose canonical fields round-trip through verify", () => {
    const token = freshToken();
    const result = verifyServerComponentToken(token, {
      signingSecret: SIGNING_SECRET,
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: true, component: "model_catalog" });
  });

  it("computes expiresAt = issuedAt + ttlMs", () => {
    const token = freshToken({ ttlMs: 30_000 });
    expect(token.issuedAt).toBe(FIXED_NOW.toISOString());
    expect(new Date(token.expiresAt).getTime()).toBe(
      FIXED_NOW.getTime() + 30_000,
    );
  });

  it("rejects unknown components", () => {
    expect(() =>
      // @ts-expect-error -- intentional invalid input
      createServerComponentToken({
        component: "renderer",
        ttlMs: 1_000,
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow(/unknown component/);
  });

  it("rejects non-positive ttlMs", () => {
    expect(() =>
      createServerComponentToken({
        component: "model_catalog",
        ttlMs: 0,
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow(/positive finite/);
  });

  it("rejects expiresAt <= issuedAt", () => {
    expect(() =>
      createServerComponentToken({
        component: "model_catalog",
        issuedAt: FIXED_NOW,
        expiresAt: FIXED_NOW,
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow(/strictly after issuedAt/);
  });
});

describe("verifyServerComponentToken", () => {
  it("rejects a token signed with a different secret", () => {
    const token = freshToken({ signingSecret: "other-secret" });
    const result = verifyServerComponentToken(token, {
      signingSecret: SIGNING_SECRET,
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a tampered component (signature won't match)", () => {
    const token = freshToken();
    const tampered = { ...token, component: "orchestrator" } as ServerComponentToken;
    const result = verifyServerComponentToken(tampered, {
      signingSecret: SIGNING_SECRET,
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects an expired token", () => {
    const token = freshToken({ ttlMs: 1_000 });
    const result = verifyServerComponentToken(token, {
      signingSecret: SIGNING_SECRET,
      now: () => new Date(FIXED_NOW.getTime() + 5_000),
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a not-yet-valid token", () => {
    const token = freshToken({
      issuedAt: new Date(FIXED_NOW.getTime() + 60_000),
      ttlMs: 60_000,
    });
    const result = verifyServerComponentToken(token, {
      signingSecret: SIGNING_SECRET,
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("rejects components outside the deployment allowlist", () => {
    const token = freshToken({ component: "fallback_manager" });
    const result = verifyServerComponentToken(token, {
      signingSecret: SIGNING_SECRET,
      allowedComponents: ["model_catalog"],
      now: () => FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "not_in_allowlist" });
  });

  it("rejects bad shapes without throwing", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "",
      42,
      {},
      { component: "model_catalog" },
      { component: 1, issuedAt: "x", expiresAt: "y", signature: "z" },
    ];
    for (const c of cases) {
      const r = verifyServerComponentToken(c, {
        signingSecret: SIGNING_SECRET,
        now: () => FIXED_NOW,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects unknown component values structurally", () => {
    const issuedAt = FIXED_NOW.toISOString();
    const expiresAt = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
    const result = verifyServerComponentToken(
      {
        component: "renderer",
        issuedAt,
        expiresAt,
        signature: "deadbeef",
      },
      { signingSecret: SIGNING_SECRET, now: () => FIXED_NOW },
    );
    expect(result).toEqual({ ok: false, reason: "unknown_component" });
  });
});

describe("createSecretGateway.resolveApiKeySecret", () => {
  function build(): {
    cipher: StubCipher;
    reader: StubReader;
    gateway: ReturnType<typeof createSecretGateway>;
  } {
    const cipher = new StubCipher();
    const reader = new StubReader();
    const gateway = createSecretGateway({
      cipher,
      recordReader: reader,
      signingSecret: SIGNING_SECRET,
      now: () => FIXED_NOW,
    });
    return { cipher, reader, gateway };
  }

  it("returns plaintext on the happy path for every supported component", async () => {
    for (const component of SERVER_COMPONENTS) {
      const { cipher, reader, gateway } = build();
      const blob = cipher.seed("sk-live-secret-value");
      reader.set({ encryptedKey: blob });
      const token = freshToken({ component });
      const plain = await gateway.resolveApiKeySecret(
        localScope(),
        "openai",
        token,
      );
      expect(plain).toBe("sk-live-secret-value");
    }
  });

  it("throws invalid_token for a forged signature", async () => {
    const { cipher, reader, gateway } = build();
    const blob = cipher.seed("sk-live");
    reader.set({ encryptedKey: blob });
    const token = freshToken({ signingSecret: "wrong" });
    await expect(
      gateway.resolveApiKeySecret(localScope(), "openai", token),
    ).rejects.toMatchObject({
      name: "SecretResolutionError",
      code: "invalid_token",
    });
    // Decrypt MUST NOT have run.
    expect(cipher.decryptCalls).toBe(0);
  });

  it("throws expired_token for an expired token", async () => {
    const cipher = new StubCipher();
    const reader = new StubReader();
    reader.set({ encryptedKey: cipher.seed("sk-live") });
    const gateway = createSecretGateway({
      cipher,
      recordReader: reader,
      signingSecret: SIGNING_SECRET,
      now: () => new Date(FIXED_NOW.getTime() + 5 * 60_000),
    });
    const token = freshToken({ ttlMs: 60_000 });
    await expect(
      gateway.resolveApiKeySecret(localScope(), "openai", token),
    ).rejects.toMatchObject({
      name: "SecretResolutionError",
      code: "expired_token",
    });
    expect(cipher.decryptCalls).toBe(0);
  });

  it("throws unauthorized_component when component is not in gateway's allowlist", async () => {
    const cipher = new StubCipher();
    const reader = new StubReader();
    reader.set({ encryptedKey: cipher.seed("sk-live") });
    const gateway = createSecretGateway({
      cipher,
      recordReader: reader,
      signingSecret: SIGNING_SECRET,
      allowedComponents: ["model_catalog"],
      now: () => FIXED_NOW,
    });
    const token = freshToken({ component: "fallback_manager" });
    await expect(
      gateway.resolveApiKeySecret(localScope(), "openai", token),
    ).rejects.toMatchObject({
      name: "SecretResolutionError",
      code: "unauthorized_component",
    });
    expect(cipher.decryptCalls).toBe(0);
    expect(reader.reads).toHaveLength(0);
  });

  it("throws not_found when no record exists for (scope, provider)", async () => {
    const { gateway, cipher } = build();
    const token = freshToken();
    await expect(
      gateway.resolveApiKeySecret(localScope(), "anthropic", token),
    ).rejects.toMatchObject({
      name: "SecretResolutionError",
      code: "not_found",
    });
    expect(cipher.decryptCalls).toBe(0);
  });

  it("throws decrypt_failed when the reader throws", async () => {
    const { gateway, reader, cipher } = build();
    reader.throwNext(new Error("storage offline"));
    const token = freshToken();
    await expect(
      gateway.resolveApiKeySecret(localScope(), "openai", token),
    ).rejects.toMatchObject({
      name: "SecretResolutionError",
      code: "decrypt_failed",
    });
    expect(cipher.decryptCalls).toBe(0);
  });

  it("throws decrypt_failed when the cipher throws", async () => {
    const { gateway, reader, cipher } = build();
    const blob = cipher.seed("sk-live");
    cipher.throwOnCiphertext(blob.ciphertext);
    reader.set({ encryptedKey: blob });
    const token = freshToken();
    await expect(
      gateway.resolveApiKeySecret(localScope(), "openai", token),
    ).rejects.toBeInstanceOf(SecretResolutionError);
    await expect(
      gateway.resolveApiKeySecret(localScope(), "openai", token),
    ).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  it("does not leak plaintext on cipher failure (error message excludes plaintext)", async () => {
    const { gateway, reader, cipher } = build();
    const PLAIN = "sk-live-leaky-shouldnt-appear";
    const blob = cipher.seed(PLAIN);
    cipher.throwOnCiphertext(blob.ciphertext);
    reader.set({ encryptedKey: blob });
    const token = freshToken();
    try {
      await gateway.resolveApiKeySecret(localScope(), "openai", token);
      expect.fail("expected decrypt_failed");
    } catch (err) {
      const e = err as Error;
      expect(e.message.includes(PLAIN)).toBe(false);
    }
  });
});
