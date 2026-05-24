/**
 * Provider and model reference types.
 *
 * Source: design.md → "Shared Core" → "Example types" and
 * "Data Models" → "Provider and Model".
 *
 * `ProviderId` is intentionally an open string union: `"openai" | "anthropic"`
 * are well-known IDs, but the system must accept additional providers without
 * a type change.
 *
 * `ModelRef` distinguishes user-key models from explicitly configured platform
 * fallback models via `source`. Per Requirement 5.5, fallback models must be
 * clearly labeled and never silently mixed with user-key models.
 */

 
export type ProviderId = "openai" | "anthropic" | (string & {});

export type ModelSource = "user-api-key" | "platform-fallback";

export type ModelRef = {
  provider: ProviderId;
  modelId: string;
  source: ModelSource;
};
