# Karo

**Karo is an experimental local-first AI coding workbench for chat, planning, agent orchestration, staged changes, and safe preview.**

Karo is currently an MVP/alpha checkpoint. It is not a finished IDE, but the repository now contains a working Tauri desktop runtime, a local Context Engine, staged artifact review, command safety checks, a safe terminal MVP, static preview/open flow, and MCP/Playwright GUI automation.

The goal is simple: give a developer a chat-first coding workspace where a good prompt can become reviewable file changes without handing a model unrestricted shell or filesystem access.

## Why Karo

Most AI coding tools still feel like a single model sitting next to your editor. That works for small answers, but it breaks down when the task needs local project context, planning, file changes, review, safe command handling, and a way to inspect the result.

Karo experiments with an orchestration-first workflow:

- **Chat** for normal conversation and project questions.
- **Plan** for read-only implementation strategy.
- **Agent** for file-changing tasks through staged artifacts.
- **Auto** to route between Chat, Plan, Agent, and Safety Check.
- **Quick Edit** for deterministic small file tasks without a model call.
- **Apply Changes** so file writes are explicit, reviewable, and not automatic.
- **Preview** so applied static HTML or allowlisted dev commands can be opened safely.

## Features

- Chat / Plan / Agent / Auto routing.
- Conversation persistence, New chat, and chat switching.
- Local Context Engine for project explain and security review.
- Staged artifacts and diffs before file writes.
- Apply Changes flow for intentional workspace modifications.
- Quick Edit for trivial create-file tasks without API/model usage.
- Safety Check for dangerous commands such as `git clean -fdx`.
- Safe MVP terminal runner with command allowlist and project-root validation.
- Static `index.html` preview/open flow after Apply Changes.
- Preview command detection for package scripts and safe preview runs.
- MCP/Playwright renderer GUI checks.
- Dev/test Tauri runtime bridge proof for native Context Engine behavior.

## Demo

Screenshots coming soon. Curated screenshots should be added manually; generated `e2e-artifacts`, runtime reports, and local screenshots are intentionally ignored.

## Quick Start

Prerequisites:

- Node.js 18.18+
- pnpm 9
- Rust stable
- Windows is the primary tested desktop target today

Install dependencies:

```powershell
pnpm install
```

Run the Tauri desktop app:

```powershell
pnpm desktop:dev
```

Run the renderer only during UI development:

```powershell
pnpm desktop:dev:renderer
```

Run the TypeScript/Vitest suite:

```powershell
pnpm test
```

Run Rust checks from the Tauri crate:

```powershell
cd apps/desktop-windows/src-tauri
cargo check
cargo test
```

## Project Status

### Working

- Chat / Plan / Agent / Auto routing.
- Conversation persistence and chat switching.
- Quick Edit for deterministic small create-file tasks.
- Multi-agent Agent runs for larger coding tasks.
- Local Context Engine for project explain and security review.
- Staged artifact review and Apply Changes.
- Command Policy and Safety Check for destructive commands.
- Safe terminal MVP runner through an allowlist.
- Static HTML preview/open flow after Apply Changes.
- MCP/Playwright renderer GUI checks.
- Tauri runtime proof for native Context Engine behavior.

### Experimental

- Terminal profiles and command execution are limited to a safe MVP allowlist.
- Preview opens applied static HTML files or external/local URLs; embedded preview is not implemented.
- Plan Mode is read-only planning, not a full planner-agent pipeline yet.
- Web/tool policy is constrained by settings and safety policy.
- Model capability metadata combines provider catalog data, known tables, and conservative heuristics.

### Not Ready

- Native WebView2 click automation.
- Unrestricted shell access.
- Fully interactive IDE terminal/PTY.
- Embedded browser preview.
- Autonomous image generation without explicit user approval.
- Marketplace or "free model of the day" flows.

## Architecture

```text
apps/
  desktop-windows/   Tauri desktop app, renderer UI, native bridge, MCP GUI checks
  web/               Secondary web shell
  backend/           Backend services, artifacts, auth, traces

packages/
  shared-core/       Shared domain types and provider presets
  shared-ui/         Shared UI screens/components
  client-sdk/        Client SDK
  validation/        Schemas and validation

docs/                Architecture, MCP automation, UX notes, benchmark criteria
```

Core pieces:

- **Context Engine**: selects relevant local files for explain/security/agent workflows while ignoring generated/runtime artifacts.
- **Decision Engine**: routes prompts to Chat, Plan, Agent, Quick Edit, or Safety Check.
- **Artifact pipeline**: stages proposed file changes before Apply Changes writes to disk.
- **Safe Terminal MVP**: runs only allowlisted commands inside the project root.
- **MCP GUI automation**: exercises renderer workflows, responsive layout, preview states, and product guardrails.

More detail:

- [Architecture overview](docs/architecture_overview.md)
- [MVP acceptance checklist](docs/mvp_acceptance.md)
- [Roadmap](docs/roadmap.md)
- [MCP GUI automation](docs/karo_mcp_gui_automation.md)

## Verification

Run the main checks:

```powershell
pnpm test
pnpm --filter @ai-agent-orchestrator/desktop-windows exec tsc --noEmit
```

Run Rust checks:

```powershell
cd apps/desktop-windows/src-tauri
cargo check
cargo test
```

Run GUI automation:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:headed
```

Run desktop smoke and real Tauri runtime proof:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:desktop
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:tauri-runtime
```

The runtime proof is dev/test-only. It verifies native Context Engine selection, dangerous-command safety, Quick Edit/Agent artifact behavior, and the one-prompt website staged-artifact path without exposing secrets or executing arbitrary shell commands.

## Security Model

- Do not commit API keys or generated reports.
- Use `.env.example` for documentation only; real `.env*` files are ignored.
- File changes are staged first and require Apply Changes.
- Destructive commands are blocked by Command Policy.
- Preview and terminal commands run through a safe MVP allowlist.
- Generated runtime files such as `.karo/`, `e2e-artifacts/`, reports, screenshots, and `karo-before-*.patch` are ignored.

See [SECURITY.md](SECURITY.md) for reporting guidance.

## Roadmap

- Embedded preview for web apps.
- Stronger terminal/PTY support with explicit permissions.
- One-prompt website creation benchmark hardening.
- More polished agent activity UI.
- Web version connected to GitHub repositories.
- Cloud sandbox execution after local safety primitives are mature.

See [docs/roadmap.md](docs/roadmap.md) for more detail.
