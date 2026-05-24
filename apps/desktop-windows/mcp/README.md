# KARO UI MCP Server

This directory contains the local MCP-first GUI automation layer for the KARO desktop renderer.

The MCP server exposes tools for starting the dev renderer, opening the app in Playwright, clicking/filling/hovering UI elements, capturing screenshots, reading DOM state, running assertions, and executing end-to-end GUI scenarios.

## Run

From the repo root:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows mcp:ui
```

For a direct scenario run without an MCP client:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:headed
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:desktop
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:tauri-runtime
```

The runner writes screenshots to:

```text
apps/desktop-windows/e2e-artifacts/screenshots
```

and reports to:

```text
apps/desktop-windows/e2e-artifacts/reports/latest.json
apps/desktop-windows/e2e-artifacts/reports/latest.md
apps/desktop-windows/e2e-artifacts/reports/report.md
apps/desktop-windows/e2e-artifacts/reports/desktop-smoke.json
apps/desktop-windows/e2e-artifacts/reports/desktop-smoke.md
apps/desktop-windows/e2e-artifacts/reports/tauri-runtime.json
apps/desktop-windows/e2e-artifacts/reports/tauri-runtime.md
```

## MCP tools

App lifecycle:

- `karo_start_dev_server`
- `karo_stop_dev_server`
- `karo_open_app`
- `karo_reload_app`

UI interaction:

- `karo_click`
- `karo_fill`
- `karo_press`
- `karo_select`
- `karo_hover`

Screenshots:

- `karo_screenshot`
- `karo_screenshot_element`

DOM/state:

- `karo_get_text`
- `karo_get_html`
- `karo_get_bounding_box`
- `karo_get_visible_state`
- `karo_get_app_diagnostics`

Assertions:

- `karo_assert_visible`
- `karo_assert_not_visible`
- `karo_assert_text_contains`
- `karo_assert_no_horizontal_overflow`
- `karo_assert_element_inside_viewport`
- `karo_assert_composer_usable`
- `karo_assert_context_popover_not_in_composer`
- `karo_assert_no_duplicate_user_messages`
- `karo_assert_responsive_layout_quality`

Scenarios:

- `karo_run_scenario_boot`
- `karo_run_scenario_sidebar_conversations`
- `karo_run_scenario_context_popover`
- `karo_run_scenario_casual_chat`
- `karo_run_scenario_clarification`
- `karo_run_scenario_plan_mode`
- `karo_run_scenario_project_explain`
- `karo_run_scenario_security_review`
- `karo_run_scenario_dangerous_command`
- `karo_run_scenario_model_switching`
- `karo_run_scenario_workspace_pages`
- `karo_run_scenario_responsive_layout`
- `karo_run_scenario_right_panel_tabs`
- `karo_run_all_gui_scenarios`

The scenario runner is intentionally stricter than a smoke test. It checks compact sidebar behavior, right-panel collapse, usable composer geometry, primary toolbar density, context popover portal placement, textarea overlap, selected conversation persistence after reload, right-panel content clipping, limited empty-state inspector tabs, bottom-panel terminal honesty, Settings scrollability/collapsed diagnostics, and route-specific safety/read-only UI states.

If `FIREWORKS_API_KEY` is present in the environment, the runner performs a tiny Fireworks `/models` smoke check, verifies whether the active model is present in the returned catalog, and records only status/latency/model count/active-model-found. The key is never printed or persisted. If the variable is absent, the smoke is reported as skipped.

`gui:check:desktop` starts the real Tauri dev flow and verifies the renderer dev server is reachable. Native window automation and real Tauri `selectedFiles > 0` proof are reported honestly as unavailable/not proven until the harness grows a desktop-control backend.

`gui:check:tauri-runtime` is the native runtime bridge proof. It starts the Tauri dev flow, then runs a debug-only Rust bridge into the Tauri crate's `context::shell_build_task_context` command implementation and drives `DesktopOrchestratorTransport` with that native context package. This proves real selected files for the Apply Changes explain workflow, dangerous-command safety, Quick Edit/Agent artifacts, and the one-prompt website staged-artifact path without exposing secrets or executing arbitrary shell commands. Native WebView2 window automation remains separate and is still reported as unavailable.

## Notes

The server seeds a local Fireworks metadata session in the Playwright browser context so the workbench can be tested without typing an API key. It does not seed or expose a plaintext API key. Scenarios that require a real model response may surface provider/API failures honestly in the report; deterministic UI checks still run.
