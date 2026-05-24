/**
 * Unit tests for the framework-free {@link TaskBuilderController}
 * (task 8.1).
 *
 * Covers the contract the task description calls out:
 *
 *   1. canLaunch matrix — all combinations of (prompt, modelRef, mode,
 *      participants) that gate the Launch button (Requirements 6.1,
 *      6.2, 6.3, 6.5).
 *   2. submit success — gateway is called with the expected
 *      `CreateTaskInput`, state transitions through `submitting` →
 *      `submitted`, and a `taskCreated` event is emitted.
 *   3. submit rejection paths — local short-circuit for empty prompt
 *      and Manual_Mode with zero participants; remote rejection when
 *      the gateway throws a `CreateTaskError`-shaped object.
 *
 * These tests drive the controller directly without any DOM —
 * jsdom-flavoured mount tests live in a sibling file when needed.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5.
 */

import { describe, expect, it } from "vitest";

import {
  TaskBuilderController,
} from "./taskBuilder.js";
import type {
  CreateTaskInput,
  ModelRef,
  TaskBuilderEvent,
  TaskBuilderGateway,
  TaskBuilderSubmitStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const USER_KEY_MODEL: ModelRef = {
  provider: "openai",
  modelId: "gpt-4o",
  source: "user-api-key",
};

const FALLBACK_MODEL: ModelRef = {
  provider: "platform",
  modelId: "free-tier-1",
  source: "platform-fallback",
};

class RecordingGateway implements TaskBuilderGateway {
  public readonly calls: Array<{
    input: CreateTaskInput;
    options?: { confirmedFallback?: boolean };
  }> = [];
  private nextTaskId = "task-1";
  private nextError: unknown = null;

  public setNextTaskId(id: string): void {
    this.nextTaskId = id;
    this.nextError = null;
  }

  public throwNext(err: unknown): void {
    this.nextError = err;
  }

  public async createTask(
    input: CreateTaskInput,
    options?: { readonly confirmedFallback?: boolean },
  ): Promise<{ readonly taskId: string }> {
    this.calls.push({
      input,
      ...(options !== undefined ? { options: { ...options } } : {}),
    });
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err as Error;
    }
    return { taskId: this.nextTaskId };
  }
}

/**
 * Reconstructs the structural shape thrown by
 * `apps/backend/src/orchestrator/createTask.ts → CreateTaskError`. We
 * don't import the backend class directly so the controller's
 * structural-guard handling is the thing under test.
 */
function buildCreateTaskError(
  code:
    | "empty_prompt"
    | "invalid_input"
    | "model_unavailable"
    | "fallback_not_confirmed"
    | "manual_mode_zero_participants"
    | "auto_mode_no_participants"
    | "persistence_failed",
  message: string,
): Error {
  const err = new Error(message);
  err.name = "CreateTaskError";
  (err as unknown as { code: typeof code }).code = code;
  return err;
}

function build(): {
  controller: TaskBuilderController;
  gateway: RecordingGateway;
} {
  const gateway = new RecordingGateway();
  const controller = new TaskBuilderController({ gateway });
  return { controller, gateway };
}

// ---------------------------------------------------------------------------
// canLaunch matrix (Requirements 6.1, 6.2, 6.3, 6.5)
// ---------------------------------------------------------------------------

describe("TaskBuilderController.canLaunch — initial state", () => {
  it("starts disabled with empty prompt and no model", () => {
    const { controller } = build();
    const state = controller.getState();
    expect(state.prompt).toBe("");
    expect(state.modelRef).toBeNull();
    expect(state.mode).toBe("auto");
    expect(state.participants).toEqual([]);
    expect(state.submit).toEqual({ kind: "idle" });
    expect(controller.canLaunch()).toBe(false);
  });
});

describe("TaskBuilderController.canLaunch — prompt gate (Requirement 6.5)", () => {
  it("stays disabled while the prompt is empty even if everything else is set", () => {
    const { controller } = build();
    controller.setModel(USER_KEY_MODEL);
    expect(controller.canLaunch()).toBe(false);
  });

  it("stays disabled when the prompt is whitespace-only", () => {
    const { controller } = build();
    controller.setModel(USER_KEY_MODEL);
    controller.setPrompt("    \n\t  ");
    expect(controller.canLaunch()).toBe(false);
  });

  it("becomes enabled with a non-empty prompt and a model in Auto mode", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    expect(controller.canLaunch()).toBe(true);
  });

  it("re-disables the launch when the prompt is cleared", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    expect(controller.canLaunch()).toBe(true);
    controller.setPrompt("");
    expect(controller.canLaunch()).toBe(false);
  });
});

