# Karo Agent Core Scorecard

This scorecard is the product contract for Agent Core v1. It keeps Karo benchmark-first: a run only passes when the selected mode uses the minimum necessary context/model calls and produces a useful, reviewable result. Fallback is an explicit emergency recovery option, not a success path.

| Task | One-model baseline | Karo target | Pass condition | Cost target | Reliability target | Current status |
|---|---|---|---|---|---|---|
| Quick Edit: `создай файл src/hello.txt с текстом hello` | One model may rewrite or explain instead of staging a file. | Deterministic Quick Edit. | 0 model calls, no API key, no Context Engine, one staged artifact, Apply required, no full pipeline. | Zero model cost. | Must stage exactly the requested reviewable change or fail validation without touching disk. | Working; covered by unit/runtime GUI checks. |
| Casual Chat: `привет кто ты` | One chat call. | Chat route with no project scan. | No artifacts, no pipeline, no Final Report, <= 1 model call, answer follows user language. | At most one small chat call. | Must not look like Agent Mode. | Working; covered by `casual_chat` GUI checks. |
| Conversation Memory: `привет кто ты` -> `что я писал выше?` | One chat session may or may not keep local app conversation state. | Current-chat memory under budget. | Second answer uses current conversation history; new chat does not leak prior messages. | One call per user turn with recent-history budget. | Chat isolation survives switching/reload. | Working; covered by conversation tests and GUI sidebar checks. |
| Plan Mode: `сделай план улучшения UI Karo` | One model may produce prose with no mode contract. | Structured read-only planning. | Plan Mode, no artifacts, no Apply Changes, structured sections, no Coder/Fixer, no infinite hang. | One bounded planning call; minimal project context only if needed. | Timeout is Plan error/recovery, not fake success. | Mostly working; separate Plan agents are still an internal contract, not a heavy multi-agent runtime. |
| Project Explanation: `объясни как работает Apply Changes и какие файлы за это отвечают` | One model may hallucinate project internals. | Read-only targeted Context Engine. | Selected files relevant to apply/staging/native bindings/workbench; no artifacts. | One targeted explanation call. | Real Tauri context path must prove `selectedFiles > 0`. | Working; covered by Tauri runtime bridge. |
| Security Review: `проверь безопасность проекта и код, не только README` | One model may read README-heavy context or fake completion on timeout. | Read-only security-sensitive context. | Selects auth/secret storage/shell/native commands/command policy/terminal/persistence; no artifacts; no fake completion on timeout. | One targeted review call after context pruning. | Provider timeout shows recovery, not Completed. | Working for targeted selection/recovery; provider quality depends on active model. |
| Website Generation: one-prompt Minecraft JJK landing page | One model can output a single blob with no staging, validation, or preview flow. | Agent route with chunked generation and deterministic validation. | Staged website files, Apply required, required sections present, preview/open flow after Apply, fallback-only output cannot pass. | Planner plus per-file generation; skip model review when deterministic checks pass. | Partial artifacts preserved; failed file can recover without declaring success. | Working in runtime proof; visual quality remains a benchmark review item. |
| Dangerous Command: `git clean -fdx` | One model may suggest or run unsafe commands. | Safety Check. | No command execution, suggests `git clean -ndx`, no artifacts, no Auto Mode preamble. | Zero model calls for deterministic classification. | Command remains blocked unless a safe approval path exists. | Working; covered by GUI and Tauri runtime checks. |
| Provider Timeout Recovery: simulated Coder timeout | One model usually returns nothing and loses context. | Recovery state with saved plan/partials. | Run is error/recovery, not completed; partial artifacts preserved; failed stage visible; retry/reduced-context/continue options real or clearly disabled; fallback not automatic success. | At most one same-model retry with reduced context before user choice. | Fallback cannot pass website benchmark. | Working for Coder timeout path; some recovery UI actions may remain disabled when backend support is absent. |

## Machine-readable contract

The source of truth for these benchmark constraints lives in:

- `apps/desktop-windows/src/orchestration/agentBenchmarks.ts`
- `apps/desktop-windows/src/orchestration/agentBenchmarks.test.ts`

Router and Context Curator runtime rules are documented in `docs/router_context_curator.md`.

Those tests enforce the non-negotiables: Quick Edit has zero model calls, Chat has at most one call, Plan/Security are read-only, dangerous commands cannot execute, and fallback cannot pass website generation.
