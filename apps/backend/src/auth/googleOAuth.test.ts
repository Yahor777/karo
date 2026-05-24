/**
 * Unit tests for Google OAuth handshake (task 17.1).
 *
 * Covers:
 *   • State validation: rejects unknown / expired / replayed state.
 *   • Authorization URL contains exactly the minimal scopes
 *     (`openid email profile`) and never carries Gmail send/read scopes.
 *   • A new Google `sub` creates a User; a returning `sub` restores the
 *     existing User without creating a duplicate.
 *   • Session response carries no token/code material.
 *   • In-memory state store enforces single-use semantics independently
 *     of the service.
 *   • Concurrent find-or-create race: the service falls back to a
 *     second `findByGoogleSub` if `create` rejects, so the caller never
 *     sees a uniqueness error.
 *
 * Validates: Requirements 3.1, 3.2.
 */

import { describe, expect, it } from "vitest";

import {
  GoogleOAuthError,
  GoogleOAuthService,
  type GoogleOAuthClient,
  InMemoryOAuthStateStore,
  InMemoryUserStore,
  MINIMAL_GOOGLE_SCOPES,
  type GoogleTokenResponse,
  type GoogleUserInfo,
  type UserStore,
} from "./googleOAuth.js";
import type { Session, User } from "@ai-agent-orchestrator/shared-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2025-01-01T00:00:00.000Z");

class StubOAuthClient implements GoogleOAuthClient {
  public exchangeCalls: Array<{
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
  }> = [];
  public userInfoCalls: Array<{ accessToken: string }> = [];

  private exchangeImpl: (input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
  }) => Promise<GoogleTokenResponse> = async () => ({
    accessToken: "stub-access-token",
  });

  private userInfoImpl: (input: {
    accessToken: string;
  }) => Promise<GoogleUserInfo> = async () => ({
    sub: "google-sub-default",
    email: "user@example.com",
  });

  public setExchange(
    impl: (input: {
      code: string;
      redirectUri: string;
      clientId: string;
      clientSecret?: string;
    }) => Promise<GoogleTokenResponse>,
  ): void {
    this.exchangeImpl = impl;
  }

  public setUserInfo(
    impl: (input: { accessToken: string }) => Promise<GoogleUserInfo>,
  ): void {
    this.userInfoImpl = impl;
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly signal?: AbortSignal;
  }): Promise<GoogleTokenResponse> {
    const recorded: {
      code: string;
      redirectUri: string;
      clientId: string;
      clientSecret?: string;
    } = {
      code: input.code,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
    };
    if (input.clientSecret !== undefined) {
      recorded.clientSecret = input.clientSecret;
    }
    this.exchangeCalls.push(recorded);
    return this.exchangeImpl({
      code: input.code,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      ...(input.clientSecret !== undefined
        ? { clientSecret: input.clientSecret }
        : {}),
    });
  }

  public async fetchUserInfo(input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<GoogleUserInfo> {
    this.userInfoCalls.push({ accessToken: input.accessToken });
    return this.userInfoImpl({ accessToken: input.accessToken });
  }
}

interface ServiceContext {
  readonly stateStore: InMemoryOAuthStateStore;
  readonly userStore: InMemoryUserStore;
  readonly oauthClient: StubOAuthClient;
  readonly clock: { now: Date };
  readonly service: GoogleOAuthService;
}

function buildService(
  overrides: Partial<{
    stateTtlMs: number;
    sessionTtlMs: number;
    initialNow: Date;
    userStore: UserStore;
    sessionIds: string[];
    states: string[];
  }> = {},
): ServiceContext {
  const stateStore = new InMemoryOAuthStateStore();
  const userStore =
    (overrides.userStore as InMemoryUserStore | undefined) ??
    new InMemoryUserStore();
  const oauthClient = new StubOAuthClient();
  const clock = { now: overrides.initialNow ?? FIXED_NOW };
  const stateQueue = [...(overrides.states ?? [])];
  const sessionQueue = [...(overrides.sessionIds ?? [])];

  const service = new GoogleOAuthService({
    stateStore,
    userStore,
    oauthClient,
    clientId: "client-123.apps.googleusercontent.com",
    redirectUri: "https://app.example.com/oauth/callback",
    ...(overrides.stateTtlMs !== undefined
      ? { stateTtlMs: overrides.stateTtlMs }
      : {}),
    ...(overrides.sessionTtlMs !== undefined
      ? { sessionTtlMs: overrides.sessionTtlMs }
      : {}),
    now: () => clock.now,
    generateState: () =>
      stateQueue.length > 0
        ? (stateQueue.shift() as string)
        : `state-${String(Math.random()).slice(2)}`,
    generateSessionId: () =>
      sessionQueue.length > 0
        ? (sessionQueue.shift() as string)
        : `sess_test_${String(Math.random()).slice(2)}`,
  });
  return {
    stateStore,
    userStore: userStore,
    oauthClient,
    clock,
    service,
  };
}

