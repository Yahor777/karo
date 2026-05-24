/**
 * Final_Report builder and Task History persistence (task 15.2).
 *
 * Sources:
 *  - design.md → "Data Models" → "Final_Report" (canonical schema in
 *    `packages/validation/src/final-report.ts`).
 *  - design.md → "Pipeline State Machine" / "Pipeline rules" — terminal
 *    states `completed` and `stopped_limit` produce a Final_Report.
 *  - design.md → "Artifact Store" → "Rules" — Final_Report references
 *    final artifact versions only.
 *  - requirements.md →
 *      8.6  (`stopped_limit` Final_Report when review-cycle limit
 *            exhausted, must list outstanding issues),
 *      8.7  (`completed` Final_Report on Boss approval),
 *      14.2 (Final_Report carries the user's original prompt, the final
 *            artifacts, a Boss summary, the list of participating agents
 *            and the number of Review_Cycles performed),
 *      14.3 (UI displays the Final_Report and lets the user download
 *            artifacts — out of scope for the builder, in scope for the
 *            persistence step that this module enables),
 *      14.4 (Russian wording "не завершено" ↔ `stopped_limit` with the
 *            list of remaining issues),
 *      14.5 (Final_Report is persisted for later viewing in Task History).
 *  - tasks.md task 15.2 sub-bullets.
 *
 * Design notes:
 *
 *  • `buildFinalReport` is a PURE function: no I/O, no clocks beyond an
 *    injectable port. The runner composes it with an `ArtifactStore` and
 *    a `TaskHistoryStore` to persist the report after terminal events,
 *    but each piece is unit-testable in isolation.
 *  • The `TaskHistoryStore` port intentionally exposes only `save`,
 *    `get` and `list`. The Task History UI (later phase) reads through
 *    `get`/`list`; the orchestrator never reads back its own writes
 *    inside the pipeline.
 *  • Production replaces {@link InMemoryTaskHistoryStore} with a
 *    durable adapter (encrypted SQLite for desktop, SQL for cloud) that
 *    implements the same port — no changes required at the call sites.
 *  • Final_Report references ARE NOT bytes: the builder converts each
 *    `FileArtifactMetadata` into a {@link FileArtifactRef} that names
 *    `(artifactId, latestVersion, fileName)`. The bytes themselves stay
 *    in the Artifact Store and are fetched on demand by the UI when the
 *    user clicks an artifact (Requirement 14.3 + 11.4).
 *
 * Out of scope (handled by other tasks):
 *  • Driving the pipeline (task 15.1's `runTaskPipeline.ts`).
 *  • Surfacing Final_Report in the UI (task 15.x / 18.x).
 *  • Generating downloads from artifacts (task 10.3 / 18.x).
 */

import type {
  FileArtifactMetadata,
  FinalReport,
  FinalReportStatus,
} from "@ai-agent-orchestrator/validation";
import { finalReportSchema } from "@ai-agent-orchestrator/validation";
import type {
  AgentId,
  TaskId,
} from "@ai-agent-orchestrator/shared-core";

import type { BossVerdict } from "../agents/index.js";
import { BOSS_VERDICT_RUSSIAN } from "../agents/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Optional clock dependency, primarily for deterministic tests. */
export interface FinalReportClock {
  /** ISO 8601 UTC ms timestamp for the current moment. */
  nowIso(): string;
}

const systemClock: FinalReportClock = {
  nowIso: () => new Date().toISOString(),
};