describe("TaskBuilderController.canLaunch — model gate (design 'Validation rules')", () => {
  it("stays disabled with a non-empty prompt but no model", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    expect(controller.canLaunch()).toBe(false);
  });

  it("re-disables the launch when the model is cleared", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    expect(controller.canLaunch()).toBe(true);
    controller.setModel(null);
    expect(controller.canLaunch()).toBe(false);
  });
});

describe("TaskBuilderController.canLaunch — manual-mode participant gate (Requirement 6.2)", () => {
  it("stays disabled in manual mode with zero participants", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    controller.setMode("manual");
    expect(controller.getState().participants).toEqual([]);
    expect(controller.canLaunch()).toBe(false);
  });

  it("becomes enabled in manual mode after at least one participant is added", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    controller.setMode("manual");
    controller.addParticipant("researcher");
    expect(controller.canLaunch()).toBe(true);
  });

  it("re-disables when the last participant is removed", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    controller.setMode("manual");
    controller.addParticipant("researcher");
    controller.removeParticipant("researcher");
    expect(controller.canLaunch()).toBe(false);
  });

  it("preserves participants when toggling mode (Requirement 6.2/6.3)", () => {
    const { controller } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    controller.setMode("manual");
    controller.addParticipant("reviewer");
    controller.setMode("auto");
    expect(controller.getState().participants).toEqual(["reviewer"]);
    expect(controller.canLaunch()).toBe(true);
    controller.setMode("manual");
    expect(controller.getState().participants).toEqual(["reviewer"]);
    expect(controller.canLaunch()).toBe(true);
  });

  it("does not add the same participant twice", () => {
    const { controller } = build();
    controller.setMode("manual");
    controller.addParticipant("researcher");
    controller.addParticipant("researcher");
    expect(controller.getState().participants).toEqual(["researcher"]);
  });
});

// ---------------------------------------------------------------------------
// submit() — success path
// ---------------------------------------------------------------------------

describe("TaskBuilderController.submit — success", () => {
  it("calls the gateway with the current input and emits taskCreated on success", async () => {
    const { controller, gateway } = build();
    gateway.setNextTaskId("task-42");

    controller.setPrompt("Write a hello-world script");
    controller.setModel(USER_KEY_MODEL);

    const events: TaskBuilderEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));

    const status = await controller.submit();

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.input).toEqual({
      prompt: "Write a hello-world script",
      modelRef: USER_KEY_MODEL,
      mode: "auto",
    });
    expect(gateway.calls[0]?.options).toEqual({ confirmedFallback: false });
    expect(status).toEqual({ kind: "submitted", taskId: "task-42" });
    expect(controller.getState().submit).toEqual({
      kind: "submitted",
      taskId: "task-42",
    });
    expect(events).toEqual([{ type: "taskCreated", taskId: "task-42" }]);
  });

  it("forwards manual-mode participants in the input", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("Refactor the auth module");
    controller.setModel(USER_KEY_MODEL);
    controller.setMode("manual");
    controller.addParticipant("researcher");
    controller.addParticipant("coder");

    await controller.submit();

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.input).toEqual({
      prompt: "Refactor the auth module",
      modelRef: USER_KEY_MODEL,
      mode: "manual",
      participants: ["researcher", "coder"],
    });
  });

  it("transitions through submitting before submitted", async () => {
    build();
    let release: (() => void) | null = null;
    const slowGateway: TaskBuilderGateway = {
      async createTask() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { taskId: "task-slow" };
      },
    };
    const c = new TaskBuilderController({ gateway: slowGateway });
    c.setPrompt("hi");
    c.setModel(USER_KEY_MODEL);

    const seen: TaskBuilderSubmitStatus["kind"][] = [];
    c.subscribeState((s) => seen.push(s.submit.kind));

    const promise = c.submit();
    expect(c.getState().submit.kind).toBe("submitting");
    expect(c.canLaunch()).toBe(false);
    release?.();
    await promise;

    expect(seen).toContain("submitting");
    expect(seen[seen.length - 1]).toBe("submitted");
  });

  it("forwards confirmedFallback=true when the user confirmed a fallback model", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("hi");
    controller.setModel(FALLBACK_MODEL);
    controller.setConfirmedFallback(true);

    await controller.submit();
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.options).toEqual({ confirmedFallback: true });
  });
});

