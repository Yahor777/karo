/**
 * Server-side `resolveApiKeySecret` gateway (task 6.3).
 *
 * Sources:
 *   • design.md → "Settings Store" → `SettingsStore` interface, in particular
 *     the `resolveApiKeySecret(scope, provider, requester)` signature and the
 *     `ServerComponentToken` shape with allowed component values
 *     `"model_catalog" | "orchestrator" | "agent_runtime" | "fallback_manager"`.
 *   • design.md → "Settings Store" → "Rules":
 *       – Decrypted API_Key must not be returned to client.
 *       – `resolveApiKeySecret` requires explicit server component request.
 *   • requirements.md → 3.7 (decrypted key only on explicit server-side
 *     request) and 4.5 (encrypted-at-rest secret storage).
 *
 * What this module provides:
 *
 *   • {@link ServerComponentToken} — the token type matching design.md.
 *   • {@link createServerComponentToken} — issues a signed token using
 *     HMAC-SHA-256 over a canonical `(version, component, issuedAt, expiresAt)`
 *     payload. Production composition issues these in-process for trusted
 *     server components and never exposes the signing secret to clients.
 *   • {@link verifyServerComponentToken} — verifies signature, expiry, and
 *     component allowlist using a constant-time signature comparison.
 *   • {@link createSecretGateway} — assembles `resolveApiKeySecret` over two
 *     injectable ports:
 *
 *       – {@link ApiKeyEncryptedRecordReader}: read-only access to the
 *         encrypted blob for a `(scope, provider)`. The records produced by
 *         task 6.1's `ApiKeyStoreBackend` already carry an `encryptedKey`
 *         field and trivially satisfy this narrower port — composition wires
 *         a thin adapter, leaving `apiKeys.ts` untouched.
 *       – `SecretCipher` from `./types.js` (re-exported here for callers):
 *         the same cipher port used by task 6.1's encrypt-on-write path.
 *         Composition wires the same `AesGcmSecretCipher` on both sides.
 *
 *   • {@link SecretResolutionError} — typed failure modes so callers (model
 *     catalog, orchestrator, agent runtime, fallback manager) can
 *     differentiate "your token is bad" from "no key is configured" from
 *     "decrypt blew up" without parsing message strings.
 *
 * Coordination with task 6.1: this module DOES NOT import from `./apiKeys.ts`.
 * It defines its own minimal {@link ApiKeyEncryptedRecordReader} port that
 * `ApiKeyStoreBackend.get` can be adapted into in three lines of composition
 * code, so tasks 6.1 and 6.3 stay independently testable and either side can
 * evolve without touching the other.
 *
 * Coordination with task 6.2: `customAgents.ts` is not touched here. Custom
 * agents are plain settings without secrets and have nothing to gate.
 *
 * No HTTP / IPC surface: this gateway is server-internal. It is never wired
 * to a route or to a renderer-facing IPC handler. The only callers are
 * trusted in-process server components that hold the signing secret.
 *
 * Validates: Requirements 3.7, 4.5.
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { ProviderId, Scope } from "@ai-agent-orchestrator/shared-core";

import type { EncryptedBlob, SecretCipher } from "./types.js";

// ---------------------------------------------------------------------------
// Server component identifiers
// ---------------------------------------------------------------------------

/**
 * Closed set of server-side components allowed to request decrypted API keys
 * via {@link resolveApiKeySecret}. Mirrors design.md → "Settings Store" →
 * `ServerComponentToken.component` exactly. Extending this set later is a
 * deliberate change because it widens the trust boundary; do not add values
 * without updating the design rules.
 */
export const SERVER_COMPONENTS = [
  "model_catalog",
  "orchestrator",
  "agent_runtime",
  "fallback_manager",
] as const;

export type ServerComponent = (typeof SERVER_COMPONENTS)[number];

const SERVER_COMPONENT_SET: ReadonlySet<string> = new Set(SERVER_COMPONENTS);

/**
 * Narrow type guard usable from JS-shaped inputs (e.g. parsed JSON), without
 * a cast. Centralised so the verifier and any future deserializer agree on
 * what counts as a known component.
 */
export function isServerComponent(value: unknown): value is ServerComponent {
  return typeof value === "string" && SERVER_COMPONENT_SET.has(value);
}

// ---------------------------------------------------------------------------
// Token type
// ---------------------------------------------------------------------------

