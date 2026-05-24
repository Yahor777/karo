/**
 * Client SDK barrel.
 *
 * Currently ships:
 *
 *   • {@link RendererLoginGateway} — renderer-side `LoginGateway`
 *     adapter that probes providers via `fetch` and persists via an
 *     injected {@link LocalApiKeySink}. Used by the desktop and web
 *     shells.
 *   • {@link fingerprintApiKey} — short, plaintext-free fingerprint
 *     for the post-save settings surface.
 *
 * Other clients (SettingsClient, ModelCatalogClient, TaskClient,
 * TraceClient, ArtifactClient) are added under tasks 6.x / 7.x / 8.x /
 * 11.x.
 */

export {
  RendererLoginGateway,
  fingerprintApiKey,
} from "./loginGateway.js";
export type {
  LocalApiKeySink,
  LocalApiKeySinkResult,
  ProbeHttpClient,
  ProbeHttpResponse,
  RendererLoginGatewayOptions,
} from "./loginGateway.js";
