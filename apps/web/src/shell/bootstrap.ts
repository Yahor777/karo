/**
 * Web Shell renderer bootstrap (tasks 18.1 + 18.2).
 *
 * Source:
 *   • design.md → "Web Shell" → "Responsibilities":
 *       – web routing, OAuth callback handling, session cookie usage.
 *   • design.md → "Components and Interfaces" → "Shared UI Components" /
 *     "Client SDK" — the web shell mounts shared-ui screens through
 *     gateway adapters; placeholder adapters live in
 *     `./screens/placeholderGateways.ts` until the Client SDK
 *     transports land in a follow-up wave.
 *   • requirements.md → Requirements 1.2, 1.7, 3.1, 11.8.
 *
 * This module mounts the web-shell layout into the supplied root and
 * wires the {@link Router} to the screen registry built by
 * {@link createScreensRegistry}. Each route resolves to one
 * shared-ui screen mount; navigating away tears the previous mount
 * down via `WebShellScreenHandle.unmount()`. The OAuth callback
 * route is handled separately by {@link mountOAuthCallbackView}
 * (task 17.4).
 *
 * Layout:
 *
 *   ┌──────────────────────── Header (title) ──────────────────────┐
 *   │                                                              │
 *   │  Top-bar nav: /login · /tasks · /settings/keys · /settings/agents │
 *   │                                                              │
 *   ├──────────────────────────── Main ────────────────────────────┤
 *   │  <screen mount goes here>                                    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Validates: Requirements 1.2, 1.7, 3.1, 11.8.
 */

import { Router, WEB_SHELL_SCREEN_ROUTES, type RouterOptions } from "./router.js";
import { SESSION_COOKIE_NAME } from "./sessionCookie.js";
import {
  mountOAuthCallbackView,
  parseOAuthCallbackParams,
  type MountOAuthCallbackViewOptions,
  type MountOAuthCallbackViewResult,
} from "./oauthCallbackView.js";
import {
  createScreensRegistry,
  type CreateScreensRegistryOptions,
  type WebShellScreenHandle,
  type WebShellScreenId,
  type WebShellScreensRegistry,
} from "./screens/screensRegistry.js";
import type { TaskId } from "@ai-agent-orchestrator/shared-core";

/** Options for {@link bootstrapWebShell}. */
export interface BootstrapWebShellOptions {
  /**
   * Router options forwarded to the {@link Router} constructor. The
   * default values pick up `globalThis.history` / `globalThis.location`
   * / `globalThis.window` automatically; tests pass stubs.
   */
  readonly routerOptions?: RouterOptions;
  /**
   * Optional override for `document.cookie`-style reads. Defaults to
   * the global `document.cookie` when present; tests can pass a
   * function returning a fixed string.
   */
  readonly readCookieHeader?: () => string | null;
  /**
   * Whether to call `router.start()` automatically. Defaults to `true`
   * so the bootstrap "just works" in production. Tests may want to
   * register routes, then call `router.start()` themselves so they can
   * assert against a known initial path.
   */
  readonly autoStart?: boolean;
  /**
   * Options forwarded to {@link mountOAuthCallbackView} when the user
   * lands on the `/oauth/callback` route (task 17.4). Tests pass
   * stub gateways here so they can drive the gmail screen + upgrade
   * screen end-to-end.
   */
  readonly oauthCallbackOptions?: Omit<
    MountOAuthCallbackViewOptions,
    "callback" | "doc"
  >;
  /**
   * Optional override for the screen registry. Production code
   * defaults to {@link createScreensRegistry} with the placeholder
   * gateways; tests use this to swap in stubbed mounts so they can
   * assert routing behaviour without rendering real DOM.
   */
  readonly screens?: WebShellScreensRegistry;
  /**
   * Forwarded to {@link createScreensRegistry} when {@link screens}
   * is omitted. Lets callers tweak the placeholder scope without
   * having to rebuild the entire registry.
   */
  readonly screensOptions?: CreateScreensRegistryOptions;
}

