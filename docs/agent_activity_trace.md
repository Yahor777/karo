# Agent Activity Trace

Karo's activity trace is a public execution log for users. It explains what the system is doing without exposing hidden chain-of-thought, private model reasoning, or raw debug dumps by default.

## Policy

- Never show hidden chain-of-thought.
- Never label model internals as "thoughts" in the primary UI.
- Show public activity only: route selection, context selection, planning, model calls, file chunks, staged artifacts, validation, skipped reviewer, targeted fixer work, finalizer summary, and recovery state.
- Keep raw trace/details collapsed by default.
- Use the user's language for visible labels when the prompt language is clear.
- Fallback is an emergency recovery option, not a success state.
- Timeout is a recovery/error state, not completed.
- Apply Changes appears only when staged artifacts exist.

## Agent Cards

Activity is grouped into cards instead of a raw event list. Each card has:

- agent name and compact initials;
- role description;
- status: queued, running, done, error, or skipped;
- short public activity summary;
- file chips when a stage touched artifacts;
- elapsed time when event timestamps are available;
- collapsed details for formatted trace events.

Current card roles:

- Chat Assistant: answers and explains without changing files.
- Context Analyst / Researcher: finds relevant project context.
- Planner: turns a task into an implementation or planning path.
- Coder: creates staged file changes.
- Deterministic Validator: runs cheap checks before model review.
- Reviewer: checks quality when validation cannot prove enough.
- Fixer: repairs specific defects.
- Finalizer: summarizes staged files, checks, and next steps.
- Safety Check: blocks dangerous command execution.

## Mode Behavior

Chat Mode must not show the Agent pipeline, Apply Changes, or Final Report styling. It may show small read-only context activity when project context is used.

Plan Mode shows planning stages and a structured Plan Result. It must not show Agent Final Report wording, Coder/Fixer file-changing cards, or Apply Changes.

Agent Mode shows Planner, Coder, Validator, optional Reviewer, optional Fixer, and Finalizer. Reviewer can be shown as skipped when deterministic validation passed and model review was not needed.

Quick Edit shows a tiny activity card, zero model calls in Usage/Diagnostics, and no review cycles or full pipeline.

Safety Check shows a safety card, a dry-run suggestion where relevant, no command execution, and no artifacts.

Recovery shows the failed stage/file/provider/model, preserved partial artifacts, and only real recovery actions. Disabled actions must be visibly disabled with a reason.

## Layout Rules

- Long paths and model ids must ellipsis or wrap without expanding the layout.
- Details stay collapsed unless the user opens them.
- Activity updates must not scroll the user to the top.
- Auto-scroll is allowed only when the user is near the bottom.
- The composer must remain visible when activity, right panel, or bottom panels update.

## Product Checks

MCP/GUI checks should verify:

- no visible hidden-thought wording;
- raw details collapsed by default;
- Quick Edit hides full pipeline and review cycles;
- Plan is read-only and not styled as an Agent Final Report;
- Agent cards show public stages and file chips;
- deterministic validation can skip Reviewer honestly;
- recovery cards do not say completed;
- long paths do not break responsive layouts.
