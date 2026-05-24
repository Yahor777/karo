# Karo Agent Activity UI

Karo must show useful activity, not hidden model reasoning.

## Principle

The timeline is a public progress stream. It may show what the system is doing, what inputs it selected, what files it prepared, and what checks failed. It must not show private chain-of-thought, fake "thinking" prose, or raw provider dumps as the default interface.

## Visible Events

Allowed user-facing events:

- scanning project files;
- selecting context files;
- creating a plan;
- preparing staged artifacts;
- running deterministic checks;
- starting or finishing a model call;
- model timeout or provider error;
- reviewer found a concrete issue;
- fixer repaired a concrete issue;
- ready for review or apply.

Raw trace details may exist for debugging, but they stay collapsed behind activity details.

## Agent Cards

Each visible agent card needs:

- a stable role name;
- a short role description;
- a status badge: pending, running, done, warning, failed, or skipped;
- a short public summary;
- collapsed details for trace events.

Current roles:

- Chat Assistant: answers and explains without changing files.
- Plan Analyst: builds read-only implementation plans.
- Researcher: finds minimal relevant project context.
- Planner: turns the task into an execution plan when a full Agent run needs it.
- Coder: creates staged file changes.
- Validator: runs cheap deterministic checks first.
- Reviewer: reviews quality and correctness when needed.
- Fixer: repairs specific issues.
- Finalizer: summarizes result and next steps.

## Scroll Behavior

New activity may auto-scroll only when the user is already near the bottom. If the user has scrolled up, the timeline must not pull them away from what they are reading.

## Language

Public progress should follow the user's language where possible. Russian prompts should get Russian progress summaries. Internal identifiers can remain English in diagnostics.
