# Karo Product UX Architecture

## Current Problems

Karo has the core technical pieces for a useful desktop AI coding app, but the product surface still feels like a debug console:

- Chat, read-only analysis, planning, and file-changing agent runs are visually mixed.
- "Assist" is overloaded. It currently means read-only help, project analysis, and planning.
- Runs exist, but the chat history is the primary user experience and must stay stable.
- The right panel can show stale run state outside the active chat context.
- Context usage is useful but must stay compact in the composer and detailed in the Usage tab.
- Preview/run and terminal concepts must stay honest: safe allowed commands can run, arbitrary shell access cannot.
- Models and capabilities need honest source labels: provider metadata, known table, heuristic, manual override, or unknown.

## Product Navigation

Karo should be chat-first:

- Sidebar:
  - New chat
  - Search
  - Projects with grouped conversations
  - Runs / History
  - Settings
  - Account and Sign out at the bottom
- Main center:
  - Conversation timeline
  - Clarification cards
  - Assistant answers
  - Compact context blocks
  - Collapsed diagnostics for non-casual runs
- Right panel:
  - Preview
  - Changes
  - Diff
  - Files
  - Logs
  - Usage
  - Terminal

Models, Agents, and Settings are product configuration surfaces, not the main daily path.

## Data Model

Project:

- id
- name
- rootPath
- conversations[]

Conversation:

- id
- projectId
- title
- messages[]
- runs[]
- createdAt
- updatedAt
- settingsSnapshot

Message:

- id
- role: user | assistant | system | safety | tool
- content
- kind: normal | clarification | safety | analysis | error
- runId optional
- createdAt

Run:

- id
- conversationId
- projectId
- mode: chat | plan | agent | auto
- decision
- status
- timeline
- contextSnapshot
- usage
- changes
- previewCommand
- createdAt
- finishedAt
- durationMs

ContextSnapshot:

- projectRoot
- selectedFiles
- scannedCount
- warnings
- tokenEstimate

UsageSnapshot:

- model
- provider
- contextWindow
- usedTokens
- systemPromptTokens
- userPromptTokens
- conversationTokens
- selectedFilesTokens
- toolTokens
- outputReservedTokens
- estimatedCost

## Modes

### Chat Mode

Chat Mode is for conversation, explanations, project questions, and read-only help. It may use project context and web/search depending on task policy, but it never creates artifacts or stages files.

Rules:

- No file writes.
- No destructive commands.
- No Coder, Reviewer, Fixer, or Boss pipeline.
- No Final Report for casual chat.
- Project/security analysis can show compact context and a collapsed analysis result.

### Plan Mode

Plan Mode replaces the old user-facing Assist concept. It is read-only and produces implementation strategy, architecture, UX, risk, and test plans. It does not change files unless the user explicitly starts implementation.

Planning agents:

- Product Planner
- Technical Architect
- UX Designer
- Safety Reviewer
- Implementation Planner
- Plan Reviewer
- Final Planner

Plan Result sections:

- Summary
- Proposed Architecture
- Implementation Phases
- Risks
- Test Plan
- Next Action

Actions:

- Start implementation
- Copy plan
- Save as task draft
- Open in editor, if enabled

### Agent Mode

Agent Mode is for real code changes, staging, tests, diffs, and Apply Changes. It may use context, web/search, and terminal commands through policy.

Rules:

- Can create artifacts.
- Can stage proposed file changes.
- Must not apply changes without explicit user action.
- Commands go through Command Policy.

### Auto Mode

Auto chooses the route:

- Casual/question -> Chat
- Planning/design/architecture -> Plan
- Project/security analysis -> Chat or Plan, depending on complexity
- Create/modify/fix/refactor -> Agent
- Dangerous command -> Safety Check
- Vague request -> Clarification Card

Auto must not start Agent Mode for vague prompts like "make it better" without clarification.

## Web And Tool Policy

Web and tools are task settings, not modes.

Web mode:

- Off
- Ask
- Auto
- Always

Tool mode:

- Off
- Ask
- Auto
- Full

Chat, Plan, and Agent all respect Web and Tool policy.

## Right Panel Logic

- Ordinary chat: no active run.
- Safety check: no command executed.
- Read-only analysis: no file changes.
- Plan mode: plan result and next implementation action.
- Agent mode with changes: Changes, Diff, Apply Changes.
- Preview available: show detected or suggested command and run it only through the safe terminal backend.
- Terminal available in MVP only as a constrained safe runner; show backend-not-connected if the native bridge is unavailable.

On medium and narrow windows the right panel collapses or becomes a drawer so the chat remains readable.

## Preview And Terminal

Preview stores a suggested run command on the run:

- command
- cwd
- source: detected | agent_suggested | user_custom
- last status
- last URL if detected

Terminal is an MVP safe command runner, not a full IDE PTY:

- Show backend-not-connected state when the native bridge is unavailable.
- Expose Run/Stop/Clear/Copy logs only when the safe backend is available.
- Restrict commands to the MVP allowlist and project root.

Every command must go through Command Policy. Destructive commands are blocked or require explicit confirmation and should suggest dry-run or backup where possible.

## Context Usage

Composer:

- Compact trigger only, for example `Context 4%`.
- Portal popover with bounded fixed positioning.
- No giant usage text in the timeline or composer layout.

Usage tab:

- model and full id
- provider
- known max context
- selected context
- source and confidence
- warnings
- token breakdown
- per-agent usage
- selected context files

Unknown/Kimi-like models use a conservative default and show max as unknown unless provider metadata or a known table says otherwise.

## Model Capabilities

Model capability source must be explicit:

- provider_metadata
- known_table
- heuristic
- manual_override
- unknown

Image-only models such as Flux should not be offered as main chat/code models in the composer selector.

## Visual Direction

Palette:

- Background: `#08080D`
- Surface: `#11111A`
- Surface elevated: `#171724`
- Border: `#2A2438`
- Text primary: `#F4F2FF`
- Text secondary: `#A8A2BA`
- Text muted: `#6F6980`
- Purple accent: `#8B5CF6`
- Blue accent: `#38BDF8`
- Green success: `#22C55E`
- Amber warning: `#F59E0B`
- Red danger: `#EF4444`

Cards:

- Chat: neutral
- Plan: violet/blue accent
- Agent: purple accent
- Safety: amber accent
- Error: red accent

## Phased Implementation

Phase 1:

- Rename user-facing Assist to Plan.
- Add Plan Mode to composer and Auto routing.
- Keep Chat pure and read-only.
- Keep Agent as the only file-changing mode.
- Keep context usage compact in composer.
- Keep read-only results free of Coder/Fixer/Boss.

Phase 2:

- Add New chat and conversation switching.
- Persist conversations per project.
- Keep messages stable when switching.

Phase 3:

- Add Preview basics: suggested command and editable command.
- Run Preview through the safe terminal backend when available.
- Keep Terminal in the bottom panel as a constrained safe runner, not a fake full shell.

Phase 4:

- Improve Models, Agents, Settings as product pages.
- Add capability source details and filters.
- Make Plan Mode agents explicit in state and UI.
