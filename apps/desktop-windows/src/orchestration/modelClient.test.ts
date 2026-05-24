// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { DesktopShell } from "../shell/types.js";

import { ChatModelClient } from "./modelClient.js";

function buildShell(): DesktopShell {
  return {
    getDeviceId: vi.fn(async () => "device-test"),
    readLocalSetting: vi.fn(async () => null),
    writeLocalSetting: vi.fn(async () => undefined),
    deleteLocalSetting: vi.fn(async () => undefined),
    encryptLocalSecret: vi.fn(async () => ({
      algorithm: "aes-256-gcm",
      ciphertext: "AA==",
      createdAt: "2026-05-17T12:00:00.000Z",
    })),
    decryptLocalSecret: vi.fn(async () => "fw-test-key"),
    writeLocalLog: vi.fn(async () => undefined),
    exportFile: vi.fn(async () => ({ savedPath: "" })),
    showNotification: vi.fn(async () => undefined),
    probeProvider: vi.fn(async () => ({ status: 200, ok: true, body: chatBody("ok") })),
  };
}

function chatBody(text: string): string {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

function buildClient(shell: DesktopShell, sleeps: number[] = []): ChatModelClient {
  return new ChatModelClient({
    desktopShell: shell,
    retryDelayMs: () => 1_500,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

async function callClient(client: ChatModelClient) {
  return client.chat({
    provider: "fireworks",
    modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "fw-test-key",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
  });
}

describe("ChatModelClient provider diagnostics and retry", () => {
  it("retries 429 once and then succeeds", async () => {
    const shell = buildShell();
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 429, ok: false, body: "rate limited" })
      .mockResolvedValueOnce({ status: 200, ok: true, body: chatBody("ok") });
    shell.probeProvider = probe;
    const sleeps: number[] = [];
    const result = await callClient(buildClient(shell, sleeps));
    expect(result).toEqual({ kind: "ok", text: "ok" });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_500]);
  });

  it("retries 500 once and then succeeds", async () => {
    const shell = buildShell();
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 500, ok: false, body: "server exploded" })
      .mockResolvedValueOnce({ status: 200, ok: true, body: chatBody("ok") });
    shell.probeProvider = probe;
    const result = await callClient(buildClient(shell));
    expect(result).toEqual({ kind: "ok", text: "ok" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not retry 401 and returns authentication_error", async () => {
    const shell = buildShell();
    const probe = vi.fn(async () => ({ status: 401, ok: false, body: "bad fw-test-key" }));
    shell.probeProvider = probe;
    const result = await callClient(buildClient(shell));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("authentication_error");
      expect(result.providerMessage).not.toContain("fw-test-key");
      expect(result.bodyPreview).not.toContain("fw-test-key");
    }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("maps 404 to model_not_found without retry", async () => {
    const shell = buildShell();
    const probe = vi.fn(async () => ({
      status: 404,
      ok: false,
      body: JSON.stringify({ error: { message: "unknown model" } }),
    }));
    shell.probeProvider = probe;
    const result = await callClient(buildClient(shell));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("model_not_found");
      expect(result.providerMessage).toContain("unknown model");
    }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries network failure once and surfaces provider_unreachable message", async () => {
    const shell = buildShell();
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error("DNS lookup failed for api.fireworks.ai"))
      .mockRejectedValueOnce(new Error("socket closed"));
    shell.probeProvider = probe;
    const result = await callClient(buildClient(shell));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerCode).toBe("provider_unreachable");
      expect(result.providerMessage).toContain("socket closed");
      expect(result.retryCount).toBe(1);
    }
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("redacts API keys from provider errors", async () => {
    const shell = buildShell();
    const probe = vi.fn(async () => ({
      status: 500,
      ok: false,
      body: "server echoed fw-test-key in body",
    }));
    shell.probeProvider = probe;
    const result = await callClient(buildClient(shell));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.providerMessage).not.toContain("fw-test-key");
      expect(result.bodyPreview).not.toContain("fw-test-key");
    }
  });
});
