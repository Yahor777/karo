/**
 * Unit tests for the local-log redaction helpers.
 *
 * The Desktop Shell is the only place on the Windows side that
 * persists logs to disk, and the design document forbids API key
 * material from ever appearing in those logs (see `design.md` →
 * "Desktop Shell" → "Security rules" and Requirement 1.6). These
 * tests pin down the policy implemented in `redaction.ts`:
 *
 *   • `redactString` recognises every supported secret/PII shape
 *     listed by `RULES` and replaces them with `[REDACTED:<tag>]`.
 *   • `redactValue` walks structured data, including arrays,
 *     plain objects, cycles and exotic types, without throwing.
 *   • `redactLogEntry` preserves non-sensitive metadata (`level`,
 *     `at`) verbatim and runs both `message` and `context`
 *     through the redactor.
 *
 * Validates: Requirements 1.6, 4.5.
 */

import { describe, expect, it } from "vitest";

import { redactLogEntry, redactString, redactValue } from "./redaction.js";
import type { LocalLogEntry } from "./types.js";

describe("redactString", () => {
  it("redacts OpenAI sk- keys", () => {
    const out = redactString(
      "calling provider with sk-ABCDEFGHIJKLMNOPQRSTUVWX now",
    );
    expect(out).toBe("calling provider with [REDACTED:api_key:openai] now");
  });

  it("redacts OpenAI sk-proj- and sk-ant- prefixed keys", () => {
    const a = redactString("sk-proj-abcdefghijklmnopqrstuvwxYZ12");
    const b = redactString("sk-ant-abcdefghijklmnopqrstuvwxYZ12");
    expect(a).toBe("[REDACTED:api_key:openai]");
    expect(b).toBe("[REDACTED:api_key:openai]");
  });

  it("redacts Stripe sk_test, sk_live, pk_test and pk_live keys", () => {
    const cases = [
      ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["pk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["pk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
    ];
    for (const value of cases) {
      expect(redactString(`secret=${value}`)).toBe(
        "secret=[REDACTED:api_key:stripe]",
      );
    }
  });

  it("redacts GitHub gh*_ tokens with all five recognised prefixes", () => {
    const prefixes = ["ghp", "gho", "ghu", "ghs", "ghr"] as const;
    const body = "0123456789abcdefghijklmnopqrstuv"; // 32 chars > 30 floor
    for (const prefix of prefixes) {
      const token = `${prefix}_${body}`;
      expect(redactString(`token=${token} suffix`)).toBe(
        "token=[REDACTED:api_key:github] suffix",
      );
    }
  });

  it("redacts AWS access key ids (AKIA + 16 uppercase alphanumerics)", () => {
    expect(redactString("aws=AKIAIOSFODNN7EXAMPLE end")).toBe(
      "aws=[REDACTED:api_key:aws] end",
    );
  });

  it("does not redact strings that look like AWS keys but are too short", () => {
    expect(redactString("AKIA1234")).toBe("AKIA1234");
  });

  it("redacts JWT-shaped values with three base64url segments", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36";
    expect(redactString(`auth ${jwt} done`)).toBe("auth [REDACTED:token:jwt] done");
  });

  it("redacts Authorization: Bearer ... headers", () => {
    expect(
      redactString("Authorization: Bearer abc.def-ghi_jkl/mn=op+qr"),
    ).toBe("Authorization: [REDACTED:token:bearer]");
    // Lower-case 'bearer' is also covered by the rule.
    expect(redactString("bearer abcdefghij")).toBe("[REDACTED:token:bearer]");
  });

  it("redacts generic 40+ char alphanumeric tokens", () => {
    // 48 hex chars — common opaque API token shape.
    const opaque = "0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(redactString(`token=${opaque} done`)).toBe(
      "token=[REDACTED:token:opaque] done",
    );
  });

  it("does not redact short alphanumerics under the 40-char threshold", () => {
    // 39 chars — below the floor.
    const shortish = "0123456789abcdef0123456789abcdef0123456";
    expect(redactString(shortish)).toBe(shortish);
  });

  it("redacts email addresses", () => {
    expect(redactString("contact alice.example+kiro@mail.example.com please"))
      .toBe("contact [REDACTED:email] please");
  });

  it("does not redact host-only forms without a dot in the domain", () => {
    expect(redactString("user@host")).toBe("user@host");
  });

  it("redacts every occurrence in a single pass (global flag)", () => {
    const out = redactString(
      "first sk-ABCDEFGHIJKLMNOPQRSTUVWX and second sk-ZYXWVUTSRQPONMLKJIHGFEDCBA",
    );
    expect(out).toBe(
      "first [REDACTED:api_key:openai] and second [REDACTED:api_key:openai]",
    );
  });

  it("preserves text that does not match any rule", () => {
    expect(redactString("nothing to redact here")).toBe("nothing to redact here");
    expect(redactString("")).toBe("");
  });

  it("prefers the most specific tag when multiple rules could match", () => {
    // A Stripe-shaped key would also satisfy the generic 40+ rule
    // when concatenated, so this guards the rule ordering in `RULES`.
    const value = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc1234567890"].join("_");
    expect(redactString(value)).toBe("[REDACTED:api_key:stripe]");
  });
});

