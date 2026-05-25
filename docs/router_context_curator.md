# Router and Context Curator

Karo should win by choosing the cheapest useful path before calling a model. The router decides the mode, and the Context Curator decides whether local project files are needed at all.

## Routing principles

1. Correct route first.
2. Minimal context first.
3. Model calls only when useful.
4. File changes only through Agent or Quick Edit staged artifacts.
5. Fallback is explicit recovery only and never benchmark success.

## Context profiles

| Profile | When used | Context policy | Pass / fail examples |
|---|---|---|---|
| `casual_chat` | Greetings and general chat. | No project files and no Context Engine. | `hello, who are you?` should be Chat with <= 1 model call. |
| `conversation_memory` | Follow-up questions about earlier messages. | Current conversation summary/recent messages only. | `what did I write above?` must not scan project files. |
| `project_explain` | Read-only project explanation. | README/package/app entry points plus topic matches. | `explain the project architecture` selects relevant source, not generated reports. |
| `apply_changes_explain` | Questions about Apply Changes/staging. | Prefer apply/staging/Tauri commands/native bindings/workbench/transport. | `explain Apply Changes` must select apply/staging/native/workbench files. |
| `security_review` | Security/key/command/storage questions. | Prefer auth, secret storage, redaction, command policy, terminal runner, Tauri commands, persistence/provider key handling. | README-only security context fails the profile. |
| `website_creation` | New static site / landing page tasks. | Minimal context; existing app package/entry/style files only; no random txt/test-output files. | `karo-test-output.txt` must never be primary context. |
| `ui_work` | UI/composer/sidebar/inspector/MCP visual behavior. | Prefer `workbench.ts`, `main.css`, workbench tests, MCP scenarios/assertions. | Backend auth files should not displace UI files unless requested. |
| `none` | Quick Edit, safety checks, clarification. | No project files. | `git clean -fdx` and deterministic create-file should not scan context. |

## Runtime behavior

`AgentCoreEstimate` carries the route/cost contract into diagnostics:

- selected mode;
- user-facing and internal route reason;
- expected and max model calls;
- expected context tokens;
- project-context requirement;
- artifact/command permissions;
- risk level;
- timeout and recovery policy;
- context profile.

The desktop transport uses the context profile to choose Context Engine options. Website creation gets a smaller context budget than security review or Apply Changes explanations.

## Generated artifacts policy

The Context Engine ignores generated/runtime files and folders, including:

- `apps/desktop-windows/e2e-artifacts/`;
- `.karo/`;
- `.codex/`;
- `.antigravitycli/`;
- `screenshots/`;
- `reports/`;
- `karo-before-*.patch`;
- `chat_response.txt`;
- `context-engine-check.txt`;
- low-signal website task text outputs such as `*-output.txt`.

## Benchmark relationship

The product scorecard is in `docs/agent_core_scorecard.md`. Machine-readable pass/fail constraints live in `apps/desktop-windows/src/orchestration/agentBenchmarks.ts`.

Fallback cannot pass the website benchmark. A timeout may preserve partial artifacts and expose recovery actions, but it is not a completed generation.
