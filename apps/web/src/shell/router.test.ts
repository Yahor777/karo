/**
 * Unit tests for the Web Shell router (task 18.1).
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 *
 * The router must:
 *   • register the five required Web Shell routes;
 *   • match `/tasks/:id` and capture the param;
 *   • parse query strings into a flat object;
 *   • reject malformed patterns at registration time;
 *   • route through `dispatch`/`navigate`/`replace` without DOM access;
 *   • dispatch on `popstate` once `start()` is called.
 */

import { describe, expect, it, vi } from "vitest";

import { Router, WEB_SHELL_ROUTES } from "./router.js";
import type {
  HistoryLike,
  LocationLike,
  PopStateTargetLike,
  RouteMatch,
} from "./types.js";

interface StubHistoryEntry {
  readonly state: unknown;
  readonly url: string;
  readonly mode: "push" | "replace";
}

function makeStubHistory(): HistoryLike & { entries: StubHistoryEntry[] } {
  const entries: StubHistoryEntry[] = [];
  return {
    entries,
    pushState(state, _unused, url) {
      entries.push({ state, url, mode: "push" });
    },
    replaceState(state, _unused, url) {
      entries.push({ state, url, mode: "replace" });
    },
  };
}

function makeStubLocation(pathname: string, search = ""): LocationLike {
  return { pathname, search };
}

function makeStubPopStateTarget(): PopStateTargetLike & {
  fire: () => void;
  listenerCount: () => number;
} {
  const listeners: Array<() => void> = [];
  return {
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    removeEventListener(_type, listener) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire() {
      for (const l of listeners) l();
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

describe("WEB_SHELL_ROUTES", () => {
  it("includes the five routes required by the design", () => {
    expect(WEB_SHELL_ROUTES).toEqual([
      "/login",
      "/oauth/callback",
      "/tasks",
      "/tasks/:id",
      "/settings",
    ]);
  });
});

describe("Router.resolve", () => {
  function makeRouter(): Router {
    const router = new Router();
    for (const pattern of WEB_SHELL_ROUTES) {
      router.on(pattern, () => {});
    }
    return router;
  }

  it("matches static routes", () => {
    const router = makeRouter();
    const match = router.resolve("/login");
    expect(match.kind).toBe("found");
    if (match.kind === "found") {
      expect(match.pattern).toBe("/login");
      expect(match.params).toEqual({});
    }
  });

  it("matches multi-segment static routes", () => {
    const router = makeRouter();
    const match = router.resolve("/oauth/callback");
    expect(match.kind).toBe("found");
    if (match.kind === "found") {
      expect(match.pattern).toBe("/oauth/callback");
    }
  });

  it("captures path params for /tasks/:id", () => {
    const router = makeRouter();
    const match = router.resolve("/tasks/abc123");
    expect(match.kind).toBe("found");
    if (match.kind === "found") {
      expect(match.pattern).toBe("/tasks/:id");
      expect(match.params).toEqual({ id: "abc123" });
    }
  });

  it("URL-decodes captured params", () => {
    const router = makeRouter();
    const match = router.resolve("/tasks/abc%20def");
    expect(match.kind).toBe("found");
    if (match.kind === "found") {
      expect(match.params).toEqual({ id: "abc def" });
    }
  });

  it("parses query string", () => {
    const router = makeRouter();
    const match = router.resolve("/oauth/callback", "?code=foo&state=bar");
    expect(match.kind).toBe("found");
    if (match.kind === "found") {
      expect(match.query).toEqual({ code: "foo", state: "bar" });
    }
  });

  it("returns not_found for unregistered paths", () => {
    const router = makeRouter();
    const match = router.resolve("/no/such/route");
    expect(match.kind).toBe("not_found");
  });

  it("treats trailing slashes as equivalent", () => {
    const router = makeRouter();
    expect(router.resolve("/tasks/").kind).toBe("found");
    expect(router.resolve("/tasks").kind).toBe("found");
  });

  it("does not match /tasks against /tasks/:id (segment count differs)", () => {
    const router = new Router();
    router.on("/tasks/:id", () => {});
    expect(router.resolve("/tasks").kind).toBe("not_found");
  });
});

describe("Router pattern compilation", () => {
  it("rejects patterns that do not start with '/'", () => {
    const router = new Router();
    expect(() => router.on("login", () => {})).toThrow(/must start with/);
  });

  it("rejects empty param names", () => {
    const router = new Router();
    expect(() => router.on("/tasks/:", () => {})).toThrow(
      /param segment must have a name/,
    );
  });

  it("rejects duplicate pattern registration", () => {
    const router = new Router();
    router.on("/login", () => {});
    expect(() => router.on("/login", () => {})).toThrow(/already registered/);
  });
});

describe("Router.dispatch", () => {
  it("invokes the handler with the captured params", () => {
    const router = new Router();
    const handler = vi.fn();
    router.on("/tasks/:id", handler);
    router.dispatch("/tasks/42");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "found",
        params: { id: "42" },
      }),
    );
  });

  it("invokes onNotFound when no route matches", () => {
    const onNotFound = vi.fn();
    const router = new Router({ onNotFound });
    router.on("/login", () => {});
    router.dispatch("/whatever");
    expect(onNotFound).toHaveBeenCalledTimes(1);
    const arg = onNotFound.mock.calls[0]![0] as RouteMatch;
    expect(arg.kind).toBe("not_found");
  });
});

