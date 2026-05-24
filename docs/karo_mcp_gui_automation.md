# Karo MCP GUI Automation

Karo now has a local MCP-first GUI automation layer for runtime UX verification. The goal is to stop relying on manual screenshots and make the agent able to start the app, click the UI, inspect DOM/state, capture screenshots, run scenarios, and save reports.

## Why MCP-first

Manual GUI checks are slow and easy to misreport. Unit tests are useful, but they do not catch runtime layout bugs such as Context Usage rendering inside the composer, right panel overlap, missing chat history, or destructive command cards looking like normal Auto Mode answers.

The MCP server gives agents a stable tool surface:

- start/stop the Karo renderer;
- open the app in a real browser;
- click, fill, hover, select, and press keys;
- read text, HTML, visibility, and bounding boxes;
- capture screenshots;
- assert layout invariants;
- run repeatable product scenarios.

Playwright is the implementation detail. Agents interact with Karo through MCP tools or the shared CLI scenario runner.

## Location

```text
apps/desktop-windows/mcp/
  karo-ui-mcp-server.ts
  run-all-gui-scenarios.ts
  tools/
    app.ts
    browser.ts
    selectors.ts
    assertions.ts
    screenshots.ts
    scenarios.ts
  README.md
  run-desktop-smoke.ts
```

## Run the MCP server

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows mcp:ui
```

An MCP client can launch this command as a stdio server. The tool names are prefixed with `karo_`, for example `karo_start_dev_server`, `karo_open_app`, and `karo_run_all_gui_scenarios`.

## Run scenarios without an MCP client

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:headed
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:desktop
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:tauri-runtime
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:screenshots
```

Artifacts are written to:

```text
apps/desktop-windows/e2e-artifacts/screenshots/
apps/desktop-windows/e2e-artifacts/reports/latest.json
apps/desktop-windows/e2e-artifacts/reports/latest.md
apps/desktop-windows/e2e-artifacts/reports/report.md
apps/desktop-windows/e2e-artifacts/reports/desktop-smoke.json
apps/desktop-windows/e2e-artifacts/reports/desktop-smoke.md
apps/desktop-windows/e2e-artifacts/reports/tauri-runtime.json
apps/desktop-windows/e2e-artifacts/reports/tauri-runtime.md
```

## Current scenarios

- Boot: app opens, sidebar/chat/composer/right panel are visible, no horizontal overflow, and the 900 px compact layout keeps the sidebar/right panel from crushing chat.
- Sidebar/New chat: creates and switches conversations without losing messages, then reloads the app and verifies the selected conversation remains active.
- Composer: verifies textarea, send button, mode controls, model chip, context trigger, and Advanced.
- Context usage: verifies the Context Usage trigger is in the composer, not the topbar, and the popover is a fixed portal rather than chat/composer content. It also checks the 900 px placement and rejects overlap with the textarea.
- Casual chat: verifies ordinary chat does not show agent pipeline/final report.
- Clarification: verifies ambiguous prompts show clarification or a local clarification fallback and do not start the pipeline.
- Plan Mode: verifies plan requests stay read-only.
- Project explain: checks read-only analysis flow does not expose Apply Changes.
- Security review: checks no raw web-search fallback and no success wording for broken analysis.
- Dangerous command: verifies `git clean -fdx` becomes Safety Check and suggests `git clean -ndx`.
- Model switching: verifies DeepSeek V4 Pro friendly display and 1M configured context, then seeds a Kimi model session and checks conservative 128k/unknown context behavior without breaking the popover.
- Right panel tabs: verifies the empty inspector only exposes useful tabs, clicks Preview/Changes/Usage, and checks that Terminal is handled by the bottom tools panel with either a real safe backend state or an honest unavailable state.
- Workspace pages: opens Project, Models, Agents, and Settings, verifies readable center content, no horizontal overflow, and a real Settings scroll container.
- Responsive: checks 1600, 1366, 1280, 1100, and 900 px widths for composer usability and horizontal overflow.

## Visual quality gates

The scenarios intentionally check more than presence of elements:

