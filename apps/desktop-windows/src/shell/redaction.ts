/**
 * PII / secret redaction for local log entries.
 *
 * Task 20.1 moved the canonical implementation into
 * `packages/shared-core/src/redaction.ts` so the same masking applies
 * across the Desktop Shell, the backend gateway and the Trace Event
 * Bus. This module is now a thin pass-through that:
 *
 *   • re-exports {@link redactString} and {@link redactValue} from
 *     shared-core so existing renderer call sites keep working;
 *   • keeps {@link redactLogEntry} here because it consumes the
 *     desktop-only {@link LocalLogEntry} type and is not needed by the
 *     backend or web shells.
 *
 * The Desktop Shell is the only place on the Windows side that
 * persists logs to disk. Before any `LocalLogEntry` crosses the
 * IPC boundary we strip values that look like API keys, tokens or
 * email addresses so they cannot end up in `app.log` and leak via
 * support bundles or stack traces. Per the design document
 * (`design.md` → "Desktop Shell" → "Security rules"):
 *
 *   - Sensitive logs must redact API keys.
 *   - Full API keys must never be displayed after initial entry time.
 *
 * Validates: Requirements 1.4, 1.6, 4.5.
 */

import {
  redactString,
  redactValue,
} from "@ai-agent-orchestrator/shared-core";

import type { LocalLogEntry } from "./types.js";

export { redactString, redactValue };

/**
 * Returns a copy of `entry` with `message` and `context` redacted.
 * The remaining fields (`level`, `at`) are non-sensitive and are
 * preserved verbatim.
 */
export function redactLogEntry(entry: LocalLogEntry): LocalLogEntry {
  const redactedMessage = redactString(entry.message);
  if (entry.context === undefined) {
    return {
      level: entry.level,
      message: redactedMessage,
      at: entry.at,
    };
  }
  return {
    level: entry.level,
    message: redactedMessage,
    context: redactValue(entry.context),
    at: entry.at,
  };
}
