/**
 * Placeholder gateway adapters for the Web Shell screen mounts (task 18.2).
 *
 * Source:
 *   • design.md → "Web Shell" → "Responsibilities" / "Rules":
 *       – web routing, OAuth callback handling, session cookie usage;
 *       – Web Shell cannot use Windows Local Encrypted Storage;
 *       – Web Shell relies on cloud session.
 *   • design.md → "Components and Interfaces" → "Client SDK" — the
 *     real adapters that satisfy these gateway shapes will land in
 *     tasks 19.2 / 20+ once the Client SDK ships HTTP transports for
 *     `Orchestrator`, `ModelCatalog`, `SettingsStore`, `ArtifactStore`,
 *     `TraceEventBus` and the `AuthService`.
 *   • requirements.md → Requirements 1.7, 11.8.
 *
 * What this module owns:
 *
 *   Tiny, in-memory gateway adapters that match the structural ports
 *   each shared-ui screen depends on (`LoginGateway`, `ModelCatalogGateway`,
 *   `TaskBuilderGateway`, `TraceStreamGateway`, `ArtifactGateway`,
 *   `ProviderKeysApiKeyGateway`, `ProviderKeysAuthGateway`,
 *   `CustomAgentsGateway`). The adapters return sensible defaults so
 *   each screen MOUNTS without throwing — the user sees the actual
 *   shared-ui shell on every route, and the "real wiring lives in a
 *   later wave" message stays scoped to the gateway boundary.
 *
 * Important non-goals:
 *
 *   • These adapters do NOT call the backend or any HTTP transport.
 *     The Client SDK (and through it, the gateway / orchestrator)
 *     lands separately. Until then every adapter resolves with empty
 *     lists, fake task ids, etc.
 *   • These adapters NEVER touch any local encrypted storage API.
 *     The web shell uses HTTP-only cookies for the session
 *     (`apps/web/src/shell/sessionCookie.ts`); per design.md the
 *     web shell cannot read or write Windows Local Encrypted Storage.
 *
 * TODO(client-sdk): replace each placeholder with the real Client SDK
 * adapter once the corresponding transport lands. The replacement is
 * always a structural one — the screen controllers consume the
 * gateway shapes verbatim, so a swap is a compile-time concern only.
 *
 * Validates: Requirements 1.7, 11.8.
 */

import type {
  ApiKeyMetadata,
  ArtifactDiffPatch as DiffPatch,
  ArtifactGateway,
  CustomAgentInputShape,
  CustomAgentShape,
  CustomAgentsGateway,
  FileArtifactContent,
  FileArtifactMetadata,
  LoginGateway,
  ModelCatalogGateway,
  ProviderId,
  ProviderKeysApiKeyGateway,
  ProviderKeysAuthGateway,
  ProviderModelsResult,
  Scope,
  Session,
  TaskBuilderGateway,
  TraceStreamGateway,
  TraceStreamMessage,
  TraceStreamSubscription,
  ValidationResult,
} from "@ai-agent-orchestrator/shared-ui";
import type { TaskId } from "@ai-agent-orchestrator/shared-core";
import type { CreateTaskInput } from "@ai-agent-orchestrator/validation";

/**
 * Synthetic taskId returned by {@link createPlaceholderTaskBuilderGateway}
 * so subsequent navigation (e.g. `/tasks/:id/trace`) lands on a
 * deterministic id during the placeholder phase.
 *
 * The value is intentionally human-recognisable so reviewers can spot
 * "this is the demo task id" without grepping the call site.
 */
export const PLACEHOLDER_TASK_ID: TaskId = "demo-task-placeholder";

/** Synthetic artifact id used by {@link createPlaceholderArtifactGateway}. */
export const PLACEHOLDER_ARTIFACT_ID = "demo-artifact-1" as const;

// ---------------------------------------------------------------------------
// Login + Auth (used by /login and /settings/keys)
// ---------------------------------------------------------------------------

/**
 * Placeholder {@link LoginGateway} for `/login`.
 *
 * The web shell has no local encrypted storage by design (design.md →
 * "Web Shell" → "Rules"), so `createLocalSession` is structurally
 * unreachable on the web — only the Gmail flow makes sense here. The
 * placeholder still accepts a gateway shape so the LoginScreen mounts
 * in API-key mode and renders the "Sign in with Gmail" button; both
 * methods reject with a structured, no-secret error indicating the
 * Client SDK transport is not yet wired.
 *
 * Mirrors the desktop's `notWiredLoginGateway` style
 * (`apps/desktop-windows/src/ui/loginBootstrap.ts`).
 *
 * TODO(client-sdk): replace with the real adapter once
 * `AuthClient.validateApiKey` lands.
 */
