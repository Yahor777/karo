/**
 * Tiny client-side router for the Web Shell (task 18.1).
 *
 * Source:
 *   • design.md → "Web Shell" → "Responsibilities":
 *       – web routing;
 *       – OAuth callback handling;
 *       – session cookie usage;
 *       – Web UI shell.
 *   • design.md → "Recommended Repository Structure" → `apps/web/src/shell/`.
 *   • requirements.md → Requirements 1.2, 1.7, 3.1.
 *
 * Design notes:
 *
 *   • Framework-free. Matches the desktop app's "no React" pattern so
 *     the same UI bootstrap can be reused on both surfaces. Real
 *     screens still live in `@ai-agent-orchestrator/shared-ui`; the
 *     router only decides which screen to mount.
 *   • Pattern syntax: `/tasks/:id` — colon-prefixed segments capture
 *     a single path segment. No `*` wildcards, no nested optional
 *     segments — keeping the matcher tiny avoids dragging in `path-to-
 *     regexp` and the associated transitive deps. The five required
 *     routes (`/login`, `/oauth/callback`, `/tasks`, `/tasks/:id`,
 *     `/settings`) all fit this grammar.
 *   • History API is injectable so unit tests can drive navigation
 *     without a DOM. `history.pushState` is preferred over hash routing
 *     because it gives clean URLs that work with the OAuth callback
 *     URL Google validates against.
 *   • The router exposes `start()` / `stop()` separately from
 *     construction so tests can register routes, then drive an initial
 *     `dispatch(path)` without having to touch `popstate`.
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */

import type {
  HistoryLike,
  LocationLike,
  NotFoundHandler,
  PopStateTargetLike,
  QueryParams,
  RouteHandler,
  RouteMatch,
  RouteParams,
} from "./types.js";

/** Internal compiled form of a registered route. */
interface CompiledRoute {
  readonly pattern: string;
  readonly segments: ReadonlyArray<
    | { readonly kind: "static"; readonly value: string }
    | { readonly kind: "param"; readonly name: string }
  >;
  readonly handler: RouteHandler;
}

/** Options for {@link Router}. */
export interface RouterOptions {
  /** History port. Defaults to `globalThis.history` when present. */
  readonly history?: HistoryLike;
  /** Location port. Defaults to `globalThis.location` when present. */
  readonly location?: LocationLike;
  /** Pop-state target. Defaults to `globalThis.window` when present. */
  readonly popStateTarget?: PopStateTargetLike;
  /** Handler for unmatched paths. Defaults to a no-op. */
  readonly onNotFound?: NotFoundHandler;
}

/**
 * The five "core" routes the Web Shell originally served (task 18.1).
 * Kept as a frozen tuple so the foundational routing test (which
 * pins the exact set) remains green even after task 18.2 grew the
 * registered routes to mount additional shared-ui screens.
 *
 * The order matters only for the unit tests' "first-match-wins"
 * documentation — the matcher requires patterns to be unambiguous, so
 * any order produces the same result.
 */
export const WEB_SHELL_ROUTES = Object.freeze([
  "/login",
  "/oauth/callback",
  "/tasks",
  "/tasks/:id",
  "/settings",
] as const);

/**
 * Full route table the Web Shell registers in production (task 18.2).
 *
 * Mirrors `apps/web/src/shell/screens/screensRegistry.ts` 1:1. Each
 * route maps to one shared-ui screen mount; tests pin this to the
 * registry to prevent the table and the screen wiring from drifting.
 *
 *   • `/login`                    — login screen
 *   • `/oauth/callback`           — OAuth callback view (task 17.4)
 *   • `/models`                   — Model selection screen
 *   • `/tasks`                    — Task Builder screen
 *   • `/tasks/:id/trace`          — Agent_Trace panel
 *   • `/tasks/:id/artifacts`      — File_Artifact viewer
 *   • `/tasks/:id/report`         — Final_Report placeholder
 *   • `/settings/keys`            — Provider / API-key management
 *   • `/settings/agents`          — Custom agents editor
 */
