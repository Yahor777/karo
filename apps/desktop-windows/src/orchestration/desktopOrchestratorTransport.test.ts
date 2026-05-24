// @vitest-environment jsdom
/**
 * Tests for `DesktopOrchestratorTransport`.
 *
 * Strategy: inject a stub `modelClient` whose `chat` returns scripted
 * responses keyed by the system prompt of each agent. The desktop
 * shell is also stubbed so the transport's `decryptLocalSecret` /
 * `readLocalSetting` path returns a deterministic plaintext.
 *
 * Validates: Requirements 6.4, 6.6, 6.7, 6.8, 7.1, 7.4, 7.5, 7.10,
 * 8.1, 8.6, 8.7, 11.1, 11.2, 11.7, 14.1, 14.2.
 */

import { describe, expect, it, vi } from "vitest";

import { DesktopOrchestratorTransport } from "./desktopOrchestratorTransport.js";
import { StartTaskError } from "./types.js";
import type { ApiKeyMetadata } from "../ui/desktopApiKeySink.js";
import type { DesktopShell } from "../shell/types.js";
import type { ChatMessage } from "./modelClient.js";

const SAMPLE_METADATA: ApiKeyMetadata = {
  provider: "fireworks",
  fingerprint: "ab12cd34",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  savedAt: "2026-05-17T12:00:00.000Z",
};

function buildShell(): DesktopShell {
  return {
    getDeviceId: vi.fn(async () => "device-test"),
    readLocalSetting: <T = unknown>(_key: string): Promise<T | null> =>
      Promise.resolve(({
        algorithm: "aes-256-gcm",
        ciphertext: "AA==",
        createdAt: "2026-05-17T12:00:00.000Z",
      } as unknown) as T),
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
    probeProvider: vi.fn(async () => ({ status: 200, ok: true, body: "{}" })),
    shell_scan_project_context: vi.fn(async (projectPath: string) => ({
      projectRoot: projectPath,
      prompt: "",
      fileTreeSummary: [],
      selectedFiles: [],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 80000,
      createdAt: Date.now().toString(),
      warnings: [],
      scannedFilesCount: 0,
      selectedFilesCount: 0,
    })),
    shell_build_task_context: vi.fn(async (projectPath: string, prompt: string) => ({
      projectRoot: projectPath,
      prompt,
      fileTreeSummary: [],
      selectedFiles: [
        {
          relativePath: "src/apply.rs",
          content: "fn apply() {}",
          sizeBytes: 13,
          score: 30.0,
          reason: ["explicit path in prompt"],
          truncated: false,
        }
      ],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 80000,
      createdAt: Date.now().toString(),
      warnings: [],
      scannedFilesCount: 5,
      selectedFilesCount: 1,
    })),
  };
}

interface ScriptedResponse {
  readonly when: "researcher" | "coder" | "reviewer" | "fixer" | "boss";
  readonly response:
    | { kind: "ok"; text: string }
    | {
        kind: "error";
        providerCode: string;
        providerMessage: string;
        retryCount?: number;
        status?: number;
        bodyPreview?: string;
      };
}

type ScriptedChatResponse = ScriptedResponse["response"];

function buildScriptedClient(script: ScriptedResponse[]): {
  client: {
    chat(req: {
      readonly provider: string;
      readonly modelId: string;
      readonly baseUrl?: string;
      readonly apiKey: string;
      readonly messages: readonly ChatMessage[];
      readonly maxTokens?: number;
      readonly timeoutMs?: number;
    }): Promise<ScriptedChatResponse>;
  };
  calls: Array<{
    which: string;
    modelId: string;
    maxTokens?: number;
    timeoutMs?: number;
    messages: readonly ChatMessage[];
  }>;
} {
  const calls: Array<{
    which: string;
    modelId: string;
    maxTokens?: number;
    timeoutMs?: number;
    messages: readonly ChatMessage[];
  }> = [];
  let pointer = 0;
  return {
    client: {
      async chat(req): Promise<ScriptedChatResponse> {
        const sys = req.messages[0]?.content ?? "";
        let which: string = "unknown";
        if (sys.startsWith("You are the Researcher")) which = "researcher";
        else if (sys.startsWith("You are the Coder")) which = "coder";
        else if (sys.startsWith("You are the Reviewer")) which = "reviewer";
        else if (sys.startsWith("You are the Fixer")) which = "fixer";
        else if (sys.startsWith("You are the Boss")) which = "boss";
        calls.push({
          which,
          modelId: req.modelId,
          messages: req.messages,
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        });
        const next = script[pointer];
        pointer += 1;
        if (next === undefined) {
          return { kind: "error", providerCode: "no_more_scripted", providerMessage: "" };
        }
        return next.response;
      },
    },
    calls,
  };
}

