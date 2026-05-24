# Chat Mode Contract

Chat Mode is Karo's read-only conversation mode. It should feel like a normal assistant for discussion, code explanation, and safe command explanation, while keeping file changes behind Agent or Quick Edit.

## Non-negotiables

- Chat Mode never creates artifacts.
- Chat Mode never applies changes.
- Chat Mode never shows Apply Changes.
- Chat Mode never runs Coder, Reviewer, Fixer, Boss, or Finalizer as a file-changing pipeline.
- Chat Mode never executes shell commands.
- Chat Mode does not expose hidden chain-of-thought.
- Raw diagnostics stay collapsed in Usage or developer diagnostics.

## Conversation memory

Chat Mode may use recent messages from the current conversation only. A new chat starts clean and must not inherit the previous chat's history. Switching back to an older chat restores that chat's own messages.

The prompt budget uses recent messages instead of an unbounded transcript. If a summary layer is added later, it must be scoped to the same conversation.

## Project-aware chat

Casual chat does not scan the project. Project-aware chat may read local context only when the user asks about the current project, code, architecture, Apply Changes, or security.

Read-only context profiles:

- `project_explain`: README/package/app entry points plus topic matches.
- `apply_changes_explain`: apply/staging/Tauri commands/native bindings/workbench/transport files.
- `security_review`: auth, secret storage, redaction, command policy, terminal runner, Tauri commands, persistence/provider key handling.

Project-aware chat still cannot create artifacts or show Apply Changes.

## Safe command explanation

Chat Mode can explain a command, including dangerous commands. It must not execute the command. For `git clean -fdx`, the answer must warn that it deletes untracked and ignored files and suggest the dry run:

```bash
git clean -ndx
```

Bare dangerous commands may be shown as Safety Check instead of ordinary Chat, but command execution remains blocked.

## File-change requests

If the user explicitly selects Chat Mode and asks to create, modify, fix, or delete files, Karo must refuse to modify files and explain that Agent Mode or Auto Mode is required. Auto Mode may route the same prompt to Quick Edit or Agent, where changes are staged and Apply Changes is required.

## Benchmarks

Pass cases:

- casual chat: no project context, no artifacts, <= 1 model call;
- same-conversation memory: answer can use prior messages from that chat;
- new chat isolation: no previous chat leakage;
- project explanation: read-only context, no artifacts;
- dangerous command: no execution, dry-run suggestion;
- explicit Chat file change: no model pipeline, no staged artifacts.

Fail cases:

- Chat Mode creates staged files;
- Chat Mode shows a Final Report or Apply Changes;
- Chat Mode runs Coder/Reviewer/Fixer/Boss;
- new chat sees a previous conversation's messages;
- dangerous command gets command permission.