/** Result of {@link bootstrapWebShell}. */
export interface BootstrapWebShellResult {
  /** The wired router. */
  readonly router: Router;
  /**
   * Returns `true` if the renderer can see the session cookie.
   *
   * Note: `__Host-aiao_session` is `HttpOnly`, so this check returns
   * `true` only on intentionally non-HttpOnly deployments (tests or
   * misconfigured environments). The function is exposed so the
   * landing page can show "you appear to be logged in" / "please
   * sign in" cues without the renderer reaching into the cookie value.
   */
  readonly hasSessionCookie: () => boolean;
  /**
   * Currently-mounted OAuth callback view (task 17.4), if the
   * `/oauth/callback` route is the active one. Tests use this to
   * drive the gmail screen + upgrade screen directly.
   */
  readonly currentOAuthCallbackView: () => MountOAuthCallbackViewResult | null;
  /**
   * The active screen handle (task 18.2), or `null` when none is
   * mounted (e.g. when the user is on `/oauth/callback`, the
   * not-found surface, or has just navigated away). Exposed so the
   * `screensRegistry.test.ts` integration test can assert that
   * `unmount()` runs when the route changes.
   */
  readonly currentScreen: () => {
    readonly screenId: WebShellScreenId;
    readonly handle: WebShellScreenHandle;
  } | null;
  /** Tear down the router (removes `popstate` listener). */
  readonly dispose: () => void;
}

/**
 * Mounts the web-shell layout into `root`, wires the router to the
 * shared-ui screen registry, and returns a handful of helpers tests
 * can use to assert behaviour.
 *
 * Returns `null` when `root` is `null` — same convention as the
 * desktop bootstrap (`apps/desktop-windows/src/ui/bootstrap.ts`).
 */