async function flushUntil(
  predicate: () => boolean,
  maxTicks = 256,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    // Use a real macrotask gap so async crypto.subtle work in jsdom can
    // actually complete — `await Promise.resolve()` only flushes
    // microtasks and would starve the WebCrypto digest call.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("DesktopOrchestratorTransport — input validation", () => {
  function build(): DesktopOrchestratorTransport {
    const shell = buildShell();
    const { client } = buildScriptedClient([]);
    return new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
  }

  it("rejects empty prompt with empty_prompt", async () => {
    const t = build();
    let caught: unknown;
    try {
      await t.createAndRunTask({
        prompt: "   ",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: [],
        maxReviewCycles: 2,
        confirmedByUser: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StartTaskError);
    expect((caught as StartTaskError).code).toBe("empty_prompt");
  });

  it("rejects unconfirmed runs with confirmation_required", async () => {
    const t = build();
    let caught: unknown;
    try {
      await t.createAndRunTask({
        prompt: "x",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: [],
        maxReviewCycles: 2,
        confirmedByUser: false,
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as StartTaskError).code).toBe("confirmation_required");
  });

  it("rejects manual mode with zero participants", async () => {
    const t = build();
    let caught: unknown;
    try {
      await t.createAndRunTask({
        prompt: "x",
        metadata: SAMPLE_METADATA,
        mode: "manual",
        participants: [],
        maxReviewCycles: 2,
        confirmedByUser: true,
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as StartTaskError).code).toBe(
      "manual_mode_zero_participants",
    );
  });

  it("rejects missing model id", async () => {
    const t = build();
    let caught: unknown;
    try {
      await t.createAndRunTask({
        prompt: "x",
        metadata: { ...SAMPLE_METADATA, modelId: "" },
        mode: "auto",
        participants: [],
        maxReviewCycles: 2,
        confirmedByUser: true,
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as StartTaskError).code).toBe("missing_model_id");
  });
});

describe("DesktopOrchestratorTransport — happy path", () => {
  it("runs Researcher → Coder → Reviewer → Fixer → Reviewer → Boss → completed", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      // Researcher
      {
        when: "researcher",
        response: { kind: "ok", text: "Enriched: build a hello world." },
      },
      // Coder
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            fileName: "hello.ts",
            content: "export function hello() { return 'hi'; }",
          }),
        },
      },
      // Reviewer (round 1) — defects
      {
        when: "reviewer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "defectsFound",
            defects: [
              {
                id: "d1",
                description: "Add a doc comment.",
                severity: "low",
              },
            ],
          }),
        },
      },
      // Fixer
      {
        when: "fixer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            fileName: "hello.ts",
            content:
              "/** says hi */\nexport function hello() { return 'hi'; }",
            addressedDefectIds: ["d1"],
          }),
        },
      },
      // Reviewer (round 2) — clean
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      // Boss approve
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: ["Looks correct."],
          }),
        },
      },
    ]);

    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });

    const { taskId } = await t.createAndRunTask({
      prompt: "Make a hello-world",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });

    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });

    const state = t.getTaskState(taskId);
    expect(state?.status).toBe("completed");
    expect(state?.reviewCycles).toBeGreaterThanOrEqual(1);

    const artifacts = t.getArtifacts(taskId);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]?.fileName).toBe("hello.ts");
    expect(artifacts[0]?.latestVersion).toBe(2);

    const report = t.getFinalReport(taskId);
    expect(report?.status).toBe("completed");
    expect(report?.bossSummary).toContain("соответствует");
    expect(report?.finalArtifacts).toHaveLength(1);

    const trace = t.getTraceEvents(taskId);
    expect(trace.length).toBeGreaterThan(5);
    const kinds = trace.map((e) => `${e.agentId}:${e.record.kind}`);
    expect(kinds).toContain("orchestrator:status");
    expect(kinds).toContain("researcher:status");
    expect(kinds).toContain("coder:artifact_change");
    expect(kinds).toContain("reviewer:thought");
    expect(kinds).toContain("fixer:artifact_change");
    expect(kinds).toContain("boss:thought");

    // No plaintext API key in any trace event.
    for (const e of trace) {
      const json = JSON.stringify(e);
      expect(json).not.toContain("fw-test-key");
    }

    // Order of agent calls matches the canonical pipeline.
    const order = calls.map((c) => c.which);
    expect(order).toEqual([
      "researcher",
      "coder",
      "reviewer",
      "fixer",
      "reviewer",
      "boss",
    ]);
  });

  it("uses quick edit for trivial create-file prompts without the full agent pipeline", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });

    const { taskId } = await t.createAndRunTask({
      prompt: "создай файл src/karo-manual-check.txt с текстом hello",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });

    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });

    const state = t.getTaskState(taskId);
    expect(state?.status).toBe("completed");
    expect(state?.participants).toEqual(["quick_edit"]);
    expect(state?.reviewCycles).toBe(0);
    expect(calls).toHaveLength(0);

    const artifacts = t.getArtifacts(taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.fileName).toBe("src/karo-manual-check.txt");
    expect(artifacts[0]?.latestVersion).toBe(1);

    const report = t.getFinalReport(taskId);
    expect(report?.status).toBe("completed");
    expect(report?.participants).toEqual(["quick_edit"]);
    expect(report?.bossSummary).toContain("Quick edit prepared 1 file");

    const agents = new Set(t.getTraceEvents(taskId).map((event) => event.agentId));
    expect(agents.has("quick_edit")).toBe(true);
    expect(agents.has("researcher")).toBe(false);
    expect(agents.has("reviewer")).toBe(false);
    expect(agents.has("fixer")).toBe(false);
    expect(agents.has("boss")).toBe(false);
  });

  it("uses quick edit in manual Agent mode without requiring a model call", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });

    const { taskId } = await t.createAndRunTask({
      prompt: "create file src/karo-mcp-proof.txt with text hello",
      metadata: SAMPLE_METADATA,
      mode: "manual",
      participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });

    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");

    expect(calls).toHaveLength(0);
    expect(t.getTaskState(taskId)?.participants).toEqual(["quick_edit"]);
    expect(t.getArtifacts(taskId)[0]?.fileName).toBe("src/karo-mcp-proof.txt");
  });

  it("uses quick edit for deterministic static html files so Preview can open after Apply", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });

    const { taskId } = await t.createAndRunTask({
      prompt:
        "create file src/karo-demo-site/index.html with text <!doctype html><html><body><section class=\"hero\">Minecraft JJK Mod</section><section>FAQ</section></body></html>",
      metadata: SAMPLE_METADATA,
      mode: "manual",
      participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });

    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");

    expect(calls).toHaveLength(0);
    expect(t.getTaskState(taskId)?.participants).toEqual(["quick_edit"]);
    const artifacts = t.getArtifacts(taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.fileName).toBe("src/karo-demo-site/index.html");
    const content = t.getArtifactVersion(taskId, artifacts[0]!.id, 1)?.content ?? "";
    expect(content).toContain("Minecraft JJK Mod");
    expect(content).toContain("FAQ");
  });
});

