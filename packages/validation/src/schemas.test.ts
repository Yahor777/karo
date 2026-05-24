/**
 * Unit tests for the validation schemas in `@ai-agent-orchestrator/validation`.
 *
 * Scope (tasks.md task 2.5):
 *   Boundary cases for taskId, ISO 8601 timestamp, agent-message type/payload,
 *   File_Artifact, Final_Report, Custom_Agent, diff patch, and maxReviewCycles.
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5
 *   (and the related boundaries from 7.4, 8.5, 12.1, 12.2, 14.2 reached
 *   incidentally — those are covered by the dedicated property tests in tasks
 *   2.3 and 2.4 and are deliberately not duplicated here.)
 *
 * The tests use plain `describe`/`it` from Vitest and the `safeParse` API on
 * each Zod schema so we can assert on `success` without throwing. This keeps
 * failure output small and avoids leaking long Zod error messages into the
 * test report.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_MESSAGE_PAYLOAD_MAX_BYTES,
  TASK_ID_MAX_LENGTH,
  TASK_ID_MIN_LENGTH,
  agentMessageSchema,
  customAgentSchema,
  diffPatchSchema,
  fileArtifactSchema,
  finalReportSchema,
  isoTimestampSchema,
  maxReviewCyclesSchema,
  taskIdSchema,
} from "./index";

// ---------- shared fixtures ---------------------------------------------------

const VALID_TIMESTAMP = "2024-01-02T03:04:05.678Z";
const ANOTHER_VALID_TIMESTAMP = "2024-01-02T03:04:06.000Z";

const VALID_AGENT_ID = "agent-coder";
const VALID_TASK_ID = "task-1";

const validTextPayload = { kind: "text", text: "hello" } as const;

const buildValidAgentMessage = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  taskId: VALID_TASK_ID,
  sender: VALID_AGENT_ID,
  recipient: "orchestrator",
  type: "request",
  payload: validTextPayload,
  timestamp: VALID_TIMESTAMP,
  ...overrides,
});

// ---------- taskIdSchema (Requirement 10.2) ----------------------------------

describe("taskIdSchema (Requirement 10.2)", () => {
  it("rejects an empty string", () => {
    expect(taskIdSchema.safeParse("").success).toBe(false);
  });

  it("accepts the minimum length (1 character)", () => {
    const result = taskIdSchema.safeParse("a");
    expect(result.success).toBe(true);
  });

  it("accepts the maximum length (128 characters)", () => {
    const max = "a".repeat(TASK_ID_MAX_LENGTH);
    expect(max.length).toBe(128);
    const result = taskIdSchema.safeParse(max);
    expect(result.success).toBe(true);
  });

  it("rejects strings longer than 128 characters (129)", () => {
    const tooLong = "a".repeat(TASK_ID_MAX_LENGTH + 1);
    const result = taskIdSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(taskIdSchema.safeParse(undefined).success).toBe(false);
    expect(taskIdSchema.safeParse(123).success).toBe(false);
  });

  it("documents the bounds via exported constants", () => {
    expect(TASK_ID_MIN_LENGTH).toBe(1);
    expect(TASK_ID_MAX_LENGTH).toBe(128);
  });
});

// ---------- isoTimestampSchema (Requirement 10.5) -----------------------------

describe("isoTimestampSchema (Requirement 10.5)", () => {
  it("accepts a well-formed ISO 8601 UTC timestamp with millisecond precision", () => {
    expect(isoTimestampSchema.safeParse(VALID_TIMESTAMP).success).toBe(true);
  });

  it("accepts the unix epoch", () => {
    expect(
      isoTimestampSchema.safeParse("1970-01-01T00:00:00.000Z").success,
    ).toBe(true);
  });

  it("rejects timestamps that are missing milliseconds", () => {
    // Common mistake: no `.sss` segment.
    expect(isoTimestampSchema.safeParse("2024-01-02T03:04:05Z").success).toBe(
      false,
    );
  });

  it("rejects timestamps that are missing the Z UTC suffix", () => {
    expect(
      isoTimestampSchema.safeParse("2024-01-02T03:04:05.678").success,
    ).toBe(false);
  });

  it("rejects timestamps with a numeric timezone offset instead of Z", () => {
    expect(
      isoTimestampSchema.safeParse("2024-01-02T03:04:05.678+00:00").success,
    ).toBe(false);
  });

  it("rejects timestamps with sub-millisecond precision", () => {
    // Six fractional digits is technically ISO 8601 but not allowed by the
    // schema, which fixes the precision at exactly 3 digits.
    expect(
      isoTimestampSchema.safeParse("2024-01-02T03:04:05.678901Z").success,
    ).toBe(false);
  });

  it("rejects calendar dates whose month is out of range", () => {
    // Month 13 is rejected by both the regex layer and `Date.parse`.
    expect(
      isoTimestampSchema.safeParse("2024-13-01T00:00:00.000Z").success,
    ).toBe(false);
    expect(
      isoTimestampSchema.safeParse("2024-99-01T00:00:00.000Z").success,
    ).toBe(false);
    // Note: overflowed days such as "2024-02-30T00:00:00.000Z" are NOT
    // currently rejected because Node's `Date.parse` normalises them
    // (Feb 30 → Mar 1). The schema's docstring claims this case is rejected;
    // tightening that promise belongs in a follow-up to task 2.2.
  });

  it("rejects empty strings and non-strings", () => {
    expect(isoTimestampSchema.safeParse("").success).toBe(false);
    expect(isoTimestampSchema.safeParse(0).success).toBe(false);
    expect(isoTimestampSchema.safeParse(null).success).toBe(false);
  });
});

// ---------- agentMessageSchema (Requirements 10.1, 10.3, 10.4) ----------------

describe("agentMessageSchema (Requirements 10.1, 10.3, 10.4)", () => {
  it("accepts a well-formed Agent_Message", () => {
    const result = agentMessageSchema.safeParse(buildValidAgentMessage());
    expect(result.success).toBe(true);
  });

  describe("type field (Requirement 10.3)", () => {
    it.each(["request", "response", "error", "handoff"])(
      "accepts type '%s'",
      (type) => {
        const result = agentMessageSchema.safeParse(
          buildValidAgentMessage({ type }),
        );
        expect(result.success).toBe(true);
      },
    );

    it.each(["", "REQUEST", "info", "ack", "unknown"])(
      "rejects invalid type '%s'",
      (type) => {
        const result = agentMessageSchema.safeParse(
          buildValidAgentMessage({ type }),
        );
        expect(result.success).toBe(false);
      },
    );

    it("rejects a missing type field", () => {
      const msg = buildValidAgentMessage();
      delete (msg as { type?: unknown }).type;
      expect(agentMessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe("required fields (Requirement 10.1)", () => {
    it.each(["taskId", "sender", "recipient", "type", "payload", "timestamp"])(
      "rejects a message missing required field '%s'",
      (field) => {
        const msg = buildValidAgentMessage();
        delete (msg)[field];
        expect(agentMessageSchema.safeParse(msg).success).toBe(false);
      },
    );

    it("rejects when taskId fails the 1..128 char rule", () => {
      const tooLongTaskId = "x".repeat(TASK_ID_MAX_LENGTH + 1);
      expect(
        agentMessageSchema.safeParse(
          buildValidAgentMessage({ taskId: tooLongTaskId }),
        ).success,
      ).toBe(false);
      expect(
        agentMessageSchema.safeParse(buildValidAgentMessage({ taskId: "" }))
          .success,
      ).toBe(false);
    });

    it("rejects when timestamp fails ISO 8601 UTC ms format", () => {
      expect(
        agentMessageSchema.safeParse(
          buildValidAgentMessage({ timestamp: "not-a-timestamp" }),
        ).success,
      ).toBe(false);
    });

    it("accepts the special 'orchestrator' recipient and any non-empty agentId", () => {
      expect(
        agentMessageSchema.safeParse(
          buildValidAgentMessage({ recipient: "orchestrator" }),
        ).success,
      ).toBe(true);
      expect(
        agentMessageSchema.safeParse(
          buildValidAgentMessage({ recipient: "agent-reviewer" }),
        ).success,
      ).toBe(true);
    });
  });

  describe("payload size (Requirement 10.4)", () => {
    it("accepts a text payload exactly at the 1 MB limit", () => {
      // ASCII characters are 1 byte each in UTF-8, so this hits the cap exactly.
      const text = "a".repeat(AGENT_MESSAGE_PAYLOAD_MAX_BYTES);
      const result = agentMessageSchema.safeParse(
        buildValidAgentMessage({ payload: { kind: "text", text } }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects a text payload one byte above the 1 MB limit", () => {
      const text = "a".repeat(AGENT_MESSAGE_PAYLOAD_MAX_BYTES + 1);
      const result = agentMessageSchema.safeParse(
        buildValidAgentMessage({ payload: { kind: "text", text } }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a binary payload above the 1 MB limit", () => {
      const bytes = new Uint8Array(AGENT_MESSAGE_PAYLOAD_MAX_BYTES + 1);
      const result = agentMessageSchema.safeParse(
        buildValidAgentMessage({
          payload: { kind: "binary", mime: "application/octet-stream", bytes },
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a json payload that serializes to more than 1 MB", () => {
      // A long string inside a JSON value puts the serialized representation
      // above the limit.
      const value = { blob: "a".repeat(AGENT_MESSAGE_PAYLOAD_MAX_BYTES + 1) };
      const result = agentMessageSchema.safeParse(
        buildValidAgentMessage({ payload: { kind: "json", value } }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a binary payload missing its mime type", () => {
      const result = agentMessageSchema.safeParse(
        buildValidAgentMessage({
          payload: { kind: "binary", mime: "", bytes: new Uint8Array(0) },
        }),
      );
      expect(result.success).toBe(false);
    });
  });
});

// ---------- diffPatchSchema ---------------------------------------------------

describe("diffPatchSchema", () => {
  const baseDiff = {
    artifactId: "artifact-1",
    fromVersion: 1,
    toVersion: 2,
    patchText: "@@ -1 +1 @@",
  };

  it("accepts a diff between two distinct versions", () => {
    expect(diffPatchSchema.safeParse(baseDiff).success).toBe(true);
  });

  it("rejects a diff where fromVersion equals toVersion", () => {
    const result = diffPatchSchema.safeParse({
      ...baseDiff,
      fromVersion: 3,
      toVersion: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fromVersion or toVersion below 1", () => {
    expect(
      diffPatchSchema.safeParse({ ...baseDiff, fromVersion: 0 }).success,
    ).toBe(false);
    expect(
      diffPatchSchema.safeParse({ ...baseDiff, toVersion: 0 }).success,
    ).toBe(false);
  });

  it("rejects non-integer versions", () => {
    expect(
      diffPatchSchema.safeParse({ ...baseDiff, fromVersion: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects empty artifactId", () => {
    expect(
      diffPatchSchema.safeParse({ ...baseDiff, artifactId: "" }).success,
    ).toBe(false);
  });
});

// ---------- maxReviewCyclesSchema --------------------------------------------

describe("maxReviewCyclesSchema (Requirement 8.5 boundary)", () => {
  it("accepts 1 (minimum permitted value)", () => {
    expect(maxReviewCyclesSchema.safeParse(1).success).toBe(true);
  });

  it("accepts the documented default of 5", () => {
    expect(maxReviewCyclesSchema.safeParse(5).success).toBe(true);
  });

  it("rejects 0", () => {
    expect(maxReviewCyclesSchema.safeParse(0).success).toBe(false);
  });

  it("rejects negative values", () => {
    expect(maxReviewCyclesSchema.safeParse(-1).success).toBe(false);
    expect(maxReviewCyclesSchema.safeParse(-100).success).toBe(false);
  });

  it("rejects non-integer numbers", () => {
    expect(maxReviewCyclesSchema.safeParse(1.5).success).toBe(false);
    expect(maxReviewCyclesSchema.safeParse(2.0001).success).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(maxReviewCyclesSchema.safeParse(Number.NaN).success).toBe(false);
    expect(
      maxReviewCyclesSchema.safeParse(Number.POSITIVE_INFINITY).success,
    ).toBe(false);
  });

  it("rejects non-number inputs", () => {
    expect(maxReviewCyclesSchema.safeParse("5").success).toBe(false);
    expect(maxReviewCyclesSchema.safeParse(undefined).success).toBe(false);
  });
});

// ---------- fileArtifactSchema (boundary cases) -------------------------------

describe("fileArtifactSchema (boundary cases)", () => {
  const buildVersion = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    version: 1,
    authoredByAgentId: VALID_AGENT_ID,
    contentHash: "sha256:abc",
    bytes: new Uint8Array([1, 2, 3]),
    createdAt: VALID_TIMESTAMP,
    ...overrides,
  });

  const buildArtifact = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    id: "artifact-1",
    taskId: VALID_TASK_ID,
    fileName: "main.ts",
    versions: [buildVersion()],
    ...overrides,
  });

  it("accepts a minimal valid artifact with one version", () => {
    expect(fileArtifactSchema.safeParse(buildArtifact()).success).toBe(true);
  });

  it("accepts an artifact with no versions yet (empty versions array)", () => {
    // Artifact creation may register the artifact before its first write.
    expect(
      fileArtifactSchema.safeParse(buildArtifact({ versions: [] })).success,
    ).toBe(true);
  });

  it("rejects an empty fileName", () => {
    expect(
      fileArtifactSchema.safeParse(buildArtifact({ fileName: "" })).success,
    ).toBe(false);
  });

  it("rejects an empty id", () => {
    expect(
      fileArtifactSchema.safeParse(buildArtifact({ id: "" })).success,
    ).toBe(false);
  });

  it("rejects a version below 1", () => {
    expect(
      fileArtifactSchema.safeParse(
        buildArtifact({ versions: [buildVersion({ version: 0 })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a non-integer version number", () => {
    expect(
      fileArtifactSchema.safeParse(
        buildArtifact({ versions: [buildVersion({ version: 1.5 })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects an empty contentHash", () => {
    expect(
      fileArtifactSchema.safeParse(
        buildArtifact({ versions: [buildVersion({ contentHash: "" })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects an invalid createdAt timestamp", () => {
    expect(
      fileArtifactSchema.safeParse(
        buildArtifact({ versions: [buildVersion({ createdAt: "yesterday" })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a taskId that violates the 1..128 char rule", () => {
    expect(
      fileArtifactSchema.safeParse(buildArtifact({ taskId: "" })).success,
    ).toBe(false);
    expect(
      fileArtifactSchema.safeParse(
        buildArtifact({ taskId: "x".repeat(TASK_ID_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });
});

// ---------- finalReportSchema (boundary cases) --------------------------------

describe("finalReportSchema (boundary cases)", () => {
  const buildReport = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    taskId: VALID_TASK_ID,
    status: "completed",
    originalPrompt: "Implement feature X",
    finalArtifacts: [
      { artifactId: "artifact-1", version: 1, fileName: "main.ts" },
    ],
    bossSummary: "Looks good.",
    participants: [VALID_AGENT_ID],
    reviewCyclesPerformed: 1,
    createdAt: VALID_TIMESTAMP,
    ...overrides,
  });

  it("accepts a valid completed report", () => {
    expect(finalReportSchema.safeParse(buildReport()).success).toBe(true);
  });

  it("accepts a stopped_limit report without bossSummary", () => {
    const report = buildReport({
      status: "stopped_limit",
      outstandingIssues: ["test failure"],
    });
    delete (report as { bossSummary?: unknown }).bossSummary;
    expect(finalReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects an unknown status value", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ status: "in_progress" }))
        .success,
    ).toBe(false);
  });

  it("rejects a report with an empty participants array", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ participants: [] })).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only originalPrompt", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ originalPrompt: "   " }))
        .success,
    ).toBe(false);
  });

  it("rejects a negative reviewCyclesPerformed", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ reviewCyclesPerformed: -1 }))
        .success,
    ).toBe(false);
  });

  it("rejects a non-integer reviewCyclesPerformed", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ reviewCyclesPerformed: 1.5 }))
        .success,
    ).toBe(false);
  });

  it("accepts reviewCyclesPerformed = 0 (lower boundary)", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ reviewCyclesPerformed: 0 }))
        .success,
    ).toBe(true);
  });

  it("rejects an artifact ref with version below 1", () => {
    expect(
      finalReportSchema.safeParse(
        buildReport({
          finalArtifacts: [
            { artifactId: "artifact-1", version: 0, fileName: "main.ts" },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects an invalid createdAt timestamp", () => {
    expect(
      finalReportSchema.safeParse(buildReport({ createdAt: "not-a-time" }))
        .success,
    ).toBe(false);
  });

  it("uses ANOTHER_VALID_TIMESTAMP as a sanity check for valid distinct timestamps", () => {
    // Belt-and-suspenders: confirm both fixture timestamps are accepted.
    expect(
      finalReportSchema.safeParse(buildReport({ createdAt: ANOTHER_VALID_TIMESTAMP }))
        .success,
    ).toBe(true);
  });
});

// ---------- customAgentSchema (boundary cases) --------------------------------

describe("customAgentSchema (boundary cases)", () => {
  const buildAgent = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    id: "custom-1",
    kind: "custom",
    name: "My Helper",
    systemPrompt: "You are a helpful agent.",
    allowedTools: ["web_search"],
    ownerScope: { kind: "local", deviceId: "device-abc" },
    ...overrides,
  });

  it("accepts a minimal valid Custom_Agent", () => {
    expect(customAgentSchema.safeParse(buildAgent()).success).toBe(true);
  });

  it("accepts an agent with an empty allowedTools array", () => {
    // A pure summarisation agent may legitimately request no tools.
    expect(
      customAgentSchema.safeParse(buildAgent({ allowedTools: [] })).success,
    ).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(
      customAgentSchema.safeParse(buildAgent({ name: "" })).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(
      customAgentSchema.safeParse(buildAgent({ name: "   " })).success,
    ).toBe(false);
  });

  it("rejects an empty systemPrompt", () => {
    expect(
      customAgentSchema.safeParse(buildAgent({ systemPrompt: "" })).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only systemPrompt", () => {
    expect(
      customAgentSchema.safeParse(buildAgent({ systemPrompt: "\n\t  " }))
        .success,
    ).toBe(false);
  });

  it("rejects an unknown tool id", () => {
    expect(
      customAgentSchema.safeParse(buildAgent({ allowedTools: ["telnet"] }))
        .success,
    ).toBe(false);
  });

  it("rejects the wrong kind discriminator", () => {
    expect(
      customAgentSchema.safeParse(buildAgent({ kind: "builtin" })).success,
    ).toBe(false);
  });

  it("rejects an invalid ownerScope shape", () => {
    expect(
      customAgentSchema.safeParse(
        buildAgent({ ownerScope: { kind: "local", deviceId: "" } }),
      ).success,
    ).toBe(false);
    expect(
      customAgentSchema.safeParse(
        buildAgent({ ownerScope: { kind: "remote", id: "x" } }),
      ).success,
    ).toBe(false);
  });

  it("accepts a cloud-scoped owner with a non-empty userId", () => {
    expect(
      customAgentSchema.safeParse(
        buildAgent({ ownerScope: { kind: "cloud", userId: "user-1" } }),
      ).success,
    ).toBe(true);
  });
});
