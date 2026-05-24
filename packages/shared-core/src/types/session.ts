/**
 * User account and session types.
 *
 * Source: design.md → "Data Models" → "User" and "Session".
 *
 * `User` represents a Gmail-bound account. `googleSub` is the stable Google
 * subject identifier used to restore an account on subsequent sign-ins.
 * Local API-key-only sessions do not have a `User` record.
 *
 * `Session` covers both local and cloud sessions. The `kind` field is the
 * discriminant; `userId` is set for cloud sessions and `deviceId` is set
 * for local sessions. Per Requirement 2.5 the session response must never
 * carry the API key.
 */

export type User = {
  id: string;
  googleSub?: string;
  email?: string;
  createdAt: string;
};

export type SessionKind = "local" | "cloud";

export type Session = {
  id: string;
  kind: SessionKind;
  userId?: string;
  deviceId?: string;
  createdAt: string;
  expiresAt?: string;
};
