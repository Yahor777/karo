# Plan Mode Agents

Plan Mode is Karo's read-only planning runtime. It helps the user design a safe implementation path before any file-changing Agent run starts.

## Contract

Plan Mode must never:

- create artifacts;
- stage or apply file changes;
- show Apply Changes;
- run Coder, Fixer, or the file-changing Agent pipeline;
- execute commands;
- expose hidden chain-of-thought;
- present a fake plan when the model/provider is unavailable.

Fallback is not success. If the provider times out or the model output cannot be repaired into a usable structure, Plan Mode must show an honest recovery state.

## Runtime Shape

The MVP implementation uses one structured provider call, not four separate model calls. The public Plan stages are still represented as product activity:

- Context Analyst: decides whether project context is needed.
- Product/Technical Planner: creates the implementation plan.
- Risk Reviewer: calls out scope, cost, safety, and verification risks.
- Plan Finalizer: formats the result for the user and suggests the correct next mode.

Because this is a single call, the UI must not imply that separate hidden agents or separate model calls happened.

## Structured Output

The internal plan shape contains:

- goal;
- assumptions;
- relevant file areas;
- implementation steps;
- risks;
- tests / verification;
- estimated complexity;
- expected model calls / context budget;
- suggested execution mode;
- acceptance criteria;
- what not to do yet.

For Russian prompts, visible labels should be Russian. For English prompts, visible labels should be English.

## Context Rules

Generic planning prompts do not scan the project. Example: "make a one-week Python learning plan".

Project-specific planning prompts may use the Context Engine with a minimal profile. Examples:

- "plan how to redesign Agent Activity UI in Karo";
- "plan the Apply Changes refactor";
- "plan a security review of this project".

Plan Mode context is read-only and only affects the model prompt.

## Failure And Recovery

Provider timeout, missing API key, and unrepaired parse failure must produce a visible recovery state:

- Retry Plan;
- Retry with reduced context;
- Switch model, when supported by the user through Models.

No plan is fabricated after these failures, and no artifacts are created.

## Mode Boundaries

- Chat: answers and explains without changing files.
- Plan: creates a structured read-only plan.
- Agent: creates staged file changes and requires Apply Changes.
- Quick Edit: deterministic tiny file edit with zero model calls.
- Safety: blocks dangerous commands and suggests safer dry runs.

Auto can route planning prompts to Plan Mode, but implementation prompts must route to Agent or Quick Edit.