export const WEB_SHELL_SCREEN_ROUTES = Object.freeze([
  "/login",
  "/oauth/callback",
  "/models",
  "/tasks",
  "/tasks/:id/trace",
  "/tasks/:id/artifacts",
  "/tasks/:id/report",
  "/settings/keys",
  "/settings/agents",
] as const);

/**
 * Tiny pattern → segment compiler. Throws on malformed patterns at
 * registration time so misconfiguration cannot survive to runtime.
 */
function compilePattern(pattern: string): CompiledRoute["segments"] {
  if (pattern.length === 0 || pattern[0] !== "/") {
    throw new Error(`Router: pattern must start with '/': ${pattern}`);
  }
  // Drop a trailing slash on multi-segment patterns so `/tasks/` and
  // `/tasks` produce the same compiled form. `/` itself is preserved.
  const trimmed =
    pattern.length > 1 && pattern.endsWith("/")
      ? pattern.slice(0, -1)
      : pattern;
  if (trimmed === "/") {
    return [];
  }
  const parts = trimmed.slice(1).split("/");
  return parts.map((part) => {
    if (part.length === 0) {
      throw new Error(`Router: empty segment in pattern: ${pattern}`);
    }
    if (part[0] === ":") {
      const name = part.slice(1);
      if (name.length === 0) {
        throw new Error(
          `Router: param segment must have a name: ${pattern}`,
        );
      }
      return { kind: "param", name };
    }
    return { kind: "static", value: part };
  });
}

/**
 * Splits an incoming path (without query) into normalised segments.
 * Trailing slashes are dropped; empty segments are dropped (handles
 * accidental `//` from join logic).
 */
function splitPath(path: string): string[] {
  const noQuery = path.split("?", 1)[0] ?? "";
  // Strip leading and trailing slashes, then split. `""` → `[""]` so
  // we filter empties.
  return noQuery
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s.length > 0);
}

/**
 * Parses the query string into a flat object. Repeated keys keep the
 * last value (matches `URLSearchParams.get` semantics). The web shell
 * does not need multi-value query support for OAuth, tasks or
 * settings.
 */