describe("DesktopOrchestratorTransport — review cycle limit", () => {
  it("stops with stopped_limit when reviewer keeps finding defects", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      // Researcher
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      // Coder
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "x.txt", content: "v1" }),
        },
      },
      // Reviewer round 1 — defects
      {
        when: "reviewer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "defectsFound",
            defects: [{ id: "a", description: "fix me", severity: "high" }],
          }),
        },
      },
      // Fixer 1
      {
        when: "fixer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            fileName: "x.txt",
            content: "v2",
            addressedDefectIds: ["a"],
          }),
        },
      },
      // Reviewer round 2 — defects again
      {
        when: "reviewer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "defectsFound",
            defects: [{ id: "b", description: "still bad", severity: "high" }],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });

    const { taskId } = await t.createAndRunTask({
      prompt: "create file anything.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "stopped_limit";
    });
    const state = t.getTaskState(taskId);
    expect(state?.status).toBe("stopped_limit");
    const report = t.getFinalReport(taskId);
    expect(report?.status).toBe("stopped_limit");
    expect(report?.outstandingIssues).toBeDefined();
    expect((report?.outstandingIssues ?? []).length).toBeGreaterThan(0);
  });
});

describe("DesktopOrchestratorTransport — coder failure", () => {
  it("transitions to error state and surfaces the reason", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "error",
          providerCode: "http_500",
          providerMessage: "boom",
          retryCount: 1,
          status: 500,
          bodyPreview: "server boom",
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 2,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "error";
    });
    const state = t.getTaskState(taskId);
    expect(state?.status).toBe("error");
    expect(state?.errorReason).toBe(
      "Запрос Coder к fireworks не прошёл: http_500: boom. Был выполнен 1 retry.",
    );
    expect(t.getFinalReport(taskId)).toBeNull();
  });

  it("writes safe provider failure diagnostics to Logs", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "error",
          providerCode: "provider_unreachable",
          providerMessage: "Could not reach fireworks: socket closed fw-test-key",
          retryCount: 1,
          bodyPreview: "body fw-test-key",
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const logs: string[] = [];
    t.subscribeLog((_, e) => logs.push(e.text));
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 2,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "error";
    });
    expect(logs.some((l) => l.includes("Provider failure"))).toBe(true);
    for (const l of logs) {
      expect(l).not.toContain("fw-test-key");
    }
    expect(t.getTaskState(taskId)?.errorReason ?? "").not.toContain("fw-test-key");
  });
});

describe("DesktopOrchestratorTransport — no forced Fixer", () => {
  it("skips Fixer when Reviewer reports no defects on the first pass", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "main.ts", content: "ok" }),
        },
      },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    expect(t.getTaskState(taskId)?.status).toBe("completed");
    const order = calls.map((c) => c.which);
    // Researcher → Coder → Reviewer (clean) → Boss → completed.
    // No Fixer in the call order.
    expect(order).toEqual(["researcher", "coder", "reviewer", "boss"]);
    expect(order).not.toContain("fixer");
  });

  it("still runs Fixer when Reviewer finds defects", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "x.ts", content: "v1" }),
        },
      },
      {
        when: "reviewer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "defectsFound",
            defects: [{ id: "d1", description: "fix it", severity: "low" }],
          }),
        },
      },
      {
        when: "fixer",
        response: {
          kind: "ok",
          text: JSON.stringify({
            fileName: "x.ts",
            content: "v2",
            addressedDefectIds: ["d1"],
          }),
        },
      },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    const order = calls.map((c) => c.which);
    expect(order).toContain("fixer");
    expect(order.indexOf("fixer")).toBeGreaterThan(order.indexOf("reviewer"));
  });
});

describe("DesktopOrchestratorTransport — pub/sub", () => {
  it("notifies state, trace, artifact and final-report listeners", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "a.txt", content: "hello" }),
        },
      },
      // Reviewer noDefects on first pass — Boss is allowed to approve
      // straight after, no forced Fixer turn.
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });

    const stateEvents: string[] = [];
    const traceEvents: string[] = [];
    const artifactEvents: string[] = [];
    let finalReportSeen = false;

    t.subscribeTaskState((_, s) => stateEvents.push(s.status));
    t.subscribeTrace((_, e) => traceEvents.push(e.record.kind));
    t.subscribeArtifacts((_, m) => artifactEvents.push(m.fileName));
    t.subscribeFinalReport(() => {
      finalReportSeen = true;
    });

    await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 3,
      confirmedByUser: true,
    });
    await flushUntil(() => finalReportSeen);
    expect(finalReportSeen).toBe(true);
    expect(stateEvents).toContain("completed");
    expect(traceEvents).toContain("artifact_change");
    expect(artifactEvents).toContain("a.txt");
  });
});


// ---------------------------------------------------------------------------
// Coder output robustness
// ---------------------------------------------------------------------------

