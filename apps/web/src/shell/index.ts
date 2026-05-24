/**
 * Public surface of the Web Shell (task 18.1).
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */

export { Router, WEB_SHELL_ROUTES, WEB_SHELL_SCREEN_ROUTES } from "./router.js";
export type { RouterOptions } from "./router.js";

export {
  SESSION_COOKIE_NAME,
  buildClearCookieHeader,
  buildSetCookieHeader,
  clearSessionCookie,
  readSessionCookie,
  writeSessionCookie,
} from "./sessionCookie.js";

export {
  DEFAULT_POST_LOGIN_REDIRECT,
  handleOAuthCallback,
} from "./oauthCallback.js";
export type { HandleOAuthCallbackOptions } from "./oauthCallback.js";

export {
  mountOAuthCallbackView,
  notWiredGmailLoginGateway,
  notWiredUpgradeGateway,
  parseOAuthCallbackParams,
} from "./oauthCallbackView.js";
export type {
  MountOAuthCallbackViewOptions,
  MountOAuthCallbackViewResult,
} from "./oauthCallbackView.js";

export { bootstrapWebShell } from "./bootstrap.js";
export type {
  BootstrapWebShellOptions,
  BootstrapWebShellResult,
} from "./bootstrap.js";

export {
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
} from "./screens/placeholderGateways.js";

export {
  createScreensRegistry,
} from "./screens/screensRegistry.js";
export type {
  CreateScreensRegistryOptions,
  WebShellScreenHandle,
  WebShellScreenId,
  WebShellScreenMount,
  WebShellScreenMountInput,
  WebShellScreensRegistry,
} from "./screens/screensRegistry.js";

export type {
  HistoryLike,
  HttpRequestLike,
  HttpResponseLike,
  LocationLike,
  NotFoundHandler,
  OAuthCallbackResult,
  OAuthCompleter,
  PopStateTargetLike,
  QueryParams,
  RouteHandler,
  RouteMatch,
  RouteParams,
  Session,
  SessionCookieOptions,
} from "./types.js";
