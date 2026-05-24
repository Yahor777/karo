/**
 * Gmail login screen public surface (task 17.4).
 *
 * Hosts (desktop renderer, web shell) import the controller and the
 * DOM render shell from here.
 */

export { GmailLoginScreen, type GmailLoginScreenOptions } from "./gmailLoginScreen.js";
export {
  mountGmailLoginScreen,
  type MountGmailLoginScreenOptions,
  type MountGmailLoginScreenResult,
} from "./mountGmailLoginScreen.js";
export type {
  GmailLoginEvent,
  GmailLoginEventListener,
  GmailLoginGateway,
  GmailLoginState,
  GmailLoginStateListener,
  GmailLoginStatus,
  Session,
  UserAgentRedirector,
} from "./types.js";
