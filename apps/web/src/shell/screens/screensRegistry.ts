/**
 * Web Shell screen registry (task 18.2).
 *
 * Source:
 *   • design.md → "Web Shell" → "Responsibilities":
 *       – web routing;
 *       – Web UI shell that reuses Shared UI components.
 *   • design.md → "Recommended Repository Structure" → `apps/web/src/shell/`.
 *   • design.md → "Components and Interfaces" → "Client SDK" — the
 *     Client SDK is wired through the renderer into each gateway port
 *     consumed by the shared-ui screens. Until the SDK ships HTTP
 *     transports, the placeholder adapters in
 *     `./placeholderGateways.ts` keep every screen mountable.
 *   • requirements.md → Requirements 1.7, 11.8.
 *
 * What this module owns:
 *
 *   • {@link WebShellScreenId}       — stable identifier per route.
 *   • {@link WebShellScreenMount}    — per-screen mount function shape.
 *   • {@link WebShellScreenHandle}   — return value of a mount, exposing
 *     `unmount()`.
 *   • {@link createScreensRegistry}  — produces a registry where each
 *     screen id resolves to the matching mount function. The router
 *     (`bootstrap.ts`) calls these on route entry and tears the
 *     previous mount down on route change.
 *
 * Why a registry rather than inline router callbacks?
 *
 *   • The unit test in `screensRegistry.test.ts` pins each route to
 *     the right mount function and asserts that `unmount()` runs on
 *     navigation away — without needing to spin up the whole
 *     bootstrap. Keeping the registry as data lets us assert it
 *     directly.
 *   • The same registry can be reused by future host integrations
 *     (e.g. a server-side renderer that wants to know which screen
 *     is active) without touching the router glue.
 *
 * Validates: Requirements 1.7, 11.8.
 */

import {
  AgentTraceController,
  GmailLoginScreen as _GmailLoginScreenSentinel,
  LoginScreen,
  ModelSelectionController,
  TaskBuilderController,
  createArtifactViewerController,
  createCustomAgentsController,
  createProviderKeysController,
  mountAgentTracePanel,
  mountArtifactViewer,
  mountCustomAgentsScreen,
  mountLoginScreen,
  mountModelSelection,
  mountProviderKeysScreen,
  mountTaskBuilderScreen,
  type AgentPickerOption,
  type ProviderModelsResult,
} from "@ai-agent-orchestrator/shared-ui";
import type { Scope, TaskId } from "@ai-agent-orchestrator/shared-core";

import {
  PLACEHOLDER_ARTIFACT_ID,
  PLACEHOLDER_TASK_ID,
  createPlaceholderArtifactGateway,
  createPlaceholderCustomAgentsGateway,
  createPlaceholderModelCatalogGateway,
  createPlaceholderProviderKeysGateway,
  createPlaceholderTaskBuilderGateway,
  createPlaceholderTraceStreamGateway,
  placeholderLoginGateway,
  placeholderProviderKeysAuthGateway,
} from "./placeholderGateways.js";

// `_GmailLoginScreenSentinel` is imported only so that consumers who
// look at this module for the full set of screens can see, at a
// glance, that the Gmail login surface is owned by `oauthCallbackView`
// (see the `/oauth/callback` route in `bootstrap.ts`) rather than
// re-mounted under `/login`. The reference is otherwise unused.
void _GmailLoginScreenSentinel;

/**
 * Stable screen identifiers. Mirrors the route table the router
 * registers — keeping the names declarative makes it easier for
 * reviewers to tell at a glance which route maps to which shared-ui
 * screen.
 */
export type WebShellScreenId =
  | "login"
  | "models"
  | "tasks"
  | "trace"
  | "artifacts"
  | "settings.keys"
  | "settings.agents"
  | "tasks.report";

/**
 * Per-screen mount input. Routes that capture a `:id` segment receive
 * the captured value; routes that don't ignore the field.
 */
export interface WebShellScreenMountInput {
  readonly root: HTMLElement;
  readonly taskId?: TaskId | undefined;
}

/** Handle returned by every screen mount. */
export interface WebShellScreenHandle {
  unmount(): void;
}

/** Mount function shape. */
export type WebShellScreenMount = (
  input: WebShellScreenMountInput,
) => WebShellScreenHandle;

/**
 * Map of screen id → mount function. Frozen so router glue cannot
 * accidentally swap entries at runtime.
 */
export type WebShellScreensRegistry = Readonly<
  Record<WebShellScreenId, WebShellScreenMount>
>;

/**
 * Options for {@link createScreensRegistry}. All fields are optional —
 * tests can stub individual mounts to keep their assertions tight,
 * production code defaults to the placeholder gateways defined in
 * `placeholderGateways.ts`.
 */
export interface CreateScreensRegistryOptions {
  /**
   * Scope passed into screens that need it (model selection, settings).
   * Defaults to a synthetic web-only scope mirroring the convention used
   * in `oauthCallbackView.ts` for the upgrade screen.
   */
  readonly scope?: Scope;
  /**
   * Optional override for the entire registry. When a test only wants
   * to assert routing, it can pass stubbed mounts here.
   */
  readonly overrides?: Partial<WebShellScreensRegistry>;
}

/**
 * The web shell does not own a local device id by design (the local
 * encrypted storage is desktop-only). A synthetic placeholder lets
 * the screens that take a `Scope` mount end-to-end during the
 * placeholder phase. Mirrors the convention used by the OAuth
 * callback view.
 */
const DEFAULT_WEB_SCOPE: Scope = {
  kind: "local",
  deviceId: "web-no-local-scope",
};

/**
 * The five Builtin_Agent roles the Task Builder picker offers in
 * Manual_Mode. Mirrors design.md → "Agent Runtime" → "Builtin agent
 * permissions" so reviewers can spot the coverage at a glance.
 */
