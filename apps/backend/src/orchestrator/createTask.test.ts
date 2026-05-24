/**
 * Unit tests for {@link Orchestrator.createTask} (task 8.2).
 *
 * Coverage (per tasks.md task 8.2 sub-bullets):
 *  - Empty prompt rejected (Requirement 6.4).
 *  - Whitespace-only prompt rejected (Requirement 6.4).
 *  - Model not in catalog rejected (Requirement 6.7).
 *  - No API key + no fallback rejected (Requirement 6.7) — surfaced through
 *    the catalog's `status: "error"` entry.
 *  - Manual_Mode with zero participants rejected (Requirement 6.6).
 *  - Auto_Mode with empty participant resolution rejected (design.md
 *    "Validation rules": Auto_Mode must produce non-empty ordered set).
 *  - Auto_Mode resolver throwing rejected as `auto_mode_no_participants`.
 *  - Platform-fallback model without `confirmedFallback: true` rejected.
 *  - Successful create persists initial `TaskState` and returns a non-empty
 *    `taskId` (Requirement 6.8).
 *
 * Companion property tests live in tasks 8.3 (empty prompt) and 8.4
 * (Manual_Mode zero agents) and intentionally are NOT duplicated here.
 *
 * Validates: Requirements 6.4, 6.6, 6.7, 6.8.
 */

import { describe, expect, it } from "vitest";

import type {
  AgentId,
  ModelRef,
  Scope,
} from "@ai-agent-orchestrator/shared-core";
import type { CreateTaskInput } from "@ai-agent-orchestrator/validation";