/**
 * Signed `ServerComponentToken` (design.md → "Settings Store").
 *
 * Field semantics:
 *
 *   • `component`  — which server component is asking. Must be one of
 *     {@link SERVER_COMPONENTS}; the verifier additionally checks the
 *     caller-provided `allowedComponents` list (default: all four), which
 *     lets `resolveApiKeySecret` deployments tighten the allowlist further
 *     (e.g. allow only `model_catalog` on a read-only catalog node).
 *   • `issuedAt`   — ISO 8601 UTC moment at which the token was minted.
 *   • `expiresAt`  — ISO 8601 UTC moment after which the token is no longer
 *     accepted. Verifier requires `expiresAt > issuedAt`.
 *   • `signature`  — lowercase hex HMAC-SHA-256 over the canonical payload
 *     described by {@link canonicalTokenPayload}. The signing key is a
 *     server-process secret, never exposed to clients.
 */
export interface ServerComponentToken {
  readonly component: ServerComponent;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: string;
}

// ---------------------------------------------------------------------------
// Signature primitives
// ---------------------------------------------------------------------------

/**
 * Token-format version baked into the canonical payload. Bump (e.g. to
 * `"v2"`) on any breaking change to the canonicalisation rules; the verifier
 * recomputes the HMAC under whatever version it builds, so old tokens
 * minted with `"v1"` would simply fail signature verification under `"v2"`
 * — there is no silent acceptance of mixed versions.
 */
const TOKEN_VERSION = "v1";

/** Stable separator between canonical payload fields. `\n` is unambiguous in ISO 8601. */
const CANONICAL_FIELD_SEP = "\n";

/**
 * Builds the exact byte sequence the HMAC is computed over.
 *
 * Format (all UTF-8):
 *
 *   `<TOKEN_VERSION>\n<component>\n<issuedAt>\n<expiresAt>`
 *
 * Field-separator collisions cannot occur because:
 *   • TOKEN_VERSION is a fixed literal.
 *   • `component` is constrained to {@link SERVER_COMPONENTS}.
 *   • ISO 8601 timestamps do not contain `\n`.
 *
 * This is deliberately not JSON: JSON serialisation has multiple valid
 * orderings/formattings, which makes a stable signature input fragile.
 */