describe("DesktopOrchestratorTransport — Coder output robustness", () => {
  it("parses valid multi-artifact JSON and writes every file", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              { fileName: "KaroLandingPage.tsx", content: "export const x = 1;" },
              { fileName: "KaroLandingPage.css", content: ".x { color: red; }" },
            ],
            summary: "Landing page scaffold with split TSX/CSS files.",
          }),
        },
      },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "Build a landing page",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 2,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    const artifacts = t.getArtifacts(taskId);
    const fileNames = artifacts.map((a) => a.fileName).sort();
    expect(fileNames).toEqual([
      "KaroLandingPage.css",
      "KaroLandingPage.tsx",
    ]);
    expect(t.getFinalReport(taskId)?.finalArtifacts.length).toBe(2);
  });

  it("parses Coder JSON wrapped in ```json fences", async () => {
    const shell = buildShell();
    const fenced =
      "```json\n" +
      JSON.stringify({
        artifacts: [{ fileName: "hi.ts", content: "console.log('hi');" }],
        summary: "ok",
      }) +
      "\n```";
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      { when: "coder", response: { kind: "ok", text: fenced } },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    expect(t.getArtifacts(taskId).map((a) => a.fileName)).toEqual([
      "hi.ts",
    ]);
  });

  it("smoke parses landing-page artifacts from fenced JSON with surrounding text", async () => {
    const shell = buildShell();
    const landingJson = JSON.stringify({
      artifacts: [
        {
          fileName: "KaroLandingPage.tsx",
          content: "import './KaroLandingPage.css';\nexport function KaroLandingPage() { return <main className=\"karo\">KARO</main>; }",
        },
        {
          fileName: "KaroLandingPage.css",
          content: ".karo { color: #f5f3ff; background: #07070b; }",
        },
      ],
      summary: "Created a compact dark KARO landing page component and styles.",
    });
    const { client, calls } = buildScriptedClient([
      {
        when: "researcher",
        response: { kind: "ok", text: "Use React + TypeScript and split CSS." },
      },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: `Here are the artifacts:\n\n\`\`\`json\n${landingJson}\n\`\`\`\n\nDone.`,
        },
      },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt:
        "Создай компонент KaroLandingPage.tsx и стили KaroLandingPage.css для лендинга KARO AI Agent Orchestrator. Верни два artifacts.",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });

    expect(calls.filter((c) => c.which === "coder")).toHaveLength(1);
    expect(t.getArtifacts(taskId).map((a) => a.fileName).sort()).toEqual([
      "KaroLandingPage.css",
      "KaroLandingPage.tsx",
    ]);
    expect(t.getFinalReport(taskId)?.finalArtifacts).toHaveLength(2);
  });

  it("retries once when Coder output is invalid and succeeds on repair", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      // First attempt — bare prose, no JSON.
      {
        when: "coder",
        response: {
          kind: "ok",
          text: "Here is some text without any JSON structure at all.",
        },
      },
      // Repair retry — valid multi-artifact response.
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [{ fileName: "main.ts", content: "export {};" }],
            summary: "ok",
          }),
        },
      },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const logs: Array<{ level: string; text: string }> = [];
    t.subscribeLog((_, e) => logs.push({ level: e.level, text: e.text }));
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    // Coder should have been called twice (first + repair retry).
    const coderCalls = calls.filter((c) => c.which === "coder").length;
    expect(coderCalls).toBe(2);
    // The repair retry message must contain the strict instruction.
    const repairCall = calls.filter((c) => c.which === "coder")[1]!;
    const lastUser = repairCall.messages[repairCall.messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toContain("Return ONLY valid JSON");
    expect(lastUser.content).toContain("artifacts");

    // Logs must carry the raw preview but never the API key.
    expect(logs.some((l) => l.text.includes("invalid artifact JSON"))).toBe(true);
    for (const l of logs) {
      expect(l.text).not.toContain("fw-test-key");
    }

    // Final state still completes and we got the file from the retry.
    expect(t.getArtifacts(taskId).map((a) => a.fileName)).toEqual([
      "main.ts",
    ]);
  });

  it("after two failures sets a readable error and stops", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      // First attempt — junk.
      { when: "coder", response: { kind: "ok", text: "no json here" } },
      // Repair attempt — still junk.
      { when: "coder", response: { kind: "ok", text: "still no json" } },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const logs: Array<{ level: string; text: string }> = [];
    t.subscribeLog((_, e) => logs.push({ level: e.level, text: e.text }));
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "error";
    });
    const state = t.getTaskState(taskId);
    expect(state?.status).toBe("error");
    expect(state?.errorReason).toContain("Retried once");
    expect(state?.errorReason).toContain("Open Logs");
    // Raw preview must reach the Logs channel.
    expect(logs.some((l) => l.text.includes("Raw preview"))).toBe(true);
    // No plaintext API key anywhere in error reason or logs.
    expect(state?.errorReason ?? "").not.toContain("fw-test-key");
    for (const l of logs) {
      expect(l.text).not.toContain("fw-test-key");
    }
  });

  it("supports legacy single-file Coder output for backwards compatibility", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            fileName: "old.ts",
            content: "export const a = 1;",
          }),
        },
      },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    expect(t.getArtifacts(taskId).map((a) => a.fileName)).toEqual([
      "old.ts",
    ]);
  });

  it("parses Coder JSON with text before and after the object", async () => {
    const shell = buildShell();
    const wrapped =
      "Here is the artifact JSON:\n" +
      JSON.stringify({
        artifacts: [{ fileName: "trimmed.ts", content: "export const ok = true;" }],
        summary: "ok",
      }) +
      "\nDone.";
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      { when: "coder", response: { kind: "ok", text: wrapped } },
      {
        when: "reviewer",
        response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
      },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "completed";
    });
    expect(t.getArtifacts(taskId).map((a) => a.fileName)).toEqual([
      "trimmed.ts",
    ]);
  });

  it("redacts plaintext API keys from raw Coder previews", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      { when: "coder", response: { kind: "ok", text: "bad fw-test-key output" } },
      { when: "coder", response: { kind: "ok", text: "still bad fw-test-key output" } },
    ]);
    const t = new DesktopOrchestratorTransport({
      desktopShell: shell,
      modelClient: client,
    });
    const logs: Array<{ level: string; text: string }> = [];
    t.subscribeLog((_, e) => logs.push({ level: e.level, text: e.text }));
    const { taskId } = await t.createAndRunTask({
      prompt: "create file x.txt",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => {
      const s = t.getTaskState(taskId);
      return s !== null && s.status === "error";
    });
    expect(logs.some((l) => l.text.includes("[REDACTED]"))).toBe(true);
    for (const l of logs) {
      expect(l.text).not.toContain("fw-test-key");
    }
    expect(t.getTaskState(taskId)?.errorReason ?? "").not.toContain("fw-test-key");
  });

  it("applies per-agent model overrides in the pipeline", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "x.ts", content: "export {};" }),
        },
      },
      { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt: "Create a component",
      metadata: SAMPLE_METADATA,
      mode: "manual",
      participants: ["researcher", "coder", "reviewer", "boss"],
      maxReviewCycles: 1,
      agentModelOverrides: {
        researcher: "research-model",
        coder: "coder-model",
        reviewer: "reviewer-model",
        boss: "boss-model",
      },
      confirmedByUser: true,
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
    expect(calls.map((c) => `${c.which}:${c.modelId}`)).toEqual([
      "researcher:research-model",
      "coder:coder-model",
      "reviewer:reviewer-model",
      "boss:boss-model",
    ]);
  });

  it("skips Boss when bossEnabled is false", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "x.ts", content: "export {};" }),
        },
      },
      { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt: "Create a utility",
      metadata: SAMPLE_METADATA,
      mode: "manual",
      participants: ["researcher", "coder", "reviewer"],
      maxReviewCycles: 1,
      bossEnabled: false,
      confirmedByUser: true,
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
    expect(calls.map((c) => c.which)).toEqual(["researcher", "coder", "reviewer"]);
    expect(t.getFinalReport(taskId)?.bossSummary).toContain("Boss review disabled");
  });

  it("raises Coder output budget for landing page tasks", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              { fileName: "KaroLandingPage.tsx", content: "export function KaroLandingPage(){return null;}" },
              { fileName: "KaroLandingPage.css", content: ".karo{}" },
            ],
            summary: "Landing page files.",
          }),
        },
      },
      { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚",
            notes: [],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt: "Создай небольшой тёмный лендинг для KARO with TSX and CSS",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
    expect(calls.find((c) => c.which === "coder")?.maxTokens).toBeGreaterThanOrEqual(8000);
    expect(t.getArtifacts(taskId).map((a) => a.fileName).sort()).toEqual([
      "KaroLandingPage.css",
      "KaroLandingPage.tsx",
    ]);
  });

  it("accepts when Reviewer is clean and requested diff artifact exists", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              { fileName: "index.html", content: "<main>Why KARO</main>" },
              { fileName: "changes.diff", content: "--- a/index.html\n+++ b/index.html\n+Why KARO" },
            ],
            summary: "Added block and diff.",
          }),
        },
      },
      { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "rejected",
            verdict: "не соответствует",
            notes: ["No diff preview was generated."],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt: "добавь блок Why KARO и покажи изменения перед применением",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
    expect(t.getTaskState(taskId)?.status).toBe("completed");
    expect(t.getFinalReport(taskId)?.bossSummary).toContain("diff preview artifact exists");
  });

  it("stops with a concrete issue when requested diff preview is missing", async () => {
    const shell = buildShell();
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Enriched" } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({ fileName: "index.html", content: "<main>Why KARO</main>" }),
        },
      },
      { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt: "добавь блок Why KARO и покажи изменения перед применением",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "stopped_limit");
    expect(t.getTaskState(taskId)?.status).toBe("stopped_limit");
    expect(t.getFinalReport(taskId)?.outstandingIssues).toContain(
      "No diff preview was generated for the requested show-changes-before-apply workflow.",
    );
    expect(calls.map((c) => c.which)).not.toContain("boss");
  });

  it("does not treat app preview wording as a required diff preview", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Use a small static site." } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              { fileName: "src/karo-demo-site/index.html", content: "<main><section class=\"hero\">JJK landing</section></main>" },
            ],
            summary: "Prepared HTML.",
          }),
        },
      },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              { fileName: "src/karo-demo-site/styles.css", content: "body { background: #08070d; } .hero { min-height: 80vh; }" },
            ],
            summary: "Prepared CSS.",
          }),
        },
      },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [{ fileName: "src/karo-demo-site/script.js", content: "document.documentElement.dataset.ready = 'true';\n" }],
            summary: "Prepared JS.",
          }),
        },
      },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [{ fileName: "src/karo-demo-site/README.md", content: "# Preview\n\nApply Changes, then open index.html.\n" }],
            summary: "Prepared README.",
          }),
        },
      },
      { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
      {
        when: "boss",
        response: {
          kind: "ok",
          text: JSON.stringify({
            kind: "approved",
            verdict: "соответствует",
            notes: ["Landing page artifacts are staged for preview."],
          }),
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt: "Create a modern landing page with hero, features, FAQ, responsive cards, and make it possible to run and view in preview.",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
    expect(t.getTaskState(taskId)?.status).toBe("completed");
    expect(t.getFinalReport(taskId)?.outstandingIssues ?? []).not.toContain(
      "No diff preview was generated for the requested show-changes-before-apply workflow.",
    );
    expect(t.getArtifacts(taskId).map((artifact) => artifact.fileName).sort()).toEqual([
      "src/karo-demo-site/README.md",
      "src/karo-demo-site/index.html",
      "src/karo-demo-site/script.js",
      "src/karo-demo-site/styles.css",
    ]);
  });

  it("keeps Coder timeout as recovery state and does not treat emergency fallback as success", async () => {
    const shell = buildShell();
    const apply = vi.fn(async () => ({
      success: true,
      changedFiles: [],
      createdFiles: [],
      overwrittenFiles: [],
      skippedFiles: [],
      errors: [],
    }));
    shell.shell_apply_staged_changes = apply;
    shell.shell_build_task_context = vi.fn(async (projectPath: string, prompt: string) => ({
      projectRoot: projectPath,
      prompt,
      fileTreeSummary: [
        {
          relativePath: "src/karo-test-output.txt",
          sizeBytes: 16,
          extension: "txt",
          isText: true,
          score: -20,
          reason: ["low-signal generated output"],
        },
      ],
      selectedFiles: [],
      ignoredSummary: {
        ignoredDirs: 0,
        ignoredFiles: 0,
        ignoredLargeFiles: 0,
        ignoredBinaryFiles: 0,
        ignoredSecretFiles: 0,
      },
      tokenBudgetHint: 80000,
      createdAt: Date.now().toString(),
      warnings: [],
      scannedFilesCount: 1,
      selectedFilesCount: 0,
    }));
    const { client, calls } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Build a static Minecraft JJK landing page." } },
      {
        when: "coder",
        response: {
          kind: "error",
          providerCode: "provider_timeout",
          providerMessage: "request timed out",
          retryCount: 1,
        },
      },
      {
        when: "coder",
        response: {
          kind: "error",
          providerCode: "provider_timeout",
          providerMessage: "reduced prompt also timed out",
          retryCount: 0,
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt:
        "Создай современный landing page для Minecraft JJK mod. Нужны: hero section, блок способностей, блок персонажей/энергии, features, FAQ, responsive layout, dark anime style, красивые cards, возможность запустить и посмотреть через preview.",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 2,
      confirmedByUser: true,
      projectPath: "D:\\проекты\\karo-test",
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "error");

    const state = t.getTaskState(taskId);
    expect(state?.status).toBe("error");
    expect(state?.decision?.executionMode).toBe("agent");
    expect(state?.reviewCycles).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(calls.map((call) => call.which)).toEqual(["researcher", "coder", "coder"]);
    expect(calls.filter((call) => call.which === "coder").every((call) => call.timeoutMs === 120000)).toBe(true);

    const artifactNames = t.getArtifacts(taskId).map((artifact) => artifact.fileName).sort();
    expect(artifactNames).toEqual([]);
    expect(state?.errorReason).toContain("Coder timed out");
    expect(state?.errorReason).toContain("Use emergency static scaffold");
    expect(state?.errorReason).toContain("This run is not completed");
    expect(state?.providerDiagnostics?.filter((diagnostic) => diagnostic.agentId === "coder")).toHaveLength(2);
    expect(state?.providerDiagnostics?.some((diagnostic) => diagnostic.errorType === "provider_timeout")).toBe(true);

    const report = t.getFinalReport(taskId);
    expect(report?.status).toBe("error");
    expect(report?.bossSummary).toBeUndefined();
    expect(report?.outstandingIssues?.join("\n")).toContain("Coder timed out");
    expect(report?.outstandingIssues?.join("\n")).toContain("Retry Coder");
    expect(report?.outstandingIssues?.join("\n")).toContain("Emergency fallback");
    expect(report?.finalArtifacts).toHaveLength(0);
  });

  it("preserves staged website drafts when a later chunk times out", async () => {
    const shell = buildShell();
    const { client } = buildScriptedClient([
      { when: "researcher", response: { kind: "ok", text: "Build a static Minecraft JJK landing page." } },
      {
        when: "coder",
        response: {
          kind: "ok",
          text: JSON.stringify({
            artifacts: [
              {
                fileName: "src/karo-demo-site/index.html",
                content: "<main><section class=\"hero\">Hero</section><section>FAQ</section></main>",
              },
            ],
            summary: "Prepared HTML.",
          }),
        },
      },
      {
        when: "coder",
        response: {
          kind: "error",
          providerCode: "provider_timeout",
          providerMessage: "styles timeout",
        },
      },
      {
        when: "coder",
        response: {
          kind: "error",
          providerCode: "provider_timeout",
          providerMessage: "styles reduced timeout",
        },
      },
    ]);
    const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
    const { taskId } = await t.createAndRunTask({
      prompt:
        "Create a modern landing page website with hero, abilities, characters, energy, features, FAQ, responsive layout, and preview.",
      metadata: SAMPLE_METADATA,
      mode: "auto",
      participants: [],
      maxReviewCycles: 1,
      confirmedByUser: true,
      projectPath: "D:\\projects\\karo-test",
    });
    await flushUntil(() => t.getTaskState(taskId)?.status === "error");

    const artifacts = t.getArtifacts(taskId);
    expect(artifacts.map((artifact) => artifact.fileName)).toEqual(["src/karo-demo-site/index.html"]);
    expect(t.getFinalReport(taskId)?.status).toBe("error");
    expect(t.getFinalReport(taskId)?.finalArtifacts).toHaveLength(1);
    expect(t.getTaskState(taskId)?.errorReason).toContain("Saved staged drafts before failure: 1 file(s)");
  });

  describe("resumeTask", () => {
    it("handles approve decision by transitioning through reviewing and completing the task", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const taskId = "test-task-id";
      const internalState = {
        state: {
          id: taskId,
          status: "waiting_consent" as const,
          currentAgentId: null,
          reviewCycles: 0,
          maxReviewCycles: 5,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originalPrompt: "Test prompt",
          modelId: "test-model",
          provider: "test-provider" as any,
          participants: [],
        },
        prompt: "Test prompt",
        apiKey: { providerId: "test-provider", secretId: "test-secret" } as any,
        trace: [],
        artifactMeta: new Map(),
        finalReport: null,
        currentArtifactId: null,
        currentArtifactVersion: null,
      };
      (t as any).tasks.set(taskId, internalState);

      const promise = t.resumeTask(taskId, { kind: "approve" });
      expect(t.getTaskState(taskId)?.status).toBe("reviewing");
      expect(t.getTaskState(taskId)?.currentAgentId).toBe("reviewer");

      await promise;

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      expect(t.getTaskState(taskId)?.status).toBe("completed");
    });

    it("handles cancel decision by transitioning to stopped_limit", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const taskId = "test-task-id-2";
      const internalState = {
        state: {
          id: taskId,
          status: "waiting_consent" as const,
          currentAgentId: null,
          reviewCycles: 0,
          maxReviewCycles: 5,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originalPrompt: "Test prompt",
          modelId: "test-model",
          provider: "test-provider" as any,
          participants: [],
        },
        prompt: "Test prompt",
        apiKey: { providerId: "test-provider", secretId: "test-secret" } as any,
        trace: [],
        artifactMeta: new Map(),
        finalReport: null,
        currentArtifactId: null,
        currentArtifactVersion: null,
      };
      (t as any).tasks.set(taskId, internalState);

      await t.resumeTask(taskId, { kind: "cancel" });
      expect(t.getTaskState(taskId)?.status).toBe("stopped_limit");
    });

    it("custom clarification is reclassified without being trapped by the original vague prompt", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        { when: "researcher", response: { kind: "ok", text: "Create the requested file." } },
        {
          when: "coder",
          response: {
            kind: "ok",
            text: JSON.stringify({
              fileName: "capabilities.md",
              content: "# Capabilities\n",
            }),
          },
        },
        { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
        {
          when: "boss",
          response: {
            kind: "ok",
            text: JSON.stringify({
              kind: "approved",
              verdict: "соответствует",
              notes: ["Clarified task completed."],
            }),
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Сделай лучше",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: ["researcher", "coder", "reviewer", "boss"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      expect(t.getTaskState(taskId)?.status).toBe("waiting_consent");
      await t.resumeTask(taskId, {
        kind: "clarify",
        customAnswer: "Создай файл capabilities.md с кратким описанием возможностей",
      });

      expect(t.getTaskState(taskId)?.status).toBe("completed");
      expect(t.getTaskState(taskId)?.originalPrompt).toContain("User clarification:");
      expect(t.getArtifacts(taskId)[0]?.fileName).toBe("capabilities.md");
    });

    it("casual chat clarification completes as text-only without Coder or artifacts", async () => {
      const shell = buildShell();
      const { client, calls } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Давай поговорим. Что хочешь обсудить?" },
        },
        {
          when: "coder",
          response: {
            kind: "ok",
            text: JSON.stringify({
              fileName: "chat_response.txt",
              content: "This must not be written.",
            }),
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Сделай лучше",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: ["researcher", "coder", "reviewer", "boss"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      expect(t.getTaskState(taskId)?.status).toBe("waiting_consent");
      await t.resumeTask(taskId, {
        kind: "clarify",
        customAnswer: "давай просто поговорим",
      });

      const state = t.getTaskState(taskId);
      expect(state?.status).toBe("completed");
      expect(state?.decision?.intent).toBe("casual_chat");
      expect(state?.decision?.allowFileChanges).toBe(false);
      expect(state?.decision?.requiresContextEngine).toBe(false);
      expect(t.getArtifacts(taskId)).toHaveLength(0);
      expect(calls.map((c) => c.which)).not.toContain("researcher");
      expect(calls.map((c) => c.which)).not.toContain("coder");
      expect(calls.map((c) => c.which)).not.toContain("reviewer");
      expect(calls.map((c) => c.which)).not.toContain("boss");
      expect(t.getFinalReport(taskId)?.finalArtifacts).toHaveLength(0);
      expect(t.getFinalReport(taskId)?.bossSummary).not.toContain("FILES CHANGED");
    });

    it("option and custom clarification are both preserved when continuing", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        { when: "researcher", response: { kind: "ok", text: "Modify the code." } },
        {
          when: "coder",
          response: {
            kind: "ok",
            text: JSON.stringify({
              fileName: "usage.md",
              content: "# Usage\n",
            }),
          },
        },
        { when: "reviewer", response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) } },
        {
          when: "boss",
          response: {
            kind: "ok",
            text: JSON.stringify({
              kind: "approved",
              verdict: "соответствует",
              notes: ["OK"],
            }),
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Сделай лучше",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: ["researcher", "coder", "reviewer", "boss"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await t.resumeTask(taskId, {
        kind: "clarify",
        selectedOptionId: "modify",
        customAnswer: "Сфокусируйся на Usage tab",
      });

      const state = t.getTaskState(taskId);
      expect(state?.status).toBe("completed");
      expect(state?.clarificationState?.selectedOptionId).toBe("modify");
      expect(state?.clarificationState?.customAnswer).toBe("Сфокусируйся на Usage tab");
      expect(state?.originalPrompt).toContain("Selected Option:");
      expect(state?.originalPrompt).toContain("Details:");
    });
  });

  describe("Conversational Intent Routing", () => {
    it("Agent mode meta question does not create artifact", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Я KARO, работаю в Agent Mode." },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "какой сейчас режим и что ты можешь делать?",
        metadata: SAMPLE_METADATA,
        mode: "manual",
        participants: ["researcher"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      expect(t.getTaskState(taskId)?.status).toBe("completed");
      const artifacts = t.getArtifacts(taskId);
      expect(artifacts.length).toBe(0);
    });

    it("Auto mode meta question routes to chat response and does not create artifact", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Я KARO, работаю в Auto Mode." },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "что ты можешь делать?",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: [],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      expect(t.getTaskState(taskId)?.status).toBe("completed");
      const artifacts = t.getArtifacts(taskId);
      expect(artifacts.length).toBe(0);
    });

    it("Agent mode explicit file creation still creates artifact", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Enriched: create capabilities file." },
        },
        {
          when: "coder",
          response: {
            kind: "ok",
            text: JSON.stringify({
              fileName: "capabilities.md",
              content: "These are my capabilities.",
            }),
          },
        },
        {
          when: "reviewer",
          response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
        },
        {
          when: "boss",
          response: {
            kind: "ok",
            text: JSON.stringify({
              kind: "approved",
              verdict: "соответствует",
              notes: ["Looks correct."],
            }),
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "создай файл capabilities.md с описанием возможностей",
        metadata: SAMPLE_METADATA,
        mode: "manual",
        participants: ["researcher", "coder", "reviewer", "boss"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      expect(t.getTaskState(taskId)?.status).toBe("completed");
      const artifacts = t.getArtifacts(taskId);
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]?.fileName).toBe("capabilities.md");
    });

    it("Auto mode explicit coding task still runs pipeline", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Enriched: create capabilities file." },
        },
        {
          when: "coder",
          response: {
            kind: "ok",
            text: JSON.stringify({
              fileName: "capabilities.md",
              content: "These are my capabilities in auto mode.",
            }),
          },
        },
        {
          when: "reviewer",
          response: { kind: "ok", text: JSON.stringify({ kind: "noDefects" }) },
        },
        {
          when: "boss",
          response: {
            kind: "ok",
            text: JSON.stringify({
              kind: "approved",
              verdict: "соответствует",
              notes: ["Looks correct."],
            }),
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "создай файл capabilities.md с описанием возможностей",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        participants: ["researcher", "coder", "reviewer", "boss"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      expect(t.getTaskState(taskId)?.status).toBe("completed");
      const artifacts = t.getArtifacts(taskId);
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]?.fileName).toBe("capabilities.md");
    });

    it("explain task does not create artifact but still builds context and populates task state", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Это объяснение: Karo использует staging перед записью на диск." },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Объясни как работает Apply Changes и какие файлы за это отвечают",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        projectPath: "D:/проекты/karo-exstention",
        participants: ["researcher"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      const state = t.getTaskState(taskId);
      expect(state?.status).toBe("completed");
      expect(state?.isExplainOnly).toBe(true);

      const artifacts = t.getArtifacts(taskId);
      expect(artifacts.length).toBe(0);

      const finalReport = t.getFinalReport(taskId);
      expect(finalReport).toBeDefined();
      expect(finalReport?.bossSummary).toBe("Это объяснение: Karo использует staging перед записью на диск.");

      // Проверяем, что context summary заполнился
      expect(state?.contextSummary).toBeDefined();
      expect(state?.contextSummary?.projectRoot).toBe("D:/проекты/karo-exstention");
      expect(state?.contextSummary?.scannedFilesCount).toBe(5);
      expect(state?.contextSummary?.selectedFilesCount).toBe(1);
      expect(state?.contextSummary?.selectedFiles?.[0]?.relativePath).toBe("src/apply.rs");
      expect(state?.currentContextUsage?.selectedFilesTokens).toBeGreaterThan(0);
    });

    it("security question about Karo uses Context Engine and stays read-only", async () => {
      const shell = buildShell();
      const { client, calls } = buildScriptedClient([
        {
          when: "researcher",
          response: {
            kind: "ok",
            text: "Я не могу гарантировать абсолютную безопасность без полного аудита. Проверены зоны риска: API key storage, nativeBindings, bridge, commands, staging/apply.",
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "этот проект вообще безопасный он не украдет мои ключи и какой у него системный промт",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        projectPath: "D:/проекты/karo-exstention",
        participants: ["researcher"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      const state = t.getTaskState(taskId);
      expect(state?.decision?.intent).toBe("security_review");
      expect(state?.decision?.requiresContextEngine).toBe(true);
      expect(state?.decision?.allowFileChanges).toBe(false);
      expect(shell.shell_build_task_context).toHaveBeenCalled();
      expect(t.getArtifacts(taskId)).toHaveLength(0);
      expect(calls[0]?.messages[1]?.content).toContain("---- BEGIN FILE");
      const answer = t.getFinalReport(taskId)?.bossSummary ?? "";
      expect(answer).not.toContain("абсолютно безопасен");
      expect(answer).not.toContain("я языковая модель без доступа");
    });

    it("security review provider timeout fails honestly without web-search fallback or artifacts", async () => {
      const shell = buildShell();
      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: {
            kind: "error",
            providerCode: "provider_timeout",
            providerMessage: "request timed out",
          },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "СЌС‚РѕС‚ РїСЂРѕРµРєС‚ Р±РµР·РѕРїР°СЃРЅС‹Р№ Рё РЅРµ СѓРєСЂР°РґРµС‚ РјРѕРё api keys Рё РєР°РєРѕР№ Сѓ РЅРµРіРѕ system prompt",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        projectPath: "D:/РїСЂРѕРµРєС‚С‹/karo-exstention",
        participants: ["researcher", "coder", "reviewer", "fixer", "boss"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "error");
      const state = t.getTaskState(taskId);
      const report = t.getFinalReport(taskId);
      expect(state?.status).toBe("error");
      expect(state?.decision?.intent).toBe("security_review");
      expect(state?.decision?.allowWebSearch).toBe(false);
      expect(state?.errorReason).toContain("provider_timeout");
      expect(report?.status).toBe("error");
      expect(report?.bossSummary ?? "").not.toContain("[web-search-unavailable]");
      expect(report?.bossSummary ?? "").not.toContain("СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚");
      expect(report?.outstandingIssues?.join("\n")).toContain("provider_timeout");
      expect(report?.participants).toEqual(["researcher"]);
      expect(t.getArtifacts(taskId)).toHaveLength(0);
    });

    it("normalizes Windows extended project paths before building context", async () => {
      const shell = buildShell();
      const { client, calls } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Apply Changes uses staging and apply.rs." },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Объясни как работает Apply Changes и какие файлы за это отвечают",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        projectPath: "\\\\?\\D:\\проекты\\karo-exstention",
        participants: ["researcher"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      expect(shell.shell_build_task_context).toHaveBeenCalledWith(
        "D:\\проекты\\karo-exstention",
        "Объясни как работает Apply Changes и какие файлы за это отвечают",
        expect.any(Object),
      );
      expect(t.getTaskState(taskId)?.contextSummary?.normalizedProjectRoot).toBe("D:\\проекты\\karo-exstention");
      expect(calls[0]?.messages[1]?.content).toContain("---- BEGIN FILE src/apply.rs ----");
      expect(calls[0]?.messages[1]?.content).toContain("fn apply() {}");
    });

    it("does not ask the model to guess when explain context has no selected files", async () => {
      const shell = buildShell();
      shell.shell_build_task_context = vi.fn(async (projectPath: string, prompt: string) => ({
        projectRoot: projectPath,
        prompt,
        fileTreeSummary: [],
        selectedFiles: [],
        ignoredSummary: {
          ignoredDirs: 0,
          ignoredFiles: 0,
          ignoredLargeFiles: 0,
          ignoredBinaryFiles: 0,
          ignoredSecretFiles: 0,
        },
        tokenBudgetHint: 80000,
        createdAt: Date.now().toString(),
        warnings: [],
        scannedFilesCount: 5,
        selectedFilesCount: 0,
      }));
      const { client, calls } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "This should not be used." },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Объясни как работает Apply Changes и какие файлы за это отвечают",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        projectPath: "D:/проекты/karo-exstention",
        participants: ["researcher"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      const state = t.getTaskState(taskId);
      expect(calls.length).toBe(0);
      expect(state?.contextSummary?.selectedFilesCount).toBe(0);
      expect(state?.contextSummary?.warnings).toContain("No local files were included. Context Engine may have failed.");
      expect(t.getFinalReport(taskId)?.bossSummary).toContain("I will not guess project architecture.");
    });

    it("buildTaskContext failure does not break the pipeline", async () => {
      const shell = buildShell();
      // Симулируем падение команды context engine
      shell.shell_build_task_context = vi.fn().mockRejectedValue(new Error("Scanner panic"));

      const { client } = buildScriptedClient([
        {
          when: "researcher",
          response: { kind: "ok", text: "Хотя context engine упал, я все равно могу ответить." },
        },
      ]);
      const t = new DesktopOrchestratorTransport({ desktopShell: shell, modelClient: client });
      const { taskId } = await t.createAndRunTask({
        prompt: "Объясни как работает Apply Changes",
        metadata: SAMPLE_METADATA,
        mode: "auto",
        projectPath: "D:/проекты/karo-exstention",
        participants: ["researcher"],
        maxReviewCycles: 3,
        confirmedByUser: true,
      });

      await flushUntil(() => t.getTaskState(taskId)?.status === "completed");
      const state = t.getTaskState(taskId);
      expect(state?.status).toBe("completed");
      expect(state?.isExplainOnly).toBe(true);
      expect(state?.contextSummary).toBeDefined();
      expect(state?.contextSummary?.error).toBe("Scanner panic");
      expect(t.getFinalReport(taskId)?.bossSummary).toBe("Context Engine failed: Scanner panic. I will not guess project architecture.");
    });
  });
});