describe("Router.navigate / replace", () => {
  it("pushes onto history and dispatches", () => {
    const history = makeStubHistory();
    const router = new Router({ history });
    const handler = vi.fn();
    router.on("/tasks/:id", handler);

    router.navigate("/tasks/7", "?from=email");

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.mode).toBe("push");
    expect(history.entries[0]!.url).toBe("/tasks/7?from=email");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replaces the current entry without adding to history", () => {
    const history = makeStubHistory();
    const router = new Router({ history });
    const handler = vi.fn();
    router.on("/tasks", handler);

    router.replace("/tasks");

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.mode).toBe("replace");
    expect(history.entries[0]!.url).toBe("/tasks");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ensures the leading '?' on the URL even when caller omits it", () => {
    const history = makeStubHistory();
    const router = new Router({ history });
    router.on("/oauth/callback", () => {});
    router.navigate("/oauth/callback", "code=x&state=y");
    expect(history.entries[0]!.url).toBe("/oauth/callback?code=x&state=y");
  });
});

describe("Router.start / popstate", () => {
  it("dispatches the current location on start", () => {
    const history = makeStubHistory();
    const location = makeStubLocation("/settings");
    const popStateTarget = makeStubPopStateTarget();
    const router = new Router({ history, location, popStateTarget });

    const settings = vi.fn();
    router.on("/settings", settings);

    const initial = router.start();
    expect(initial?.kind).toBe("found");
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("re-dispatches on popstate", () => {
    const history = makeStubHistory();
    const location: { pathname: string; search: string } = {
      pathname: "/tasks",
      search: "",
    };
    const popStateTarget = makeStubPopStateTarget();
    const router = new Router({ history, location, popStateTarget });

    const tasks = vi.fn();
    const settings = vi.fn();
    router.on("/tasks", tasks);
    router.on("/settings", settings);

    router.start();
    expect(tasks).toHaveBeenCalledTimes(1);

    // Simulate the user navigating via the address bar / back button.
    location.pathname = "/settings";
    popStateTarget.fire();

    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("stop() removes the popstate listener", () => {
    const popStateTarget = makeStubPopStateTarget();
    const router = new Router({
      history: makeStubHistory(),
      location: makeStubLocation("/tasks"),
      popStateTarget,
    });
    router.on("/tasks", () => {});
    router.start();
    expect(popStateTarget.listenerCount()).toBe(1);
    router.stop();
    expect(popStateTarget.listenerCount()).toBe(0);
  });
});
