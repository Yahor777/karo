# KARO Reference Plan

This document tracks external products and repositories we can use as
references while building KARO. It separates safe implementation reuse
from product inspiration so we do not accidentally copy proprietary UI,
branding, assets, or incompatible code.

## Reuse Rules

- Use ideas, UX patterns, and architecture freely.
- Copy code only from permissive repositories such as MIT or Apache-2.0,
  and preserve license headers plus a note in `THIRD_PARTY_NOTICES.md`.
- Treat proprietary products as inspiration only: no code, no exact UI,
  no icons, no text, no brand imitation.
- Avoid GPL/AGPL code unless the whole affected distribution is intended
  to comply with that license.
- Treat source-available or modified licenses as "idea only" unless a
  specific legal review approves reuse.

## Primary Open-Source References

| Project          | License posture                                                | What to borrow                                                                |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| OpenHands        | MIT for the public core; enterprise code excluded              | Local/cloud agent loop, sandboxed execution, task handoff, repo-oriented UX   |
| Cline            | Apache-2.0                                                     | Human approvals, command/read/write gating, MCP integration, tool traces      |
| Continue         | Apache-2.0                                                     | Model roles, config-as-code, IDE/CLI split, autocomplete/chat/edit separation |
| Goose            | Apache-2.0                                                     | Desktop + CLI parity, extensions, Todo/task tracking, conversation search     |
| LangGraph Studio | Permissive ecosystem, use as idea source unless copying a file | Visual graph, checkpoints, time-travel debugging, per-node state inspection   |
| Flowise          | Apache-2.0                                                     | Visual workflow builder concepts, node palette, graph editing                 |
| Roo Code         | Apache-2.0, archived                                           | Agent modes such as Code/Architect/Ask/Debug; idea source only for now        |

## Proprietary References

| Product        | What to borrow as ideas only                                                      |
| -------------- | --------------------------------------------------------------------------------- |
| OpenAI Codex   | Worktrees, cloud tasks, approval modes, skills, automations, PR-oriented workflow |
| Cursor         | Background agents, project memories, Bugbot-style review, rules                   |
| Windsurf       | Memories/rules/workflows/skills taxonomy, checkpoints, Cascade-style interaction  |
| Claude Code    | Slash commands, hooks, subagents, permission model                                |
| GitHub Copilot | Agent mode, coding agent on issues, PR review ergonomics                          |

## Immediate KARO Feature Backlog

1. Agent command center: runs list, chat/plan center, trace/changes/diff/logs right panel.
2. Approval modes: suggest, auto-edit, sandboxed full-auto.
3. Rules/memories/workflows/skills: `.karo/rules/*.md`, `AGENTS.md`, slash workflows, approved memories.
4. Model roles: planner, coder, reviewer, fixer, summarizer, cheap-search.
5. Tool calling: provider-agnostic JSON tool protocol, starting with free DuckDuckGo web search.
6. Visual trace graph: checkpoints, per-agent state, tool call inputs/outputs, diff links.
7. Extension registry: local tools with explicit permission scopes.
8. GitHub mode: issue to branch to diff to PR.
