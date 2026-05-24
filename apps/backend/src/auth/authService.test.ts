/**
 * Unit tests for the Auth Service local session flow (tasks 4.2 + 4.4).
 *
 * Two surfaces are exercised here:
 *
 *   1. `AuthService.createLocalSession` (task 4.2) — the four sub-bullets
 *      from tasks.md task 4.2 plus the `LocalSessionError` failure modes:
 *
 *      • Success path: returns a `Session` of kind `"local"`, mints a
 *        fresh `id`, copies the input `deviceId`, stamps `createdAt`
 *        from the injected clock, and forwards the API key to the sink
 *        EXACTLY ONCE.
 *      • Confirmation gate (Requirement 2.4): missing or
 *        `confirmedByUser` other than the literal `true` rejects with
 *        `LocalSessionError("missing_confirmation")` BEFORE the sink is
 *        called.
 *      • Returned-session shape (Requirement 2.5): no field on the
 *        returned `Session` carries the API key — checked by deep
 *        stringification.
 *      • Encrypted-storage write invariant (Requirement 4.5): the sink
 *        receives the plaintext exactly once on success, zero times on
 *        every rejection path.
 *      • Storage failure (Requirement 4.5 hygiene): when the sink
 *        throws, the call rejects with
 *        `LocalSessionError("storage_failed")`, attaches the original
 *        error as `cause`, and the error message does NOT contain the
 *        API-key plaintext.
 *
 *   2. `AuthService.validateApiKey` (task 4.4) — the "invalid key
 *      rejection" sub-bullet that completes task 4.4's coverage of the
 *      local session flow:
 *
 *      • Empty/whitespace key short-circuits to a structured
 *        `kind: "error"` without invoking the probe (Requirement 2.2).
 *      • A Provider-rejected key is forwarded verbatim with the
 *        Provider's `providerCode`/`providerMessage` so the UI can
 *        surface the cause (Requirement 2.3).
 *      • An unknown provider returns `unsupported_provider` so the UI
 *        can render a distinct "configure this Provider first" message
 *        (Requirement 2.3 hygiene).
 *      • A probe that throws is wrapped as `unexpected_error` rather
 *        than bubbling — Requirement 2.3 must hold even if a probe
 *        adapter misbehaves.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.8, 4.5.
 */

import { describe, expect, it } from "vitest";

import {
  AuthService,
  LocalSessionError,
  type CreateLocalSessionInput,
  type LocalApiKeySink,
  type ProviderProbe,
} from "./index.js";

const FIXED_NOW = new Date("2025-02-03T12:34:56.789Z");

/** Minimal stub probe — `validateApiKey` is exercised in other tests. */
const noopProbe: ProviderProbe = {
  provider: "openai",
  async probe() {
    return { kind: "ok" };
  },
};

/**
 * Recording sink used to assert the persistence contract:
 *   • plaintext is forwarded verbatim;
 *   • the sink is invoked exactly once on success and never on rejected
 *     calls.
 */
class RecordingSink implements LocalApiKeySink {
  public readonly calls: Array<{
    deviceId: string;
    provider: string;
    apiKey: string;
  }> = [];
  private err: Error | null = null;

  public throwOnNext(err: Error): void {
    this.err = err;
  }

  public async persistApiKey(input: {
    readonly deviceId: string;
    readonly provider: string;
    readonly apiKey: string;
  }): Promise<void> {
    this.calls.push({
      deviceId: input.deviceId,
      provider: input.provider,
      apiKey: input.apiKey,
    });
    if (this.err) {
      const e = this.err;
      this.err = null;
      throw e;
    }
  }
}

interface BuildResult {
  service: AuthService;
  sink: RecordingSink;
}

function build(overrides: { sink?: RecordingSink } = {}): BuildResult {
  const sink = overrides.sink ?? new RecordingSink();
  let n = 0;
  const service = new AuthService({
    probes: [noopProbe],
    localApiKeySink: sink,
    clock: { now: () => FIXED_NOW },
    sessionIdSource: {
      next: () => {
        n += 1;
        return `session-${String(n)}`;
      },
    },
  });
  return { service, sink };
}

const validInput: CreateLocalSessionInput = {
  deviceId: "device-A",
  provider: "openai",
  apiKey: "sk-test-shouldnt-leak",
  confirmedByUser: true,
};

