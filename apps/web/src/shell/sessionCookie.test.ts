/**
 * Unit tests for the Web Shell session-cookie helpers (task 18.1).
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 *
 * Verifies that:
 *   • `Set-Cookie` defaults are HttpOnly + Secure + SameSite=Lax.
 *   • Cookie name uses `__Host-` prefix.
 *   • `Domain` cannot be set on a `__Host-` cookie.
 *   • Already-expired sessions are rejected.
 *   • `writeSessionCookie` works with a stub `res`.
 *   • `readSessionCookie` parses the incoming `Cookie` header.
 *   • `clearSessionCookie` produces a `Max-Age=0` header.
 *
 * No DOM is required.
 */

import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  buildClearCookieHeader,
  buildSetCookieHeader,
  clearSessionCookie,
  readSessionCookie,
  writeSessionCookie,
} from "./sessionCookie.js";
import type { HttpResponseLike, Session } from "./types.js";

interface RecordedHeader {
  readonly name: string;
  readonly value: string | readonly string[];
}

function makeStubResponse(): HttpResponseLike & {
  readonly headers: RecordedHeader[];
  readonly body: { value: string | undefined };
} {
  const headers: RecordedHeader[] = [];
  const body = { value: undefined as string | undefined };
  return {
    statusCode: 200,
    headers,
    body,
    setHeader(name, value) {
      headers.push({ name, value });
    },
    end(maybeBody) {
      body.value = maybeBody;
    },
  };
}

const SAMPLE_SESSION: Session = {
  id: "sess_abc-123",
  kind: "cloud",
  userId: "user_42",
  createdAt: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-01-02T00:00:00.000Z",
};

describe("SESSION_COOKIE_NAME", () => {
  it("uses the __Host- prefix", () => {
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
  });
});

describe("buildSetCookieHeader", () => {
  it("emits HttpOnly + Secure + SameSite=Lax + Path=/ by default", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const header = buildSetCookieHeader(SAMPLE_SESSION, {}, now);

    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
  });

  it("URL-encodes the session id", () => {
    const session: Session = { ...SAMPLE_SESSION, id: "a b/c" };
    const header = buildSetCookieHeader(session, {}, new Date("2025-01-01T00:00:00.000Z"));
    expect(header.split(";")[0]).toBe(
      `${SESSION_COOKIE_NAME}=a%20b%2Fc`,
    );
  });

  it("computes Max-Age from session.expiresAt", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const header = buildSetCookieHeader(SAMPLE_SESSION, {}, now);
    expect(header).toContain("Max-Age=86400"); // 24 h
  });

  it("rejects an already-expired session", () => {
    const session: Session = {
      ...SAMPLE_SESSION,
      expiresAt: "2024-01-01T00:00:00.000Z",
    };
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() => buildSetCookieHeader(session, {}, now)).toThrow(/expired/);
  });

  it("forbids Domain on __Host- cookies", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() =>
      buildSetCookieHeader(SAMPLE_SESSION, { domain: "example.com" }, now),
    ).toThrow(/Domain/);
  });

  it("forbids non-/ path on __Host- cookies", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() =>
      buildSetCookieHeader(SAMPLE_SESSION, { path: "/api" }, now),
    ).toThrow(/Path=\//);
  });

  it("forbids disabling Secure on __Host- cookies", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() =>
      buildSetCookieHeader(SAMPLE_SESSION, { secure: false }, now),
    ).toThrow(/Secure/);
  });

  it("rejects setting both maxAgeSeconds and expires", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() =>
      buildSetCookieHeader(
        SAMPLE_SESSION,
        { maxAgeSeconds: 60, expires: new Date("2025-01-02T00:00:00.000Z") },
        now,
      ),
    ).toThrow();
  });

  it("rejects an empty session id", () => {
    const session: Session = { ...SAMPLE_SESSION, id: "" };
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() => buildSetCookieHeader(session, {}, now)).toThrow(/non-empty/);
  });
});

describe("buildClearCookieHeader", () => {
  it("produces a Max-Age=0 header that also includes Expires", () => {
    const header = buildClearCookieHeader();
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Expires=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
  });
});

describe("writeSessionCookie", () => {
  it("appends Set-Cookie onto a stub response", () => {
    const res = makeStubResponse();
    writeSessionCookie(
      res,
      SAMPLE_SESSION,
      {},
      new Date("2025-01-01T00:00:00.000Z"),
    );
    const setCookieHeaders = res.headers.filter((h) => h.name === "Set-Cookie");
    expect(setCookieHeaders).toHaveLength(1);
    const value = setCookieHeaders[0]!.value;
    expect(Array.isArray(value)).toBe(true);
    expect((value as readonly string[])[0]).toContain(SESSION_COOKIE_NAME);
  });

  it("uses res.appendHeader when available", () => {
    const calls: string[] = [];
    const res: HttpResponseLike = {
      statusCode: 200,
      setHeader: () => {
        throw new Error("setHeader should not be called when appendHeader is available");
      },
      appendHeader: (name, value) => {
        calls.push(`${name}:${Array.isArray(value) ? value.join(",") : String(value)}`);
      },
      end: () => {},
    };
    writeSessionCookie(
      res,
      SAMPLE_SESSION,
      {},
      new Date("2025-01-01T00:00:00.000Z"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toContain("Set-Cookie:");
  });
});

describe("clearSessionCookie", () => {
  it("emits a Max-Age=0 Set-Cookie", () => {
    const res = makeStubResponse();
    clearSessionCookie(res);
    const header = res.headers.find((h) => h.name === "Set-Cookie")!;
    const value = (header.value as readonly string[])[0]!;
    expect(value).toContain("Max-Age=0");
  });
});

describe("readSessionCookie", () => {
  it("returns null when the header is missing", () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie("")).toBeNull();
  });

  it("returns null when the session cookie is not present", () => {
    expect(readSessionCookie("foo=bar; baz=qux")).toBeNull();
  });

  it("returns the URL-decoded session id when the cookie is present", () => {
    const cookieHeader = `other=ignored; ${SESSION_COOKIE_NAME}=sess_abc-123; trailing=ok`;
    expect(readSessionCookie(cookieHeader)).toBe("sess_abc-123");
  });

  it("URL-decodes the value", () => {
    const cookieHeader = `${SESSION_COOKIE_NAME}=a%20b%2Fc`;
    expect(readSessionCookie(cookieHeader)).toBe("a b/c");
  });
});
