/**
 * Runtime environment and app target types.
 *
 * Source: design.md → "Runtime Environments" and "Shared Core" → "Example types".
 *
 * `AppTarget` distinguishes the two product surfaces. Windows Desktop App is the
 * primary product; Web App is the secondary interface.
 *
 * `RuntimeEnvironment` is a discriminated union of capability descriptors. The
 * `target` field is the discriminant. Each capability is encoded as a literal
 * boolean so that consumers can rely on compile-time narrowing — for example,
 * code paths that touch local encrypted storage can require
 * `supportsLocalEncryptedStorage: true`, which is satisfied only by the
 * Windows Desktop variant.
 */

export type AppTarget = "windows-desktop" | "web";

export type WindowsDesktopRuntimeEnvironment = {
  target: "windows-desktop";
  supportsLocalEncryptedStorage: true;
  supportsCloudSync: true;
  supportsNativeLogs: true;
  supportsDesktopNotifications: true;
};

export type WebRuntimeEnvironment = {
  target: "web";
  supportsLocalEncryptedStorage: false;
  supportsCloudSync: true;
  supportsNativeLogs: false;
  supportsDesktopNotifications: false;
};

export type RuntimeEnvironment =
  | WindowsDesktopRuntimeEnvironment
  | WebRuntimeEnvironment;
