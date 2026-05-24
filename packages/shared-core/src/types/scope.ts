/**
 * Scope of stored settings and secrets.
 *
 * Source: design.md → "Shared Core" → "Example types" and
 * "Data Models" → "Scope".
 *
 * A `Scope` is either device-local (API-key-only mode, no Gmail account) or
 * cloud (Gmail-bound user account, sync-eligible). The discriminant `kind`
 * lets storage adapters route requests to Local Encrypted Storage or
 * Cloud Settings Store respectively.
 */

export type LocalScope = {
  kind: "local";
  deviceId: string;
};

export type CloudScope = {
  kind: "cloud";
  userId: string;
};

export type Scope = LocalScope | CloudScope;