export function bootstrapWebShell(
  root: HTMLElement | null,
  options: BootstrapWebShellOptions = {},
): BootstrapWebShellResult | null {
  if (root === null) {
    return null;
  }

  root.innerHTML = "";

  // -- Header + top-bar nav ----------------------------------------------
  const header = document.createElement("header");
  header.className = "web-shell-header";
  const title = document.createElement("h1");
  title.textContent = "AI Agent Orchestrator (Web)";
  header.appendChild(title);

  const nav = document.createElement("nav");
  nav.className = "web-shell-nav";
  nav.setAttribute("aria-label", "Main");
  header.appendChild(nav);
  root.appendChild(header);

  const main = document.createElement("main");
  main.className = "web-shell-main";
  root.appendChild(main);

  const status = document.createElement("p");
  status.className = "web-shell-status";
  status.setAttribute("aria-live", "polite");
  root.appendChild(status);

  const router = new Router(options.routerOptions ?? {});

  // -- Top-bar nav links -------------------------------------------------
  // Plain anchors; click handlers route through `router.navigate(...)` so
  // the address bar stays in sync without a full reload.
  const NAV_ITEMS: ReadonlyArray<{ readonly href: string; readonly label: string }> = [
    { href: "/login", label: "Sign in" },
    { href: "/tasks", label: "Tasks" },
    { href: "/settings/keys", label: "API keys" },
    { href: "/settings/agents", label: "Custom agents" },
  ];
  for (const item of NAV_ITEMS) {
    const link = document.createElement("a");
    link.className = "web-shell-nav__link";
    link.href = item.href;
    link.textContent = item.label;
    link.dataset["href"] = item.href;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      router.navigate(item.href);
    });
    nav.appendChild(link);
  }

  // -- Screen registry ---------------------------------------------------
  const screens =
    options.screens ?? createScreensRegistry(options.screensOptions ?? {});

  let activeScreen:
    | { readonly screenId: WebShellScreenId; readonly handle: WebShellScreenHandle }
    | null = null;
  let oauthCallbackView: MountOAuthCallbackViewResult | null = null;

  const tearDownActiveScreen = (): void => {
    if (activeScreen !== null) {
      try {
        activeScreen.handle.unmount();
      } catch {
        // Mount teardown errors must never propagate into router
        // glue — they are non-fatal and drop the renderer into a
        // broken state if rethrown. The screen author is expected
        // to log internally if something is genuinely wrong.
      }
      activeScreen = null;
    }
    main.innerHTML = "";
  };

  const tearDownOAuthCallbackView = (): void => {
    if (oauthCallbackView !== null) {
      oauthCallbackView.unmount();
      oauthCallbackView = null;
    }
    main.innerHTML = "";
  };

  /**
   * Mounts a screen by id into the main pane. Tears down whatever
   * was previously mounted (regular screen or OAuth callback view)
   * before mounting the next one.
   */
  const mountScreen = (
    screenId: WebShellScreenId,
    extras: { readonly taskId?: TaskId } = {},
  ): void => {
    tearDownActiveScreen();
    tearDownOAuthCallbackView();
    main.dataset["route"] = screenId;
    const mount = screens[screenId];
    const handle = mount({
      root: main,
      ...(extras.taskId !== undefined ? { taskId: extras.taskId } : {}),
    });
    activeScreen = { screenId, handle };
  };

  // -- Route handlers ----------------------------------------------------

  router.on("/login", () => {
    mountScreen("login");
  });

  router.on("/oauth/callback", (match) => {
    tearDownActiveScreen();
    main.innerHTML = "";
    const heading = document.createElement("h2");
    heading.textContent = "Completing Google sign-in";
    main.appendChild(heading);
    const container = document.createElement("section");
    container.className = "oauth-callback-view";
    main.appendChild(container);
    main.dataset["route"] = "/oauth/callback";

    tearDownOAuthCallbackView();
    const search = options.routerOptions?.location?.search ??
      (typeof globalThis !== "undefined" &&
      "location" in globalThis &&
      (globalThis as { location?: { search?: string } }).location
        ? ((globalThis as { location: { search: string } }).location.search)
        : undefined);
    const fromQuery = parseOAuthCallbackParams(search ?? "");
    const fromMatch = parseOAuthCallbackParams(buildSearchFromQuery(match.query));
    const callback = fromQuery ?? fromMatch ?? null;

    const viewOptions: MountOAuthCallbackViewOptions = {
      ...(options.oauthCallbackOptions ?? {}),
      ...(callback ? { callback } : {}),
    };
    oauthCallbackView = mountOAuthCallbackView(container, viewOptions);
  });

  router.on("/models", () => {
    mountScreen("models");
  });

  router.on("/tasks", () => {
    mountScreen("tasks");
  });

  router.on("/tasks/:id/trace", (match) => {
    mountScreen("trace", { taskId: match.params["id"] ?? "" });
  });

  router.on("/tasks/:id/artifacts", (match) => {
    mountScreen("artifacts", { taskId: match.params["id"] ?? "" });
  });

  router.on("/tasks/:id/report", (match) => {
    mountScreen("tasks.report", { taskId: match.params["id"] ?? "" });
  });

  router.on("/settings/keys", () => {
    mountScreen("settings.keys");
  });

  router.on("/settings/agents", () => {
    mountScreen("settings.agents");
  });

  // Keep a record on the dataset so callers (and tests) can see which
  // routes the bootstrap registered without re-reading the source.
  root.dataset["registeredRoutes"] = WEB_SHELL_SCREEN_ROUTES.join(",");

  const readCookieHeader =
    options.readCookieHeader ??
    ((): string | null => {
      if (typeof document !== "undefined" && typeof document.cookie === "string") {
        return document.cookie;
      }
      return null;
    });

  const hasSessionCookie = (): boolean => {
    const header = readCookieHeader();
    if (!header) return false;
    return header.split(";").some((piece) => {
      const trimmed = piece.trim();
      return trimmed.startsWith(`${SESSION_COOKIE_NAME}=`);
    });
  };

  if (options.autoStart !== false) {
    router.start();
  }

  // Brief status message so users land on something sensible before
  // the screen mounts pick up.
  status.textContent = hasSessionCookie()
    ? "Session active."
    : "Sign in to continue.";

  return {
    router,
    hasSessionCookie,
    currentOAuthCallbackView: () => oauthCallbackView,
    currentScreen: () => activeScreen,
    dispose: () => {
      tearDownActiveScreen();
      tearDownOAuthCallbackView();
      router.stop();
    },
  };
}

/**
 * Reconstructs an OAuth-callback search string from the router's
 * captured `query` map. Used by the `/oauth/callback` handler when no
 * direct `Location` is available (tests inject a custom `Location`
 * that the router uses; we mirror its parsing here so the screen
 * receives the same params).
 */
function buildSearchFromQuery(
  query: Readonly<Record<string, string>>,
): string {
  const code = query["code"];
  const state = query["state"];
  if (!code || !state) return "";
  const params = new URLSearchParams();
  params.set("code", code);
  params.set("state", state);
  return `?${params.toString()}`;
}
