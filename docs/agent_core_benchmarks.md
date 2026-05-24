# Karo Agent Core Benchmarks

Karo wins only when the correct mode uses the minimum necessary context and model calls, then produces a useful reviewable result.

Fallback is not a success path. It is an explicit emergency recovery option after a real generation failure.

The detailed scorecard and machine-readable contract live in:

- `docs/agent_core_scorecard.md`
- `apps/desktop-windows/src/orchestration/agentBenchmarks.ts`

## Mode Contracts

### Chat

Chat answers questions and uses current conversation history. It does not create artifacts, run Coder/Reviewer/Fixer/Finalizer, or change files. It may use project context only when the user asks a project-specific read-only question.

Required checks:

- casual prompt routes to Chat;
- current conversation history is included;
- a new chat does not inherit old history;
- no artifacts and no Final Report.

### Plan

Plan is a read-only planning system. It may gather minimal context, then returns a structured plan with:

- goal;
- assumptions;
- file areas;
- implementation steps;
- risks;
- tests;
- estimated complexity;
- suggested mode for execution.

It does not create artifacts, show Apply Changes, or pretend to be an Agent run.

### Agent

Agent is the file-changing production path. It stages artifacts and requires Apply Changes. Simple deterministic edits must use Quick Edit with zero model calls. Larger work may use Researcher, Planner, Coder, Validator, Reviewer, Fixer, and Finalizer, but only where those steps reduce risk.

### Auto

Auto is a supervisor/router. It chooses Chat, Plan, Agent, Safety Check, or Quick Edit based on intent, risk, required context, expected model calls, timeout risk, and user settings. It should explain the route briefly in diagnostics, not spam the main response.

### Safety Check

Dangerous commands such as `git clean -fdx` must not execute automatically. Karo should explain the risk and suggest a safe dry-run such as `git clean -ndx`.

## One-Prompt Website Benchmark

Benchmark prompt:

> Create a modern landing page for a Minecraft JJK mod with hero, abilities, characters/energy, features, FAQ, responsive layout, dark anime style, and preview support.

The benchmark passes only when:

- Agent or Quick Edit produces staged website files from a real model/agent generation path or deterministic formal request;
- required sections are present;
- Apply Changes is required;
- Preview/Open flow exists after apply;
- no provider-timeout fallback is counted as success.

If Coder times out, Karo must keep partial artifacts, show the failed stage, and offer recovery actions such as retry, reduced context, switch model, continue from partial artifacts, or explicit emergency scaffold.

## Metrics

Usage and diagnostics should report:

- selected files count;
- context tokens;
- model calls count;
- elapsed model time;
- stage timeout;
- artifacts count;
- whether fallback was used;
- selected mode and route reason.