export const placeholderLoginGateway: LoginGateway = {
  validateApiKey(): Promise<ValidationResult> {
    return Promise.resolve({
      kind: "error",
      providerCode: "gateway_not_wired",
      providerMessage:
        "Auth Service transport is not yet wired in the web shell. The Client SDK adapter lands in a follow-up wave.",
    });
  },
  createLocalSession(): Promise<Session> {
    return Promise.reject(
      Object.assign(
        new Error(
          "Local sessions are not supported in the web shell. Sign in with Gmail to use cloud sync.",
        ),
        { code: "gateway_not_wired" },
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// Model catalog (used by /models)
// ---------------------------------------------------------------------------

/**
 * Returns a small static catalog so the model-selection screen mounts
 * end-to-end during the placeholder phase. Two providers, one model
 * each — enough to render the grouped UI and to verify the
 * provider-isolation rendering path.
 *
 * TODO(client-sdk): replace with a real adapter that calls
 * `ModelCatalog.listModelsForUser` through the Client SDK.
 */
export function createPlaceholderModelCatalogGateway(): ModelCatalogGateway {
  const sample: readonly ProviderModelsResult[] = [
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
  return {
    listModelsForUser(_scope: Scope): Promise<readonly ProviderModelsResult[]> {
      return Promise.resolve(sample);
    },
  };
}

// ---------------------------------------------------------------------------
// Task Builder (used by /tasks)
// ---------------------------------------------------------------------------

/**
 * Returns a placeholder {@link TaskBuilderGateway} that resolves
 * `createTask` with a fake taskId so the Task Builder screen mounts
 * and a successful "Launch" produces a deterministic navigation.
 *
 * TODO(client-sdk): replace with a real adapter once `Orchestrator
 * .createTask` is exposed through the Client SDK (task 19.2 / 20+).
 */
export function createPlaceholderTaskBuilderGateway(): TaskBuilderGateway {
  return {
    createTask(
      _input: CreateTaskInput,
      _options?: { readonly confirmedFallback?: boolean },
    ): Promise<{ readonly taskId: string }> {
      return Promise.resolve({ taskId: PLACEHOLDER_TASK_ID });
    },
  };
}

// ---------------------------------------------------------------------------
// Trace stream (used by /tasks/:id/trace)
// ---------------------------------------------------------------------------

/**
 * Returns a {@link TraceStreamGateway} that emits a couple of
 * synthetic trace records every 1.5 seconds so the Agent_Trace panel
 * has something to render while the real SSE transport is wired in
 * a follow-up wave.
 *
 * The synthetic stream uses the real `TraceEvent` shape from
 * `@ai-agent-orchestrator/validation` so the agent-trace controller
 * applies its lifecycle / sequencing logic exactly as it would
 * against a live backend. Concrete emissions:
 *
 *   1. `status: started`        for agent `boss` (sequence 1)
 *   2. `thought`                for agent `boss` (sequence 2)
 *   3. `history-end`            (the controller flips to "live")
 *   4. ... then once every 1.5 s, an alternating thought / status
 *      record so the panel keeps moving.
 *
 * The subscription `close()` stops the timer and resolves the
 * iterator. Repeated `close()` calls are a no-op.
 *
 * TODO(client-sdk): replace with a real adapter that opens an
 * EventSource against `/v1/tasks/:id/trace`.
 */
export function createPlaceholderTraceStreamGateway(): TraceStreamGateway {
  return {
    open(input: {
      readonly taskId: TaskId;
      readonly agentId?: string;
    }): TraceStreamSubscription {
      return createSyntheticTraceSubscription(input.taskId);
    },
  };
}

/**
 * Builds a fresh synthetic trace subscription. Extracted so unit
 * tests can call it directly without going through the gateway.
 */
function createSyntheticTraceSubscription(
  taskId: TaskId,
): TraceStreamSubscription {
  const queue: TraceStreamMessage[] = [];
  let resolveNext: ((v: IteratorResult<TraceStreamMessage>) => void) | null =
    null;
  let done = false;
  let sequence = 0;

  const enqueue = (message: TraceStreamMessage): void => {
    if (done) return;
    if (resolveNext !== null) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: message, done: false });
      return;
    }
    queue.push(message);
  };

  const baseAt = "2025-01-01T00:00:00.000Z";
  enqueue({
    kind: "event",
    event: {
      taskId,
      agentId: "boss",
      sequence: ++sequence,
      record: { kind: "status", status: "started", at: baseAt },
    },
  });
  enqueue({
    kind: "event",
    event: {
      taskId,
      agentId: "boss",
      sequence: ++sequence,
      record: {
        kind: "thought",
        text: "Reviewing original prompt against current artifact.",
        at: baseAt,
      },
    },
  });
  enqueue({ kind: "history-end", upTo: sequence });

  // After history-end, emit a synthetic alternating thought / status
  // pulse every 1.5 s so the panel stays alive. We deliberately
  // schedule on a setInterval so close() can stop it cleanly.
  const interval =
    typeof globalThis.setInterval === "function"
      ? globalThis.setInterval(() => {
          enqueue({
            kind: "event",
            event: {
              taskId,
              agentId: "boss",
              sequence: ++sequence,
              record: {
                kind: "thought",
                text: `Synthetic trace tick #${String(sequence)}.`,
                at: baseAt,
              },
            },
          });
        }, 1500)
      : null;

  const subscription: TraceStreamSubscription = {
    close(): void {
      if (done) return;
      done = true;
      if (interval !== null && typeof globalThis.clearInterval === "function") {
        globalThis.clearInterval(interval);
      }
      if (resolveNext !== null) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<TraceStreamMessage> {
      return {
        next(): Promise<IteratorResult<TraceStreamMessage>> {
          if (queue.length > 0) {
            const value = queue.shift();
            if (value !== undefined) {
              return Promise.resolve({ value, done: false });
            }
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<TraceStreamMessage>>((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<TraceStreamMessage>> {
          subscription.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return subscription;
}

// ---------------------------------------------------------------------------
// Artifact store (used by /tasks/:id/artifacts)
// ---------------------------------------------------------------------------

/**
 * Returns an in-memory {@link ArtifactGateway} containing one artifact
 * with two versions so the artifact viewer renders end-to-end and the
 * "Compare versions" button has something to compare. Diff is still
 * gated behind the explicit user gesture (Requirement 11.5).
 *
 * TODO(client-sdk): replace with a real adapter once the artifact
 * HTTP routes are exposed through the Client SDK.
 */
export function createPlaceholderArtifactGateway(): ArtifactGateway {
  const fileName = "hello.txt";
  const version1Bytes = new TextEncoder().encode("Hello, world.\n");
  const version2Bytes = new TextEncoder().encode("Hello, AI Agent Orchestrator.\n");
  const metadata: FileArtifactMetadata = {
    id: PLACEHOLDER_ARTIFACT_ID,
    taskId: PLACEHOLDER_TASK_ID,
    fileName,
    latestVersion: 2,
    latestContentHash: "demo-hash-v2",
    updatedAt: "2025-01-01T00:00:01.000Z",
  };

  const versions: ReadonlyMap<number, FileArtifactContent> = new Map([
    [
      1,
      {
        id: PLACEHOLDER_ARTIFACT_ID,
        taskId: PLACEHOLDER_TASK_ID,
        fileName,
        version: 1,
        bytes: version1Bytes,
        contentHash: "demo-hash-v1",
      },
    ],
    [
      2,
      {
        id: PLACEHOLDER_ARTIFACT_ID,
        taskId: PLACEHOLDER_TASK_ID,
        fileName,
        version: 2,
        bytes: version2Bytes,
        contentHash: "demo-hash-v2",
      },
    ],
  ]);

  return {
    listArtifacts(_taskId: TaskId): Promise<readonly FileArtifactMetadata[]> {
      return Promise.resolve([metadata]);
    },
    getArtifact(input: {
      readonly taskId: TaskId;
      readonly artifactId: string;
      readonly version?: number;
    }): Promise<FileArtifactContent | null> {
      if (input.artifactId !== PLACEHOLDER_ARTIFACT_ID) {
        return Promise.resolve(null);
      }
      const v = input.version ?? metadata.latestVersion;
      return Promise.resolve(versions.get(v) ?? null);
    },
    getDiff(input: {
      readonly taskId: TaskId;
      readonly artifactId: string;
      readonly fromVersion: number;
      readonly toVersion: number;
    }): Promise<DiffPatch | null> {
      if (input.artifactId !== PLACEHOLDER_ARTIFACT_ID) {
        return Promise.resolve(null);
      }
      if (!versions.has(input.fromVersion) || !versions.has(input.toVersion)) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        artifactId: input.artifactId,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        patchText:
          `--- v${String(input.fromVersion)}\n+++ v${String(input.toVersion)}\n` +
          `@@ placeholder diff @@\n-Hello, world.\n+Hello, AI Agent Orchestrator.\n`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Provider keys (used by /settings/keys)
// ---------------------------------------------------------------------------

/**
 * Returns a placeholder {@link ProviderKeysApiKeyGateway} with an
 * empty in-memory listing. Add/remove operations succeed but do not
 * persist anywhere — the UI mounts and the "no keys configured"
 * empty state renders.
 *
 * TODO(client-sdk): replace with a real adapter once the cloud-scoped
 * settings store routes are exposed through the Client SDK.
 */
export function createPlaceholderProviderKeysGateway(): ProviderKeysApiKeyGateway {
  let entries: readonly ApiKeyMetadata[] = [];
  return {
    listApiKeyMetadata(_scope: Scope): Promise<readonly ApiKeyMetadata[]> {
      return Promise.resolve(entries);
    },
    upsertApiKey(
      _scope: Scope,
      input: { readonly provider: ProviderId; readonly apiKey: string },
    ): Promise<void> {
      const next: ApiKeyMetadata = {
        provider: input.provider,
        fingerprint: "demo-fingerprint",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastValidatedAt: "2025-01-01T00:00:00.000Z",
      };
      entries = [...entries.filter((e) => e.provider !== input.provider), next];
      return Promise.resolve();
    },
    removeApiKey(_scope: Scope, provider: ProviderId): Promise<void> {
      entries = entries.filter((e) => e.provider !== provider);
      return Promise.resolve();
    },
  };
}

/**
 * Placeholder {@link ProviderKeysAuthGateway}. Always returns
 * `{ kind: "ok" }` so the "Save" path in the provider-keys screen
 * exercises the full happy path during the placeholder phase. The
 * desktop's loginBootstrap surfaces a `gateway_not_wired` error for
 * the same surface; the web shell mirrors that by simply pointing
 * the controller at the placeholder validate, which still goes
 * through the upsert path and produces a metadata row in the listing.
 */
export const placeholderProviderKeysAuthGateway: ProviderKeysAuthGateway = {
  validateApiKey(): Promise<ValidationResult> {
    return Promise.resolve({ kind: "ok" });
  },
};

// ---------------------------------------------------------------------------
// Custom agents (used by /settings/agents)
// ---------------------------------------------------------------------------

/**
 * Returns an in-memory {@link CustomAgentsGateway} with no agents.
 * Save / delete operations succeed but do not persist anywhere.
 *
 * TODO(client-sdk): replace with a real adapter once the
 * `SettingsStore.upsertCustomAgent` / `removeCustomAgent` routes are
 * exposed through the Client SDK.
 */
export function createPlaceholderCustomAgentsGateway(): CustomAgentsGateway {
  let agents: readonly CustomAgentShape[] = [];
  let nextId = 1;
  return {
    listCustomAgents(_scope: Scope): Promise<readonly CustomAgentShape[]> {
      return Promise.resolve(agents);
    },
    upsertCustomAgent(
      scope: Scope,
      input: CustomAgentInputShape,
    ): Promise<CustomAgentShape> {
      const id = `demo-agent-${String(nextId)}`;
      nextId += 1;
      const record: CustomAgentShape = {
        id,
        kind: "custom",
        name: input.name,
        systemPrompt: input.systemPrompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        allowedTools: input.allowedTools,
        ownerScope: scope,
      };
      agents = [...agents, record];
      return Promise.resolve(record);
    },
    removeCustomAgent(_scope: Scope, agentId: string): Promise<void> {
      agents = agents.filter((a) => a.id !== agentId);
      return Promise.resolve();
    },
  };
}