const BUILTIN_AGENT_OPTIONS: readonly AgentPickerOption[] = [
  {
    id: "researcher",
    displayName: "Researcher",
    description: "Enriches the prompt with web research.",
  },
  {
    id: "coder",
    displayName: "Coder",
    description: "Writes code from the enriched prompt.",
  },
  {
    id: "reviewer",
    displayName: "Reviewer",
    description: "Checks the artifact for defects.",
  },
  {
    id: "fixer",
    displayName: "Fixer",
    description: "Applies Reviewer's defects to the artifact.",
  },
  {
    id: "boss",
    displayName: "Boss",
    description: "Decides whether the result matches the prompt.",
  },
];

/**
 * Builds the screen registry. Each entry returns a {@link WebShellScreenHandle}
 * the router can call `unmount()` on when the user navigates away.
 */
export function createScreensRegistry(
  options: CreateScreensRegistryOptions = {},
): WebShellScreensRegistry {
  const scope = options.scope ?? DEFAULT_WEB_SCOPE;

  const registry: WebShellScreensRegistry = Object.freeze({
    login: ({ root }) => {
      const controller = new LoginScreen({ gateway: placeholderLoginGateway });
      const mount = mountLoginScreen(root, controller);
      return {
        unmount: () => {
          mount.unmount();
        },
      };
    },

    models: ({ root }) => {
      const controller = new ModelSelectionController({
        gateway: createPlaceholderModelCatalogGateway(),
        scope,
      });
      const teardown = mountModelSelection(root, controller);
      // Kick off an initial refresh so the catalog renders without the
      // user having to press the button. Fire-and-forget on purpose —
      // the controller surfaces failures into its own state.
      void controller.refresh();
      return { unmount: teardown };
    },

    tasks: ({ root }) => {
      // The model catalog is composed (not imported) into the Task
      // Builder per its design — we hand it the same static snapshot
      // the placeholder catalog gateway returns so both screens stay
      // consistent during the placeholder phase.
      const availableModels: readonly ProviderModelsResult[] = [
        {
          provider: "openai",
          status: "ok",
          models: [
            {
              provider: "openai",
              modelId: "gpt-4o-mini",
              displayName: "GPT-4o mini",
              source: "user-api-key",
              qualityTier: "standard",
            },
          ],
        },
        {
          provider: "anthropic",
          status: "ok",
          models: [
            {
              provider: "anthropic",
              modelId: "claude-3-5-haiku",
              displayName: "Claude 3.5 Haiku",
              source: "user-api-key",
              qualityTier: "standard",
            },
          ],
        },
      ];
      const controller = new TaskBuilderController({
        gateway: createPlaceholderTaskBuilderGateway(),
      });
      const result = mountTaskBuilderScreen({
        root,
        controller,
        availableModels,
        availableAgents: BUILTIN_AGENT_OPTIONS,
      });
      return {
        unmount: () => {
          result.unmount();
        },
      };
    },

    trace: ({ root, taskId }) => {
      const controller = new AgentTraceController({
        taskId: taskId ?? PLACEHOLDER_TASK_ID,
        gateway: createPlaceholderTraceStreamGateway(),
      });
      const teardown = mountAgentTracePanel({ root, controller });
      // Fire-and-forget: the consume loop never rejects (per
      // AgentTraceController design), and stop is handled by the
      // returned `unmount`.
      void controller.start();
      return {
        unmount: () => {
          teardown();
          controller.dispose();
        },
      };
    },

    artifacts: ({ root, taskId }) => {
      const controller = createArtifactViewerController({
        gateway: createPlaceholderArtifactGateway(),
        taskId: taskId ?? PLACEHOLDER_TASK_ID,
      });
      const teardown = mountArtifactViewer({ root, controller });
      // Initial listing + auto-select the placeholder artifact so the
      // user lands on something interesting. Selection NEVER opens a
      // diff (Requirement 11.5) — that still requires the explicit
      // "Compare versions" button.
      void controller
        .refresh()
        .then(() => controller.selectArtifact(PLACEHOLDER_ARTIFACT_ID));
      return { unmount: teardown };
    },

    "settings.keys": ({ root }) => {
      const controller = createProviderKeysController({
        scope,
        apiKeys: createPlaceholderProviderKeysGateway(),
        auth: placeholderProviderKeysAuthGateway,
      });
      const teardown = mountProviderKeysScreen({ root, controller });
      void controller.refresh();
      return { unmount: teardown };
    },

    "settings.agents": ({ root }) => {
      const controller = createCustomAgentsController({
        scope,
        gateway: createPlaceholderCustomAgentsGateway(),
      });
      const teardown = mountCustomAgentsScreen({ root, controller });
      void controller.refresh();
      return { unmount: teardown };
    },

    "tasks.report": ({ root }) => {
      // Placeholder Final_Report screen. The shared-ui Final_Report
      // surface lands in a follow-up wave (see tasks.md task 14.x /
      // 15.2 viewer surfaces). Until then we render a small notice so
      // the route is still navigable end-to-end.
      const doc = root.ownerDocument ?? globalThis.document;
      root.innerHTML = "";
      root.classList.add("final-report-placeholder");
      const heading = doc.createElement("h2");
      heading.className = "final-report-placeholder__heading";
      heading.textContent = "Final report";
      const body = doc.createElement("p");
      body.className = "final-report-placeholder__body";
      body.textContent =
        "Final report viewer lands in a follow-up. Once the shared-ui screen ships it will mount here.";
      root.append(heading, body);
      return {
        unmount: () => {
          root.innerHTML = "";
          root.classList.remove("final-report-placeholder");
        },
      };
    },
    ...options.overrides,
  } satisfies WebShellScreensRegistry);

  return registry;
}
