/**
 * Unit tests for the Web Shell OAuth callback handler (task 18.1).
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 *
 * Verifies:
 *   • A successful handshake writes the session cookie + 302 redirect.
 *   • Missing `code` / `state` produce 400 with structured JSON.
 *   • A non-GET method is rejected with 405.
 *   • A failure from `completeGoogleOAuth` is surfaced as 401.
 *   • The OAuth port is invoked with the parsed `code` / `state`.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_POST_LOGIN_REDIRECT,
  handleOAuthCallback,
} from "./oauthCallback.js";
import { SESSION_COOKIE_NAME } from "./sessionCookie.js";
import type {
  HttpRequestLike,
  HttpResponseLike,
  OAuthCompleter,
  Session,
} from "./types.js";

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

function findHeader(
  res: ReturnType<typeof makeStubResponse>,
  name: string,
): string | string[] | undefined {
  const header = res.headers.find((h) => h.name === name);
  if (!header) return undefined;
  return Array.isArray(header.value) ? [...header.value] : (header.value as string);
}

const SAMPLE_SESSION: Session = {
  id: "sess_xyz",
  kind: "cloud",
  userId: "user_99",
  createdAt: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-01-02T00:00:00.000Z",
};

function makeSuccessOAuth(session: Session = SAMPLE_SESSION): OAuthCompleter {
  return {
    completeGoogleOAuth: vi.fn(async () => session),
  };
}

function makeReq(url: string, method: string = "GET"): HttpRequestLike {
  return { url, method };
}

describe("handleOAuthCallback (success path)", () => {
  it("writes the session cookie and redirects to /tasks by default", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    const result = await handleOAuthCallback(
      makeReq("/oauth/callback?code=goog-code&state=goog-state"),
      res,
      { oauth, now: () => new Date("2025-01-01T00:00:00.000Z") },
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.redirectTo).toBe(DEFAULT_POST_LOGIN_REDIRECT);
      expect(result.session).toBe(SAMPLE_SESSION);
    }

    expect(res.statusCode).toBe(302);
    expect(findHeader(res, "Location")).toBe("/tasks");
    expect(findHeader(res, "Cache-Control")).toBe("no-store");

    const setCookie = findHeader(res, "Set-Cookie") as string[] | undefined;
    expect(setCookie).toBeDefined();
    expect(setCookie!.length).toBe(1);
    const cookie = setCookie![0]!;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("invokes the OAuth port with parsed code and state", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    await handleOAuthCallback(
      makeReq("/oauth/callback?code=GOOG_CODE&state=GOOG_STATE"),
      res,
      { oauth, now: () => new Date("2025-01-01T00:00:00.000Z") },
    );
    expect(oauth.completeGoogleOAuth).toHaveBeenCalledWith({
      code: "GOOG_CODE",
      state: "GOOG_STATE",
    });
  });

  it("respects a custom successRedirect", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    await handleOAuthCallback(
      makeReq("/oauth/callback?code=c&state=s"),
      res,
      {
        oauth,
        successRedirect: "/dashboard",
        now: () => new Date("2025-01-01T00:00:00.000Z"),
      },
    );
    expect(findHeader(res, "Location")).toBe("/dashboard");
  });

  it("rejects an off-host successRedirect", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    await expect(
      handleOAuthCallback(
        makeReq("/oauth/callback?code=c&state=s"),
        res,
        {
          oauth,
          successRedirect: "//evil.example.com/path",
          now: () => new Date("2025-01-01T00:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(/successRedirect/);
  });
});

describe("handleOAuthCallback (failure paths)", () => {
  it("returns 405 for non-GET methods without invoking OAuth", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    const result = await handleOAuthCallback(
      makeReq("/oauth/callback?code=c&state=s", "POST"),
      res,
      { oauth },
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("invalid_method");
      expect(result.status).toBe(405);
    }
    expect(res.statusCode).toBe(405);
    expect(oauth.completeGoogleOAuth).not.toHaveBeenCalled();
  });

  it("returns 400 when code is missing", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    const result = await handleOAuthCallback(
      makeReq("/oauth/callback?state=only-state"),
      res,
      { oauth },
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("missing_code");
    }
    expect(res.statusCode).toBe(400);
    expect(oauth.completeGoogleOAuth).not.toHaveBeenCalled();
  });

  it("returns 400 when state is missing", async () => {
    const res = makeStubResponse();
    const oauth = makeSuccessOAuth();
    const result = await handleOAuthCallback(
      makeReq("/oauth/callback?code=only-code"),
      res,
      { oauth },
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("missing_state");
    }
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 when the OAuth port throws", async () => {
    const res = makeStubResponse();
    const oauth: OAuthCompleter = {
      completeGoogleOAuth: vi.fn(async () => {
        throw new Error("state replayed");
      }),
    };
    const onError = vi.fn();
    const result = await handleOAuthCallback(
      makeReq("/oauth/callback?code=c&state=s"),
      res,
      { oauth, onError },
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("oauth_failed");
      expect(result.status).toBe(401);
      expect(result.message).toContain("state replayed");
    }
    expect(res.statusCode).toBe(401);
    expect(findHeader(res, "Content-Type")).toContain("application/json");
    expect(res.body.value).toContain("oauth_failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not write the session cookie on failure", async () => {
    const res = makeStubResponse();
    const oauth: OAuthCompleter = {
      completeGoogleOAuth: vi.fn(async () => {
        throw new Error("invalid state");
      }),
    };
    await handleOAuthCallback(
      makeReq("/oauth/callback?code=c&state=s"),
      res,
      { oauth },
    );
    expect(findHeader(res, "Set-Cookie")).toBeUndefined();
  });
});

describe("handleOAuthCallback (settings_load_failed branch — Requirement 3.5)", () => {
  it("returns 503 with HTML and Retry-After when OAuth throws settings_load_failed", async () => {
    const res = makeStubResponse();
    const oauth: OAuthCompleter = {
      completeGoogleOAuth: vi.fn(async () => {
        const err = new Error("cloud settings backend unreachable") as Error & {
          code: string;
        };
        err.code = "settings_load_failed";
        throw err;
      }),
    };
    const onError = vi.fn();
    const result = await handleOAuthCallback(
      makeReq("/oauth/callback?code=c&state=s"),
      res,
      { oauth, onError },
    );
    expect(result.kind).toBe("settings_load_failed");
    if (result.kind === "settings_load_failed") {
      expect(result.status).toBe(503);
      expect(result.message.toLowerCase()).toContain("retry later");
    }

    expect(res.statusCode).toBe(503);
    expect(findHeader(res, "Content-Type")).toContain("text/html");
    expect(findHeader(res, "Retry-After")).toBe("60");
    expect(findHeader(res, "Cache-Control")).toBe("no-store");
    expect(res.body.value?.toLowerCase()).toContain("retry later");
    expect(res.body.value).toContain("/login");
  });

  it("does not write the session cookie when settings_load_failed is hit", async () => {
    const res = makeStubResponse();
    const oauth: OAuthCompleter = {
      completeGoogleOAuth: vi.fn(async () => {
        throw Object.assign(new Error("storage outage"), {
          code: "settings_load_failed",
        });
      }),
    };
    await handleOAuthCallback(
      makeReq("/oauth/callback?code=c&state=s"),
      res,
      { oauth },
    );
    expect(findHeader(res, "Set-Cookie")).toBeUndefined();
  });
});
