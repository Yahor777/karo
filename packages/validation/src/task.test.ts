/**
 * Property tests for `createTaskInputSchema`.
 *
 * Validates: Requirements 6.4, 6.5, 6.6.
 *
 * **Property 3: Empty prompt can never create Task.**
 *   For any whitespace-only string (including ""), `createTaskInputSchema`
 *   rejects the input regardless of how the rest of the input is shaped.
 *   Source: requirements.md → 6.4 ("IF пользователь пытается запустить Task
 *   без введённого промта, THEN ... SHALL отклонить запуск...") and 6.5
 *   ("WHILE поле промта пусто, ... блокировать инициирование Task"). The
 *   schema's `promptSchema` enforces `v.trim().length > 0`, so the property
 *   is "any string whose trimmed form is empty is rejected".
 *
 * **Property 4: Manual_Mode with zero agents can never create Task.**
 *   For any input with `mode: "manual"` and `participants` either an empty
 *   array or omitted entirely, `createTaskInputSchema` rejects the input
 *   regardless of how prompt / modelRef / maxReviewCycles are shaped.
 *   Source: requirements.md → 6.6 ("IF пользователь в Manual_Mode пытается
 *   запустить Task с нулевым числом выбранных агентов, THEN ... SHALL
 *   отклонить запуск и потребовать выбрать хотя бы одного Agent").
 *
 * Each property is annotated with the requirement clause it validates so the
 * traceability matrix in `tasks.md` (task 2.4) stays accurate.
 *
 * Generator notes:
 *  - `arbitraryWhitespaceOnly` mixes the empty string with strings made
 *    purely from JavaScript-trim whitespace characters (space, `\t`, `\n`,
 *    `\r`, `\v`, `\f`, NBSP, ZWNBSP). Without a `\u00a0` / `\ufeff` arm the
 *    test would silently miss the Unicode-whitespace cases that
 *    `String.prototype.trim` strips but a naive `=== ""` check would not.
 *  - `arbitraryNonEmptyPrompt` is used in Property 4 so the prompt itself
 *    cannot be the rejection cause; rejection must come from the
 *    Manual_Mode/zero-agents rule alone. We force at least one
 *    non-whitespace code unit by sandwiching a printable character.
 *  - `arbitraryModelRef` produces a valid `modelRef` so the schema's other
 *    branches don't fire. Property 3 / Property 4 each isolate a single
 *    rejection cause; orthogonal failures would muddle the counter-example.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { createTaskInputSchema } from "./task";

/**
 * Whitespace characters that `String.prototype.trim` removes. Includes the
 * common ASCII set plus a couple of Unicode codepoints (NBSP, ZWNBSP) so the
 * generator covers cases where a UI might silently insert non-breaking
 * spaces.
 */
const TRIM_WHITESPACE_CHARS = [
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u00a0",
  "\ufeff",
] as const;

/**
 * Arbitrary that produces strings whose `.trim()` is empty: either the
 * empty string itself or a string made entirely of whitespace characters.
 *
 * `minLength: 0` ensures `""` is in the support; `maxLength: 16` keeps
 * counter-examples readable when the property fails.
 */
const arbitraryWhitespaceOnly: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TRIM_WHITESPACE_CHARS), {
    minLength: 0,
    maxLength: 16,
  })
  .map((chars) => chars.join(""));

/**
 * Arbitrary that always trims to a non-empty string. We pick a printable
 * ASCII letter and surround it by arbitrary text so the generator covers a
 * variety of prompt shapes while guaranteeing the trim invariant.
 */
const arbitraryNonEmptyPrompt: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ maxLength: 32 }),
    fc.constantFrom("A", "x", "1", "?"),
    fc.string({ maxLength: 32 }),
  )
  .map(([prefix, mid, suffix]) => `${prefix}${mid}${suffix}`);

/** A valid `ModelRef` so that branch can't be the rejection cause. */
const arbitraryModelRef = fc.record({
  provider: fc.constantFrom("openai", "anthropic", "custom-provider"),
  modelId: fc.string({ minLength: 1, maxLength: 32 }),
  source: fc.constantFrom("user-api-key", "platform-fallback"),
});

/** Mode picker; both arms exercise the schema. */
const arbitraryMode = fc.constantFrom("auto", "manual");