import type {
  ModelInfo,
  ProviderModelsResult,
} from "../models/index.js";
import {
  CreateTaskError,
  InMemoryTaskStateStore,
  Orchestrator,
  type AutoParticipantResolver,
  type ModelCatalogPort,
  type OrchestratorClock,
  type TaskIdGenerator,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-06-15T12:00:00.000Z");
const FIXED_ISO = FIXED_NOW.toISOString();

function localScope(deviceId = "device-1"): Scope {
  return { kind: "local", deviceId };
}

function userModel(provider = "openai", modelId = "gpt-4o"): ModelInfo {
  return { provider, modelId, displayName: modelId, source: "user-api-key" };
}

function fallbackModel(provider = "platform", modelId = "free-tier"): ModelInfo {
  return {
    provider,
    modelId,
    displayName: modelId,
    source: "platform-fallback",
    qualityTier: "basic",
  };
}

function userKeyModelRef(
  provider = "openai",
  modelId = "gpt-4o",
): ModelRef {
  return { provider, modelId, source: "user-api-key" };
}

/** Stub catalog returning a fixed list. */
class StubCatalog implements ModelCatalogPort {
  public calls: Scope[] = [];
  public constructor(
    private readonly response:
      | readonly ProviderModelsResult[]
      | (() => readonly ProviderModelsResult[])
      | (() => never),
  ) {}
  public async listModelsForUser(
    scope: Scope,
  ): Promise<ProviderModelsResult[]> {
    this.calls.push(scope);
    if (typeof this.response === "function") {
      return [...(this.response)()];
    }
    return [...this.response];
  }
}

/** Stub Auto_Mode resolver returning a configured response. */
class StubAutoResolver implements AutoParticipantResolver {
  public calls: Array<{ prompt: string; modelRef: ModelRef; ownerScope: Scope }> = [];
  public constructor(
    private readonly response:
      | readonly AgentId[]
      | (() => readonly AgentId[])
      | (() => never),
  ) {}
  public async resolveAutoParticipants(input: {
    readonly prompt: string;
    readonly modelRef: ModelRef;
    readonly ownerScope: Scope;
  }): Promise<readonly AgentId[]> {
    this.calls.push({ ...input });
    if (typeof this.response === "function") {
      return [...(this.response)()];
    }
    return [...this.response];
  }
}

/** Deterministic id generator for assertions. */
class CounterIdGenerator implements TaskIdGenerator {
  private n = 0;
  public next(): string {
    this.n += 1;
    return `task-${this.n}`;
  }
}

const fixedClock: OrchestratorClock = { now: () => FIXED_NOW };

/** Helper: build an Orchestrator wired with sensible defaults. */
function buildOrchestrator(opts: {
  catalog?: StubCatalog;
  resolver?: StubAutoResolver;
  store?: InMemoryTaskStateStore;
  idGen?: TaskIdGenerator;
} = {}): {
  orchestrator: Orchestrator;
  catalog: StubCatalog;
  resolver: StubAutoResolver;
  store: InMemoryTaskStateStore;
  idGen: TaskIdGenerator;
} {
  const catalog =
    opts.catalog ??
    new StubCatalog([
      { provider: "openai", status: "ok", models: [userModel()] },
    ]);
  const resolver = opts.resolver ?? new StubAutoResolver(["agent-researcher"]);
  const store = opts.store ?? new InMemoryTaskStateStore();
  const idGen = opts.idGen ?? new CounterIdGenerator();
  const orchestrator = new Orchestrator({
    modelCatalog: catalog,
    autoResolver: resolver,
    store,
    idGenerator: idGen,
    clock: fixedClock,
  });
  return { orchestrator, catalog, resolver, store, idGen };
}

function manualInput(
  overrides: Partial<CreateTaskInput> = {},
): CreateTaskInput {
  return {
    prompt: "Build a parser",
    modelRef: userKeyModelRef(),
    mode: "manual",
    participants: ["agent-coder"],
    ...overrides,
  };
}

function autoInput(
  overrides: Partial<CreateTaskInput> = {},
): CreateTaskInput {
  return {
    prompt: "Build a parser",
    modelRef: userKeyModelRef(),
    mode: "auto",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty / whitespace prompt
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask — empty prompt (Requirement 6.4)", () => {
  it("rejects an empty prompt", async () => {
    const { orchestrator, store } = buildOrchestrator();
    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ prompt: "" }),
      }),
    ).rejects.toMatchObject({
      name: "CreateTaskError",
      code: "empty_prompt",
    });
    expect(store.size()).toBe(0);
  });

  it("rejects a whitespace-only prompt", async () => {
    const { orchestrator, store } = buildOrchestrator();
    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ prompt: "   \n\t  " }),
      }),
    ).rejects.toMatchObject({
      code: "empty_prompt",
    });
    expect(store.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Model availability
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask — model availability (Requirement 6.7)", () => {
  it("rejects when the requested model is not in the user's catalog", async () => {
    const catalog = new StubCatalog([
      // The user has a different model from the same provider.
      {
        provider: "openai",
        status: "ok",
        models: [userModel("openai", "gpt-3.5")],
      },
    ]);
    const { orchestrator, store } = buildOrchestrator({ catalog });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ modelRef: userKeyModelRef("openai", "gpt-4o") }),
      }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
    expect(store.size()).toBe(0);
  });

  it("rejects when the requested provider returned a catalog error (no API key)", async () => {
    // Mirrors the catalog's behaviour when no API key is configured.
    const catalog = new StubCatalog([
      {
        provider: "openai",
        status: "error",
        reason: "No API key configured for this provider",
      },
    ]);
    const { orchestrator } = buildOrchestrator({ catalog });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ modelRef: userKeyModelRef("openai", "gpt-4o") }),
      }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("rejects when the requested provider is missing entirely from the catalog", async () => {
    const catalog = new StubCatalog([
      { provider: "anthropic", status: "ok", models: [userModel("anthropic", "claude")] },
    ]);
    const { orchestrator } = buildOrchestrator({ catalog });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ modelRef: userKeyModelRef("openai", "gpt-4o") }),
      }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("rejects when the catalog has only a fallback model but the request asked for user-api-key (Requirement 5.5)", async () => {
    const catalog = new StubCatalog([
      {
        provider: "platform",
        status: "ok",
        models: [fallbackModel("platform", "free-tier")],
      },
    ]);
    const { orchestrator } = buildOrchestrator({ catalog });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        // user-api-key source on a provider that only offers fallback.
        input: manualInput({
          modelRef: { provider: "platform", modelId: "free-tier", source: "user-api-key" },
        }),
      }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });
});

// ---------------------------------------------------------------------------
// Fallback confirmation gate
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask — fallback confirmation gate", () => {
  it("rejects a fallback model when confirmedFallback is not set", async () => {
    const catalog = new StubCatalog([
      {
        provider: "platform",
        status: "ok",
        models: [fallbackModel("platform", "free-tier")],
      },
    ]);
    const { orchestrator } = buildOrchestrator({ catalog });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({
          modelRef: {
            provider: "platform",
            modelId: "free-tier",
            source: "platform-fallback",
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "fallback_not_confirmed" });
  });

  it("accepts a fallback model when confirmedFallback === true", async () => {
    const catalog = new StubCatalog([
      {
        provider: "platform",
        status: "ok",
        models: [fallbackModel("platform", "free-tier")],
      },
    ]);
    const { orchestrator, store } = buildOrchestrator({ catalog });

    const out = await orchestrator.createTask({
      ownerScope: localScope(),
      input: manualInput({
        modelRef: {
          provider: "platform",
          modelId: "free-tier",
          source: "platform-fallback",
        },
      }),
      confirmedFallback: true,
    });

    expect(out.taskId).toBe("task-1");
    expect(store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-mode participant rules
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask — Manual_Mode (Requirement 6.6)", () => {
  it("rejects Manual_Mode with zero participants (participants undefined)", async () => {
    const { orchestrator, store } = buildOrchestrator();

    const input = manualInput();
    delete (input as { participants?: unknown }).participants;

    await expect(
      orchestrator.createTask({ ownerScope: localScope(), input }),
    ).rejects.toMatchObject({ code: "manual_mode_zero_participants" });
    expect(store.size()).toBe(0);
  });

  it("rejects Manual_Mode with zero participants (empty array)", async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ participants: [] }),
      }),
    ).rejects.toMatchObject({ code: "manual_mode_zero_participants" });
  });

  it("accepts Manual_Mode with at least one participant", async () => {
    const { orchestrator, store } = buildOrchestrator();
    const out = await orchestrator.createTask({
      ownerScope: localScope(),
      input: manualInput({ participants: ["agent-coder", "agent-reviewer"] }),
    });
    expect(out.taskId).toBe("task-1");
    expect(store.size()).toBe(1);
  });
});

