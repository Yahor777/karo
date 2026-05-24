// @vitest-environment jsdom
/**
 * Unit tests for the Web Shell screen registry (task 18.2).
 *
 * Validates: Requirements 1.7, 11.8.
 *
 * Coverage matrix:
 *   • Each route resolves to the right registry mount function.
 *   • The bootstrap calls `unmount()` on the previously-mounted screen
 *     when the user navigates to a different route.
 *   • Captured `:id` params are forwarded to the screens that need
 *     them (`/tasks/:id/trace`, `/tasks/:id/artifacts`,
 *     `/tasks/:id/report`).
 *   • `WEB_SHELL_SCREEN_ROUTES` exposes the full nine-route table that
 *     the registry mounts, so the router glue and the registry cannot
 *     drift out of sync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapWebShell } from "../bootstrap.js";
import { WEB_SHELL_SCREEN_ROUTES } from "../router.js";
import {
  createScreensRegistry,
  type WebShellScreenHandle,
  type WebShellScreenId,
  type WebShellScreenMount,
  type WebShellScreensRegistry,
} from "./screensRegistry.js";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

interface ScreenSpy {
  readonly mount: WebShellScreenMount;
  readonly unmount: ReturnType<typeof vi.fn>;
  readonly invocations: Array<{
    readonly root: HTMLElement;
    readonly taskId: string | undefined;
  }>;
}

function makeScreenSpy(label: string): ScreenSpy {
  const unmount = vi.fn();
  const invocations: ScreenSpy["invocations"] = [];
  const mount: WebShellScreenMount = ({ root: r, taskId }) => {
    invocations.push({ root: r, taskId });
    const tag = document.createElement("section");
    tag.className = "screen-spy";
    tag.dataset["spy"] = label;
    r.append(tag);
    const handle: WebShellScreenHandle = { unmount };
    return handle;
  };
  return { mount, unmount, invocations };
}

function makeStubRegistry(
  spies: Record<WebShellScreenId, ScreenSpy>,
): WebShellScreensRegistry {
  return Object.freeze({
    login: spies["login"].mount,
    models: spies["models"].mount,
    tasks: spies["tasks"].mount,
    trace: spies["trace"].mount,
    artifacts: spies["artifacts"].mount,
    "settings.keys": spies["settings.keys"].mount,
    "settings.agents": spies["settings.agents"].mount,
    "tasks.report": spies["tasks.report"].mount,
  } satisfies WebShellScreensRegistry);
}

describe("WEB_SHELL_SCREEN_ROUTES", () => {
  it("exposes the full nine-route table the bootstrap registers", () => {
    expect(WEB_SHELL_SCREEN_ROUTES).toEqual([
      "/login",
      "/oauth/callback",
      "/models",
      "/tasks",
      "/tasks/:id/trace",
      "/tasks/:id/artifacts",
      "/tasks/:id/report",
      "/settings/keys",
      "/settings/agents",
    ]);
  });
});

describe("createScreensRegistry", () => {
  it("returns one mount function per known screen id", () => {
    const registry = createScreensRegistry();
    const ids: readonly WebShellScreenId[] = [
      "login",
      "models",
      "tasks",
      "trace",
      "artifacts",
      "settings.keys",
      "settings.agents",
      "tasks.report",
    ];
    for (const id of ids) {
      expect(typeof registry[id]).toBe("function");
    }
  });

  it("placeholder mount functions return a handle with `unmount()`", () => {
    const registry = createScreensRegistry();
    const host = document.createElement("div");
    const handle = registry["tasks.report"]({ root: host });
    expect(typeof handle.unmount).toBe("function");
    handle.unmount();
    // Final-report placeholder cleans up after itself.
    expect(host.children.length).toBe(0);
  });
});

describe("bootstrapWebShell — route → mount wiring", () => {
  it("mounts the right screen on each route via the registry", () => {
    const spies: Record<WebShellScreenId, ScreenSpy> = {
      login: makeScreenSpy("login"),
      models: makeScreenSpy("models"),
      tasks: makeScreenSpy("tasks"),
      trace: makeScreenSpy("trace"),
      artifacts: makeScreenSpy("artifacts"),
      "settings.keys": makeScreenSpy("settings.keys"),
      "settings.agents": makeScreenSpy("settings.agents"),
      "tasks.report": makeScreenSpy("tasks.report"),
    };
    const registry = makeStubRegistry(spies);
    const result = bootstrapWebShell(root, {
      autoStart: false,
      screens: registry,
    });
    expect(result).not.toBeNull();
    if (result === null) return;

    const cases: ReadonlyArray<{
      readonly path: string;
      readonly screenId: WebShellScreenId;
      readonly taskId?: string | undefined;
    }> = [
      { path: "/login", screenId: "login" },
      { path: "/models", screenId: "models" },
      { path: "/tasks", screenId: "tasks" },
      { path: "/tasks/abc/trace", screenId: "trace", taskId: "abc" },
      { path: "/tasks/abc/artifacts", screenId: "artifacts", taskId: "abc" },
      { path: "/tasks/abc/report", screenId: "tasks.report", taskId: "abc" },
      { path: "/settings/keys", screenId: "settings.keys" },
      { path: "/settings/agents", screenId: "settings.agents" },
    ];

    for (const c of cases) {
      const before = spies[c.screenId].invocations.length;
      const match = result.router.dispatch(c.path);
      expect(match.kind).toBe("found");
      const last = spies[c.screenId].invocations[before];
      expect(last).toBeDefined();
      expect(last!.taskId).toBe(c.taskId);
      expect(result.currentScreen()?.screenId).toBe(c.screenId);
    }

    result.dispose();
  });

  it("calls `unmount()` on the previous screen when navigating away", () => {
    const spies: Record<WebShellScreenId, ScreenSpy> = {
      login: makeScreenSpy("login"),
      models: makeScreenSpy("models"),
      tasks: makeScreenSpy("tasks"),
      trace: makeScreenSpy("trace"),
      artifacts: makeScreenSpy("artifacts"),
      "settings.keys": makeScreenSpy("settings.keys"),
      "settings.agents": makeScreenSpy("settings.agents"),
      "tasks.report": makeScreenSpy("tasks.report"),
    };
    const registry = makeStubRegistry(spies);
    const result = bootstrapWebShell(root, {
      autoStart: false,
      screens: registry,
    });
    expect(result).not.toBeNull();
    if (result === null) return;

    result.router.dispatch("/login");
    expect(spies["login"].invocations).toHaveLength(1);
    expect(spies["login"].unmount).not.toHaveBeenCalled();

    // Navigate away — login screen MUST be unmounted.
    result.router.dispatch("/tasks");
    expect(spies["login"].unmount).toHaveBeenCalledTimes(1);
    expect(spies["tasks"].invocations).toHaveLength(1);

    // Another navigation — tasks screen MUST be unmounted in turn.
    result.router.dispatch("/settings/keys");
    expect(spies["tasks"].unmount).toHaveBeenCalledTimes(1);
    expect(spies["settings.keys"].invocations).toHaveLength(1);

    // dispose() unmounts the last active screen.
    result.dispose();
    expect(spies["settings.keys"].unmount).toHaveBeenCalledTimes(1);
  });

  it("does not mount a regular screen when /oauth/callback is active", () => {
    const spies: Record<WebShellScreenId, ScreenSpy> = {
      login: makeScreenSpy("login"),
      models: makeScreenSpy("models"),
      tasks: makeScreenSpy("tasks"),
      trace: makeScreenSpy("trace"),
      artifacts: makeScreenSpy("artifacts"),
      "settings.keys": makeScreenSpy("settings.keys"),
      "settings.agents": makeScreenSpy("settings.agents"),
      "tasks.report": makeScreenSpy("tasks.report"),
    };
    const registry = makeStubRegistry(spies);
    const result = bootstrapWebShell(root, {
      autoStart: false,
      screens: registry,
    });
    expect(result).not.toBeNull();
    if (result === null) return;

    result.router.dispatch("/oauth/callback", "?code=c&state=s");
    expect(result.currentScreen()).toBeNull();
    expect(result.currentOAuthCallbackView()).not.toBeNull();
    for (const spy of Object.values(spies)) {
      expect(spy.invocations).toHaveLength(0);
    }
    result.dispose();
  });

  it("tears down the OAuth callback view when navigating to a regular route", () => {
    const spies: Record<WebShellScreenId, ScreenSpy> = {
      login: makeScreenSpy("login"),
      models: makeScreenSpy("models"),
      tasks: makeScreenSpy("tasks"),
      trace: makeScreenSpy("trace"),
      artifacts: makeScreenSpy("artifacts"),
      "settings.keys": makeScreenSpy("settings.keys"),
      "settings.agents": makeScreenSpy("settings.agents"),
      "tasks.report": makeScreenSpy("tasks.report"),
    };
    const registry = makeStubRegistry(spies);
    const result = bootstrapWebShell(root, {
      autoStart: false,
      screens: registry,
    });
    expect(result).not.toBeNull();
    if (result === null) return;

    result.router.dispatch("/oauth/callback", "?code=c&state=s");
    expect(result.currentOAuthCallbackView()).not.toBeNull();

    result.router.dispatch("/tasks");
    expect(result.currentOAuthCallbackView()).toBeNull();
    expect(spies["tasks"].invocations).toHaveLength(1);

    result.dispose();
  });
});
