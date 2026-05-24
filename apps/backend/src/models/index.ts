/**
 * Public surface of the Model Catalog backend module.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5.
 */

export type {
  ApiKeyResolver,
  ModelInfo,
  ModelQualityTier,
  ModelSource,
  ProviderModelsAdapter,
  ProviderModelsResult,
} from "./types.js";
export { DEFAULT_MODEL_CATALOG_TTL_MS } from "./types.js";

export type { ModelCatalogOptions } from "./catalog.js";
export { ModelCatalog } from "./catalog.js";
