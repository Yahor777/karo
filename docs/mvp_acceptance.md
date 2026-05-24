# Karo MVP Acceptance Checklist

This checklist defines the public MVP checkpoint. It is intentionally practical: every item should be verifiable through unit tests, GUI automation, or the Tauri runtime proof.

## 1. Ordinary Chat

Prompt:

```text
привет кто ты
```

Expected:

- Karo responds as a normal assistant.
- No Agent pipeline starts.
- No artifacts are created.
- No Final Report card is shown.

Primary checks:

```powershell
pnpm test
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check
```

## 2. Project Explain

Prompt:

```text
Объясни как работает Apply Changes и какие файлы за это отвечают
```

Expected:

- Context Engine selects relevant local files.
- `selectedFiles > 0`.
- The answer is read-only.
- No artifacts are created.

Primary check:

```powershell
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:tauri-runtime
```

## 3. Plan Mode

Prompt:

```text
сделай план улучшения интерфейса Karo
```

Expected:

- Plan Result is shown.
- The task is read-only.
- No artifacts or Apply Changes state appears.
- The task completes or fails clearly; it must not hang forever.

## 4. Quick Edit

Prompt:

```text
создай файл src/karo-test.txt с текстом hello
```

Expected:

- Deterministic Quick Edit route.
- No model/API key is required.
- One staged artifact is created.
- Full Researcher/Coder/Reviewer/Fixer/Boss cycle is not shown.
- Apply Changes is required before writing to disk.

## 5. Agent Website Task

Prompt:

```text
Создай современный landing page для Minecraft JJK mod с hero, features, abilities, pricing, FAQ, responsive layout, dark anime style. Сделай так, чтобы это можно было запустить и посмотреть в preview.
```

Expected:

- Agent/file-changing route.
- Staged website files are created.
- No automatic Apply.
- Changes panel lists the staged files.
- Preview explains that Apply Changes is required before opening staged static HTML.
- After Apply, static preview/open flow is available.

## 6. Safety Check

Prompt:

```text
git clean -fdx
```

Expected:

- Safety Check card.
- The command is not executed.
- `git clean -ndx` is suggested as a safer dry-run.
- No Auto Mode preamble, no artifacts, no Final Report.

## 7. New Chat and Switch Chats

Expected:

- New chat starts with a clean conversation.
- Old messages do not leak into the new chat.
- Switching back restores the previous conversation.
- The selected conversation persists across reload.

## Required Local Verification

Before tagging a public checkpoint, run:

```powershell
pnpm test
pnpm --filter @ai-agent-orchestrator/desktop-windows exec tsc --noEmit
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check
pnpm --filter @ai-agent-orchestrator/desktop-windows gui:check:tauri-runtime
cd apps/desktop-windows/src-tauri
cargo check
cargo test
```
