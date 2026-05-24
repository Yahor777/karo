/**
 * Shared core public surface.
 *
 * Domain types, state machine types and constants live under `./types/` and
 * future sibling folders. Subsequent tasks (e.g. 2.2 validation schemas,
 * 9.1 state machines) extend this barrel.
 */

export * from "./types";

export {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  findProviderPreset,
  joinProviderPath,
  resolveBaseUrl,
} from "./providerPresets.js";
export type {
  ProviderApiShape,
  ProviderAuthStyle,
  ProviderPreset,
} from "./providerPresets.js";

export {
  DEFAULT_REDACT_RECORD_MAX_DEPTH,
  redactRecord,
  redactString,
  redactStructuredError,
  redactValue,
} from "./redaction.js";
export type { RedactedStructuredError } from "./redaction.js";
