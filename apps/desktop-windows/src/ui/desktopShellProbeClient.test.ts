/**
 * `desktopShellProbeClient` tests — pin the contract that the desktop
 * renderer routes provider probes through the Tauri shell instead of
 * a direct `fetch`.
 *
 * Background — see `desktopShellProbeClient.ts`. The bug we are
 * regression-guarding against:
 *
 *   • Tauri WebView's CSP blocks outbound HTTPS to provider domains.
 *   • Provider responses do not advertise CORS for `tauri://` origins.
 *   • A direct renderer `fetch` therefore rejects with `TypeError:
 *     Failed to fetch`, surfaced to the user as
 *     `provider_unreachable: Could not reach fireworks: Failed to fetch`.
 *
 * The fix is to route the probe through the Rust side via
 * `desktopShell.probeProvider`. These tests pin that wiring — both at
 * the unit level (the wrapper translates correctly) and end-to-end
 * (the gateway picks up the wrapper and never falls back to `fetch`).
 *
 * Validates: Requirements 1.6, 2.2, 2.3, 4.2, 4.3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RendererLoginGateway } from "@ai-agent-orchestrator/client-sdk";

import type { DesktopShell, ProviderProbeRequest } from "../shell/types.js";

import { createDesktopShellProbeClient } from "./desktopShellProbeClient.js";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Builds a fake `DesktopShell` whose `probeProvider` records every
 * call and returns a configurable response.
 */
function buildShell(opts: {
  status?: number;
  body?: string;
  ok?: boolean;
  error?: Error;
}): {
  shell: DesktopShell;
  probeCalls: ProviderProbeRequest[];
} {
  const probeCalls: ProviderProbeRequest[] = [];
  const shell: DesktopShell = {
    getDeviceId: vi.fn(async () => "device-test"),
    readLocalSetting: vi.fn(async () => null),
    writeLocalSetting: vi.fn(async () => undefined),
    deleteLocalSetting: vi.fn(async () => undefined),
    encryptLocalSecret: vi.fn(async () => ({
      algorithm: "fake",
      ciphertext: "",
      createdAt: "2025-01-01T00:00:00.000Z",
    })),
    decryptLocalSecret: vi.fn(async () => ""),
    writeLocalLog: vi.fn(async () => undefined),
    exportFile: vi.fn(async () => ({ savedPath: "" })),
    showNotification: vi.fn(async () => undefined),
    probeProvider: vi.fn(async (request: ProviderProbeRequest) => {
      probeCalls.push(request);
      if (opts.error) throw opts.error;
      return {
        status: opts.status ?? 200,
        ok: opts.ok ?? (opts.status === undefined ? true : opts.status < 400),
        body: opts.body ?? "",
      };
    }),
  };
  return { shell, probeCalls };
}

/**
 * Sentinel `fetch` that always throws — used to verify the gateway
 * never falls back to it under the desktop bootstrap.
 */
