# Architecture Overview

Karo is a monorepo for an experimental local-first AI coding workbench. The current product target is a Windows-first Tauri desktop app with a renderer UI, Rust native commands, and TypeScript orchestration.

## Repository Structure

```text
apps/
  desktop-windows/   Primary desktop app
  web/               Secondary web shell
  backend/           Backend services and shared orchestration primitives

packages/
  shared-core/       Shared provider/domain types
  shared-ui/         Shared UI screens
  client-sdk/        Client SDK
  validation/        Runtime schemas
```

## Main Layers

### Desktop Shell

`apps/desktop-windows` contains the Tauri app, renderer UI, native bridge, and MCP GUI automation.

Key areas:

- `src/ui/workbench.ts`: current chat-first workbench UI.
- `src/orchestration/`: renderer-local decision, model, token, and transport logic.
- `src/shell/`: frontend bridge to native capabilities.
- `src-tauri/src/`: Rust commands for filesystem, staging, context, storage, terminal, and preview open flow.
- `mcp/`: Playwright-based automation tools and scenarios.

### Context Engine

The Context Engine selects relevant files for project explain, security review, and agent tasks. It is designed to ignore generated/runtime artifacts such as `.karo/`, `e2e-artifacts/`, screenshots, reports, and patch files.

The real Tauri runtime proof checks this path through a dev/test bridge instead of relying only on the browser renderer harness.

### Decision and Command Policy

The Decision Engine routes user prompts into:

- Chat
- Plan
- Agent
- Quick Edit
- Safety Check

Dangerous shell commands are handled by Command Policy and should never be executed automatically.

### Staged Artifact Flow

Agent and Quick Edit outputs become staged artifacts first. Apply Changes is the explicit boundary where proposed files are written to the project.

This keeps the model from silently changing the workspace and gives the user a review point through Changes/Diff/Preview.

### Terminal and Preview

The terminal is an MVP safe runner, not a full interactive PTY. It runs allowlisted commands inside the project root and blocks destructive commands.

Preview currently supports:

- applied static HTML open flow;
- detected package scripts through the safe terminal runner;
- external/local URLs detected from terminal output.

Embedded browser preview is future work.

### MCP GUI Automation

`apps/desktop-windows/mcp` provides a local Playwright automation layer for renderer workflows. It checks layout, chat flows, routing, safety cards, context popovers, preview states, model pages, and responsive behavior.

The runtime proof command separately verifies native Tauri behavior for selected files and safety-critical paths.

## Current Architecture Risks

- `workbench.ts` is still a large file and should eventually be split into smaller components.
- Native WebView2 click automation is not available yet.
- Terminal is intentionally constrained and should not be described as a full IDE shell.
- Plan Mode is read-only planning, not a full planner-agent pipeline.
