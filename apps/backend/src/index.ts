// Backend entry. Service modules (gateway, auth, settings, models, orchestrator, runtime,
// search, trace, artifacts, persistence, secrets, fallback) are implemented in later tasks (4.x onwards).
export const backendServiceName = "ai-agent-orchestrator-backend";

// Orchestrator pipeline state machine (task 9.1).
export * as orchestrator from "./orchestrator/index.js";

// Agent Runtime — model adapter port + Agent_Message normalisation (task 14.1).
export * as agentRuntime from "./agentRuntime/index.js";

// Error boundary helpers — wraps async handlers so thrown values become
// redacted structured envelopes (task 20.1).
export {
  wrapAsync,
  wrapAsyncHandler,
} from "./errorBoundary.js";
export type { AsyncResult } from "./errorBoundary.js";
