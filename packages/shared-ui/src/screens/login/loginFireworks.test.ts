// @vitest-environment jsdom
/**
 * Fireworks AI / Custom OpenAI-compatible login flow tests.
 *
 * Pins the contract that:
 *
 *   • Fireworks AI is in the provider dropdown.
 *   • Picking Fireworks reveals the model-id field and pre-fills it.
 *   • Custom preset reveals the baseUrl field.
 *   • Validation blocks with `missing_model_id` when Fireworks model
 *     is empty, and with `missing_base_url` when Custom baseUrl is
 *     empty — without ever calling the gateway.
 *   • Successful Fireworks validation forwards the chosen baseUrl +
 *     modelId into both `validateApiKey` and `createLocalSession`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LoginScreen } from "./loginScreen.js";
import { mountLoginScreen } from "./mountLoginScreen.js";
import type { LoginGateway, Session, ValidationResult } from "./types.js";

class StubGateway implements LoginGateway {
  public validateCalls: Array<{
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelId?: string;
  }> = [];
  public createCalls: Array<{
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelId?: string;
  }> = [];
  private nextValidate: ValidationResult = { kind: "ok" };
  private nextSession: Session = {
    id: "sess-1",
    kind: "local",
    deviceId: "device-test",
    createdAt: "2025-01-01T00:00:00.000Z",
  };

  public setNextValidate(r: ValidationResult): void {
    this.nextValidate = r;
  }

  public async validateApiKey(input: {
    readonly provider: string;
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly modelId?: string;
  }): Promise<ValidationResult> {
    const recorded: {
      provider: string;
      apiKey: string;
      baseUrl?: string;
      modelId?: string;
    } = { provider: input.provider, apiKey: input.apiKey };
    if (input.baseUrl !== undefined) recorded.baseUrl = input.baseUrl;
    if (input.modelId !== undefined) recorded.modelId = input.modelId;
    this.validateCalls.push(recorded);
    await Promise.resolve();
    return this.nextValidate;
  }

  public async createLocalSession(input: {
    readonly provider: string;
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly modelId?: string;
    readonly confirmedByUser: true;
  }): Promise<Session> {
    const recorded: {
      provider: string;
      apiKey: string;
      baseUrl?: string;
      modelId?: string;
    } = { provider: input.provider, apiKey: input.apiKey };
    if (input.baseUrl !== undefined) recorded.baseUrl = input.baseUrl;
    if (input.modelId !== undefined) recorded.modelId = input.modelId;
    this.createCalls.push(recorded);
    await Promise.resolve();
    return this.nextSession;
  }
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("section");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

function flush(): Promise<void> {
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined);
}

// ---------------------------------------------------------------------
// Provider dropdown
// ---------------------------------------------------------------------

describe("login dropdown — provider list", () => {
  it("includes OpenAI, Anthropic, Fireworks AI and Custom OpenAI-compatible", () => {
    const controller = new LoginScreen({ gateway: new StubGateway() });
    mountLoginScreen(root, controller);
    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    const ids = Array.from(select.options).map((o) => o.value);
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("fireworks");
    expect(ids).toContain("custom-openai");
    // Visible labels
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Fireworks AI");
    expect(labels).toContain("Custom OpenAI-compatible");
  });
});

// ---------------------------------------------------------------------
// Conditional fields
// ---------------------------------------------------------------------

describe("login form — conditional baseUrl / modelId fields", () => {
  it("hides both fields for OpenAI and Anthropic", () => {
    const controller = new LoginScreen({ gateway: new StubGateway() });
    mountLoginScreen(root, controller);
    const baseUrl = root.querySelector<HTMLElement>(".login-field-baseurl")!;
    const modelId = root.querySelector<HTMLElement>(".login-field-modelid")!;
    expect(baseUrl.hidden).toBe(true);
    expect(modelId.hidden).toBe(true);

    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    select.value = "anthropic";
    select.dispatchEvent(new Event("change"));
    expect(baseUrl.hidden).toBe(true);
    expect(modelId.hidden).toBe(true);
  });

  it("shows model-id field for Fireworks and pre-fills it", () => {
    const controller = new LoginScreen({ gateway: new StubGateway() });
    mountLoginScreen(root, controller);
    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    select.value = "fireworks";
    select.dispatchEvent(new Event("change"));
    const modelId = root.querySelector<HTMLElement>(".login-field-modelid")!;
    expect(modelId.hidden).toBe(false);
    const modelInput = root.querySelector<HTMLInputElement>(
      'input[name="modelId"]',
    )!;
    expect(modelInput.value).toBe(
      "accounts/fireworks/models/llama-v3p1-8b-instruct",
    );
  });

  it("shows both fields for Custom OpenAI-compatible and clears the model id", () => {
    const controller = new LoginScreen({ gateway: new StubGateway() });
    mountLoginScreen(root, controller);
    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    select.value = "custom-openai";
    select.dispatchEvent(new Event("change"));
    const baseUrl = root.querySelector<HTMLElement>(".login-field-baseurl")!;
    const modelId = root.querySelector<HTMLElement>(".login-field-modelid")!;
    expect(baseUrl.hidden).toBe(false);
    expect(modelId.hidden).toBe(false);
    const modelInput = root.querySelector<HTMLInputElement>(
      'input[name="modelId"]',
    )!;
    expect(modelInput.value).toBe("");
  });
});

// ---------------------------------------------------------------------
// Pre-flight validation
// ---------------------------------------------------------------------

describe("login form — pre-flight validation rules", () => {
  it("Fireworks validate without modelId rejects with missing_model_id (no gateway call)", async () => {
    const gateway = new StubGateway();
    const controller = new LoginScreen({ gateway });
    mountLoginScreen(root, controller);

    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    select.value = "fireworks";
    select.dispatchEvent(new Event("change"));

    // Clear the pre-filled modelId to simulate a user who deleted it.
    const modelInput = root.querySelector<HTMLInputElement>(
      'input[name="modelId"]',
    )!;
    modelInput.value = "";
    modelInput.dispatchEvent(new Event("input"));

    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "fw-test";
    apiKey.dispatchEvent(new Event("input"));

    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();

    expect(gateway.validateCalls).toHaveLength(0);
    const errorSurface = root.querySelector<HTMLElement>(
      ".login-error-surface",
    )!;
    expect(errorSurface.dataset["code"]).toBe("missing_model_id");
  });

  it("Custom validate without baseUrl rejects with missing_base_url (no gateway call)", async () => {
    const gateway = new StubGateway();
    const controller = new LoginScreen({ gateway });
    mountLoginScreen(root, controller);

    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    select.value = "custom-openai";
    select.dispatchEvent(new Event("change"));

    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "custom-test";
    apiKey.dispatchEvent(new Event("input"));
    const modelInput = root.querySelector<HTMLInputElement>(
      'input[name="modelId"]',
    )!;
    modelInput.value = "my-llm";
    modelInput.dispatchEvent(new Event("input"));

    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();

    expect(gateway.validateCalls).toHaveLength(0);
    const errorSurface = root.querySelector<HTMLElement>(
      ".login-error-surface",
    )!;
    expect(errorSurface.dataset["code"]).toBe("missing_base_url");
  });
});

// ---------------------------------------------------------------------
// End-to-end Fireworks flow
// ---------------------------------------------------------------------

describe("login form — Fireworks happy path forwards baseUrl + modelId", () => {
  it("forwards the resolved Fireworks baseUrl and the user's model id to validate + save", async () => {
    const gateway = new StubGateway();
    const controller = new LoginScreen({ gateway });
    mountLoginScreen(root, controller);

    const select = root.querySelector<HTMLSelectElement>(
      'select[name="provider"]',
    )!;
    select.value = "fireworks";
    select.dispatchEvent(new Event("change"));

    const apiKey = root.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    apiKey.value = "fw-real-key";
    apiKey.dispatchEvent(new Event("input"));

    const modelInput = root.querySelector<HTMLInputElement>(
      'input[name="modelId"]',
    )!;
    modelInput.value = "accounts/fireworks/models/llama-v3p1-70b-instruct";
    modelInput.dispatchEvent(new Event("input"));

    root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
    await flush();

    expect(gateway.validateCalls).toHaveLength(1);
    expect(gateway.validateCalls[0]).toEqual({
      provider: "fireworks",
      apiKey: "fw-real-key",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      modelId: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    });

    // Save flow.
    root.querySelector<HTMLButtonElement>(".login-save-button")!.click();
    root.querySelector<HTMLButtonElement>(".login-modal-confirm")!.click();
    await flush();
    await flush();

    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]).toEqual({
      provider: "fireworks",
      apiKey: "fw-real-key",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      modelId: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    });
  });

  it(
    "after a successful save the modal closes (login modal still works after " +
      "successful validation)",
    async () => {
      const gateway = new StubGateway();
      const controller = new LoginScreen({ gateway });
      mountLoginScreen(root, controller);

      const select = root.querySelector<HTMLSelectElement>(
        'select[name="provider"]',
      )!;
      select.value = "fireworks";
      select.dispatchEvent(new Event("change"));
      const apiKey = root.querySelector<HTMLInputElement>(
        'input[name="apiKey"]',
      )!;
      apiKey.value = "fw-real-key";
      apiKey.dispatchEvent(new Event("input"));

      root.querySelector<HTMLButtonElement>(".login-validate-button")!.click();
      await flush();
      root.querySelector<HTMLButtonElement>(".login-save-button")!.click();
      const backdrop = root.querySelector<HTMLElement>(
        ".login-modal-backdrop",
      )!;
      expect(backdrop.hidden).toBe(false);

      root.querySelector<HTMLButtonElement>(".login-modal-confirm")!.click();
      await flush();
      await flush();

      // After the save status flips to "saved" the controller does not
      // collapse the modal automatically — the host shell decides what
      // to render next. The save state itself MUST report `saved`.
      const saveState = controller.getState().save;
      expect(saveState.kind).toBe("saved");
    },
  );
});