// ---------------------------------------------------------------------------
// submit() — local rejection paths
// ---------------------------------------------------------------------------

describe("TaskBuilderController.submit — local rejection paths", () => {
  it("rejects an empty prompt without calling the gateway (Requirement 6.5)", async () => {
    const { controller, gateway } = build();
    controller.setModel(USER_KEY_MODEL);

    const status = await controller.submit();

    expect(gateway.calls).toHaveLength(0);
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("empty_prompt");
    }
  });

  it("rejects a whitespace-only prompt without calling the gateway", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("   \n  ");
    controller.setModel(USER_KEY_MODEL);

    const status = await controller.submit();

    expect(gateway.calls).toHaveLength(0);
    if (status.kind === "error") {
      expect(status.code).toBe("empty_prompt");
    } else {
      throw new Error(`expected error status, got ${status.kind}`);
    }
  });

  it("rejects manual mode with zero participants (Requirement 6.6)", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("Build something");
    controller.setModel(USER_KEY_MODEL);
    controller.setMode("manual");

    const status = await controller.submit();

    expect(gateway.calls).toHaveLength(0);
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("manual_mode_zero_participants");
    }
  });

  it("rejects launch when no model is selected", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("Build something");

    const status = await controller.submit();

    expect(gateway.calls).toHaveLength(0);
    if (status.kind === "error") {
      expect(status.code).toBe("model_unavailable");
    } else {
      throw new Error(`expected error status, got ${status.kind}`);
    }
  });

  it("rejects fallback model launch without confirmation", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("hi");
    controller.setModel(FALLBACK_MODEL);

    const status = await controller.submit();

    expect(gateway.calls).toHaveLength(0);
    if (status.kind === "error") {
      expect(status.code).toBe("fallback_not_confirmed");
    } else {
      throw new Error(`expected error status, got ${status.kind}`);
    }
  });

  it("clears the inline error when the user starts editing the form", async () => {
    const { controller } = build();
    controller.setModel(USER_KEY_MODEL);
    await controller.submit();
    expect(controller.getState().submit.kind).toBe("error");

    controller.setPrompt("now I have a prompt");
    expect(controller.getState().submit).toEqual({ kind: "idle" });
  });
});

// ---------------------------------------------------------------------------
// submit() — gateway-side rejection paths
// ---------------------------------------------------------------------------

describe("TaskBuilderController.submit — gateway rejection", () => {
  it("surfaces CreateTaskError code/message verbatim", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("hi");
    controller.setModel(USER_KEY_MODEL);
    gateway.throwNext(
      buildCreateTaskError(
        "model_unavailable",
        'createTask: model "gpt-4o" is not available for provider "openai"',
      ),
    );

    const status = await controller.submit();
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("model_unavailable");
      expect(status.message).toContain("not available");
    }
  });

  it("maps unknown errors to code: 'unknown'", async () => {
    const { controller, gateway } = build();
    controller.setPrompt("hi");
    controller.setModel(USER_KEY_MODEL);
    gateway.throwNext(new Error("network down"));

    const status = await controller.submit();
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.code).toBe("unknown");
      expect(status.message).toContain("network down");
    }
  });

  it("only the latest concurrent submit applies its result", async () => {
    let resolveFirst!: (taskId: string) => void;
    let resolveSecond!: (taskId: string) => void;
    const gateway: TaskBuilderGateway = {
      async createTask() {
        if (resolveFirst === undefined) {
          return await new Promise<{ taskId: string }>((res) => {
            resolveFirst = (id: string) => res({ taskId: id });
          });
        }
        return await new Promise<{ taskId: string }>((res) => {
          resolveSecond = (id: string) => res({ taskId: id });
        });
      },
    };
    const c = new TaskBuilderController({ gateway });
    c.setPrompt("hi");
    c.setModel(USER_KEY_MODEL);

    const p1 = c.submit();
    // Bypass the canLaunch=false guard while the first call is in
    // flight by submitting via the public API again. canLaunch returns
    // false during submitting, but submit() does not gate on it (the
    // renderer does), so two concurrent calls are possible from a
    // misbehaving host.
    const p2 = c.submit();

    // Resolve the older call last; controller must drop it.
    resolveSecond("task-newer");
    resolveFirst("task-older");

    await p1;
    await p2;

    const final = c.getState().submit;
    expect(final).toEqual({ kind: "submitted", taskId: "task-newer" });
  });
});
