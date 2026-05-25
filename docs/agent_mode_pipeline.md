# Agent Mode Pipeline

Agent Mode is Karo's file-changing runtime. It is the only full pipeline that may create or modify files, and every change must be written as a staged artifact first. Project files are not changed until the user approves Apply Changes.

## Contract

- Agent Mode can create or modify files only through staged artifacts.
- Apply Changes is always required before writing to the project.
- Simple deterministic edits use Quick Edit with zero model calls.
- Emergency fallback is never a success path and never passes the website benchmark.
- Timeout preserves partial artifacts and reports recovery instead of completion.
- Hidden chain-of-thought is not shown. The UI shows public activity events only.

## Adaptive Strategy

Karo should not run the heaviest pipeline for every file-changing task.

| Task shape | Runtime path | Model budget |
| --- | --- | --- |
| Create one file with exact text | Quick Edit | 0 calls |
| Small single-file creative/code task | Coder plus deterministic validation | Usually 1 call |
| Multi-file static website | Planner trace, chunked Coder, deterministic Validator, targeted Fixer if needed, Finalizer | Researcher + one call per file |
| Existing project modification | Context Curator, Planner, Coder, Validator, Reviewer/Fixer only if needed | Targeted calls |

## Machine-Readable Plan

Before coding, Agent Mode normalizes the task into an internal implementation plan:

- task type;
- goal;
- files to create;
- files to modify;
- files to read;
- acceptance criteria;
- required checks;
- risks;
- expected artifacts;
- whether preview instructions are needed;
- estimated model calls;
- context budget;
- `fallbackAllowedAsSuccess: false`.

The plan is exposed as public activity, not as model reasoning.

## Chunked Coder

Multi-file website work is generated one file at a time:

- `src/karo-demo-site/index.html`;
- `src/karo-demo-site/styles.css`;
- `src/karo-demo-site/script.js`;
- `src/karo-demo-site/README.md`.

Each successful file is staged immediately. If a later file times out, earlier staged drafts remain visible and reviewable.

## Deterministic Validator

The Validator runs before model review. It checks:

- safe artifact paths;
- non-empty artifact content;
- no secret-looking generated values;
- required website files;
- hero, abilities, characters/energy, features, and FAQ sections;
- responsive dark/card styling signals;
- preview/apply instructions.

If validation passes, Karo skips model Reviewer and Boss calls for the website path. If validation finds concrete website defects, Karo first tries targeted deterministic repair.

## Targeted Fixer

The Fixer must repair concrete defects only:

- missing FAQ updates `index.html`;
- missing preview instructions updates or creates `README.md`;
- missing CSS creates `styles.css`;
- missing responsive/card styling updates `styles.css`;
- missing script creates `script.js`.

It must not rewrite unrelated artifacts.

## Reviewer and Finalizer

Reviewer is used only when deterministic validation cannot prove the result or targeted repair cannot address the defect. Reviewer output must be structured; invalid output gets one repair retry. If it remains invalid, the run enters recovery/error instead of fake success.

Finalizer reports:

- completed, recovery, or failed status;
- staged files;
- validation checks and remaining issues;
- fallback used or not;
- model call count when known;
- context profile;
- preview instructions;
- that Apply Changes is still required.

Finalizer must not claim files were applied or preview was verified unless that actually happened.