describe("Orchestrator.createTask — Auto_Mode (design.md Validation rules)", () => {
  it("rejects when the auto resolver returns an empty list", async () => {
    const resolver = new StubAutoResolver([]);
    const { orchestrator, store } = buildOrchestrator({ resolver });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: autoInput(),
      }),
    ).rejects.toMatchObject({ code: "auto_mode_no_participants" });
    expect(store.size()).toBe(0);
  });

  it("rejects when the auto resolver throws", async () => {
    const resolver = new StubAutoResolver(() => {
      throw new Error("LLM unreachable");
    });
    const { orchestrator } = buildOrchestrator({ resolver });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: autoInput(),
      }),
    ).rejects.toMatchObject({ code: "auto_mode_no_participants" });
  });

  it("accepts Auto_Mode when the resolver returns a non-empty ordered list", async () => {
    const resolver = new StubAutoResolver([
      "agent-researcher",
      "agent-coder",
      "agent-reviewer",
    ]);
    const { orchestrator, store } = buildOrchestrator({ resolver });

    const out = await orchestrator.createTask({
      ownerScope: localScope(),
      input: autoInput(),
    });
    expect(out.taskId).toBe("task-1");
    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]?.prompt).toBe("Build a parser");
    expect(store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Successful persistence
// ---------------------------------------------------------------------------

describe("Orchestrator.createTask — success persists initial TaskState (Requirement 6.8)", () => {
  it("returns a non-empty taskId and persists the initial state", async () => {
    const { orchestrator, store } = buildOrchestrator();

    const out = await orchestrator.createTask({
      ownerScope: localScope(),
      input: manualInput(),
    });

    expect(typeof out.taskId).toBe("string");
    expect(out.taskId.length).toBeGreaterThan(0);

    const persisted = store.get(out.taskId);
    expect(persisted).not.toBeNull();
    expect(persisted).toEqual({
      id: out.taskId,
      ownerScope: localScope(),
      status: "created",
      reviewCycles: 0,
      maxReviewCycles: 5,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    });
  });

  it("honors a caller-supplied maxReviewCycles", async () => {
    const { orchestrator, store } = buildOrchestrator();

    const out = await orchestrator.createTask({
      ownerScope: localScope(),
      input: manualInput({ maxReviewCycles: 3 }),
    });

    expect(store.get(out.taskId)?.maxReviewCycles).toBe(3);
  });

  it("rejects an invalid maxReviewCycles", async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ maxReviewCycles: 0 }),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("surfaces persistence errors as persistence_failed", async () => {
    class FailingStore extends InMemoryTaskStateStore {
      public override async save(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const store = new FailingStore();
    const { orchestrator } = buildOrchestrator({ store });

    await expect(
      orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput(),
      }),
    ).rejects.toMatchObject({ code: "persistence_failed" });
  });

  it("creates two tasks with distinct ids", async () => {
    const { orchestrator, store } = buildOrchestrator();
    const a = await orchestrator.createTask({
      ownerScope: localScope(),
      input: manualInput({ prompt: "first" }),
    });
    const b = await orchestrator.createTask({
      ownerScope: localScope(),
      input: manualInput({ prompt: "second" }),
    });
    expect(a.taskId).not.toBe(b.taskId);
    expect(store.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CreateTaskError shape
// ---------------------------------------------------------------------------

describe("CreateTaskError", () => {
  it("is an instance of Error and exposes a stable code", async () => {
    const { orchestrator } = buildOrchestrator();
    try {
      await orchestrator.createTask({
        ownerScope: localScope(),
        input: manualInput({ prompt: "" }),
      });
      throw new Error("expected createTask to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(CreateTaskError);
      expect(e).toBeInstanceOf(Error);
      if (e instanceof CreateTaskError) {
        expect(e.code).toBe("empty_prompt");
        expect(e.name).toBe("CreateTaskError");
      }
    }
  });
});