function installNoFetchGuard(): { restore: () => void; calls: number } {
  const original = globalThis.fetch;
  let calls = 0;
  const guard = vi.fn(async () => {
    calls += 1;
    throw new Error(
      "fetch is forbidden in the desktop renderer — probe must go through " +
        "desktopShell.probeProvider",
    );
  });
  // The cast is fine: the override only handles the codepath that
  // would have been a regression — actual gateway calls go through
  // the injected ProbeHttpClient instead.
  (globalThis as { fetch: unknown }).fetch = guard;
  return {
    restore: () => {
      (globalThis as { fetch: unknown }).fetch = original;
    },
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------
// Wrapper unit tests
// ---------------------------------------------------------------------

describe("createDesktopShellProbeClient — translates ProbeHttpClient calls into shell.probeProvider", () => {
  it("forwards url, method, headers and body verbatim", async () => {
    const { shell, probeCalls } = buildShell({
      status: 200,
      body: JSON.stringify({ data: [{ id: "m1" }] }),
    });
    const client = createDesktopShellProbeClient({ desktopShell: shell });

    const response = await client.send({
      url: "https://api.fireworks.ai/inference/v1/models",
      method: "GET",
      headers: { Authorization: "Bearer fw-test" },
    });

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]).toEqual({
      url: "https://api.fireworks.ai/inference/v1/models",
      method: "GET",
      headers: { Authorization: "Bearer fw-test" },
    });
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe(
      JSON.stringify({ data: [{ id: "m1" }] }),
    );
  });

  it("forwards POST body and additional headers", async () => {
    const { shell, probeCalls } = buildShell({ status: 200, body: "{}" });
    const client = createDesktopShellProbeClient({ desktopShell: shell });

    await client.send({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": "anth-test",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_tokens: 1 }),
    });

    expect(probeCalls[0]?.method).toBe("POST");
    expect(probeCalls[0]?.headers["x-api-key"]).toBe("anth-test");
    expect(probeCalls[0]?.body).toBe(JSON.stringify({ max_tokens: 1 }));
  });

  it("translates a 401 from the shell into ok=false / status=401", async () => {
    const { shell } = buildShell({ status: 401, ok: false, body: "" });
    const client = createDesktopShellProbeClient({ desktopShell: shell });
    const response = await client.send({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: { Authorization: "Bearer sk-bad" },
    });
    expect(response.status).toBe(401);
    expect(response.ok).toBe(false);
  });

  it("rethrows shell.probeProvider errors so the gateway can surface them", async () => {
    const { shell } = buildShell({
      error: Object.assign(new Error("provider unreachable"), {
        code: "provider_unreachable",
      }),
    });
    const client = createDesktopShellProbeClient({ desktopShell: shell });
    await expect(
      client.send({
        url: "https://api.fireworks.ai/inference/v1/models",
        method: "GET",
        headers: { Authorization: "Bearer fw-test" },
      }),
    ).rejects.toThrow(/provider unreachable/);
  });

  it("short-circuits when the caller's signal is already aborted", async () => {
    const { shell, probeCalls } = buildShell({});
    const client = createDesktopShellProbeClient({ desktopShell: shell });

    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      await client.send({
        url: "https://api.fireworks.ai/inference/v1/models",
        method: "GET",
        headers: {},
        signal: ac.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe("AbortError");
    // The shell was never asked.
    expect(probeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// End-to-end gateway test — Fireworks validation must NOT call fetch
// ---------------------------------------------------------------------

describe("RendererLoginGateway + desktopShellProbeClient — Fireworks via Tauri shell", () => {
  let fetchGuard: { restore: () => void; calls: number };

  beforeEach(() => {
    fetchGuard = installNoFetchGuard();
  });

  afterEach(() => {
    fetchGuard.restore();
  });

  it(
    "Fireworks validation routes through desktopShell.probeProvider, not fetch, " +
      "and returns ok with modelsCount",
    async () => {
      const { shell, probeCalls } = buildShell({
        status: 200,
        body: JSON.stringify({
          data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }],
        }),
      });
      const gateway = new RendererLoginGateway({
        sink: { saveLocalSession: vi.fn(async () => ({ session: { id: 's', kind: 'local' as const, deviceId: 'd', createdAt: '2025-01-01T00:00:00.000Z' }, fingerprint: 'xxxx' })) },
        http: createDesktopShellProbeClient({ desktopShell: shell }),
      });

      const result = await gateway.validateApiKey({
        provider: "fireworks",
        apiKey: "fw-real-test-key",
        modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
      });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.modelsCount).toBe(3);
      }
      expect(probeCalls).toHaveLength(1);
      expect(probeCalls[0]?.url).toBe(
        "https://api.fireworks.ai/inference/v1/models",
      );
      expect(probeCalls[0]?.headers["Authorization"]).toBe(
        "Bearer fw-real-test-key",
      );
      // The critical regression guard — fetch must never be invoked.
      expect(fetchGuard.calls).toBe(0);
    },
  );

  it("HTTP 401 from the shell becomes authentication_error", async () => {
    const { shell } = buildShell({
      status: 401,
      ok: false,
      body: "",
    });
    const gateway = new RendererLoginGateway({
      sink: { saveLocalSession: vi.fn(async () => ({ session: { id: 's', kind: 'local' as const, deviceId: 'd', createdAt: '2025-01-01T00:00:00.000Z' }, fingerprint: 'xxxx' })) },
      http: createDesktopShellProbeClient({ desktopShell: shell }),
    });

    const result = await gateway.validateApiKey({
      provider: "fireworks",
      apiKey: "fw-bad",
      modelId: "x",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("authentication_error");
    }
    expect(fetchGuard.calls).toBe(0);
  });

  it("provider error body is passed through to providerCode/providerMessage", async () => {
    const { shell } = buildShell({
      status: 404,
      ok: false,
      body: JSON.stringify({
        error: { code: "model_not_found", message: "unknown model x" },
      }),
    });
    const gateway = new RendererLoginGateway({
      sink: { saveLocalSession: vi.fn(async () => ({ session: { id: 's', kind: 'local' as const, deviceId: 'd', createdAt: '2025-01-01T00:00:00.000Z' }, fingerprint: 'xxxx' })) },
      http: createDesktopShellProbeClient({ desktopShell: shell }),
    });

    const result = await gateway.validateApiKey({
      provider: "fireworks",
      apiKey: "fw-test",
      modelId: "x",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("model_not_found");
      expect(result.providerMessage).toContain("unknown model x");
    }
  });

  it("a thrown shell error becomes provider_unreachable", async () => {
    const { shell } = buildShell({
      error: Object.assign(new Error("dns failure"), {
        code: "transport_error",
      }),
    });
    const gateway = new RendererLoginGateway({
      sink: { saveLocalSession: vi.fn(async () => ({ session: { id: 's', kind: 'local' as const, deviceId: 'd', createdAt: '2025-01-01T00:00:00.000Z' }, fingerprint: 'xxxx' })) },
      http: createDesktopShellProbeClient({ desktopShell: shell }),
    });

    const result = await gateway.validateApiKey({
      provider: "fireworks",
      apiKey: "fw-test",
      modelId: "x",
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("provider_unreachable");
    }
    expect(fetchGuard.calls).toBe(0);
  });
});
