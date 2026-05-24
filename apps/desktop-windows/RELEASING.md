# Releasing the Windows Desktop App

This document describes the release flow for `@ai-agent-orchestrator/desktop-windows`.
It complements `tauri.conf.json` (`bundle.*` and `plugins.updater`) and
the Rust setup in `src-tauri/Cargo.toml` + `src-tauri/src/lib.rs`.

The Windows Desktop App is the **primary** product target (Requirements 1.1, 1.3, 1.4).
The release flow below is what makes it installable and self-updating
on a user's Windows PC without depending on the hosted Web App.

## Toolchain

A release build needs the following on the build machine:

- Rust toolchain (`rustup` + stable MSVC target) — install from <https://rustup.rs>.
- Microsoft C++ Build Tools (Windows 10/11 SDK + MSVC v143 or newer).
- Node.js ≥ 18.18 and `pnpm@9` (declared in the root `package.json`).
- Tauri CLI — installed automatically as a workspace dev dependency
  (`@tauri-apps/cli`); no global install needed.

The CI build is triggered manually for now (see "Publishing a new version" below).

## Bundle targets

`tauri.conf.json` ships two Windows installer targets:

- **MSI** (`bundle.windows.wix`) — for managed deployments and the
  classic `msiexec`/Group Policy flow.
- **NSIS** (`bundle.windows.nsis`) — installs into the current user's
  profile (`installMode: "currentUser"`), no admin elevation required.
  This is the recommended target for individual users.

Both are produced by:

```sh
pnpm desktop:build
# expands to:
# pnpm --filter @ai-agent-orchestrator/desktop-windows build:installer
# which runs `tauri build --bundles msi,nsis`
```

The artifacts land under
`apps/desktop-windows/src-tauri/target/release/bundle/{msi,nsis}/`.

## Signing keys for the auto-update channel

The updater plugin is enabled in `tauri.conf.json` (`plugins.updater`).
Tauri requires every update artifact to be signed with an Ed25519 key
that the running app embeds as `pubkey`. The matching private key
**must never** be committed and is only loaded into the build via
environment variables.

### One-time: generate the signing key pair

```sh
# Generates a fresh key pair in ~/.tauri/.
pnpm --filter @ai-agent-orchestrator/desktop-windows tauri signer generate -w ~/.tauri/aiao-updater.key
```

The command prints the **base64 public key**. Paste it into
`tauri.conf.json` → `plugins.updater.pubkey`, replacing the
`REPLACE_WITH_BASE64_TAURI_PUBLIC_KEY` placeholder. Commit the
public-key change. The private key (`~/.tauri/aiao-updater.key`) and
its password stay on the release operator's machine (or in the CI
secret store) — never in the repo.

### Per-build: export the secret env vars

Before running `tauri build`, export the private key and its password.
The CLI reads both:

```sh
# Bash / Zsh / WSL
export TAURI_PRIVATE_KEY="$(cat ~/.tauri/aiao-updater.key)"
export TAURI_KEY_PASSWORD="<password chosen at generate time>"
```

```powershell
# PowerShell
$env:TAURI_PRIVATE_KEY = (Get-Content $HOME\.tauri\aiao-updater.key -Raw)
$env:TAURI_KEY_PASSWORD = '<password chosen at generate time>'
```

If `TAURI_PRIVATE_KEY` is not set, `tauri build` still produces
installers but skips the updater signature, and clients running the
released build will refuse the update.

## Publishing a new version (manual)

The auto-update channel is currently published manually. Each release
does the following:

1. Bump `version` in `apps/desktop-windows/package.json`,
   `apps/desktop-windows/src-tauri/tauri.conf.json` and
   `apps/desktop-windows/src-tauri/Cargo.toml`. Versions must agree.
2. Export `TAURI_PRIVATE_KEY` and `TAURI_KEY_PASSWORD` (see above).
3. Run `pnpm desktop:build` from the repo root. This produces:
   - `…/bundle/msi/AI Agent Orchestrator_<version>_x64_en-US.msi`
   - `…/bundle/msi/AI Agent Orchestrator_<version>_x64_en-US.msi.sig`
   - `…/bundle/nsis/AI Agent Orchestrator_<version>_x64-setup.exe`
   - `…/bundle/nsis/AI Agent Orchestrator_<version>_x64-setup.exe.sig`
4. Upload the installer + its `.sig` file to the update bucket.
5. Generate / update the signed `latest.json` manifest (see layout below).
6. Verify by installing the previous version, then triggering the
   updater dialog from the running app.

A `release.yml` GitHub Action that automates steps 2–5 is on the
roadmap but is **not** part of task 20.2.

## Update channel layout

`plugins.updater.endpoints` is templated:

```text
https://example.invalid/updates/{{target}}/{{current_version}}
```

`{{target}}` resolves to a Tauri target triple (e.g.
`windows-x86_64`) and `{{current_version}}` to the installed version.
The placeholder host (`example.invalid`) intentionally never resolves
on the public internet — the production endpoint is configured by the
platform owner before the first signed release.

The expected bucket layout, served from any static-file host:

```text
updates/
  windows-x86_64/
    latest.json          <- signed manifest, returned for any current_version
    0.1.0/
      AI Agent Orchestrator_0.1.0_x64-setup.exe
      AI Agent Orchestrator_0.1.0_x64-setup.exe.sig
    0.1.1/
      AI Agent Orchestrator_0.1.1_x64-setup.exe
      AI Agent Orchestrator_0.1.1_x64-setup.exe.sig
```

`latest.json` follows the Tauri v2 schema:

```json
{
  "version": "0.1.1",
  "notes": "Release notes for 0.1.1.",
  "pub_date": "2025-01-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .sig file>",
      "url": "https://example.invalid/updates/windows-x86_64/0.1.1/AI Agent Orchestrator_0.1.1_x64-setup.exe"
    }
  }
}
```

The `signature` field is the **literal contents** of the `.sig` file
produced by `tauri build`. Tauri verifies it against the embedded
`pubkey` before applying the update; a tampered or unsigned manifest
is rejected and the user keeps the installed version.

## Local verification (no signing)

`tauri build` requires the Rust toolchain. The signing keys above are
only required for shipped releases. For purely local smoke-testing
the bundle scripts (e.g. on a developer machine without keys),
unsetting `TAURI_PRIVATE_KEY` produces unsigned installers — usable
for install/uninstall verification but rejected by the live updater.

## Requirement traceability

- **Requirement 1.1** — Windows Desktop App is the primary product target;
  the installer/updater flow is the shipping vehicle for that target.
- **Requirement 1.3** — Desktop App ships as a self-contained Windows
  installer that runs without depending on the hosted Web App.
- **Requirement 1.4** — The signed installer + auto-update channel
  delivers the full core flow (auth, API key management, model
  selection, task creation, agent trace, file artifact, final report)
  to a user's Windows PC.
