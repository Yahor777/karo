/**
 * Unit tests for the framework-free LoginScreen controller (task 4.3).
 *
 * These tests cover the form state machine and gateway interactions
 * end-to-end without any DOM. Render-side smoke tests are kept in a
 * separate file so the controller still runs in a plain Node test
 * environment.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4.
 */

import { describe, expect, it } from "vitest";

import { LoginScreen } from "./loginScreen.js";
import type {
  LoginEvent,
  LoginGateway,
  LoginState,
  Session,
  ValidationResult,
} from "./types.js";

const FIXED_SESSION: Session = {
  id: "session-1",
  kind: "local",
  deviceId: "device-A",
  createdAt: "2025-02-03T12:34:56.789Z",
};

class RecordingGateway implements LoginGateway {
  public readonly validateCalls: Array<{
    provider: string;
    apiKey: string;
  }> = [];
  public readonly createCalls: Array<{
    provider: string;
    apiKey: string;
    confirmedByUser: true;
  }> = [];
  private nextValidate: ValidationResult = { kind: "ok" };
  private nextValidateError: Error | null = null;
  private nextSession: Session = FIXED_SESSION;
  private nextSessionError: (Error & { code?: string }) | null = null;

  public setNextValidate(result: ValidationResult): void {
    this.nextValidate = result;
    this.nextValidateError = null;
  }

  public throwOnValidate(err: Error): void {
    this.nextValidateError = err;
  }

  public setNextSession(session: Session): void {
    this.nextSession = session;
    this.nextSessionError = null;
  }

  public throwOnCreate(err: Error & { code?: string }): void {
    this.nextSessionError = err;
  }

  public async validateApiKey(input: {
    readonly provider: string;
    readonly apiKey: string;
  }): Promise<ValidationResult> {
    this.validateCalls.push({
      provider: input.provider,
      apiKey: input.apiKey,
    });
    if (this.nextValidateError) {
      const err = this.nextValidateError;
      this.nextValidateError = null;
      throw err;
    }
    return this.nextValidate;
  }

  public async createLocalSession(input: {
    readonly provider: string;
    readonly apiKey: string;
    readonly confirmedByUser: true;
  }): Promise<Session> {
    this.createCalls.push({
      provider: input.provider,
      apiKey: input.apiKey,
      confirmedByUser: input.confirmedByUser,
    });
    if (this.nextSessionError) {
      const err = this.nextSessionError;
      this.nextSessionError = null;
      throw err;
    }
    return this.nextSession;
  }
}

function build(): { controller: LoginScreen; gateway: RecordingGateway } {
  const gateway = new RecordingGateway();
  const controller = new LoginScreen({ gateway });
  return { controller, gateway };
}

describe("LoginScreen — initial state and entry-mode toggle", () => {
  it("starts in apiKey mode with idle validation and idle save", () => {
    const { controller } = build();
    const state = controller.getState();
    expect(state.entryMode).toBe("apiKey");
    expect(state.provider).toBe("openai");
    expect(state.apiKey).toBe("");
    expect(state.validation).toEqual({ kind: "idle" });
    expect(state.save).toEqual({ kind: "idle" });
  });

  it("toggles entry mode and pushes the new state to subscribers", () => {
    const { controller } = build();
    const seen: LoginState[] = [];
    controller.subscribeState((s) => seen.push(s));

    controller.setEntryMode("google");
    controller.setEntryMode("apiKey");

    // Initial eager push + two transitions.
    expect(seen.map((s) => s.entryMode)).toEqual([
      "apiKey",
      "google",
      "apiKey",
    ]);
  });

  it("requestGoogleOAuth switches to google mode and emits an event", () => {
    const { controller } = build();
    const events: LoginEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));

    controller.requestGoogleOAuth();

    expect(controller.getState().entryMode).toBe("google");
    expect(events).toEqual([{ type: "requestGoogleOAuth" }]);
  });
});