function canonicalTokenPayload(input: {
  readonly component: ServerComponent;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): string {
  return [
    TOKEN_VERSION,
    input.component,
    input.issuedAt,
    input.expiresAt,
  ].join(CANONICAL_FIELD_SEP);
}

/** Returns lowercase hex HMAC-SHA-256 over `payload`, keyed by `secret`. */
function computeSignature(payload: string, secret: string | Uint8Array): string {
  // `node:crypto.createHmac` accepts either a string secret or BinaryLike.
  // Both are supported here so callers can choose how to materialise the
  // secret (env var string, KMS-derived Uint8Array, etc).
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Constant-time hex string comparison. Returns `false` on any length
 * mismatch or non-hex input rather than throwing — the verifier treats
 * any failure as `invalid_signature`.
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  let aBuf: Buffer;
  let bBuf: Buffer;
  try {
    aBuf = Buffer.from(a, "hex");
    bBuf = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (aBuf.length !== bBuf.length || aBuf.length === 0) {
    // `Buffer.from(<bad hex>, "hex")` silently yields a shorter buffer in
    // some Node versions; reject any size mismatch.
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Token issuance
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link createServerComponentToken}.
 *
 * Either supply `expiresAt` directly or use `ttlMs` from `issuedAt`. Exactly
 * one of the two must be provided; supplying both, or neither, throws.
 * Tests typically use `issuedAt` + `ttlMs` for determinism.
 */
export type CreateServerComponentTokenInput =
  & {
    readonly component: ServerComponent;
    readonly signingSecret: string | Uint8Array;
    readonly issuedAt?: Date;
  }
  & (
    | { readonly ttlMs: number; readonly expiresAt?: undefined }
    | { readonly expiresAt: Date; readonly ttlMs?: undefined }
  );

/**
 * Mints a signed {@link ServerComponentToken}.
 *
 * Behaviour:
 *   • `component` MUST be one of {@link SERVER_COMPONENTS}.
 *   • `issuedAt` defaults to "now" via `new Date()`.
 *   • `ttlMs` MUST be a positive finite integer when supplied; the resulting
 *     `expiresAt` is `issuedAt + ttlMs`.
 *   • `expiresAt` MUST be strictly after `issuedAt` when supplied directly.
 *
 * Issuance never inspects the encrypted store or the cipher — minting a
 * token is a pure, fast operation. The trust boundary is enforced at
 * {@link verifyServerComponentToken} time, which is what `resolveApiKeySecret`
 * always calls before touching ciphertext.
 */
export function createServerComponentToken(
  input: CreateServerComponentTokenInput,
): ServerComponentToken {
  if (!isServerComponent(input.component)) {
    throw new Error(
      `createServerComponentToken: unknown component "${String(input.component)}".`,
    );
  }
  const issuedAtDate = input.issuedAt ?? new Date();
  if (Number.isNaN(issuedAtDate.getTime())) {
    throw new Error("createServerComponentToken: issuedAt is an invalid Date.");
  }

  let expiresAtDate: Date;
  if (input.ttlMs !== undefined) {
    if (input.expiresAt !== undefined) {
      throw new Error(
        "createServerComponentToken: provide either ttlMs or expiresAt, not both.",
      );
    }
    if (
      typeof input.ttlMs !== "number" ||
      !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0
    ) {
      throw new Error(
        "createServerComponentToken: ttlMs must be a positive finite number.",
      );
    }
    expiresAtDate = new Date(issuedAtDate.getTime() + input.ttlMs);
  } else if (input.expiresAt !== undefined) {
    if (Number.isNaN(input.expiresAt.getTime())) {
      throw new Error(
        "createServerComponentToken: expiresAt is an invalid Date.",
      );
    }
    if (input.expiresAt.getTime() <= issuedAtDate.getTime()) {
      throw new Error(
        "createServerComponentToken: expiresAt must be strictly after issuedAt.",
      );
    }
    expiresAtDate = input.expiresAt;
  } else {
    throw new Error(
      "createServerComponentToken: either ttlMs or expiresAt is required.",
    );
  }

  const issuedAt = issuedAtDate.toISOString();
  const expiresAt = expiresAtDate.toISOString();
  const signature = computeSignature(
    canonicalTokenPayload({ component: input.component, issuedAt, expiresAt }),
    input.signingSecret,
  );

  return {
    component: input.component,
    issuedAt,
    expiresAt,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Reasons a token can be rejected. Returned to callers as a discriminated
 * union; never as a string the caller has to parse.
 */
export type TokenVerificationFailure =
  | "invalid_shape"
  | "unknown_component"
  | "not_in_allowlist"
  | "invalid_timestamps"
  | "invalid_signature"
  | "not_yet_valid"
  | "expired";

export type TokenVerificationResult =
  | { readonly ok: true; readonly component: ServerComponent }
  | { readonly ok: false; readonly reason: TokenVerificationFailure };

export interface VerifyServerComponentTokenOptions {
  readonly signingSecret: string | Uint8Array;
  /**
   * Optional further-restricted allowlist. Defaults to {@link SERVER_COMPONENTS}
   * (every supported component). A deployment that only needs to support
   * `model_catalog` access can pass `["model_catalog"]` to fail-fast on any
   * other component, even with a structurally valid signature.
   */
  readonly allowedComponents?: readonly ServerComponent[];
  /**
   * Clock injection point. Defaults to `() => new Date()`. Tests pass a
   * fixed clock to make expiry assertions deterministic.
   */
  readonly now?: () => Date;
}

/**
 * Verifies a token end-to-end:
 *
 *   1. Structural shape (4 string fields, all present).
 *   2. `component` is a recognised {@link ServerComponent}.
 *   3. `component` is in the caller's `allowedComponents` allowlist.
 *   4. Timestamps parse as ISO 8601 with `expiresAt > issuedAt`.
 *   5. Signature matches a fresh HMAC over the canonical payload.
 *   6. `now` is in `[issuedAt, expiresAt)`.
 *
 * Returns a structured result instead of throwing so callers can map each
 * reason to a different protocol response without exception parsing.
 *
 * Order of checks: shape and component go first because they are cheap and
 * key-independent. Signature verification runs before clock checks so an
 * attacker cannot distinguish "valid signature, expired" from
 * "invalid signature, expired" via timing alone — both paths still touch
 * the HMAC computation.
 */
export function verifyServerComponentToken(
  token: unknown,
  options: VerifyServerComponentTokenOptions,
): TokenVerificationResult {
  if (typeof token !== "object" || token === null) {
    return { ok: false, reason: "invalid_shape" };
  }
  const t = token as Partial<ServerComponentToken>;
  if (
    typeof t.component !== "string" ||
    typeof t.issuedAt !== "string" ||
    typeof t.expiresAt !== "string" ||
    typeof t.signature !== "string"
  ) {
    return { ok: false, reason: "invalid_shape" };
  }
  if (t.component.length === 0 || t.signature.length === 0) {
    return { ok: false, reason: "invalid_shape" };
  }

  if (!isServerComponent(t.component)) {
    return { ok: false, reason: "unknown_component" };
  }
  const component = t.component;

  const allowed = options.allowedComponents ?? SERVER_COMPONENTS;
  if (!allowed.includes(component)) {
    return { ok: false, reason: "not_in_allowlist" };
  }

  const issuedAtMs = Date.parse(t.issuedAt);
  const expiresAtMs = Date.parse(t.expiresAt);
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= issuedAtMs
  ) {
    return { ok: false, reason: "invalid_timestamps" };
  }

  const expectedSig = computeSignature(
    canonicalTokenPayload({
      component,
      issuedAt: t.issuedAt,
      expiresAt: t.expiresAt,
    }),
    options.signingSecret,
  );
  if (!timingSafeHexEqual(expectedSig, t.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  if (nowMs < issuedAtMs) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (nowMs >= expiresAtMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, component };
}

// ---------------------------------------------------------------------------
// Encrypted record reader port
// ---------------------------------------------------------------------------

/**
 * Read-only port for fetching the encrypted blob for a `(scope, provider)`.
 *
 * Why a custom port instead of importing `ApiKeyStoreBackend` from
 * `./types.ts`: task 6.3 must not depend on task 6.1's surface. A wrapper
 * adapter in composition (a few lines) maps `ApiKeyStoreBackend.get` into
 * this port — that is the integration seam.
 *
 * Contract:
 *   • Returns `null` when no record exists for `(scope, provider)`.
 *   • Throws on transport / storage failure (network, decrypt of an outer
 *     wrapper layer, etc.). The gateway turns thrown errors into a typed
 *     {@link SecretResolutionError} so callers don't have to inspect causes.
 *   • The returned value carries only the `encryptedKey` field — no
 *     metadata leaks through this path. Callers that need metadata go
 *     through `ApiKeyService.listApiKeyMetadata` (task 6.1) instead.
 */
export interface ApiKeyEncryptedRecordReader {
  read(
    scope: Scope,
    provider: ProviderId,
  ): Promise<{ readonly encryptedKey: EncryptedBlob } | null>;
}

// ---------------------------------------------------------------------------
// Gateway error type
// ---------------------------------------------------------------------------

/**
 * Failure modes the gateway can surface. Keep this list narrow so the
 * caller's `switch` over `code` stays exhaustive even as the gateway
 * evolves.
 */
export type SecretResolutionErrorCode =
  | "invalid_token"
  | "expired_token"
  | "not_yet_valid_token"
  | "unauthorized_component"
  | "not_found"
  | "decrypt_failed";

/**
 * Typed error thrown by `resolveApiKeySecret`. Distinct codes let callers
 * differentiate "your token is bad" (caller bug) from "no key configured"
 * (user state) from "decrypt blew up" (operational issue) without parsing
 * messages. Original verifier reasons are folded into a smaller user-facing
 * code set:
 *
 *   • `invalid_shape` / `unknown_component` / `invalid_timestamps` /
 *     `invalid_signature`  → `"invalid_token"`
 *   • `expired`                                                  → `"expired_token"`
 *   • `not_yet_valid`                                            → `"not_yet_valid_token"`
 *   • `not_in_allowlist`                                         → `"unauthorized_component"`
 *
 * Messages are deliberately short and contain no secret material.
 */
export class SecretResolutionError extends Error {
  public readonly code: SecretResolutionErrorCode;

  public constructor(code: SecretResolutionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SecretResolutionError";
  }
}

// ---------------------------------------------------------------------------
// Gateway factory
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link createSecretGateway}.
 */
export interface SecretGatewayOptions {
  readonly recordReader: ApiKeyEncryptedRecordReader;
  readonly cipher: SecretCipher;
  /**
   * HMAC signing secret. MUST be at least 32 bytes of unguessable material
   * in production. Tests typically pass a fixed string; production
   * composition derives this from a KMS or environment variable.
   */
  readonly signingSecret: string | Uint8Array;
  /** Optional allowlist override; defaults to all of {@link SERVER_COMPONENTS}. */
  readonly allowedComponents?: readonly ServerComponent[];
  /** Optional clock injection (defaults to `() => new Date()`). */
  readonly now?: () => Date;
}

/**
 * Public surface produced by {@link createSecretGateway}. A single function
 * is enough — the gateway exposes no other operations because every other
 * settings concern (metadata listing, custom agents, etc.) belongs to a
 * different module.
 */
export interface SecretGateway {
  /**
   * Verifies `requester`, reads the encrypted blob for `(scope, provider)`,
   * and returns the decrypted plaintext. Throws {@link SecretResolutionError}
   * on any failure mode.
   *
   * Server-internal: this method is NEVER exposed over HTTP / IPC. Callers
   * MUST be in-process server components (model catalog, orchestrator,
   * agent runtime, fallback manager) holding the signing secret.
   *
   * Validates: Requirements 3.7, 4.5.
   */
  resolveApiKeySecret(
    scope: Scope,
    provider: ProviderId,
    requester: ServerComponentToken,
  ): Promise<string>;
}

/**
 * Builds a gateway over a record reader and a cipher.
 *
 * Steps in order:
 *   1. {@link verifyServerComponentToken} — signature, expiry, allowlist.
 *      A failure here throws {@link SecretResolutionError} BEFORE any
 *      ciphertext is touched, so an attacker who only forges a token
 *      gains nothing.
 *   2. `recordReader.read` — fetch the encrypted blob. `null` ⇒
 *      `"not_found"`. Thrown errors are wrapped as `"not_found"` only when
 *      they unambiguously mean "no such record"; any other thrown error
 *      propagates as `"decrypt_failed"` so callers retry storage failures
 *      separately. (We standardise on `"decrypt_failed"` for "encrypted
 *      record could not be materialised" to avoid a new error code; the
 *      `cause` field preserves the underlying error for diagnostics.)
 *   3. `cipher.decrypt` — produce plaintext. Any exception becomes
 *      `"decrypt_failed"` with the original error attached as `cause`.
 *
 * The plaintext is returned ONLY through this function's return value. No
 * logging, no caching, no error-message embedding.
 */
export function createSecretGateway(options: SecretGatewayOptions): SecretGateway {
  const allowedComponents = options.allowedComponents ?? SERVER_COMPONENTS;
  const now = options.now ?? ((): Date => new Date());

  return {
    async resolveApiKeySecret(scope, provider, requester) {
      // 1. Token verification.
      const verification = verifyServerComponentToken(requester, {
        signingSecret: options.signingSecret,
        allowedComponents,
        now,
      });
      if (!verification.ok) {
        switch (verification.reason) {
          case "expired":
            throw new SecretResolutionError(
              "expired_token",
              "ServerComponentToken has expired.",
            );
          case "not_yet_valid":
            throw new SecretResolutionError(
              "not_yet_valid_token",
              "ServerComponentToken is not yet valid.",
            );
          case "not_in_allowlist":
            throw new SecretResolutionError(
              "unauthorized_component",
              "ServerComponentToken component is not authorised for this gateway.",
            );
          case "invalid_shape":
          case "unknown_component":
          case "invalid_timestamps":
          case "invalid_signature":
            throw new SecretResolutionError(
              "invalid_token",
              "ServerComponentToken failed verification.",
            );
        }
      }

      // 2. Encrypted record lookup.
      let record: { readonly encryptedKey: EncryptedBlob } | null;
      try {
        record = await options.recordReader.read(scope, provider);
      } catch (cause) {
        const err = new SecretResolutionError(
          "decrypt_failed",
          "Failed to read encrypted API key record.",
        );
        (err as { cause?: unknown }).cause = cause;
        throw err;
      }
      if (record === null) {
        throw new SecretResolutionError(
          "not_found",
          "No API key configured for the given scope and provider.",
        );
      }

      // 3. Decrypt.
      try {
        return await options.cipher.decrypt(record.encryptedKey);
      } catch (cause) {
        const err = new SecretResolutionError(
          "decrypt_failed",
          "Decryption of the stored API key failed.",
        );
        (err as { cause?: unknown }).cause = cause;
        throw err;
      }
    },
  };
}
