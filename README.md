# Karo

Karo is a Windows-first desktop AI coding workbench built with Tauri, TypeScript, and Rust. The MVP checkpoint is focused on a chat-first workflow: ask questions, inspect a local project, create a plan, request file changes through an agent pipeline, review staged changes, apply them intentionally, and run a safe preview command.

Karo is not a finished IDE yet. It is a product checkpoint with a real local runtime, a real Context Engine, a staged artifact flow, safety checks for dangerous commands, and MCP/Playwright GUI automation.

## MVP status

### Working

- Chat / Plan / Agent / Auto routing.
- Conversation persistence, New chat, and chat switching.
- Quick Edit for trivial create-file tasks without model/API usage.
- Multi-agent Agent runs for larger coding tasks.
- Local Context Engine for project explain and security review.
- Staged artifact flow with Apply Changes required before file writes.
- Command Policy for dangerous commands such as `git clean -fdx`.
- Safe MVP Terminal backend through a command allowlist.
- Static `index.html` preview after Apply Changes, plus Preview command detection and Preview run through the safe terminal backend.
- MCP/Playwright renderer GUI checks.
- Dev/test Tauri runtime bridge proof for native Context Engine behavior.

### Experimental

- Terminal profiles and command execution are limited to a safe MVP allowlist.
- Preview opens applied static HTML files or external/local URLs detected from terminal output; embedded preview is not implemented.
- Plan Mode is read-only planning, not a full planner-agent pipeline yet.
- Web/tool policy is constrained by settings and safety policy.
- Model capability metadata is a mix of provider catalog, known tables, and conservative heuristics.

### Not ready

- Native WebView2 click automation.
- Unrestricted shell access.
- Fully interactive IDE terminal/PTY.
- Autonomous image generation without explicit user approval.
- Broad marketplace or "free model of the day" flows.

## MVP acceptance scenarios

1. Ordinary chat: `привет как дела`
   - Expected: normal assistant response, no agent pipeline, no artifacts, no Final Report.

2. Project explain: `Объясни как работает Apply Changes и какие файлы за это отвечают`
   - Expected: Context Engine selects local files, response is read-only, no artifacts.

3. Plan Mode: `сделай план улучшения UI`
   - Expected: Plan Result, read-only, no artifacts.

4. Quick Edit: `создай файл src/karo-test.txt с текстом hello`
   - Expected: Quick Edit route, one staged artifact, no model call, no full agent pipeline, Apply required.

5. Agent website task:
   - Prompt: `Создай современный landing page для Minecraft JJK mod с hero, features, abilities, pricing, FAQ, responsive layout, dark anime style. Сделай так, чтобы это можно было запустить и посмотреть в preview.`
   - Expected: Agent route, staged website files, no auto-apply, static preview/open flow or preview command available after apply.

6. Safety Check: `git clean -fdx`
   - Expected: command is not executed, response explains the risk and suggests `git clean -ndx`.

7. New chat / switch chats
   - Expected: a new conversation starts cleanly, and previous conversation history is restored correctly when switching back.

## Repository layout

```text
apps/
  desktop-windows/   Tauri desktop app and primary UI
  web/               Secondary web shell
  backend/           Backend services, artifacts, auth, traces

packages/
  shared-core/       Shared domain types and provider presets
  shared-ui/         Shared UI screens/components
  client-sdk/        Client SDK
  validation/        Schemas and validation
```

## Development

Install dependencies:

```powershell
pnpm install
```

Run the desktop renderer during UI development:

```powershell
pnpm desktop:dev:renderer
```

Run the Tauri desktop app:

```powershell
pnpm desktop:dev
```

## Verification

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

Run renderer GUI automation:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:headed
```

Run the desktop process smoke and the real Tauri runtime proof:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:desktop
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:tauri-runtime
```

The runtime proof is dev/test-only. It proves native Context Engine selection, command-safety behavior, Quick Edit/Agent artifact behavior, and the website-creation staged artifact path without exposing secrets or executing arbitrary shell commands.

## MCP GUI automation

Karo includes a local MCP/Playwright automation layer under:

```text
apps/desktop-windows/mcp/
```

Run the MCP server:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows mcp:ui
```

Generated screenshots and reports are written under:

```text
apps/desktop-windows/e2e-artifacts/
```

Those files are runtime artifacts and should not be committed.

## Secrets

Karo reads provider keys from the configured local secret storage or environment variables used by smoke tests. Do not commit API keys or generated reports. `FIREWORKS_API_KEY` may be used for a tiny provider smoke check, but the key must never be printed, persisted, or included in screenshots/reports.

Use `.env.example` as documentation only. Real `.env*` files are ignored.

## Git hygiene

Do not commit:

- `apps/desktop-windows/e2e-artifacts/`
- `karo-before-*.patch`
- `.karo/staging/`
- `.env`, `.env.local`, `.env.*.local`
- screenshots, generated reports, or local runtime artifacts
- `chat_response.txt`
- `context-engine-check.txt`
- `.codex/` autogenerated local environment files, unless intentionally reviewed

Before checkpointing, run:

```powershell
git diff --check
git status --short
git diff --stat
```
