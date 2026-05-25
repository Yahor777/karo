# desktop-windows

Windows Desktop App. This is the **primary** product target. The web app in `apps/web` is a secondary interface.

## Stack

- **Tauri 2** (Rust shell, WebView renderer) — chosen per the design's recommendation: lighter than Electron, smaller memory footprint, safer native bridge model. Electron remains an acceptable fallback documented in `design.md`.
- **TypeScript + Vite** for the renderer. The renderer is framework-free at this scaffolding stage and will host the React shared UI from `@ai-agent-orchestrator/shared-ui` once that package exposes screens.
- **No paid services** are required for the scaffold.

## Layout

```
apps/desktop-windows/
├── index.html               # Main window HTML, strict CSP
├── package.json             # Workspace package + Tauri/Vite scripts
├── tsconfig.json            # Extends repo tsconfig.base.json (strict)
├── vite.config.ts           # Renderer dev server (port 1420)
├── src/
│   ├── index.ts             # Package barrel (re-exports DesktopShell)
│   ├── main.ts              # Renderer entry; wires Tauri invoke into the bridge
│   ├── shell/
│   │   ├── types.ts         # DesktopShell, EncryptedBlob, LocalLogEntry
│   │   ├── nativeBindings.ts# Tauri-invoke layer (stubs reject with NotImplemented)
│   │   ├── bridge.ts        # Single secure entrypoint for UI code
│   │   ├── bridge.test.ts   # Bridge contract tests (Vitest)
│   │   └── index.ts         # Public barrel for the shell module
│   └── ui/
│       ├── bootstrap.ts     # Placeholder bootstrap UI
│       └── main.css         # Minimal styles
└── src-tauri/
    ├── tauri.conf.json      # Tauri 2 config
    ├── Cargo.toml           # Rust dependencies
    ├── build.rs             # tauri-build hook
    ├── capabilities/
    │   └── default.json     # Capability set for the main window
    └── src/
        ├── main.rs          # Binary entry
        └── lib.rs           # IPC commands (stubs mirroring DESKTOP_SHELL_COMMANDS)
```

## Renderer ↔ Shell bridge

The `DesktopShell` interface (see `src/shell/types.ts`) is the contract between the renderer and the native side. UI code consumes it exclusively through `desktopShell` from `./shell` — never via Tauri's `invoke` directly. This keeps the security boundary auditable and lets us swap implementations in tests:

```ts
import { desktopShell } from "./shell";

const deviceId = await desktopShell.getDeviceId();
```

`src/main.ts` wires the real Tauri `invoke` binding into `nativeBindings` exactly once at boot. When the binding is not available (e.g. running renderer tests outside Tauri), every native call rejects with `DesktopShellNotImplementedError` — an intentional signal that the native side is not yet wired.

## Status of native implementations

All Tauri commands in `src-tauri/src/lib.rs` are stubs that return `ShellError::NotImplemented`. Real bodies are landed by:

- task **3.2** — Local Encrypted Storage (`encryptLocalSecret`, `decryptLocalSecret`, `readLocalSetting`, `writeLocalSetting`, `deleteLocalSetting`).
- task **3.3** — Local device id and local logs (`getDeviceId`, `writeLocalLog`).
- task **4.x** — Auth flow uses these primitives.

`exportFile` and `showNotification` are wired to the Tauri dialog/notification plugins in later tasks once a UI flow needs them.

## Scripts

```sh
pnpm --filter @ai-agent-orchestrator/desktop-windows dev              # Tauri dev (full shell + renderer)
pnpm --filter @ai-agent-orchestrator/desktop-windows dev:renderer     # Vite dev server only (renderer, no native shell)
pnpm --filter @ai-agent-orchestrator/desktop-windows build            # tsc + vite build (renderer bundle)
pnpm --filter @ai-agent-orchestrator/desktop-windows build:tauri      # Full Tauri release build (default bundle targets)
pnpm --filter @ai-agent-orchestrator/desktop-windows build:installer  # Windows installer build (msi + nsis)
pnpm --filter @ai-agent-orchestrator/desktop-windows typecheck        # tsc -p tsconfig.json --noEmit
pnpm --filter @ai-agent-orchestrator/desktop-windows test             # Vitest
pnpm --filter @ai-agent-orchestrator/desktop-windows tauri:dev        # Alias of `dev` (kept for back-compat)
pnpm --filter @ai-agent-orchestrator/desktop-windows tauri:build      # Alias of `build:tauri` (kept for back-compat)
```

From the repo root the same flows are available as convenience scripts:

```sh
pnpm run            # alias of `pnpm desktop:dev` — starts the Windows desktop app
pnpm desktop:dev    # `tauri dev` for the desktop-windows package
pnpm desktop:build  # `tauri build --bundles msi,nsis` for the desktop-windows package
```

`dev`, `tauri:dev`, `build:tauri` and `build:installer` require the
Rust toolchain (`rustup`, MSVC build tools on Windows). They are not
invoked during scaffolding tasks and will be exercised end-to-end
starting at task 3.2.

## Releases and auto-update

Release packaging (MSI + NSIS) and the auto-update channel
(`plugins.updater` in `tauri.conf.json` + `tauri-plugin-updater`) are
documented in [`RELEASING.md`](./RELEASING.md). It covers signing key
generation (`TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD`), the manual
publish flow, and the per-OS bucket layout for the signed `latest.json`
manifest.