describe("redactValue", () => {
  it("passes primitives other than strings through unchanged", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(false)).toBe(false);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(BigInt(7))).toBe(BigInt(7));
  });

  it("redacts strings and walks arrays element-wise", () => {
    const out = redactValue([
      "hello",
      "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      42,
      ["nested", "user@example.com"],
    ]);
    expect(out).toEqual([
      "hello",
      "[REDACTED:api_key:openai]",
      42,
      ["nested", "[REDACTED:email]"],
    ]);
  });

  it("walks plain objects without redacting their keys", () => {
    const out = redactValue({
      provider: "openai",
      apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      meta: { contact: "alice@example.com", count: 3 },
    });
    expect(out).toEqual({
      provider: "openai",
      apiKey: "[REDACTED:api_key:openai]",
      meta: { contact: "[REDACTED:email]", count: 3 },
    });
  });

  it("substitutes [REDACTED:cycle] when an object is reachable from itself", () => {
    type Node = { name: string; self?: Node };
    const node: Node = { name: "loop" };
    node.self = node;

    const out = redactValue(node) as { name: string; self: unknown };
    expect(out.name).toBe("loop");
    expect(out.self).toBe("[REDACTED:cycle]");
  });

  it("substitutes [REDACTED:unsupported] for functions and symbols", () => {
    expect(redactValue(() => 1)).toBe("[REDACTED:unsupported]");
    expect(redactValue(Symbol("k"))).toBe("[REDACTED:unsupported]");
  });

  it("does not mutate the input value", () => {
    const input = {
      apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      tags: ["a", "b"],
    };
    const before = JSON.parse(JSON.stringify(input)) as typeof input;
    redactValue(input);
    expect(input).toEqual(before);
  });
});

describe("redactLogEntry", () => {
  it("preserves level and at and redacts message", () => {
    const entry: LocalLogEntry = {
      level: "warn",
      message: "auth failed for sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      at: "2025-01-01T00:00:00.000Z",
    };
    const out = redactLogEntry(entry);
    expect(out).toEqual({
      level: "warn",
      message: "auth failed for [REDACTED:api_key:openai]",
      at: "2025-01-01T00:00:00.000Z",
    });
    // No `context` key on either side.
    expect("context" in out).toBe(false);
  });

  it("redacts both message and context when context is present", () => {
    const entry: LocalLogEntry = {
      level: "error",
      message: "provider call failed",
      context: {
        provider: "openai",
        apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
        user: { email: "alice@example.com" },
      },
      at: "2025-01-02T00:00:00.000Z",
    };
    const out = redactLogEntry(entry);
    expect(out).toEqual({
      level: "error",
      message: "provider call failed",
      context: {
        provider: "openai",
        apiKey: "[REDACTED:api_key:openai]",
        user: { email: "[REDACTED:email]" },
      },
      at: "2025-01-02T00:00:00.000Z",
    });
  });

  it("returns a new object and leaves the input unchanged", () => {
    const entry: LocalLogEntry = {
      level: "info",
      message: "tokens=" +
        "0123456789abcdef0123456789abcdef0123456789abcdef",
      context: { detail: "alice@example.com" },
      at: "2025-01-03T00:00:00.000Z",
    };
    const before = JSON.stringify(entry);
    const out = redactLogEntry(entry);
    // Source untouched.
    expect(JSON.stringify(entry)).toBe(before);
    // Output redacted.
    expect(out.message).toBe("tokens=[REDACTED:token:opaque]");
    expect(out.context).toEqual({ detail: "[REDACTED:email]" });
  });
});