/** Optional `maxReviewCycles`: undefined or any integer ≥ 1. */
const arbitraryMaxReviewCycles = fc.option(
  fc.integer({ min: 1, max: 100 }),
  { nil: undefined },
);

/**
 * Participants arm for Property 3: either omitted, empty, or a non-empty
 * list of agent ids. We cover all three to make sure the rejection in
 * Property 3 is driven by the prompt and not by the participants rule.
 */
const arbitraryParticipantsAny = fc.option(
  fc.array(fc.string({ minLength: 1, maxLength: 16 }), { maxLength: 5 }),
  { nil: undefined },
);

/**
 * Participants arm for Property 4: either an empty array or omitted. Both
 * shapes must be rejected when paired with `mode: "manual"`.
 */
const arbitraryEmptyOrMissingParticipants = fc.oneof(
  fc.constant<undefined>(undefined),
  fc.constant<string[]>([]),
);

describe("createTaskInputSchema", () => {
  it("Property 3: empty/whitespace-only prompt is always rejected (Validates: Requirements 6.4, 6.5, 6.6)", () => {
    fc.assert(
      fc.property(
        arbitraryWhitespaceOnly,
        arbitraryModelRef,
        arbitraryMode,
        arbitraryParticipantsAny,
        arbitraryMaxReviewCycles,
        (prompt, modelRef, mode, participants, maxReviewCycles) => {
          const input: Record<string, unknown> = { prompt, modelRef, mode };
          if (participants !== undefined) input.participants = participants;
          if (maxReviewCycles !== undefined) {
            input.maxReviewCycles = maxReviewCycles;
          }

          const result = createTaskInputSchema.safeParse(input);
          if (result.success) {
            throw new Error(
              `Empty/whitespace prompt unexpectedly accepted: ${JSON.stringify({
                prompt,
                mode,
                participants,
              })}`,
            );
          }
          // Sanity: at least one issue must be on the prompt path. Other
          // issues (e.g. Manual_Mode / participants) may also be present and
          // are allowed — Property 3 only promises rejection.
          const promptIssue = result.error.issues.find((iss) =>
            iss.path.includes("prompt"),
          );
          expect(promptIssue, JSON.stringify(result.error.issues)).toBeDefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 4: Manual_Mode with zero/omitted participants is always rejected (Validates: Requirements 6.6)", () => {
    fc.assert(
      fc.property(
        arbitraryNonEmptyPrompt,
        arbitraryModelRef,
        arbitraryEmptyOrMissingParticipants,
        arbitraryMaxReviewCycles,
        (prompt, modelRef, participants, maxReviewCycles) => {
          const input: Record<string, unknown> = {
            prompt,
            modelRef,
            mode: "manual",
          };
          if (participants !== undefined) input.participants = participants;
          if (maxReviewCycles !== undefined) {
            input.maxReviewCycles = maxReviewCycles;
          }

          const result = createTaskInputSchema.safeParse(input);
          if (result.success) {
            throw new Error(
              `Manual_Mode with zero agents unexpectedly accepted: ${JSON.stringify(
                { prompt, participants },
              )}`,
            );
          }
          // The participants rule is the rejection cause we care about;
          // because the prompt is forced non-empty and the modelRef is
          // valid, no other rule should fire.
          const participantsIssue = result.error.issues.find((iss) =>
            iss.path.includes("participants"),
          );
          expect(
            participantsIssue,
            JSON.stringify(result.error.issues),
          ).toBeDefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  // ---- minimal sanity examples ---------------------------------------------
  // These confirm the schema accepts straightforward valid inputs so the
  // properties above are not vacuously true (i.e. rejecting *everything*).

  it("accepts a well-formed Auto_Mode input without participants", () => {
    const result = createTaskInputSchema.safeParse({
      prompt: "Write a hello-world script.",
      modelRef: {
        provider: "openai",
        modelId: "gpt-4",
        source: "user-api-key",
      },
      mode: "auto",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed Manual_Mode input with one participant", () => {
    const result = createTaskInputSchema.safeParse({
      prompt: "Write a hello-world script.",
      modelRef: {
        provider: "openai",
        modelId: "gpt-4",
        source: "user-api-key",
      },
      mode: "manual",
      participants: ["agent-coder"],
    });
    expect(result.success).toBe(true);
  });
});