describe("AuthService.createLocalSession", () => {
  it("returns a local Session with id, deviceId, createdAt and no apiKey field", async () => {
    const { service, sink } = build();
    const session = await service.createLocalSession(validInput);

    expect(session).toEqual({
      id: "session-1",
      kind: "local",
      deviceId: "device-A",
      createdAt: FIXED_NOW.toISOString(),
    });
    // Structural check: the returned shape carries no apiKey-shaped key.
    expect(Object.keys(session)).toEqual(
      expect.arrayContaining(["id", "kind", "deviceId", "createdAt"]),
    );
    expect("apiKey" in (session as Record<string, unknown>)).toBe(false);
    // Deep stringification proves no nested field carries the plaintext.
    expect(JSON.stringify(session)).not.toContain(validInput.apiKey);

    // Sink was invoked exactly once with the supplied plaintext.
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({
      deviceId: "device-A",
      provider: "openai",
      apiKey: "sk-test-shouldnt-leak",
    });
  });

  it("does not include userId on a local session (Requirement 2.8)", async () => {
    const { service } = build();
    const session = await service.createLocalSession(validInput);
    expect(session.kind).toBe("local");
    expect(session.userId).toBeUndefined();
  });

  it("rejects with missing_confirmation when confirmedByUser is missing", async () => {
    const { service, sink } = build();
    // Cast through `unknown` so the test can construct an input that the
    // literal-true type intentionally forbids at compile time.
    const bad = {
      deviceId: "device-A",
      provider: "openai",
      apiKey: "sk-test",
    } as unknown as CreateLocalSessionInput;

    await expect(service.createLocalSession(bad)).rejects.toBeInstanceOf(
      LocalSessionError,
    );
    await expect(service.createLocalSession(bad)).rejects.toMatchObject({
      code: "missing_confirmation",
    });

    // Critically: sink MUST NOT have been called.
    expect(sink.calls).toHaveLength(0);
  });

  it("rejects with missing_confirmation when confirmedByUser is false", async () => {
    const { service, sink } = build();
    const bad = {
      ...validInput,
      confirmedByUser: false,
    } as unknown as CreateLocalSessionInput;

    await expect(service.createLocalSession(bad)).rejects.toMatchObject({
      name: "LocalSessionError",
      code: "missing_confirmation",
    });
    expect(sink.calls).toHaveLength(0);
  });

  it("rejects truthy non-true confirmedByUser values (e.g. 1, 'true', {})", async () => {
    for (const truthy of [1, "true", {}, [true]] as const) {
      const { service, sink } = build();
      const bad = {
        ...validInput,
        confirmedByUser: truthy,
      } as unknown as CreateLocalSessionInput;

      await expect(service.createLocalSession(bad)).rejects.toMatchObject({
        name: "LocalSessionError",
        code: "missing_confirmation",
      });
      expect(sink.calls).toHaveLength(0);
    }
  });

  it("rejects with invalid_input for empty deviceId / provider / apiKey", async () => {
    const cases: Array<Partial<CreateLocalSessionInput>> = [
      { deviceId: "" },
      { deviceId: "   " },
      { provider: "" },
      { provider: "   " },
      { apiKey: "" },
    ];

    for (const patch of cases) {
      const { service, sink } = build();
      const input = { ...validInput, ...patch } as CreateLocalSessionInput;
      await expect(service.createLocalSession(input)).rejects.toMatchObject({
        name: "LocalSessionError",
        code: "invalid_input",
      });
      expect(sink.calls).toHaveLength(0);
    }
  });

  it("propagates sink failures as storage_failed without leaking plaintext", async () => {
    const sink = new RecordingSink();
    sink.throwOnNext(new Error("disk offline"));
    const { service } = build({ sink });

    let caught: unknown;
    try {
      await service.createLocalSession(validInput);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalSessionError);
    const e = caught as LocalSessionError;
    expect(e.code).toBe("storage_failed");
    // Original error preserved as `cause` for diagnostics.
    expect((e as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((e as { cause?: Error }).cause as Error).message).toContain(
      "disk offline",
    );
    // The thrown error MUST NOT carry the plaintext key.
    expect(e.message).not.toContain(validInput.apiKey);

    // Sink WAS attempted exactly once.
    expect(sink.calls).toHaveLength(1);
  });

  it("invokes the sink exactly once on a successful call", async () => {
    const { service, sink } = build();
    await service.createLocalSession(validInput);
    expect(sink.calls).toHaveLength(1);

    // A second call mints a different session id and invokes the sink
    // again — the "exactly once per call" invariant is per-call.
    await service.createLocalSession({
      ...validInput,
      apiKey: "sk-second-call",
    });
    expect(sink.calls).toHaveLength(2);
    expect(sink.calls.map((c) => c.apiKey)).toEqual([
      "sk-test-shouldnt-leak",
      "sk-second-call",
    ]);
  });

  it("fails with storage_failed when no sink is configured", async () => {
    const service = new AuthService({
      probes: [noopProbe],
      // No `localApiKeySink` — simulates a deployment that wired up
      // `validateApiKey` but forgot the sink.
      clock: { now: () => FIXED_NOW },
      sessionIdSource: { next: () => "s" },
    });
    await expect(
      service.createLocalSession(validInput),
    ).rejects.toMatchObject({
      name: "LocalSessionError",
      code: "storage_failed",
    });
  });
});

describe("AuthService.validateApiKey (task 4.4 — invalid key rejection)", () => {
  /**
   * Probe that fails the key with a Provider-native error code/message
   * — the realistic shape an OpenAI 401 would produce after passing
   * through `mapErrorBody` in `providerProbe.ts`.
   */
  const rejectingProbe: ProviderProbe = {
    provider: "openai",
    async probe() {
      return {
        kind: "error",
        providerCode: "invalid_api_key",
        providerMessage: "Incorrect API key provided",
      };
    },
  };

  /** Probe that surfaces a transport-level failure as a structured error. */
  const unreachableProbe: ProviderProbe = {
    provider: "openai",
    async probe() {
      return {
        kind: "error",
        providerCode: "provider_unreachable",
        providerMessage: "Could not reach openai: ECONNREFUSED",
      };
    },
  };

  /**
   * Defence-in-depth: probes are documented not to throw, but if one
   * does, `validateApiKey` must still return a structured error rather
   * than rejecting (Requirement 2.3 — never let an auth failure bubble
   * as an unhandled exception).
   */
  const throwingProbe: ProviderProbe = {
    provider: "openai",
    async probe() {
      throw new Error("probe blew up");
    },
  };

  function buildValidator(probe: ProviderProbe): AuthService {
    return new AuthService({
      probes: [probe],
      // No sink wired — `validateApiKey` doesn't need one.
      clock: { now: () => FIXED_NOW },
      sessionIdSource: { next: () => "session-validate" },
    });
  }

  it("rejects empty / whitespace-only API key without invoking the probe", async () => {
    let probeCalls = 0;
    const probe: ProviderProbe = {
      provider: "openai",
      async probe() {
        probeCalls += 1;
        return { kind: "ok" };
      },
    };
    const service = buildValidator(probe);

    for (const apiKey of ["", "   ", "\t\n"]) {
      const result = await service.validateApiKey({
        provider: "openai",
        apiKey,
      });
      expect(result).toEqual({
        kind: "error",
        providerCode: "invalid_api_key",
        providerMessage: "API key is empty",
      });
    }

    // Critically: empty input never reaches the network. This protects
    // Requirement 2.2's "validate before creating session" by failing
    // fast on obviously bad UI state.
    expect(probeCalls).toBe(0);
  });

  it("returns a structured error carrying the Provider's code and message (Requirement 2.3)", async () => {
    const service = buildValidator(rejectingProbe);
    const result = await service.validateApiKey({
      provider: "openai",
      apiKey: "sk-bogus",
    });

    expect(result).toEqual({
      kind: "error",
      providerCode: "invalid_api_key",
      providerMessage: "Incorrect API key provided",
    });
  });

  it("forwards transport-level Provider failures as structured errors", async () => {
    const service = buildValidator(unreachableProbe);
    const result = await service.validateApiKey({
      provider: "openai",
      apiKey: "sk-anything",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("provider_unreachable");
      expect(result.providerMessage).toContain("Could not reach openai");
    }
  });

  it("returns unsupported_provider for a provider with no registered probe", async () => {
    const service = buildValidator(rejectingProbe);
    const result = await service.validateApiKey({
      // `rejectingProbe` only handles "openai"; routing for any other
      // ID must short-circuit cleanly so the UI shows a precise
      // "configure this Provider first" message.
      provider: "anthropic",
      apiKey: "sk-anything",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("unsupported_provider");
      expect(result.providerMessage).toContain("anthropic");
    }
  });

  it("wraps unexpected probe exceptions as kind=error rather than rejecting", async () => {
    const service = buildValidator(throwingProbe);

    // The promise must resolve, not reject — Requirement 2.3 forbids
    // letting a misbehaving probe surface as an unhandled exception
    // that would bypass the "reject login on auth failure" path.
    const result = await service.validateApiKey({
      provider: "openai",
      apiKey: "sk-anything",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("unexpected_error");
      expect(result.providerMessage).toContain("probe blew up");
    }
  });

  it("returns kind=ok and forwards modelsCount when the probe accepts the key", async () => {
    const okProbe: ProviderProbe = {
      provider: "openai",
      async probe() {
        return { kind: "ok", modelsCount: 7 };
      },
    };
    const service = buildValidator(okProbe);
    const result = await service.validateApiKey({
      provider: "openai",
      apiKey: "sk-good",
    });
    expect(result).toEqual({ kind: "ok", modelsCount: 7 });
  });

  it("does not echo the supplied apiKey into the result message", async () => {
    const service = buildValidator(rejectingProbe);
    const apiKey = "sk-secret-must-not-leak";
    const result = await service.validateApiKey({
      provider: "openai",
      apiKey,
    });

    // The whole result is stringified to catch leakage in any nested
    // field (current or future). Probe adapters are required to keep
    // the plaintext out of `providerMessage`; this asserts the contract
    // at the AuthService boundary too.
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});
