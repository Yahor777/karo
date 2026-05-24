/**
 * Login screen public surface (task 4.3).
 *
 * Hosts (desktop renderer, web shell) import the controller and the
 * DOM render shell from here. Internals (`statesEqual`, etc.) stay
 * private to the screen folder.
 */

export {
  LoginScreen,
  DEFAULT_PROVIDER,
  DEFAULT_PROVIDER_OPTIONS,
  type LoginScreenOptions,
} from "./loginScreen.js";

export {
  mountLoginScreen,
  type MountLoginScreenOptions,
  type MountLoginScreenResult,
} from "./mountLoginScreen.js";

export type {
  LoginEntryMode,
  LoginEvent,
  LoginEventListener,
  LoginGateway,
  LoginSaveStatus,
  LoginState,
  LoginStateListener,
  LoginValidationStatus,
  ProviderId,
  Session,
} from "./types.js";

// `ValidationResult` from `./types.js` is intentionally NOT re-exported
// from this barrel: the shared-ui top-level barrel also re-exports a
// structurally identical `ValidationResult` from `./ports/settings.js`,
// and `export *` cannot resolve the name collision automatically. The
// type itself is still reachable via:
//
//   import type { ValidationResult } from
//     "@ai-agent-orchestrator/shared-ui/screens/login/types.js";
//
// or by using the equivalent name re-exported from `ports/settings.js`.