function parseQuery(search: string): QueryParams {
  if (search.length === 0 || search === "?") {
    return Object.freeze({});
  }
  const trimmed = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * Matches a path against a compiled route. Returns the captured params
 * on success or `null` on miss.
 */
function matchSegments(
  segments: CompiledRoute["segments"],
  parts: string[],
): RouteParams | null {
  if (segments.length !== parts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const part = parts[i]!;
    if (seg.kind === "static") {
      if (seg.value !== part) {
        return null;
      }
    } else {
      // URL-decode captured params so `/tasks/abc%20def` produces
      // `{ id: "abc def" }`.
      try {
        params[seg.name] = decodeURIComponent(part);
      } catch {
        // Malformed percent-encoding — leave as-is rather than crash.
        params[seg.name] = part;
      }
    }
  }
  return Object.freeze(params);
}

/**
 * Tiny client-side router. Registers handlers per pattern and resolves
 * the current location on `start()`/`navigate()`/`popstate`.
 */
export class Router {
  private readonly routes: CompiledRoute[] = [];
  private readonly history: HistoryLike | undefined;
  private readonly location: LocationLike | undefined;
  private readonly popStateTarget: PopStateTargetLike | undefined;
  private readonly onNotFound: NotFoundHandler;
  private started = false;
  // Bound listener so we can remove it in `stop()`.
  private readonly popStateListener = (): void => {
    this.dispatchCurrent();
  };

  public constructor(options: RouterOptions = {}) {
    this.history = options.history ?? readGlobalHistory();
    this.location = options.location ?? readGlobalLocation();
    this.popStateTarget =
      options.popStateTarget ?? readGlobalPopStateTarget();
    this.onNotFound = options.onNotFound ?? ((): void => {});
  }

  /** Registers a handler for `pattern`. Throws on duplicate patterns. */
  public on(pattern: string, handler: RouteHandler): void {
    const segments = compilePattern(pattern);
    if (this.routes.some((r) => r.pattern === pattern)) {
      throw new Error(`Router: pattern already registered: ${pattern}`);
    }
    this.routes.push({ pattern, segments, handler });
  }

  /**
   * Resolves `path` against the registered routes WITHOUT side
   * effects. Useful for tests and for server-side rendering choices.
   */
  public resolve(path: string, search = ""): RouteMatch {
    const parts = splitPath(path);
    const query = parseQuery(search);
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (params !== null) {
        return Object.freeze({
          kind: "found" as const,
          pattern: route.pattern,
          path,
          params,
          query,
        });
      }
    }
    return Object.freeze({ kind: "not_found" as const, path, query });
  }

  /**
   * Resolves `path` and runs the matching handler (or `onNotFound`).
   * Does NOT change the address bar — call {@link navigate} for that.
   */
  public dispatch(path: string, search = ""): RouteMatch {
    const match = this.resolve(path, search);
    this.runMatch(match);
    return match;
  }

  /**
   * Pushes `path` (and optional `search`) onto the history stack and
   * dispatches the matching handler.
   */
  public navigate(path: string, search = ""): RouteMatch {
    const url = search.length > 0 ? `${path}${ensureLeadingQuestion(search)}` : path;
    if (this.history) {
      this.history.pushState({}, "", url);
    }
    return this.dispatch(path, search);
  }

  /**
   * Replaces the current entry with `path` (used after OAuth callback
   * to drop `?code=...&state=...` from the URL).
   */
  public replace(path: string, search = ""): RouteMatch {
    const url = search.length > 0 ? `${path}${ensureLeadingQuestion(search)}` : path;
    if (this.history) {
      this.history.replaceState({}, "", url);
    }
    return this.dispatch(path, search);
  }

  /**
   * Wires the popstate listener and dispatches the current location.
   * Idempotent: a second call is a no-op.
   */
  public start(): RouteMatch | null {
    if (this.started) {
      return null;
    }
    this.started = true;
    if (this.popStateTarget) {
      this.popStateTarget.addEventListener(
        "popstate",
        this.popStateListener,
      );
    }
    return this.dispatchCurrent();
  }

  /** Removes the popstate listener. Idempotent. */
  public stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.popStateTarget) {
      this.popStateTarget.removeEventListener(
        "popstate",
        this.popStateListener,
      );
    }
  }

  /**
   * Dispatches whatever path the injected `Location` currently
   * reports. Returns `null` when no location is available (e.g. SSR).
   */
  private dispatchCurrent(): RouteMatch | null {
    if (!this.location) {
      return null;
    }
    return this.dispatch(this.location.pathname, this.location.search);
  }

  private runMatch(match: RouteMatch): void {
    if (match.kind === "found") {
      const handler = this.routes.find((r) => r.pattern === match.pattern);
      handler?.handler(match);
    } else {
      this.onNotFound(match);
    }
  }
}

function readGlobalHistory(): HistoryLike | undefined {
  return typeof globalThis !== "undefined" &&
    "history" in globalThis &&
    (globalThis as { history?: unknown }).history
    ? ((globalThis as { history: HistoryLike }).history)
    : undefined;
}

function readGlobalLocation(): LocationLike | undefined {
  return typeof globalThis !== "undefined" &&
    "location" in globalThis &&
    (globalThis as { location?: unknown }).location
    ? ((globalThis as { location: LocationLike }).location)
    : undefined;
}

function readGlobalPopStateTarget(): PopStateTargetLike | undefined {
  return typeof globalThis !== "undefined" &&
    "addEventListener" in globalThis &&
    typeof (globalThis as { addEventListener?: unknown }).addEventListener ===
      "function"
    ? (globalThis)
    : undefined;
}

function ensureLeadingQuestion(search: string): string {
  return search.startsWith("?") ? search : `?${search}`;
}
