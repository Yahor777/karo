# Karo Product UI System Audit

Дата: 2026-05-23

Аудит основан на текущем renderer UI, `apps/desktop-windows/src/ui/workbench.ts`, `apps/desktop-windows/src/ui/main.css`, MCP/Playwright сценариях и screenshots из `apps/desktop-windows/e2e-artifacts/screenshots`.

Главный вывод: passed tests не равны хорошему UX. До этого MCP проверял, что элементы существуют и не выходят за viewport, но почти не проверял, должен ли элемент вообще быть на этом месте и не создает ли он ощущение недоделанной IDE.

## 1. Что сейчас лишнее

- Right inspector раньше показывал `Preview / Changes / Diff / Files / Logs / Usage / Terminal` как равнозначные вкладки даже без active run. Это превращало панель в свалку пустых состояний.
- Composer показывал слишком много решений сразу: command policy, web mode, preset, context window, effort, cycles, attach, model, mode, context usage. Для обычного ввода это шум.
- Terminal выглядел как рабочая вкладка, хотя backend отключен. Это обещало функциональность, которой нет.
- Context indicator `Context 0%` технически компактный, но без title/popover непонятно, что он значит.
- Welcome copy раньше описывал Agent pipeline, хотя главный экран должен быть chat-first.
- Changes как default right tab создавал ощущение, что даже обычный чат должен производить файлы.

## 2. Какие вкладки полезны, а какие пока фейковые

Полезны сейчас:

- `Chat`: основной рабочий поток.
- `Project`: полезен, если показывает clean path и состояние проекта.
- `Changes`: полезен только после Agent Mode или как короткий read-only empty state.
- `Models`: полезен для выбора модели, но должен показывать friendly name первым.
- `Settings`: полезен, если diagnostics collapsed.
- `Usage`: полезен для active run/context, не как stale глобальная панель.

Переосмыслены или демонтированы:

- `Terminal`: не должен быть обычной right tab, пока backend не подключен. Перенесен в bottom tools placeholder.
- `Diff`: нужен только при artifact/selected file.
- `Files`: нужен при выбранном проекте.
- `Logs`: нужен при run/log events.
- `Runs`: должен быть связан с conversation history, иначе выглядит как debug list.

## 3. Где интерфейс обманывает пользователя готовностью

- Run/Stop/Restart для terminal можно показывать только когда safe terminal backend доступен.
- Preview должен запускать только allowlist-команды через safe terminal backend; если bridge недоступен, показывать честное unavailable-состояние.
- Все right tabs не должны быть видимы одновременно без данных.
- Большие diagnostics/context blocks не должны попадать в основной chat/composer.
- Empty state `No changes proposed` звучит как результат pipeline. Для пустого workspace лучше `No changes yet`.

## 4. Left sidebar

Должно быть:

- project/current workspace сверху;
- primary action `New chat`;
- разделы Chat, Project, Changes, Runs, Models, Agents, Settings;
- список conversations как вторичный блок;
- selected chat явно подсвечен;
- Sign out снизу, компактно.

Что исправлено в текущем проходе:

- Список чатов сохранен как вторичный блок, а не основная навигация.
- Compact sidebar на narrow width не должен ломать центр.
- New chat остается главным действием.

## 5. Center area

Должно быть:

- пустой чат показывает компактный Welcome с подсказками;
- обычный chat выглядит как conversation;
- Plan/Safety/Analysis не показывают Coder/Fixer/Boss;
- Agent Mode отдельно показывает run/artifacts;
- Context block для read-only compact/collapsible.

Что исправлено:

- Welcome copy заменен на chat-first текст.
- Добавлены быстрые подсказки: Explain project, Make a plan, Create a file, Security review.

## 6. Right inspector

Right inspector должен показывать детали текущего run/task, а не список всех будущих возможностей.

Новая логика:

- Без active run: только Preview, Changes, Usage.
- Diff показывается только при artifact.
- Files показывается при project.
- Logs показывается при logs/active task.
- Terminal убран из right tab row.

## 7. Bottom panel

Terminal должен жить в IDE-like bottom panel:

- collapsed по умолчанию;
- показывает `Terminal backend is not connected` только если native bridge реально недоступен;
- показывает Run/Stop/Clear/Copy logs только при подключенном safe backend;
- не мешает composer.

Это честнее, чем pretending terminal tab.

## 8. Composer

Primary composer:

- textarea;
- attach;
- mode Auto/Chat/Plan/Agent;
- model chip;
- compact context indicator;
- Advanced;
- send.

Advanced:

- command policy;
- web mode;
- context window;
- preset;
- effort;
- cycles;
- future agent selection.

Что исправлено:

- Command/Web/Context window перенесены в Advanced.
- MCP теперь проверяет, что primary toolbar не занимает больше двух визуальных строк на normal viewport.

## 9. Context usage

Context usage должен жить рядом с composer controls:

- compact trigger `Context 0%`;
- title объясняет selected file tokens и window;
- подробности только в fixed portal popover и Usage tab;
- popover anchored near trigger;
- не внутри chat timeline;
- не перекрывает textarea;
- long model id wraps.

## 10. Terminal

Текущий backend терминала не подключен. Поэтому:

- terminal не показывается как полноценная рабочая вкладка;
- terminal state находится в bottom panel;
- fake command buttons убраны;
- Copy logs можно оставить как безопасное действие.

## 11. Empty states

Каждое пустое состояние должно объяснять следующий шаг:

- Changes: `No changes yet. Ask Agent to modify files, then proposed changes will appear here for review before Apply Changes.`
- Runs: `No runs yet. Plan and Agent runs will appear here.`
- Files: попросить выбрать project, если project отсутствует.
- Logs: `No logs yet.`
- Usage: `No usage yet. Start a project analysis, plan, or agent run to see token usage.`
- Terminal: safe MVP command runner or explicit backend-unavailable state.

## 12. Что скрыть до готовности backend

- Terminal run controls without a connected safe backend.
- Terminal как right tab.
- Any destructive command execution controls without Command Policy confirmation.
- Effort/preset/system prompt в main composer.
- Large diagnostics JSON by default.

## 13. Что оставить, но переименовать

- `Final Report` только для Agent Mode.
- Read-only: `Analysis Result`.
- Security: `Security Review Result`.
- Empty Changes: `No changes yet`.
- Context details: `Context usage`.

## 14. UX-принципы из Codex/Cursor/VS Code

- Chat-first center.
- Progressive disclosure.
- Inspector справа, tools снизу.
- Empty states короткие и полезные.
- Dangerous commands обрабатываются отдельным Safety response.
- Advanced controls не должны мешать простому вводу.

## 15. Что не копировать

- Не копировать точный chrome Codex: Karo имеет Agent/Plan/Apply Changes и должен явно показывать эти режимы.
- Не прятать Context Engine полностью: это сильная сторона Karo, но она должна быть compact.
- Не делать все задачи одним потоком assistant text: Agent Mode все еще требует artifacts/diff/apply.

## Решения текущего прохода

1. Right inspector больше не показывает все вкладки сразу.
2. Terminal перенесен в bottom tools placeholder.
3. Command/Web/Context window перенесены в Advanced.
4. Welcome стал chat-first.
5. MCP проверяет toolbar density, context popover anchor, hidden diagnostics, limited empty right tabs, no fake terminal controls.
