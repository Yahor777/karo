/**
 * Local-to-cloud upgrade screen public surface (task 17.4).
 *
 * Hosts (desktop renderer, web shell) import the controller and the
 * DOM render shell from here.
 */

export {
  LocalToCloudUpgradeScreen,
  type LocalToCloudUpgradeScreenOptions,
} from "./localToCloudUpgradeScreen.js";
export {
  mountLocalToCloudUpgradeScreen,
  type MountLocalToCloudUpgradeScreenOptions,
  type MountLocalToCloudUpgradeScreenResult,
} from "./mountLocalToCloudUpgradeScreen.js";
export type {
  LocalScopeForUpgrade,
  OAuthCallbackParams,
  Session,
  UpgradeEvent,
  UpgradeEventListener,
  UpgradeGateway,
  UpgradeMergeReport,
  UpgradeState,
  UpgradeStateListener,
  UpgradeStatus,
} from "./types.js";
