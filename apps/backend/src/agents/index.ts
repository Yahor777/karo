/**
 * Public surface of the backend Builtin_Agents module.
 *
 * Tasks 14.2–14.4 ship the five Builtin_Agent roles:
 *
 *   • {@link ResearcherAgent}  (task 14.2) — enriches the user prompt
 *     using the model and Web_Search_Tool, tolerates search failure,
 *     hands off to the Coder. Validates Requirements 7.1, 7.2, 7.3.
 *   • {@link CoderAgent}       (task 14.2) — produces a single
 *     File_Artifact atomically and hands off to the Reviewer.
 *     Validates Requirements 7.1, 7.4.
 *   • {@link ReviewerAgent}    (task 14.3) — produces a defects list or
 *     no-defects confirmation. Routes handoff to Fixer or Boss per the
 *     design's pipeline rules. Validates Requirements 7.1, 7.5, 7.6.
 *   • {@link FixerAgent}       (task 14.3) — applies defects to the
 *     latest File_Artifact and writes the updated bytes as a NEW
 *     version atomically. Validates Requirements 7.1, 7.6, 7.7.
 *   • {@link BossAgent}        (task 14.4) — final-reviewer with the
 *     "approve only after ≥ 1 Review_Cycle" gate. Validates Requirements
 *     7.1, 7.10, 7.11, 14.1.
 *
 *   • Defect / verdict / fixed-artifact / coded-artifact / enriched-prompt
 *     payload types — shared between agents and downstream consumers
 *     (Boss, Final_Report, UI).
 */

export {
  ResearcherAgent,
  RESEARCHER_BUDGET_MS,
  RESEARCHER_PERSISTENCE_BUDGET_MS,
  WEB_SEARCH_NO_RESULTS_MARKER,
  WEB_SEARCH_UNAVAILABLE_MARKER,
} from "./researcher.js";
export type {
  Clock as ResearcherClock,
  ResearcherAgentOptions,
  ResearcherRunInput,
  ResearcherRunResult,
} from "./researcher.js";

export { CoderAgent, CODER_PERSISTENCE_BUDGET_MS } from "./coder.js";
export type {
  Clock as CoderClock,
  CoderAgentOptions,
  CoderRunInput,
  CoderRunResult,
} from "./coder.js";

export { ReviewerAgent, REVIEWER_PERSISTENCE_BUDGET_MS, ConsentRequiredError } from "./reviewer.js";
export type {
  Clock as ReviewerClock,
  ReviewerAgentOptions,
  ReviewerRunInput,
  ReviewerRunResult,
  ConsentDecision,
} from "./reviewer.js";

export { FixerAgent, FIXER_PERSISTENCE_BUDGET_MS } from "./fixer.js";
export type {
  Clock as FixerClock,
  FixerAgentOptions,
  FixerRunInput,
  FixerRunResult,
} from "./fixer.js";

export {
  BossAgent,
  BOSS_AGENT_ID,
  BOSS_ALLOWED_TOOLS,
  BOSS_REVIEW_CYCLE_REQUIRED_NOTE,
  BOSS_SYSTEM_PROMPT,
  BOSS_VERDICT_RUSSIAN,
  DEFAULT_BOSS_AGENT,
} from "./boss.js";
export type {
  BossAgentOptions,
  BossEvaluateInput,
  BossEvaluateResult,
  BossVerdict,
  BossVerdictKind,
  BossVerdictWording,
} from "./boss.js";

export type {
  CodedArtifactPayload,
  Defect,
  DefectSeverity,
  DefectsFoundPayload,
  EnrichedPromptPayload,
  FixedArtifactPayload,
  NoDefectsPayload,
  ReviewerVerdictPayload,
} from "./types.js";