describe("LoginScreen — validate()", () => {
  it("rejects empty key locally without calling the gateway (Req. 2.2)", async () => {
    const { controller, gateway } = build();
    const result = await controller.validate();
    expect(result).toEqual({
      kind: "error",
      providerCode: "invalid_api_key",
      providerMessage: "API key is empty",
    });
    expect(gateway.validateCalls).toHaveLength(0);
  });

  it("transitions to validating then ok on success and forwards modelsCount", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok", modelsCount: 7 });
    controller.setApiKey("sk-test");

    const seen: string[] = [];
    controller.subscribeState((s) => seen.push(s.validation.kind));

    await controller.validate();

    // Initial push + setApiKey reset to idle + validating + ok.
    expect(seen).toContain("validating");
    expect(seen[seen.length - 1]).toBe("ok");
    expect(controller.getState().validation).toEqual({
      kind: "ok",
      modelsCount: 7,
    });
  });

  it("surfaces the Provider error code/message verbatim (Req. 2.3)", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({
      kind: "error",
      providerCode: "invalid_api_key",
      providerMessage: "Incorrect API key provided",
    });
    controller.setApiKey("sk-bogus");

    await controller.validate();
    const state = controller.getState();
    expect(state.validation).toEqual({
      kind: "error",
      providerCode: "invalid_api_key",
      providerMessage: "Incorrect API key provided",
    });
  });

  it("wraps an unexpected gateway throw as a structured error", async () => {
    const { controller, gateway } = build();
    gateway.throwOnValidate(new Error("boom"));
    controller.setApiKey("sk-test");

    await controller.validate();
    const v = controller.getState().validation;
    expect(v.kind).toBe("error");
    if (v.kind === "error") {
      expect(v.providerCode).toBe("unexpected_error");
      expect(v.providerMessage).toContain("boom");
    }
  });

  it("editing the apiKey resets validation back to idle", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();
    expect(controller.getState().validation.kind).toBe("ok");

    controller.setApiKey("sk-test-edited");
    expect(controller.getState().validation).toEqual({ kind: "idle" });
  });

  it("changing the provider resets validation back to idle", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();
    expect(controller.getState().validation.kind).toBe("ok");

    controller.setProvider("anthropic");
    expect(controller.getState().validation).toEqual({ kind: "idle" });
  });

  it("only the latest concurrent validate result is applied", async () => {
    const { controller: _controller } = build();
    let resolveFirst!: (r: ValidationResult) => void;
    let resolveSecond!: (r: ValidationResult) => void;
    const gateway: LoginGateway = {
      async validateApiKey() {
        // Two distinct deferred promises so the test can resolve them
        // out of order.
        if (!resolveFirst) {
          return await new Promise<ValidationResult>((res) => {
            resolveFirst = res;
          });
        }
        return await new Promise<ValidationResult>((res) => {
          resolveSecond = res;
        });
      },
      async createLocalSession() {
        return FIXED_SESSION;
      },
    };
    const c = new LoginScreen({ gateway });
    c.setApiKey("sk-test");

    const p1 = c.validate();
    const p2 = c.validate();

    // Resolve the older call last; the controller must drop it.
    resolveSecond({ kind: "ok", modelsCount: 2 });
    resolveFirst({
      kind: "error",
      providerCode: "stale",
      providerMessage: "stale result",
    });

    await p1;
    await p2;

    expect(c.getState().validation).toEqual({ kind: "ok", modelsCount: 2 });
  });
});

describe("LoginScreen — save flow (Requirement 2.4)", () => {
  it("Save button is gated on validation == ok", () => {
    const { controller } = build();
    expect(controller.canRequestSave()).toBe(false);
    controller.requestSave();
    expect(controller.getState().save).toEqual({ kind: "idle" });
  });

  it("requestSave opens the confirmation modal but does not call the gateway", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();

    controller.requestSave();
    expect(controller.getState().save).toEqual({
      kind: "awaitingConfirmation",
    });
    expect(gateway.createCalls).toHaveLength(0);
  });

  it("cancelSave returns to idle and never invokes the gateway", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();

    controller.requestSave();
    controller.cancelSave();

    expect(controller.getState().save).toEqual({ kind: "idle" });
    expect(gateway.createCalls).toHaveLength(0);
  });

  it("confirmAndSave invokes createLocalSession with confirmedByUser=true exactly once and emits saved", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();

    const events: LoginEvent[] = [];
    controller.subscribeEvents((e) => events.push(e));

    controller.requestSave();
    await controller.confirmAndSave();

    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]).toEqual({
      provider: "openai",
      apiKey: "sk-test",
      confirmedByUser: true,
    });
    expect(controller.getState().save).toEqual({
      kind: "saved",
      session: FIXED_SESSION,
    });
    expect(events).toContainEqual({ type: "saved", session: FIXED_SESSION });
  });

  it("confirmAndSave without a prior requestSave is a no-op", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();

    await controller.confirmAndSave();
    expect(gateway.createCalls).toHaveLength(0);
    expect(controller.getState().save).toEqual({ kind: "idle" });
  });

  it("save failure surfaces the error code from LocalSessionError-shaped errors", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();

    const err = Object.assign(new Error("disk offline"), {
      code: "storage_failed",
    });
    gateway.throwOnCreate(err);

    controller.requestSave();
    await controller.confirmAndSave();

    const save = controller.getState().save;
    expect(save.kind).toBe("error");
    if (save.kind === "error") {
      expect(save.code).toBe("storage_failed");
      expect(save.message).toContain("disk offline");
    }
  });

  it("editing the apiKey while modal is open invalidates validation and aborts save", async () => {
    const { controller, gateway } = build();
    gateway.setNextValidate({ kind: "ok" });
    controller.setApiKey("sk-test");
    await controller.validate();

    controller.requestSave();
    expect(controller.getState().save.kind).toBe("awaitingConfirmation");

    controller.setApiKey("sk-changed");
    expect(controller.getState().validation.kind).toBe("idle");
    expect(controller.getState().save.kind).toBe("idle");

    await controller.confirmAndSave();
    expect(gateway.createCalls).toHaveLength(0);
  });
});