/**
 * Input to {@link buildFinalReport}.
 *
 * Decoupled from the pipeline driver so the builder can be exercised
 * directly with hand-rolled fixtures (task 15.2 unit tests).
 *
 * Field semantics:
 *
 *  • `taskId`              — the Task this report describes.
 *  • `terminalStatus`      — the {@link TaskState.status} on which the
 *                             pipeline terminated. Only `completed` and
 *                             `stopped_limit` are accepted; any other
 *                             value throws to surface the precondition
 *                             violation up the call chain rather than
 *                             persisting a malformed report.
 *  • `originalPrompt`      — the user's prompt verbatim (Requirement
 *                             14.2 demands the original prompt be
 *                             archived).
 *  • `participants`        — ordered, non-empty list of agents that
 *                             actually participated in the run. The
 *                             driver passes the resolved Auto/Manual
 *                             selection here; `Final_Report.participants`
 *                             must be non-empty per the validation
 *                             schema.
 *  • `reviewCyclesPerformed` — counter copied from
 *                             `TaskState.reviewCycles` at terminal time.
 *  • `finalArtifacts`      — listing produced by
 *                             `ArtifactStore.listArtifacts(taskId)`.
 *                             The builder maps each metadata entry to a
 *                             `(artifactId, latestVersion, fileName)`
 *                             reference.
 *  • `bossVerdict`         — the Boss's verdict, if one was reached.
 *                             Required when `terminalStatus` is
 *                             `completed` (the pipeline only completes
 *                             when the Boss approves). Optional for
 *                             `stopped_limit` (the cap may have been
 *                             hit during the Reviewer→Fixer loop, so
 *                             the Boss may never have run).
 *  • `outstandingIssues`   — explicit list of remaining issues for
 *                             `stopped_limit` reports (Requirement 14.4
 *                             / 8.6). When omitted on `stopped_limit`
 *                             the builder derives them from
 *                             `bossVerdict.notes` (if a rejection is
 *                             present) or falls back to a generic
 *                             marker. For `completed` reports any
 *                             supplied issues are dropped — a
 *                             completed report does not list residual
 *                             defects.
 */
export interface BuildFinalReportInput {
  readonly taskId: TaskId;
  readonly terminalStatus: FinalReportStatus;
  readonly originalPrompt: string;
  readonly participants: readonly AgentId[];
  readonly reviewCyclesPerformed: number;
  readonly finalArtifacts: readonly FileArtifactMetadata[];
  readonly bossVerdict?: BossVerdict;
  readonly outstandingIssues?: readonly string[];
  readonly clock?: FinalReportClock;
}

/**
 * Persistence port for Final_Report records.
 *
 * Mirrors design.md → "Persistence" — the orchestrator owns Final_Report
 * archiving but does not care whether the backend is in-memory, encrypted
 * SQLite or a cloud database.
 *
 * Contract:
 *
 *   • `save` MUST persist the report before resolving. Re-saving the same
 *     `taskId` is implementation-defined; the orchestrator only saves on
 *     terminal transitions, so production callers do not encounter
 *     same-task overwrites today. The default {@link InMemoryTaskHistoryStore}
 *     overwrites by `taskId`, which is the friendliest behaviour for tests.
 *   • `get` MUST return `null` for unknown ids and MUST NOT throw — the
 *     UI depends on missing reports being a non-error outcome
 *     (Requirement 14.5).
 *   • `list` MUST return reports ordered most-recent first by `createdAt`.
 *     The Task History panel renders that order verbatim. Ties are broken
 *     by `taskId` ascending so listings are deterministic.
 *
 * Implementations SHOULD return defensive copies so caller mutation
 * cannot leak back into stored data.
 */
export interface TaskHistoryStore {
  save(report: FinalReport): Promise<void>;
  get(taskId: TaskId): Promise<FinalReport | null>;
  list(): Promise<readonly FinalReport[]>;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/**
 * Map-backed {@link TaskHistoryStore}, keyed by `report.taskId`.
 *
 * Used by:
 *   • Vitest unit tests for `buildFinalReport` and the runner wiring
 *     smoke test (task 15.2).
 *   • Early bring-up of the desktop pipeline before durable Task
 *     History storage lands.
 *
 * The store keeps a defensive deep copy of every saved report so caller-
 * side mutation cannot leak back into persisted data — same convention
 * used by `InMemoryTaskStateStore`.
 */
export class InMemoryTaskHistoryStore implements TaskHistoryStore {
  private readonly entries = new Map<string, FinalReport>();

  public save(report: FinalReport): Promise<void> {
    // Validate at the boundary so tests catch builder bugs immediately
    // rather than letting an invalid record through to disk.
    const parsed = finalReportSchema.parse(report);
    this.entries.set(parsed.taskId, cloneReport(parsed));
    return Promise.resolve();
  }

