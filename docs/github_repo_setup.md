# GitHub Repository Setup

Recommended public repository metadata for Karo.

## Description

```text
AI coding workbench with chat, planning, agent orchestration, staged changes, safe terminal, and local preview.
```

## Topics

```text
ai-coding
ai-agent
developer-tools
tauri
typescript
rust
mcp
playwright
code-assistant
local-first
```

## Website

Leave blank for now, or add a future landing page when there is a stable public demo.

## Repository Settings

- Enable Issues.
- Enable Discussions later if there is active user feedback.
- Keep branch protection lightweight until CI runtime is stable.
- Add GitHub Actions as the initial CI gate.

## Suggested About Text

Karo is an experimental local-first AI coding workbench. It combines chat, planning, agent orchestration, staged file changes, command safety, and preview workflows in a Tauri desktop app.

## Public README Notes

The README should stay honest about current limitations:

- MVP/alpha status.
- Terminal is a safe runner, not a full PTY.
- Embedded preview is not implemented.
- Native WebView2 click automation is not implemented.
- Generated runtime artifacts and reports are not part of the public repository.
