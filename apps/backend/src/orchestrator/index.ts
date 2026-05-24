/**
 * Public surface of the orchestrator backend module.
 *
 * Task 9.1 introduces the pipeline state machine (pure structural
 * transitions). Task 9.2 layers Review_Cycle counting and the Boss
 * approval precondition on top via {@link applyEvent}. Task 15.1
 * composes those primitives with the five Builtin_Agent runners
 * to drive an end-to-end pipeline (`runTaskPipeline` / `TaskPipeline`).
 * Task 15.2 adds Final_Report assembly + Task History persistence on
 * top of the pipeline driver.
 */

export * from "./stateMachine.js";
export {
  applyEvent,
  applyEventOrThrow,
} from "./reviewCycle.js";

// Task 8.2 — `Orchestrator.createTask` input validation, participant
// resolution and initial `TaskState` persistence.
export {
  CreateTaskError,
  Orchestrator,
} from "./createTask.js";
export type {
  AutoParticipantResolver,
  CreateTaskArgs,
  CreateTaskErrorCode,
  ModelCatalogPort,
  OrchestratorClock,
  OrchestratorOptions,
  TaskIdGenerator,
  TaskStateStore,
} from "./createTask.js";
export { InMemoryTaskStateStore } from "./inMemoryTaskStateStore.js";

// Task 15.1 — end-to-end pipeline driver.
export {
  ORCHESTRATOR_AGENT_ID,
  TaskPipeline,
  runTaskPipeline,
  resumeTask,
  activeConsentRequests,
} from "./runTaskPipeline.js";
export type {
  BossParticipant,
  CoderParticipant,
  FixerParticipant,
  PipelineClock,
  PipelineParticipants,
  ResearcherParticipant,
  ReviewerParticipant,
  RunTaskPipelineInput,
  RunTaskPipelineResult,
  TaskPipelineOptions,
} from "./runTaskPipeline.js";

// Task 15.2 — Final_Report builder and Task History persistence.
export {
  InMemoryTaskHistoryStore,
  STOPPED_LIMIT_GENERIC_ISSUE,
  buildFinalReport,
} from "./finalReport.js";
export type {
  BuildFinalReportInput,
  FinalReportClock,
  TaskHistoryStore,
} from "./finalReport.js";
