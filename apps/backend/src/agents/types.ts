/**
 * Builtin agent shared types (task 14.3).
 *
 * Shapes used by the Reviewer and Fixer builtin agents to encode review
 * results and fixed artifacts inside `Agent_Message` JSON payloads.
 *
 * Sources:
 * - design.md → "Agent Runtime" → "Builtin agent permissions" (Reviewer:
 *   web_search, file_read, artifact_diff; Fixer: web_search, file_read,
 *   file_write, artifact_diff).
 * - design.md → "Pipeline State Machine" / "Task Execution Flow" — the
 *   Reviewer's verdict drives the next pipeline transition (defects →
 *   Fixer, no defects → Boss); the Fixer hands the updated artifact back
 *   to the Reviewer.
 * - requirements.md →
 *     7.1 (five Builtin_Agent roles, exclusive responsibilities),
 *     7.5 (Reviewer returns a list of defects or explicit no-defects
 *          confirmation),
 *     7.6 (Orchestrator passes the defects list and current File_Artifact
 *          to the Fixer when the Reviewer returns a non-empty list),
 *     7.7 (Fixer applies the fixes and returns an updated File_Artifact
 *          atomically).
 *
 * The Reviewer's outgoing `Agent_Message` carries one of two payload
 * shapes; the Fixer's outgoing message carries the fixedArtifact shape.
 * Both are encoded as `payload: { kind: "json", value: ... }` so the
 * Orchestrator and Boss can read them through the standard
 * `Agent_Message` contract without any per-agent decoding glue.
 */

import type { AgentId } from "@ai-agent-orchestrator/shared-core";

// ---------------------------------------------------------------------------
// Defect shape
// ---------------------------------------------------------------------------

/**
 * Severity classes that the Reviewer can attach to a defect.
 *
 * Values are deliberately coarse — the orchestrator does not branch on
 * severity in task 14.3; the field is preserved for the UI (task 11.3)
 * and Final_Report (task 15.2) to render summaries.
 */
export type DefectSeverity = "low" | "medium" | "high" | "critical";

/**
 * A single defect raised by the Reviewer.
 *
 * `id` is a stable identifier the Fixer can use to reference the defect
 * (and the Reviewer can use to confirm it is resolved on the next pass).
 * `location` is optional free-form text — file path, line range or
 * symbol name — and is displayed verbatim in the Agent_Trace UI.
 */
export interface Defect {
  readonly id: string;
  readonly description: string;
  readonly severity: DefectSeverity;
  readonly location?: string;
}

// ---------------------------------------------------------------------------
// Reviewer payload shapes
// ---------------------------------------------------------------------------

/**
 * Reviewer payload when at least one defect is found.
 *
 * Requirement 7.5 mandates the Reviewer return either a list of defects
 * or an explicit no-defects confirmation. `defects` MUST be non-empty
 * for this variant; an empty list is encoded as {@link NoDefectsPayload}
 * instead so the Orchestrator can branch on the discriminator alone
 * without inspecting `defects.length`.
 */
export interface DefectsFoundPayload {
  readonly kind: "defectsFound";
  readonly defects: readonly Defect[];
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly summary?: string;
}

/**
 * Reviewer payload when the artifact has no remaining defects.
 *
 * Requirement 7.5: the no-defects confirmation must be explicit; the
 * `kind` discriminator is the explicit signal.
 */
export interface NoDefectsPayload {
  readonly kind: "noDefects";
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly summary?: string;
}

/** Discriminated union of every Reviewer verdict payload. */
export type ReviewerVerdictPayload = DefectsFoundPayload | NoDefectsPayload;

// ---------------------------------------------------------------------------
// Fixer payload shape
// ---------------------------------------------------------------------------

/**
 * Fixer payload reporting a freshly-written artifact version.
 *
 * Requirement 7.7: the Fixer returns the updated File_Artifact as a
 * single atomic action. The payload references the new version by
 * `(artifactId, version)` rather than embedding the bytes — the bytes
 * live in the Artifact Store (Requirement 11.7). `addressedDefectIds`
 * lets the next Reviewer pass cross-check that the Fixer attempted
 * every defect raised in the previous review.
 */
export interface FixedArtifactPayload {
  readonly kind: "fixedArtifact";
  readonly artifactId: string;
  readonly version: number;
  readonly fileName: string;
  readonly contentHash: string;
  readonly addressedDefectIds: readonly string[];
  readonly summary?: string;
}

// ---------------------------------------------------------------------------
// Researcher payload shape (task 14.2)
// ---------------------------------------------------------------------------

/**
 * Researcher payload reporting the enriched prompt handed off to the
 * Coder.
 *
 * Sources:
 *  - requirements.md → 7.2 (Researcher hands the next agent an enriched
 *    prompt that contains the original user prompt plus collected
 *    context).
 *  - requirements.md → 7.3 (when the Web_Search_Tool fails, the enriched
 *    prompt is built from the model alone and MUST include a marker
 *    indicating the absence of search results — the
 *    {@link webSearchOutcome} field is that marker).
 *  - design.md → "Pipeline State Machine" / "Task Execution Flow" — the
 *    Researcher's output is consumed by the Coder, which expects to see
 *    an enriched prompt rather than the raw user text.
 *
 * The body of the enriched prompt is carried verbatim in
 * {@link enrichedPrompt} so the Coder can hand it straight to the model
 * adapter on its next turn. {@link originalPrompt} is preserved
 * separately so the Boss agent and the Final_Report builder can match
 * the user's original prompt against the artifact later (Requirement
 * 7.10 / 14.2).
 */
export interface EnrichedPromptPayload {
  readonly kind: "enrichedPrompt";
  readonly originalPrompt: string;
  readonly enrichedPrompt: string;
  /**
   * Outcome of the Web_Search_Tool call performed by the Researcher.
   * `unavailable` is set whenever the tool returned an error result, the
   * tool threw an exception, or the call was skipped because the prompt
   * did not yield a viable query — Requirement 7.3 demands an explicit
   * marker on the enriched prompt when web search results are missing.
   */
  readonly webSearchOutcome: "ok" | "unavailable" | "skipped";
  readonly searchSummary?: string;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Coder payload shape (task 14.2)
// ---------------------------------------------------------------------------

/**
 * Coder payload reporting the freshly-written File_Artifact handed off
 * to the Reviewer.
 *
 * Sources:
 *  - requirements.md → 7.4 (Coder atomically forms the code as a single
 *    File_Artifact and hands it to the Reviewer as a single action).
 *  - design.md → "Artifact Store" — versions are append-only and start
 *    at 1; the Coder's atomic write produces version 1 of a brand-new
 *    artifact.
 *
 * Mirrors {@link FixedArtifactPayload}'s shape for the same reason: the
 * Reviewer can consume both the Coder's first cut and the Fixer's
 * subsequent fixes through a single decoder.
 */
export interface CodedArtifactPayload {
  readonly kind: "codedArtifact";
  readonly artifactId: string;
  readonly version: number;
  readonly fileName: string;
  readonly contentHash: string;
  readonly mimeType?: string;
  readonly summary?: string;
}

// ---------------------------------------------------------------------------
// Re-exports for ergonomics
// ---------------------------------------------------------------------------

export type { AgentId };
