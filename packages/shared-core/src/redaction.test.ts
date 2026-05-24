/**
 * Unit tests for the shared-core redaction utilities (task 20.1).
 *
 * Sources:
 *   • design.md → "Desktop Shell" → "Security rules" (no API keys in
 *     local logs).
 *   • design.md → "Settings Store" → "Rules" (decrypted API_Key never
 *     returned to client; API_Key cloud sync requires explicit user
 *     confirmation).
 *   • requirements.md → 1.6, 3.7, 4.5.
 *
 * Coverage:
 *   • `redactString` masks every supported secret/PII shape (sk-…,
 *     OpenAI org keys, Anthropic / Bearer / JWT / Google OAuth /
 *     Stripe / GitHub / AWS / opaque 40+ char tokens).
 *   • `redactRecord` walks JSON-shaped data, redacts strings, masks
 *     `Uint8Array` / `ArrayBuffer` payloads as
 *     `[redacted-binary:<n>-bytes]`, short-circuits on cycles and
 *     terminates at the configured depth bound.
 *   • `redactStructuredError` produces `{ code, message, details? }`
 *     envelopes whose `code` defaults to `"unknown"` when the input
 *     does not carry a string `code`, never throws, and redacts all
 *     three fields.
 *   • Parity check: the shared-core helper produces identical output
 *     to the legacy Desktop Shell helper for the same input.
 *
 * Validates: Requirements 1.6, 3.7, 4.5.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_REDACT_RECORD_MAX_DEPTH,
  redactRecord,
  redactString,
  redactStructuredError,
  redactValue,
} from "./redaction.js";

// ---------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------

describe("redactString", () => {
  it("redacts OpenAI sk- keys (including sk-proj- and sk-ant-)", () => {
    expect(
      redactString("sk-ABCDEFGHIJKLMNOPQRSTUVWX after"),
    ).toBe("[REDACTED:api_key:openai] after");
    expect(redactString("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(
      "[REDACTED:api_key:openai]",
    );
    expect(redactString("sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(
      "[REDACTED:api_key:openai]",
    );
  });

  it("redacts OpenAI organisation ids", () => {
    expect(redactString("org=org-ABCDEFGHIJKLMNOPQRSTUV done")).toBe(
      "org=[REDACTED:api_key:openai_org] done",
    );
  });

  it("redacts Authorization: Bearer ... headers", () => {
    expect(
      redactString("Authorization: Bearer abc.def-ghi_jkl/mn=op+qr"),
    ).toBe("Authorization: [REDACTED:token:bearer]");
    // Lower-case `bearer` is also covered by the rule.
    expect(redactString("bearer abcdefghij")).toBe("[REDACTED:token:bearer]");
  });

  it("redacts JWT-shaped values", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36";
    expect(redactString(`auth ${jwt} done`)).toBe(
      "auth [REDACTED:token:jwt] done",
    );
  });

  it("redacts Google OAuth access tokens (ya29.…)", () => {
    expect(
      redactString("access=ya29.abcdefghijklmnopqrstuvwx done"),
    ).toBe("access=[REDACTED:token:google_oauth] done");
  });

  it("redacts Google refresh tokens (1//…)", () => {
    expect(
      redactString("refresh 1//abcdefghijklmnopqrstuvwx ok"),
    ).toBe("refresh [REDACTED:token:google_refresh] ok");
  });

  it("redacts Stripe keys, GitHub tokens and AWS access key ids", () => {
    expect(redactString("k=" + ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"))).toBe(
      "k=[REDACTED:api_key:stripe]",
    );
    expect(
      redactString("token=ghp_0123456789abcdefghijklmnopqrstuv0123 ok"),
    ).toBe("token=[REDACTED:api_key:github] ok");
    expect(redactString("aws=AKIAIOSFODNN7EXAMPLE end")).toBe(
      "aws=[REDACTED:api_key:aws] end",
    );
  });

  it("redacts generic 40+ char alphanumeric tokens", () => {
    const opaque = "0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(redactString(`token=${opaque} done`)).toBe(
      "token=[REDACTED:token:opaque] done",
    );
  });

  it("preserves text that does not match any rule", () => {
    expect(redactString("nothing to redact here")).toBe(
      "nothing to redact here",
    );
    expect(redactString("")).toBe("");
  });

  it("redacts every occurrence in a single pass", () => {
    expect(
      redactString(
        "sk-ABCDEFGHIJKLMNOPQRSTUVWX and sk-ZYXWVUTSRQPONMLKJIHGFEDCBA",
      ),
    ).toBe("[REDACTED:api_key:openai] and [REDACTED:api_key:openai]");
  });
});

// ---------------------------------------------------------------------
// redactRecord
// ---------------------------------------------------------------------

describe("redactRecord", () => {
  it("redacts strings and walks arrays element-wise", () => {
    expect(
      redactRecord([
        "hello",
        "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
        ["nested", "user@example.com"],
      ]),
    ).toEqual([
      "hello",
      "[REDACTED:api_key:openai]",
      ["nested", "[REDACTED:email]"],
    ]);
  });

  it("walks plain objects without redacting their keys", () => {
    expect(
      redactRecord({
        provider: "openai",
        apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
        meta: { contact: "alice@example.com", count: 3 },
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "[REDACTED:api_key:openai]",
      meta: { contact: "[REDACTED:email]", count: 3 },
    });
  });

  it("preserves primitives (number, boolean, bigint, null, undefined)", () => {
    expect(redactRecord(42)).toBe(42);
    expect(redactRecord(true)).toBe(true);
    expect(redactRecord(false)).toBe(false);
    expect(redactRecord(null)).toBeNull();
    expect(redactRecord(undefined)).toBeUndefined();
    expect(redactRecord(BigInt(7))).toBe(BigInt(7));
  });

  it("replaces Uint8Array payloads with [redacted-binary:<n>-bytes]", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(redactRecord(bytes)).toBe("[redacted-binary:4-bytes]");
    expect(
      redactRecord({ payload: new Uint8Array(16), label: "blob" }),
    ).toEqual({
      payload: "[redacted-binary:16-bytes]",
      label: "blob",
    });
  });

  it("replaces ArrayBuffer payloads with [redacted-binary:<n>-bytes]", () => {
    expect(redactRecord(new ArrayBuffer(8))).toBe(
      "[redacted-binary:8-bytes]",
    );
  });

  it("substitutes [REDACTED:cycle] when an object is reachable from itself", () => {
    type Node = { name: string; self?: Node };
    const node: Node = { name: "loop" };
    node.self = node;

    const out = redactRecord(node) as { name: string; self: unknown };
    expect(out.name).toBe("loop");
    expect(out.self).toBe("[REDACTED:cycle]");
  });

  it("substitutes [REDACTED:unsupported] for functions and symbols", () => {
    expect(redactRecord(() => 1)).toBe("[REDACTED:unsupported]");
    expect(redactRecord(Symbol("k"))).toBe("[REDACTED:unsupported]");
  });

  it("terminates at the supplied depth bound", () => {
    const chain = {
      level0: {
        level1: {
          level2: {
            level3: { secret: "deep" },
          },
        },
      },
    };
    const out = redactRecord(chain, 2) as Record<string, unknown>;
    const level0 = out["level0"] as Record<string, unknown>;
    const level1 = level0["level1"];
    expect(level1).toBe("[REDACTED:max_depth]");
  });

  it("uses a default depth of DEFAULT_REDACT_RECORD_MAX_DEPTH (4)", () => {
    expect(DEFAULT_REDACT_RECORD_MAX_DEPTH).toBe(4);
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const out = redactRecord(deep) as Record<string, unknown>;
    const a = out["a"] as Record<string, unknown>;
    const b = a["b"] as Record<string, unknown>;
    const c = b["c"] as Record<string, unknown>;
    const d = c["d"];
    expect(d).toBe("[REDACTED:max_depth]");
  });

  it("treats a negative depth bound as 0", () => {
    expect(redactRecord({ x: 1 }, -3)).toBe("[REDACTED:max_depth]");
  });

  it("does not mutate the input value", () => {
    const input = {
      apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      tags: ["a", "b"],
    };
    const before = JSON.parse(JSON.stringify(input)) as typeof input;
    redactRecord(input);
    expect(input).toEqual(before);
  });
});

// ---------------------------------------------------------------------
// redactStructuredError
// ---------------------------------------------------------------------

describe("redactStructuredError", () => {
  it("preserves a string `code` field on Error subclasses", () => {
    class MyError extends Error {
      public readonly code = "settings_load_failed";
    }
    const out = redactStructuredError(
      new MyError("upstream said sk-ABCDEFGHIJKLMNOPQRSTUVWX"),
    );
    expect(out.code).toBe("settings_load_failed");
    expect(out.message).toBe("upstream said [REDACTED:api_key:openai]");
    expect(out.details).toBeUndefined();
  });

  it("classifies missing/non-string code as 'unknown'", () => {
    const e = new Error("boom");
    expect(redactStructuredError(e)).toEqual({
      code: "unknown",
      message: "boom",
    });

    const numCoded = Object.assign(new Error("nope"), { code: 42 });
    expect(redactStructuredError(numCoded)).toEqual({
      code: "unknown",
      message: "nope",
    });
  });

  it("redacts the message regardless of where the secret lives", () => {
    const out = redactStructuredError(
      new Error("authorization=Bearer abcdefghij"),
    );
    expect(out.code).toBe("unknown");
    expect(out.message).toBe("authorization=[REDACTED:token:bearer]");
  });

  it("redacts a `details` field via redactRecord when present", () => {
    const err = Object.assign(new Error("provider rejected key"), {
      code: "invalid_api_key",
      details: {
        provider: "openai",
        apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      },
    });
    const out = redactStructuredError(err);
    expect(out).toEqual({
      code: "invalid_api_key",
      message: "provider rejected key",
      details: {
        provider: "openai",
        apiKey: "[REDACTED:api_key:openai]",
      },
    });
  });

  it("handles a string thrown value", () => {
    expect(redactStructuredError("sk-ABCDEFGHIJKLMNOPQRSTUVWX")).toEqual({
      code: "unknown",
      message: "[REDACTED:api_key:openai]",
    });
  });

  it("handles plain objects with `code` / `message` / `details`", () => {
    const out = redactStructuredError({
      code: "rate_limited",
      message: "try again later sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      details: { tries: 3 },
    });
    expect(out).toEqual({
      code: "rate_limited",
      message: "try again later [REDACTED:api_key:openai]",
      details: { tries: 3 },
    });
  });

  it("handles null / undefined / numbers without throwing", () => {
    expect(redactStructuredError(null)).toEqual({
      code: "unknown",
      message: "",
    });
    expect(redactStructuredError(undefined)).toEqual({
      code: "unknown",
      message: "",
    });
    expect(redactStructuredError(42)).toEqual({
      code: "unknown",
      message: "42",
    });
  });

  it("never throws when an accessor on the input throws", () => {
    const evil = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(evil, "code", {
      get() {
        throw new Error("trap");
      },
    });
    Object.defineProperty(evil, "message", {
      get() {
        throw new Error("trap");
      },
    });

    const out = redactStructuredError(evil);
    expect(out.code).toBe("unknown");
    expect(typeof out.message).toBe("string");
  });
});

// ---------------------------------------------------------------------
// Parity with the legacy Desktop Shell helper
// ---------------------------------------------------------------------

describe("parity between redactValue and redactRecord on shallow input", () => {
  it("produces identical output for the same shallow input", () => {
    const input = {
      provider: "openai",
      apiKey: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      meta: { contact: "alice@example.com", count: 3 },
    };
    expect(redactRecord(input)).toEqual(redactValue(input));
  });
});