/**
 * Auth Service — structured error redaction at the gateway boundary
 * (task 20.1).
 *
 * Sources:
 *   • design.md → "Auth Service" → "Rules" — API_Key never included in
 *     responses; OAuth/secret material never echoed back.
 *   • design.md → "Settings Store" → "Rules" — descriptive errors must
 *     not leak secrets.
 *   • requirements.md → 1.6, 3.5, 3.7, 4.5.
 *
 * The Auth Service already enforces the no-leak invariant inside its
 * own implementation (see `authService.test.ts` and `googleOAuth.ts`).
 * Task 20.1 adds the {@link wrapAsyncHandler} adapter so the gateway
 * can surface a redacted, structured `{ code, message, details? }`
 * envelope to the renderer regardless of how a service throws. These
 * tests pin two contracts:
 *
 *   1. `validateApiKey` returning a Provider error MUST NOT echo the
 *      API key back. The probe contract already forbids this; we add
 *      a regression test at the boundary so an upstream library bug
 *      cannot quietly bring back the leak.
 *   2. `completeGoogleOAuth` rejecting with `settings_load_failed`
 *      (Requirement 3.5) MUST surface as a structured envelope with
 *      `code === "settings_load_failed"`. The wrapper preserves the
 *      string `code` field so the existing Gmail UI's "retry later"
 *      branch keeps working unchanged.
 *
 * Validates: Requirements 1.6, 3.5, 3.7, 4.5.
 */

import { describe, expect, it } from "vitest";

import { wrapAsync, wrapAsyncHandler } from "../errorBoundary.js";

import {
  AuthService,
  GoogleOAuthError,
  type ProviderProbe,
} from "./index.js";

// ---------------------------------------------------------------------
// validateApiKey wrapped through the error boundary
// ---------------------------------------------------------------------

describe("wrapAsyncHandler around AuthService.validateApiKey", () => {
  it(
    "returns the structured success envelope and never echoes the API key " +
      "in the rejected branch (Requirements 2.3, 4.5)",
    async () => {
      const apiKey = "sk-secret-must-not-leak-ABCDEFGHIJKLMNOP";
      // Probe that surfaces a Provider rejection while strictly
      // following the contract: never echo `apiKey` into the response.
      const rejecting: ProviderProbe = {
        provider: "openai",
        async probe() {
          return {
            kind: "error",
            providerCode: "invalid_api_key",
            providerMessage: "Incorrect API key provided",
          };
        },
      };
      const service = new AuthService({ probes: [rejecting] });

      const wrapped = wrapAsyncHandler(
        async (input: { provider: string; apiKey: string }) =>
          service.validateApiKey(input),
      );

      const result = await wrapped({ provider: "openai", apiKey });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The wrapped value is the structured ValidationResult — Auth's
        // own contract — and must not contain the plaintext key in any
        // nested field.
        expect(result.value).toEqual({
          kind: "error",
          providerCode: "invalid_api_key",
          providerMessage: "Incorrect API key provided",
        });
        expect(JSON.stringify(result.value)).not.toContain(apiKey);
      }
    },
  );

  it(
    "redacts API-key-shaped material in a thrown-value path " +
      "(defence-in-depth for any future probe that misbehaves)",
    async () => {
      const leakedKey = "sk-leaked-XXXXXXXXXXXXXXXXXXXX";
      // A handler that "shouldn't" exist but might if a future probe
      // throws a misformatted Error embedding the API key. The wrapper
      // is the last line of defence.
      const wrapped = wrapAsyncHandler<
        { apiKey: string },
        { kind: "ok" }
      >(async () => {
        throw new Error(
          `provider call rejected key ${leakedKey} via http_401`,
        );
      });

      const result = await wrapped({ apiKey: leakedKey });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unknown");
        expect(result.error.message).not.toContain(leakedKey);
        expect(result.error.message).toMatch(/REDACTED/);
      }
    },
  );
});

// ---------------------------------------------------------------------
// completeGoogleOAuth wrapped through the error boundary
// ---------------------------------------------------------------------

describe("wrapAsync around completeGoogleOAuth (Requirement 3.5)", () => {
  /**
   * Stand-in for the wider `completeGoogleOAuth` flow: the existing
   * runtime behaviour from task 17.4 already attaches `code` properties
   * to errors (see `apps/web/src/shell/oauthCallback.ts`). Task 20.1
   * only adds the redaction wrapper around them — we never alter the
   * runtime behaviour. This test reproduces the canonical
   * `settings_load_failed` shape via a typed `Error` carrying a string
   * `code`, which is what the Gmail UI branches on.
   */
  class SettingsLoadError extends Error {
    public override readonly name = "SettingsLoadError";
    public readonly code = "settings_load_failed";
    public readonly status: number;

    public constructor(message: string, status = 503) {
      super(message);
      this.status = status;
    }
  }

  it(
    "surfaces a structured envelope with code === 'settings_load_failed' " +
      "without leaking secrets",
    async () => {
      const wrapped = wrapAsync<{ id: string }>(async () => {
        throw new SettingsLoadError(
          "cloud settings backend unreachable for sk-ABCDEFGHIJKLMNOPQRSTUVWX",
        );
      });

      const result = await wrapped();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Requirement 3.5: the Gmail UI branches on this exact code.
        expect(result.error.code).toBe("settings_load_failed");
        // Secret material is masked even when embedded in the message.
        expect(result.error.message).not.toContain(
          "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
        );
        expect(result.error.message).toContain(
          "[REDACTED:api_key:openai]",
        );
        // No `details` was provided so the envelope omits the field.
        expect(result.error.details).toBeUndefined();
      }
    },
  );

  it(
    "preserves typed GoogleOAuthError codes through the wrapper " +
      "(state_replayed, code_exchange_failed, …)",
    async () => {
      const codes = [
        "invalid_state",
        "expired_state",
        "code_exchange_failed",
        "userinfo_failed",
        "provider_unreachable",
      ] as const;
      for (const code of codes) {
        const wrapped = wrapAsync<{ id: string }>(async () => {
          throw new GoogleOAuthError(code, `provider rejected (${code})`);
        });
        const result = await wrapped();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(code);
          expect(result.error.message).toContain(code);
        }
      }
    },
  );

  it(
    "never throws when the underlying error has weird accessors " +
      "— the gateway always sees a structured envelope",
    async () => {
      const evil = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(evil, "code", {
        get() {
          throw new Error("trap");
        },
      });
      Object.defineProperty(evil, "message", {
        get() {
          throw new Error("trap");
        },
      });

      const wrapped = wrapAsync<{ id: string }>(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw evil;
      });
      const result = await wrapped();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unknown");
        expect(typeof result.error.message).toBe("string");
      }
    },
  );

  it("returns the success envelope when the wrapped handler resolves", async () => {
    const wrapped = wrapAsync<{ id: string }>(async () => ({
      id: "session-1",
    }));
    const result = await wrapped();
    expect(result).toEqual({ ok: true, value: { id: "session-1" } });
  });
});