// ---------------------------------------------------------------------------
// Tests: beginGoogleOAuth
// ---------------------------------------------------------------------------

describe("GoogleOAuthService.beginGoogleOAuth", () => {
  it("returns an authorization URL with exactly the minimal scopes", async () => {
    const { service } = buildService({ states: ["state-A"] });
    const { authorizationUrl, state } = await service.beginGoogleOAuth();

    expect(state).toBe("state-A");

    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(
      "client-123.apps.googleusercontent.com",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-A");

    const scopeParam = url.searchParams.get("scope") ?? "";
    const requestedScopes = scopeParam.split(" ").filter((s) => s.length > 0);

    // Exactly the minimal set, in any order, with no extras.
    expect(new Set(requestedScopes)).toEqual(new Set(MINIMAL_GOOGLE_SCOPES));
    expect(requestedScopes).toHaveLength(MINIMAL_GOOGLE_SCOPES.length);
  });

  it("never requests any Gmail send/read scope", async () => {
    const { service } = buildService();
    const { authorizationUrl } = await service.beginGoogleOAuth();
    const url = new URL(authorizationUrl);
    const scope = url.searchParams.get("scope") ?? "";

    // Spot-check the entire Gmail scope namespace and the broader
    // restricted scope namespace. None of these should ever appear.
    const forbiddenSubstrings = [
      "https://www.googleapis.com/auth/gmail",
      "gmail.send",
      "gmail.compose",
      "gmail.modify",
      "gmail.readonly",
      "gmail.metadata",
      "https://mail.google.com",
    ];
    for (const forbidden of forbiddenSubstrings) {
      expect(scope.includes(forbidden)).toBe(false);
    }
  });

  it("issues distinct states across calls", async () => {
    const { service } = buildService({
      states: ["state-A", "state-B", "state-C"],
    });
    const a = await service.beginGoogleOAuth();
    const b = await service.beginGoogleOAuth();
    const c = await service.beginGoogleOAuth();
    expect(new Set([a.state, b.state, c.state]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: completeGoogleOAuth — state validation
// ---------------------------------------------------------------------------

describe("GoogleOAuthService.completeGoogleOAuth — state validation", () => {
  it("rejects an unknown state with `invalid_state` and never calls Google", async () => {
    const { service, oauthClient } = buildService();

    await expect(
      service.completeGoogleOAuth({ code: "auth-code", state: "never-issued" }),
    ).rejects.toMatchObject({
      name: "GoogleOAuthError",
      code: "invalid_state",
    });
    expect(oauthClient.exchangeCalls).toHaveLength(0);
    expect(oauthClient.userInfoCalls).toHaveLength(0);
  });

  it("rejects an expired state with `expired_state`", async () => {
    const { service, clock } = buildService({
      states: ["state-A"],
      stateTtlMs: 60_000,
    });
    await service.beginGoogleOAuth();

    // Advance past TTL.
    clock.now = new Date(FIXED_NOW.getTime() + 5 * 60_000);

    await expect(
      service.completeGoogleOAuth({ code: "auth-code", state: "state-A" }),
    ).rejects.toMatchObject({ code: "expired_state" });
  });

  it("rejects replayed state on the second call (single-use semantics)", async () => {
    const {
      service,
      oauthClient,
      userStore,
    } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => ({ sub: "sub-A", email: "a@x.test" }));

    // First call succeeds.
    const session = await service.completeGoogleOAuth({
      code: "code-1",
      state: "state-A",
    });
    expect(session.userId).toBeDefined();
    expect(userStore.size()).toBe(1);

    // Second call with the same state must be rejected before any
    // outbound HTTP call. We assert by checking that no additional
    // exchange happened.
    const exchangesBefore = oauthClient.exchangeCalls.length;
    await expect(
      service.completeGoogleOAuth({ code: "code-2", state: "state-A" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(oauthClient.exchangeCalls.length).toBe(exchangesBefore);
  });

  it("rejects empty state without calling Google", async () => {
    const { service, oauthClient } = buildService();
    await expect(
      service.completeGoogleOAuth({ code: "code-1", state: "" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(oauthClient.exchangeCalls).toHaveLength(0);
  });

  it("rejects empty code with `code_exchange_failed`", async () => {
    const { service, oauthClient } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    await expect(
      service.completeGoogleOAuth({ code: "", state: "state-A" }),
    ).rejects.toMatchObject({ code: "code_exchange_failed" });
    expect(oauthClient.exchangeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: completeGoogleOAuth — User find-or-create
// ---------------------------------------------------------------------------

describe("GoogleOAuthService.completeGoogleOAuth — user find-or-create", () => {
  it("creates a new User on first sight of a Google sub", async () => {
    const { service, userStore, oauthClient } = buildService({
      states: ["state-A"],
    });
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => ({
      sub: "sub-fresh",
      email: "new@example.com",
    }));

    expect(userStore.size()).toBe(0);

    const session = await service.completeGoogleOAuth({
      code: "auth-code",
      state: "state-A",
    });

    expect(session.kind).toBe("cloud");
    expect(session.userId).toBeDefined();
    expect(userStore.size()).toBe(1);
    const user = await userStore.findByGoogleSub("sub-fresh");
    expect(user).not.toBeNull();
    expect(user?.id).toBe(session.userId);
    expect(user?.email).toBe("new@example.com");
    expect(user?.googleSub).toBe("sub-fresh");
  });

  it("restores the existing User when the same Google sub returns", async () => {
    const { service, userStore, oauthClient, clock } = buildService({
      states: ["state-A", "state-B"],
    });

    // First login: create user.
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => ({
      sub: "sub-stable",
      email: "first@example.com",
    }));
    const first = await service.completeGoogleOAuth({
      code: "code-1",
      state: "state-A",
    });

    // Second login from a different "device" / time: same sub.
    clock.now = new Date(FIXED_NOW.getTime() + 60 * 1000);
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => ({
      sub: "sub-stable",
      // Even if Google would echo a different email later, we don't
      // mutate the stored record here — find-or-create is read-only
      // for existing users in this minimal task scope.
      email: "different@example.com",
    }));
    const second = await service.completeGoogleOAuth({
      code: "code-2",
      state: "state-B",
    });

    expect(userStore.size()).toBe(1);
    expect(second.userId).toBe(first.userId);
    const restored = await userStore.findByGoogleSub("sub-stable");
    expect(restored?.email).toBe("first@example.com");
  });

  it("falls back to a second findByGoogleSub when create races with another caller", async () => {
    // Build a UserStore stub that simulates a concurrent insert: the
    // first findByGoogleSub returns null, then create rejects with a
    // uniqueness-shaped error, then the second findByGoogleSub returns
    // the racing caller's record. The service must surface that record
    // rather than the create error.
    const racingUser: User = {
      id: "user_race_winner",
      googleSub: "sub-race",
      email: "race@example.com",
      createdAt: FIXED_NOW.toISOString(),
    };
    let findCalls = 0;
    const racingStore: UserStore = {
      findByGoogleSub: async () => {
        findCalls += 1;
        if (findCalls === 1) {
          return null;
        }
        return racingUser;
      },
      create: async () => {
        throw new Error("UNIQUE constraint failed: users.google_sub");
      },
    };

    const { service, oauthClient } = buildService({
      states: ["state-A"],
      userStore: racingStore,
    });
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => ({
      sub: "sub-race",
      email: "race@example.com",
    }));

    const session = await service.completeGoogleOAuth({
      code: "auth-code",
      state: "state-A",
    });

    expect(session.userId).toBe("user_race_winner");
    expect(findCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: completeGoogleOAuth — failures from Google
// ---------------------------------------------------------------------------

describe("GoogleOAuthService.completeGoogleOAuth — Google failures", () => {
  it("surfaces token-exchange failure as `code_exchange_failed`", async () => {
    const { service, oauthClient } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    oauthClient.setExchange(async () => {
      throw new Error("invalid_grant");
    });

    await expect(
      service.completeGoogleOAuth({ code: "bad-code", state: "state-A" }),
    ).rejects.toMatchObject({ code: "code_exchange_failed" });
  });

  it("treats an empty access token as `code_exchange_failed`", async () => {
    const { service, oauthClient } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    oauthClient.setExchange(async () => ({ accessToken: "" }));

    await expect(
      service.completeGoogleOAuth({ code: "auth-code", state: "state-A" }),
    ).rejects.toMatchObject({ code: "code_exchange_failed" });
  });

  it("surfaces userinfo failure as `userinfo_failed`", async () => {
    const { service, oauthClient } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => {
      throw new Error("403 Forbidden");
    });
    await expect(
      service.completeGoogleOAuth({ code: "auth-code", state: "state-A" }),
    ).rejects.toMatchObject({ code: "userinfo_failed" });
  });

  it("treats a missing `sub` as `userinfo_failed`", async () => {
    const { service, oauthClient } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    oauthClient.setUserInfo(async () => ({ sub: "", email: "x@y.test" }));
    await expect(
      service.completeGoogleOAuth({ code: "auth-code", state: "state-A" }),
    ).rejects.toMatchObject({ code: "userinfo_failed" });
  });

  it("translates a network-shaped TypeError into `provider_unreachable`", async () => {
    const { service, oauthClient } = buildService({ states: ["state-A"] });
    await service.beginGoogleOAuth();
    oauthClient.setExchange(async () => {
      // Node's `fetch` surfaces network failures as TypeError.
      const e = new TypeError("fetch failed");
      throw e;
    });
    await expect(
      service.completeGoogleOAuth({ code: "auth-code", state: "state-A" }),
    ).rejects.toMatchObject({ code: "provider_unreachable" });
  });
});

// ---------------------------------------------------------------------------
// Tests: Session response shape
// ---------------------------------------------------------------------------

describe("GoogleOAuthService.completeGoogleOAuth — Session shape", () => {
  it("returns a cloud Session with no token/code material", async () => {
    const { service, oauthClient } = buildService({
      states: ["state-A"],
      sessionIds: ["sess_test_1"],
    });
    await service.beginGoogleOAuth();
    oauthClient.setExchange(async () => ({
      accessToken: "ya29.SECRET",
      idToken: "id-tok-SECRET",
    }));
    oauthClient.setUserInfo(async () => ({
      sub: "sub-fresh",
      email: "user@example.com",
    }));

    const session: Session = await service.completeGoogleOAuth({
      code: "auth-code-SECRET",
      state: "state-A",
    });

    expect(session.id).toBe("sess_test_1");
    expect(session.kind).toBe("cloud");
    expect(session.userId).toBeDefined();
    expect(session.deviceId).toBeUndefined();

    const serialized = JSON.stringify(session);
    // Fail loudly if any token or code leaks through the session
    // surface — the design rule is "API_Key/secrets must never be
    // included in Session response".
    expect(serialized.includes("ya29.SECRET")).toBe(false);
    expect(serialized.includes("id-tok-SECRET")).toBe(false);
    expect(serialized.includes("auth-code-SECRET")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: InMemoryOAuthStateStore (port-level invariants)
// ---------------------------------------------------------------------------

describe("InMemoryOAuthStateStore", () => {
  it("first consume returns ok exactly once; second consume is unknown", async () => {
    const store = new InMemoryOAuthStateStore();
    const created = FIXED_NOW;
    const expires = new Date(FIXED_NOW.getTime() + 60_000);
    await store.issue({ state: "S", createdAt: created, expiresAt: expires });

    const r1 = await store.consume("S", FIXED_NOW);
    expect(r1).toEqual({ ok: true, createdAt: created });

    const r2 = await store.consume("S", FIXED_NOW);
    expect(r2).toEqual({ ok: false, reason: "unknown" });
  });

  it("consume returns expired and removes the entry past TTL", async () => {
    const store = new InMemoryOAuthStateStore();
    await store.issue({
      state: "S",
      createdAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 1_000),
    });
    const r = await store.consume("S", new Date(FIXED_NOW.getTime() + 5_000));
    expect(r).toEqual({ ok: false, reason: "expired" });
    // A subsequent consume sees no entry — single-use even on expiry.
    const r2 = await store.consume("S", new Date(FIXED_NOW.getTime() + 5_000));
    expect(r2).toEqual({ ok: false, reason: "unknown" });
    expect(store.size()).toBe(0);
  });

  it("rejects empty state", async () => {
    const store = new InMemoryOAuthStateStore();
    await expect(
      store.issue({
        state: "",
        createdAt: FIXED_NOW,
        expiresAt: new Date(FIXED_NOW.getTime() + 1_000),
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects expiresAt <= createdAt", async () => {
    const store = new InMemoryOAuthStateStore();
    await expect(
      store.issue({
        state: "S",
        createdAt: FIXED_NOW,
        expiresAt: FIXED_NOW,
      }),
    ).rejects.toThrow(/strictly after/);
  });
});

// ---------------------------------------------------------------------------
// Tests: GoogleOAuthError shape
// ---------------------------------------------------------------------------

describe("GoogleOAuthError", () => {
  it("carries a typed code and is an Error subclass", () => {
    const err = new GoogleOAuthError("invalid_state", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GoogleOAuthError");
    expect(err.code).toBe("invalid_state");
    expect(err.message).toBe("msg");
  });
});
