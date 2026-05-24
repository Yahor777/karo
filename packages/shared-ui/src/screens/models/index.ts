/**
 * Public surface of the Model Selection screen module.
 *
 * Validates: Requirements 5.2, 5.3, 5.5.
 */

export type {
  ModelCatalogGateway,
  ModelInfo,
  ModelQualityTier,
  ModelRef,
  ModelSource,
  ProviderId,
  ProviderModelsResult,
  Scope,
} from "./types.js";

export type {
  ModelSelectionControllerOptions,
  ModelSelectionLoadStatus,
  ModelSelectionState,
  PendingFallback,
} from "./modelSelection.js";
export { ModelSelectionController } from "./modelSelection.js";

export { mountModelSelection } from "./mountModelSelection.js";
