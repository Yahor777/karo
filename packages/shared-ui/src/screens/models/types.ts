/**
 * Public types for the Model Selection screen.
 *
 * The shapes here mirror `design.md` → "Model Catalog" so the renderer
 * does not have to import from `apps/backend`. They are structurally
 * compatible with the backend `ModelInfo` / `ProviderModelsResult`
 * types declared in `apps/backend/src/models/types.ts`, which is what
 * the production gateway will hand us across the IPC/HTTP boundary.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5.
 */

import type {
  ModelRef,
  ModelSource,
  ProviderId,
  Scope,
} from "@ai-agent-orchestrator/shared-core";

/**
 * Quality tier surfaced to the UI. Optional because not every Provider
 * exposes a comparable tier; the UI may visually emphasise `basic` so
 * users can tell their cheap fallback options apart from premium ones.
 */
export type ModelQualityTier = "basic" | "standard" | "premium";

/**
 * Model description shown in the catalog UI. Mirrors the backend
 * `ModelInfo` shape from the design doc verbatim.
 */
export interface ModelInfo {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly displayName: string;
  readonly source: ModelSource;
  readonly qualityTier?: ModelQualityTier;
  readonly contextWindow?: number;
  readonly supportsTools?: boolean;
}

/**
 * Per-provider listing outcome. Discriminated by `status` so the UI
 * cannot silently coerce an error into an empty list — that would
 * violate Requirement 5.3 ("provider failure must not remove other
 * providers' models").
 */
export type ProviderModelsResult =
  | {
      readonly provider: ProviderId;
      readonly status: "ok";
      readonly models: readonly ModelInfo[];
    }
  | {
      readonly provider: ProviderId;
      readonly status: "error";
      readonly reason: string;
    };

/**
 * Narrow inbound port the controller depends on.
 *
 * In production this is wired to a Client SDK call that ultimately
 * reaches `ModelCatalog.listModelsForUser` in the backend
 * (`apps/backend/src/models/catalog.ts`). In tests we stub it.
 *
 * The gateway MUST return one entry per configured provider, in
 * deterministic order, so the renderer can preserve grouping and
 * expand-state stability across refreshes.
 */
export interface ModelCatalogGateway {
  listModelsForUser(scope: Scope): Promise<readonly ProviderModelsResult[]>;
}

/**
 * Convenience re-exports so consumers of the screen module don't need
 * to also import from `@ai-agent-orchestrator/shared-core` for common
 * value types they pass into the controller.
 */
export type { ModelRef, ModelSource, ProviderId, Scope };
