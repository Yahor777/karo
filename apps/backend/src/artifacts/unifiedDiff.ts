/**
 * Minimal inline unified-diff helper for `ArtifactStore.getDiff` (task 10.2).
 *
 * The Artifact Store needs a textual diff between two versions of the same
 * `File_Artifact` (design.md → "Artifact Store" → "Interface", `getDiff`).
 * The task brief asks for a small inline implementation rather than a third-
 * party dependency, so we provide a pure helper here and keep the store
 * itself free of formatting concerns.
 *
 * Algorithm: classic line-level Longest Common Subsequence (LCS) via dynamic
 * programming, then a back-walk to produce an edit script of `equal` /
 * `delete` / `insert` operations. The script is grouped into hunks with
 * `contextLines` lines of unchanged context around each change cluster,
 * and adjacent clusters are merged when the gap between them is too small
 * to justify a fresh hunk header. Output is plain unified-diff format with
 * `--- old`, `+++ new`, and `@@ -a,b +c,d @@` headers — the same shape
 * `git diff` produces, so any reader (UI, log scraper, test) can recognise
 * it without bespoke parsing.
 *
 * Notes / scope:
 *
 *   • Pure function. No I/O, no clock, no global state.
 *   • Identical inputs return an empty string. Callers (the Artifact Store)
 *     pass the empty string straight through to `DiffPatch.patchText`; the
 *     `diffPatchSchema` in `@ai-agent-orchestrator/validation` accepts an
 *     empty `patchText`.
 *   • Line-level granularity only. Word/character-level diffs and binary
 *     diffs are out of scope — the caller decodes bytes as UTF-8 first.
 *   • Hunk header counts are emitted as `,N` always (never the abbreviated
 *     single-line form). The output is meant for human reading and tests,
 *     not for `patch -p` application, so this minor non-conformance does
 *     not matter.
 *   • LCS DP is O(m·n) time and memory in the number of lines. That is
 *     more than enough for File_Artifact sizes that flow through Coder /
 *     Fixer in practice. If extreme inputs ever land here, swap in Myers'
 *     O((m+n)·D) algorithm without changing the caller-visible API.
 *
 * Validates: Requirements 11.4 (explicit-version-pair diff), 11.5 (diff is
 * computed only on explicit request — this helper exists to be called from
 * `ArtifactStore.getDiff` and nowhere else).
 */

/** A single edit-script entry. Indices are 0-based into the input arrays. */
type EditOp =
  | { readonly kind: "equal"; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: "delete"; readonly oldIndex: number }
  | { readonly kind: "insert"; readonly newIndex: number };

export interface UnifiedDiffOptions {
  /** Number of unchanged lines kept around each change cluster. Default: 3. */
  readonly contextLines?: number;
  /** Label rendered in the `---` header. Default: "old". */
  readonly oldLabel?: string;
  /** Label rendered in the `+++` header. Default: "new". */
  readonly newLabel?: string;
}

/**
 * Returns a unified diff between `oldText` and `newText`.
 *
 * Returns the empty string when the two inputs are byte-identical. The
 * caller MUST treat empty output as "no diff" rather than as an error —
 * idempotent writes (Property 6, task 10.4) make same-content versions
 * impossible in practice, but defensive callers should still handle the
 * trivial case gracefully.
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {},
): string {
  if (oldText === newText) {
    return "";
  }

  const contextLines = Math.max(0, options.contextLines ?? 3);
  const oldLabel = options.oldLabel ?? "old";
  const newLabel = options.newLabel ?? "new";

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const ops = computeEditScript(oldLines, newLines);
  if (!ops.some((op) => op.kind !== "equal")) {
    return "";
  }

  const hunks = groupHunks(ops, contextLines);
  if (hunks.length === 0) {
    return "";
  }

  return renderUnifiedDiff(hunks, ops, oldLines, newLines, oldLabel, newLabel);
}

/**
 * Builds the edit script via LCS dynamic programming.
 *
 * The DP table is stored flat (`(m+1)·(n+1)` ints in a single typed array)
 * so the strict `noUncheckedIndexedAccess` setting does not force a forest
 * of `!` assertions on a nested-array shape — flat indexing through an
 * `Int32Array` returns plain `number` values directly.
 */
