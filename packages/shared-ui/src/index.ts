/**
 * Public surface of `@ai-agent-orchestrator/shared-ui`.
 *
 * Currently ships:
 *
 *   • Login screen (task 4.3) — `screens/login/`.
 *   • Settings screens (task 6.4):
 *     - Provider / API-key management — `screens/settings/providerKeys.ts`.
 *     - Custom agents editor          — `screens/settings/customAgents.ts`.
 *   • Model selection screen (task 7.2) — `screens/models/`.
 *   • File_Artifact viewer (task 10.3) — `screens/artifacts/`.
 *   • Task Builder screen (task 8.1) — `screens/taskBuilder/`.
 *
 * Screens are framework-free DOM controllers + mount helpers that
 * read backend state through narrow ports. Other screens land in
 * tasks 11.x.
 *
 * Note: `customAgents.ts`, `providerKeys.ts` and `screens/artifacts`
 * each export a `ListStatus` type (related but distinct discriminated
 * unions). The `providerKeys` surface is re-exported in full;
 * `customAgents` and `artifacts` are re-exported selectively (with
 * `ListStatus` aliased in the artifact case). Consumers needing the
 * raw module-specific names can import them directly from
 * `"@ai-agent-orchestrator/shared-ui/screens/<screen>/index.js"`.
 */

export * from "./screens/login/index.js";
export {
  GmailLoginScreen,
  mountGmailLoginScreen,
} from "./screens/gmailLogin/index.js";
export type {
  GmailLoginEvent,
  GmailLoginEventListener,
  GmailLoginGateway,
  GmailLoginScreenOptions,
  GmailLoginState,
  GmailLoginStateListener,
  GmailLoginStatus,
  MountGmailLoginScreenOptions,
  MountGmailLoginScreenResult,
  UserAgentRedirector,
} from "./screens/gmailLogin/index.js";
export {
  LocalToCloudUpgradeScreen,
  mountLocalToCloudUpgradeScreen,
} from "./screens/localToCloudUpgrade/index.js";
export type {
  LocalScopeForUpgrade,
  LocalToCloudUpgradeScreenOptions,
  MountLocalToCloudUpgradeScreenOptions,
  MountLocalToCloudUpgradeScreenResult,
  OAuthCallbackParams,
  UpgradeEvent,
  UpgradeEventListener,
  UpgradeGateway,
  UpgradeMergeReport,
  UpgradeState,
  UpgradeStateListener,
  UpgradeStatus,
} from "./screens/localToCloudUpgrade/index.js";
export {
  isSettingsLoadFailedError,
} from "./ports/auth.js";
export type {
  CompleteGoogleOAuthErrorCode,
  CompleteGoogleOAuthErrorLike,
} from "./ports/auth.js";
export * from "./ports/settings.js";
export {
  createArtifactViewerController,
  mountArtifactViewer,
} from "./screens/artifacts/index.js";
export type {
  ArtifactGateway,
  ArtifactViewerController,
  ArtifactViewerControllerOptions,
  ArtifactViewerListener,
  ArtifactViewerState,
  ContentStatus,
  DiffPatch as ArtifactDiffPatch,
  DiffStatus,
  FileArtifactContent,
  FileArtifactMetadata,
  ListStatus as ArtifactListStatus,
  MountArtifactViewerOptions,
} from "./screens/artifacts/index.js";
export * from "./screens/settings/providerKeys.js";
export {
  createCustomAgentsController,
  mountCustomAgentsScreen,
} from "./screens/settings/customAgents.js";
export type {
  CustomAgentsController,
  CustomAgentsControllerOptions,
  CustomAgentsGateway,
  CustomAgentsListener,
  CustomAgentsState,
  MountCustomAgentsScreenOptions,
  SaveFailureReason,
  SaveStatus,
} from "./screens/settings/customAgents.js";
export * from "./screens/models/index.js";
export * from "./screens/agentTrace/index.js";
export {
  TaskBuilderController,
  mountTaskBuilderScreen,
  isCreateTaskError,
} from "./screens/taskBuilder/index.js";
export type {
  AgentPickerOption,
  CreateTaskErrorCode,
  CreateTaskErrorLike,
  CreateTaskInput,
  MountTaskBuilderScreenOptions,
  MountTaskBuilderScreenResult,
  TaskBuilderControllerOptions,
  TaskBuilderErrorCode,
  TaskBuilderEvent,
  TaskBuilderEventListener,
  TaskBuilderGateway,
  TaskBuilderState,
  TaskBuilderStateListener,
  TaskBuilderSubmitStatus,
  TaskMode,
} from "./screens/taskBuilder/index.js";