  public get(taskId: TaskId): Promise<FinalReport | null> {
    const value = this.entries.get(taskId);
    return Promise.resolve(value === undefined ? null : cloneReport(value));
  }

  public list(): Promise<readonly FinalReport[]> {
    const values = Array.from(this.entries.values()).map(cloneReport);
    values.sort((a, b) => {
      // Most recent first.
      if (a.createdAt > b.createdAt) return -1;
      if (a.createdAt < b.createdAt) return 1;
      // Stable tiebreaker for identical timestamps.
      if (a.taskId < b.taskId) return -1;
      if (a.taskId > b.taskId) return 1;
      return 0;
    });
    return Promise.resolve(values);
  }

  /** Test helper: number of persisted reports. */
  public size(): number {
    return this.entries.size;
  }

  /** Test helper: removes every entry. */
  public clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Generic placeholder used when `stopped_limit` is reached without any
 * concrete outstanding-issue information surfacing. Requirement 14.4
 * still expects the Final_Report to list "remaining remarks" so we
 * never persist an empty list for the stopped-limit case.
 */
const STOPPED_LIMIT_GENERIC_ISSUE =
  "Review_Cycle limit reached without Boss approval; the artifact may still contain unresolved issues.";

/**
 * Build a Final_Report from a terminal pipeline outcome.
 *
 * The function is pure: no I/O, no global state. It validates the
 * resulting record against {@link finalReportSchema} so a builder bug
 * cannot leak a malformed report into persistence.
 *
 * Behaviour summary:
 *
 *   • Status is taken verbatim from `terminalStatus`. The two accepted
 *     values map directly to design.md's two terminal states.
 *   • `bossSummary` is populated from `bossVerdict` when present. For
 *     `completed` reports we always require an `approved` verdict (the
 *     pipeline cannot complete without one); for `stopped_limit` we
 *     accept either a rejection verdict (cap hit during Boss review)
 *     or no verdict at all (cap hit during the Reviewer→Fixer loop).
 *   • `outstandingIssues`:
 *       - `completed`: never set.
 *       - `stopped_limit`: caller-supplied list takes precedence; if
 *         absent we derive from `bossVerdict.notes`; if neither is
 *         available we fall back to {@link STOPPED_LIMIT_GENERIC_ISSUE}.
 *   • `finalArtifacts` — derived from `finalArtifacts` metadata. Order
 *     is preserved so the UI can show artifacts in the same order the
 *     `ArtifactStore.listArtifacts` lookup returned (sorted by
 *     `updatedAt` ascending — last-edited artifact appears last).
 *
 * Validates: Requirements 8.6, 8.7, 14.2, 14.4.
 */
export function buildFinalReport(input: BuildFinalReportInput): FinalReport {
  // Programmer-error guards — these surface as TypeError because they
  // indicate a bug in the caller (e.g. passing a non-terminal status).
  if (
    input.terminalStatus !== "completed" &&
    input.terminalStatus !== "stopped_limit"
  ) {
    throw new TypeError(
      `buildFinalReport: terminalStatus must be "completed" or "stopped_limit"; got "${String(
        input.terminalStatus,
      )}"`,
    );
  }
  if (
    typeof input.originalPrompt !== "string" ||
    input.originalPrompt.trim().length === 0
  ) {
    throw new TypeError(
      "buildFinalReport: originalPrompt must be a non-empty string after trim",
    );
  }
  if (!Array.isArray(input.participants) || input.participants.length === 0) {
    throw new TypeError(
      "buildFinalReport: participants must be a non-empty array",
    );
  }
  if (
    !Number.isInteger(input.reviewCyclesPerformed) ||
    input.reviewCyclesPerformed < 0
  ) {
    throw new TypeError(
      "buildFinalReport: reviewCyclesPerformed must be a non-negative integer",
    );
  }

  // `completed` requires an approved Boss verdict per Requirement 8.7.
  // The pipeline state machine already enforces this on the structural
  // side (`boss_approved → completed` only fires when the Boss returned
  // approved); we mirror it here so the builder is safe to call from
  // tests that bypass the runner.
  if (input.terminalStatus === "completed") {
    if (input.bossVerdict === undefined) {
      throw new TypeError(
        "buildFinalReport: completed Final_Report requires a bossVerdict",
      );
    }
    if (input.bossVerdict.kind !== "approved") {
      throw new TypeError(
        "buildFinalReport: completed Final_Report requires bossVerdict.kind === 'approved'",
      );
    }
  }

  const clock = input.clock ?? systemClock;
  const createdAt = clock.nowIso();

  const finalArtifacts = input.finalArtifacts.map((meta) => ({
    artifactId: meta.id,
    version: meta.latestVersion,
    fileName: meta.fileName,
  }));

  const bossSummary = renderBossSummary(input);
  const outstandingIssues = renderOutstandingIssues(input);

  const draft: FinalReport = {
    taskId: input.taskId,
    status: input.terminalStatus,
    originalPrompt: input.originalPrompt,
    finalArtifacts,
    ...(bossSummary !== undefined ? { bossSummary } : {}),
    ...(outstandingIssues !== undefined ? { outstandingIssues } : {}),
    // Defensive copy keeps caller-side mutation away from the persisted
    // record. Schema validation below normalises the array shape too.
    participants: input.participants.map((p) => String(p)),
    reviewCyclesPerformed: input.reviewCyclesPerformed,
    createdAt,
  };

  // Final cross-check: the builder is the last line of defence before
  // a record reaches `TaskHistoryStore.save`. Schema validation here
  // surfaces shape bugs immediately, with the canonical zod error path
  // pointing at the offending field.
  return finalReportSchema.parse(draft);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format the Boss's verdict into the human-readable `bossSummary`
 * string consumed by the UI. The verdict wording (`соответствует` /
 * `не соответствует`) is preserved verbatim because it is the wording
 * Requirement 7.10 / 14.2 surface to the user. Notes are appended on
 * a single line per note, joined by a separator that survives JSON
 * round-trips.
 *
 * Returns `undefined` when no Boss verdict is available and no fallback
 * summary is appropriate — the schema marks `bossSummary` as optional.
 */
function renderBossSummary(input: BuildFinalReportInput): string | undefined {
  const verdict = input.bossVerdict;
  if (verdict === undefined) {
    return undefined;
  }

  const wording =
    verdict.kind === "approved"
      ? BOSS_VERDICT_RUSSIAN.approved
      : BOSS_VERDICT_RUSSIAN.rejected;

  const trimmedNotes = verdict.notes
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n.length > 0);

  if (trimmedNotes.length === 0) {
    return wording;
  }

  return `${wording}: ${trimmedNotes.join("; ")}`;
}

/**
 * Compute the `outstandingIssues` field for the report. See the doc
 * comment on {@link buildFinalReport} for the precedence order.
 *
 * `completed` reports never carry outstanding issues — even if the
 * caller supplies a list, it is dropped. Boss approval is by definition
 * an "all clear" signal (Requirement 8.7).
 */
function renderOutstandingIssues(
  input: BuildFinalReportInput,
): string[] | undefined {
  if (input.terminalStatus === "completed") {
    return undefined;
  }

  const supplied = input.outstandingIssues;
  if (Array.isArray(supplied)) {
    const cleaned = supplied
      .map((issue) => (typeof issue === "string" ? issue.trim() : ""))
      .filter((issue) => issue.length > 0);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  // No caller-supplied issues — try Boss rejection notes.
  const verdict = input.bossVerdict;
  if (verdict !== undefined && verdict.kind === "rejected") {
    const notes = verdict.notes
      .map((n) => (typeof n === "string" ? n.trim() : ""))
      .filter((n) => n.length > 0);
    if (notes.length > 0) {
      return notes;
    }
  }

  // Final fallback so Requirement 14.4 (`stopped_limit` reports list
  // remaining remarks) is satisfied even when no concrete details are
  // available.
  return [STOPPED_LIMIT_GENERIC_ISSUE];
}

/**
 * Deep clone a Final_Report. JSON round-trip is sufficient: every field
 * on the schema is JSON-safe (strings, numbers, plain arrays/objects).
 */
function cloneReport(report: FinalReport): FinalReport {
  return JSON.parse(JSON.stringify(report)) as FinalReport;
}

export { STOPPED_LIMIT_GENERIC_ISSUE };
