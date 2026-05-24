/**
 * Public surface of the Agent_Trace panel screen module (task 11.3).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.6, 11.8.
 */

export type {
  AgentId,
  AgentTraceLifecycle,
  AgentTraceState,
  TaskId,
  TimerHandle,
  TimerPort,
  TraceAgentStatus,
  TraceAgentSummary,
  TraceConnectionStatus,
  TraceEvent,
  TraceGapNotice,
  TraceRecord,
  TraceStreamGateway,
  TraceStreamMessage,
  TraceStreamSubscription,
} from "./types.js";

export {
  AgentTraceController,
  DEFAULT_DELAY_THRESHOLD_MS,
} from "./agentTraceController.js";
export type { AgentTraceControllerOptions } from "./agentTraceController.js";

export { mountAgentTracePanel } from "./mountAgentTracePanel.js";
export type { MountAgentTracePanelOptions } from "./mountAgentTracePanel.js";