function computeEditScript(
  oldLines: readonly string[],
  newLines: readonly string[],
): EditOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  const stride = n + 1;
  const table = new Int32Array((m + 1) * stride);

  for (let i = 1; i <= m; i += 1) {
    const rowOffset = i * stride;
    const prevRowOffset = (i - 1) * stride;
    for (let j = 1; j <= n; j += 1) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        table[rowOffset + j] = (table[prevRowOffset + (j - 1)] as number) + 1;
      } else {
        const up = table[prevRowOffset + j] as number;
        const left = table[rowOffset + (j - 1)] as number;
        table[rowOffset + j] = up >= left ? up : left;
      }
    }
  }

  const ops: EditOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ kind: "equal", oldIndex: i - 1, newIndex: j - 1 });
      i -= 1;
      j -= 1;
      continue;
    }

    // Tie-break order matches `diff(1)`: prefer deletions over insertions
    // when LCS counts agree. This produces stable, human-readable output.
    const up = i > 0 ? (table[(i - 1) * stride + j] as number) : -1;
    const left = j > 0 ? (table[i * stride + (j - 1)] as number) : -1;

    if (j > 0 && (i === 0 || left >= up)) {
      ops.push({ kind: "insert", newIndex: j - 1 });
      j -= 1;
    } else {
      ops.push({ kind: "delete", oldIndex: i - 1 });
      i -= 1;
    }
  }

  ops.reverse();
  return ops;
}

interface Hunk {
  /** First op index (inclusive) of this hunk in the global edit script. */
  readonly lo: number;
  /** Last op index (inclusive) of this hunk in the global edit script. */
  readonly hi: number;
}

/**
 * Builds a list of hunk index-ranges over the edit script.
 *
 * Each change op (insert/delete) is expanded by `contextLines` neighbours on
 * each side, then overlapping or back-to-back ranges are merged. The
 * resulting ranges are non-overlapping and sorted left-to-right.
 */
function groupHunks(ops: readonly EditOp[], contextLines: number): Hunk[] {
  const ranges: Array<{ lo: number; hi: number }> = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as EditOp;
    if (op.kind === "equal") continue;

    const lo = Math.max(0, i - contextLines);
    const hi = Math.min(ops.length - 1, i + contextLines);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, hi);
    } else {
      ranges.push({ lo, hi });
    }
  }
  return ranges.map((r) => ({ lo: r.lo, hi: r.hi }));
}

/**
 * Renders the unified-diff text for a list of hunks.
 *
 * Header line counts are computed from the ops in the hunk:
 *
 *   • `oldCount` = equal + delete ops in the hunk.
 *   • `newCount` = equal + insert ops in the hunk.
 *
 * Start line numbers come from the first old/new line referenced in the
 * hunk (1-based). When a count is 0 the start is set to 0 so the header
 * still parses as `,0` cleanly.
 */
function renderUnifiedDiff(
  hunks: readonly Hunk[],
  ops: readonly EditOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
  oldLabel: string,
  newLabel: string,
): string {
  const out: string[] = [];
  out.push(`--- ${oldLabel}`);
  out.push(`+++ ${newLabel}`);

  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    let oldStartSet = false;
    let newStartSet = false;
    const body: string[] = [];

    for (let k = hunk.lo; k <= hunk.hi; k += 1) {
      const op = ops[k] as EditOp;
      switch (op.kind) {
        case "equal": {
          if (!oldStartSet) {
            oldStart = op.oldIndex + 1;
            oldStartSet = true;
          }
          if (!newStartSet) {
            newStart = op.newIndex + 1;
            newStartSet = true;
          }
          oldCount += 1;
          newCount += 1;
          body.push(` ${oldLines[op.oldIndex] as string}`);
          break;
        }
        case "delete": {
          if (!oldStartSet) {
            oldStart = op.oldIndex + 1;
            oldStartSet = true;
          }
          oldCount += 1;
          body.push(`-${oldLines[op.oldIndex] as string}`);
          break;
        }
        case "insert": {
          if (!newStartSet) {
            newStart = op.newIndex + 1;
            newStartSet = true;
          }
          newCount += 1;
          body.push(`+${newLines[op.newIndex] as string}`);
          break;
        }
      }
    }

    out.push(`@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`);
    out.push(...body);
  }

  return out.join("\n");
}
