/**
 * Task Builder screen public surface (task 8.1).
 *
 * Hosts (desktop renderer, web shell) import the controller and the
 * DOM mount helper from here. Internals (`statesEqual`, etc.) stay
 * private to the screen folder.
 */

export {
  TaskBuilderController,
  type TaskBuilderControllerOptions,
} from "./taskBuilder.js";

export {
  mountTaskBuilderScreen,
  type MountTaskBuilderScreenOptions,
  type MountTaskBuilderScreenResult,
} from "./mountTaskBuilderScreen.js";

export type {
  AgentId,
  AgentPickerOption,
  CreateTaskInput,
  ModelInfo,
  ModelRef,
  ProviderModelsResult,
  TaskBuilderErrorCode,
  TaskBuilderEvent,
  TaskBuilderEventListener,
  TaskBuilderGateway,
  TaskBuilderState,
  TaskBuilderStateListener,
  TaskBuilderSubmitStatus,
  TaskMode,
} from "./types.js";

export {
  isCreateTaskError,
  type CreateTaskErrorCode,
  type CreateTaskErrorLike,
} from "../../ports/orchestrator.js";
