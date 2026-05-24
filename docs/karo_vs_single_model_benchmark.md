# Karo vs Single Model Benchmark

This benchmark defines the product bar for Karo's main MVP scenario: creating a runnable website from one high-quality prompt. It is a manual/e2e benchmark, not a marketing claim.

## Prompt

```text
Создай современный landing page для Minecraft JJK mod с hero, features, abilities, pricing, FAQ, responsive layout, dark anime style. Сделай так, чтобы это можно было запустить и посмотреть в preview.
```

## Baseline: one model in a normal IDE

Expected single-model behavior:

- The model writes one or more files directly or suggests code snippets.
- Planning is usually implicit.
- Review/fix is manual unless the user asks again.
- Preview command discovery is manual.
- Command safety depends on the IDE/user, not on the model response.
- A failed build often needs another prompt.

## Karo expected behavior

Karo should be better because it orchestrates a workflow instead of only returning one completion:

- Researcher gathers task/project context when needed.
- Coder prepares staged changes.
- Reviewer checks generated files for obvious correctness issues.
- Fixer repairs issues when the reviewer finds them.
- Finalizer/Boss summarizes what changed and what to do next.
- Changes are staged first; Apply Changes is required before writing to the real project.
- Preview command is detected from project scripts and can be run through the safe terminal backend.
- Dangerous commands are blocked or require explicit approval.
- The user sees a clear summary, changed files, preview status, and logs.

## Acceptance Criteria

The Karo run passes this benchmark when:

- The task routes to Agent, not Chat or Plan.
- Simple create-file Quick Edit is not used for this multi-file website task.
- Staged changes contain website files with clear names and complete contents.
- No files are applied before the user clicks Apply Changes.
- Changes and Diff panels show the proposed files.
- Preview detects a safe script such as `pnpm desktop:dev:renderer`, `pnpm dev`, `pnpm start`, or `pnpm preview`.
- Running Preview starts through the MVP terminal allowlist.
- If terminal output contains a localhost URL, Karo extracts and displays it.
- If the preview/build fails, Karo shows the error and logs instead of fake success.
- The generated UI is responsive and has no broken imports in the produced files.
- The final user-facing summary lists changed files and next steps.

## Current Proof

The deterministic `gui:check:tauri-runtime` suite includes a staged website creation scenario with a stubbed model response. It proves:

- the complex landing-page prompt uses Agent mode;
- the full agent path is used instead of Quick Edit;
- staged website files are created;
- no apply happens automatically;
- command execution is not attempted by the agent task.

Renderer `gui:check` covers the product UI guardrails: composer density, Quick Edit behavior, right inspector, Changes, Preview/Terminal honesty, context popover, responsive layout, safety cards, and chat conversation behavior.

## Current Limitations

- Native WebView2 click automation is not available yet.
- Embedded preview is not implemented; the MVP shows detected URLs and supports opening them externally.
- The terminal backend is an MVP safe runner, not a full IDE PTY.
- Live model quality still depends on the selected provider/model and API availability.
