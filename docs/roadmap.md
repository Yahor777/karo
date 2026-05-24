# Roadmap

Karo is in an MVP/alpha stage. The near-term roadmap focuses on making the core workflow reliable before adding broad surface area.

## Near Term

- Harden the one-prompt website creation benchmark.
- Improve Agent activity cards and progress summaries.
- Split the large desktop workbench UI into smaller modules.
- Improve model capability metadata and provider status UX.
- Add curated public screenshots and a short demo video.
- Keep MCP GUI checks aligned with product UX, not just DOM existence.

## Preview and Terminal

- Add embedded preview when it can be implemented honestly and safely.
- Improve the safe terminal runner.
- Explore full PTY support only after command policy, process cleanup, and secret redaction are mature.
- Add better URL detection and preview health checks.

## Agent Orchestration

- Improve planner/reviewer/fixer loops without making trivial edits expensive.
- Keep Quick Edit deterministic for simple file tasks.
- Add clearer recovery flows for provider timeout and context reduction.
- Expand read-only security review with better local static analysis.

## Web and Cloud

- Build a web version connected to GitHub repositories.
- Add cloud sandbox execution later, after local safety primitives are stable.
- Keep local-first workflows as the default for private projects.

## Not Planned for MVP

- Unrestricted shell access.
- Autonomous destructive command execution.
- Hidden automatic Apply Changes.
- Image generation without explicit user approval.
- Marketplace or "free model of the day" flows.