- composer width, textarea height, and send-button reachability;
- no body horizontal overflow;
- compact sidebar width and hidden right panel below the compact breakpoint;
- minimum readable chat-thread width at narrow viewports;
- context popover inside the viewport and outside chat/composer layout flow;
- context popover not overlapping the textarea;
- Settings route uses a real scroll container;
- ordinary chat, safety, and read-only routes do not expose agent pipeline or Apply Changes controls.
- right-panel tab content is not horizontally shifted or clipped after tab switching;
- primary composer controls stay compact instead of expanding into a settings console;
- the empty right inspector does not expose too many irrelevant tabs;
- Terminal state lives in the bottom panel and only shows run controls when the safe backend is available;
- Settings diagnostics stay collapsed by default instead of exposing raw JSON.

## Live provider smoke

`gui:check` also records a minimal Fireworks smoke result in the report:

- if `FIREWORKS_API_KEY` is not set, the smoke is marked `skipped`;
- if it is set, the runner calls the Fireworks `/models` endpoint with a short timeout;
- the active model is checked against the returned catalog and reported as `activeModelFound`;
- the key is never printed, written to localStorage, included in screenshots, or stored in reports;
- the report stores only status, provider, endpoint, target model id, latency, model count, or a short failure reason.

## Desktop/Tauri smoke

`gui:check:desktop` starts the real Tauri dev command and verifies that the renderer dev server becomes reachable. The current harness cannot drive the native Tauri window with Playwright, so the desktop report is explicit:

- Tauri dev process start: checked.
- Renderer URL reachability: checked.
- Native window automation: reported as `unavailable` until a desktop-control layer is added.
- Real Tauri `selectedFiles > 0` via GUI: reported as not proven by this smoke.
- Cleanup: the process tree started by the smoke is killed before exit.

This keeps renderer GUI confidence separate from true native runtime proof instead of pretending that Vite automation proves Tauri IPC.

## Real Tauri runtime bridge

`gui:check:tauri-runtime` adds the native runtime proof that renderer-only Playwright cannot provide. It:

- starts the real Tauri dev flow and verifies the dev server;
- runs a debug-only Rust bridge binary from the Tauri crate;
- calls the same Rust `context::shell_build_task_context` implementation that the Tauri command exposes;
- drives `DesktopOrchestratorTransport` with a shell adapter backed by that native context bridge;
- proves `Apply Changes` project explain selects real files from the repo;
- proves read-only/security tasks do not create artifacts;
- proves `git clean -fdx` is handled by Command Policy without command execution;
- proves the one-prompt website creation path creates staged website files through Agent mode instead of Quick Edit;
- writes `tauri-runtime.json` and `tauri-runtime.md`.

The bridge is dev/test only, does not read secrets, does not execute arbitrary shell commands, and does not expose selected file contents in reports.

## Stable selectors

The workbench exposes `data-testid` hooks for automation, including:

- `app-root`, `topbar`, `sidebar`, `sidebar-new-chat`, `sidebar-conversation-list`, `sidebar-conversation-item`;
- `nav-chat`, `nav-project`, `nav-changes`, `nav-runs`, `nav-models`, `nav-agents`, `nav-settings`;
- `chat-thread`, `chat-message-user`, `chat-message-assistant`, `chat-message-safety`, `chat-message-plan`, `chat-message-analysis`;
- `composer`, `composer-textarea`, `composer-send`, `composer-attach`, mode buttons, model chip, command/web controls, context trigger, advanced panel;
- `context-usage-popover`, `context-usage-copy`;
- right panel tabs and key result cards.

Selectors are test hooks only. They should not drive styling or product behavior.

## Limitations

- The first implementation tests the Vite renderer because most GUI regressions are visible there. Tauri desktop dev remains a separate smoke check.
- The renderer suite does not prove `selectedFiles > 0` in the real Tauri runtime. The report has a separate Context runtime proof section so this gap stays visible.
- The Playwright context seeds non-secret provider metadata so the workspace opens without typing an API key. It does not seed a plaintext API key.
- Scenarios that require a real provider response can fail or report model/API errors when no key is configured. Those failures are intentional and should not be reported as passed.
- Integrated terminal execution is limited to the MVP safe allowlist and remains separate from arbitrary shell access.

## Adding a scenario

1. Add or reuse a `data-testid`.
2. Add a function in `apps/desktop-windows/mcp/tools/scenarios.ts`.
3. Include screenshots on failure or at the important UI state.
4. Add assertions that describe the product invariant, not implementation trivia.
5. Register the scenario in `ALL_SCENARIOS` and in `karo-ui-mcp-server.ts`.
