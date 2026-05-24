# Implementation Plan: AI Agent Orchestrator

## Overview

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

The plan follows the desktop-first architecture defined in `design.md`: Windows Desktop App as the primary product, Web App as a secondary interface, with shared core/UI/SDK packages and a backend orchestrator. Implementation language is **TypeScript** (Node.js for backend, React + TypeScript for UI, Tauri for the Windows Desktop Shell with Electron acceptable as fallback).

Property-based tests are included for the 15 properties listed in `design.md` → "Testing Strategy" → "Property-based tests". Each property test sub-task references both its property number and the requirements clause it validates.

## Tasks

- [x] 1. Set up monorepo project structure and tooling
  - [x] 1.1 Initialize monorepo with apps and shared packages
    - Create `apps/desktop-windows`, `apps/web`, `apps/backend`
    - Create `packages/shared-core`, `packages/shared-ui`, `packages/client-sdk`, `packages/validation`, `packages/agent-contracts`
    - Add workspace manifest (pnpm/npm workspaces) wiring packages together
    - _Requirements: 1.5, 1.7_

  - [x] 1.2 Configure TypeScript, linting, formatting and base test runner
    - Add root and per-package `tsconfig.json` with strict mode
    - Configure ESLint + Prettier + project-wide path aliases
    - Add Vitest (or Jest) with `fast-check` for property-based testing
    - _Requirements: 1.5, 1.7_

- [x] 2. Implement shared domain types and validation schemas
  - [x] 2.1 Define core domain types in `packages/shared-core`
    - Add `AppTarget`, `ProviderId`, `ModelRef`, `Scope`, `Session`, `User`, `TaskId`, `AgentId`, `BuiltinAgentRole`, `ToolId`
    - Add `RuntimeEnvironment` capability types for desktop and web
    - _Requirements: 1.5, 2.5, 3.2_

  - [x] 2.2 Define schemas for `Agent_Message`, `Task`, `File_Artifact`, `Final_Report`, `Custom_Agent` in `packages/validation`
    - Use Zod (or equivalent) for runtime validation
    - Enforce taskId 1..128 chars, payload ≤ 1 MB, ISO 8601 UTC ms timestamps
    - Enforce non-empty prompt after trim, `maxReviewCycles >= 1`, Manual_Mode requires participants
    - _Requirements: 6.4, 6.5, 6.6, 7.1, 10.1, 10.2, 10.3, 10.4, 10.5, 12.1, 12.2, 14.2_

  - [x]* 2.3 Write property test for `Agent_Message` normalization
    - **Property 5: Agent_Message normalization always returns valid Agent_Message**
    - **Validates: Requirements 10.8, 10.9**
    - _Requirements: 10.8, 10.9_

  - [x]* 2.4 Write property test for Task input validation
    - **Property 3: Empty prompt can never create Task**
    - **Property 4: Manual_Mode with zero agents can never create Task**
    - **Validates: Requirements 6.4, 6.5, 6.6**
    - _Requirements: 6.4, 6.5, 6.6_

  - [x]* 2.5 Write unit tests for validation schemas
    - Cover boundary cases (empty taskId, oversize payload, invalid timestamps, invalid agent message types)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 3. Build Windows Desktop Shell foundation
  - [x] 3.1 Create desktop app skeleton (Tauri preferred, Electron acceptable)
    - Add main window, secure renderer↔shell bridge, application entry
    - Define `DesktopShell` interface from design and stub native bindings
    - _Requirements: 1.1, 1.3, 1.4, 1.6_

  - [x] 3.2 Implement Local Encrypted Storage abstraction
    - Implement `encryptLocalSecret`/`decryptLocalSecret` using OS-backed key storage where available
    - Implement `readLocalSetting`/`writeLocalSetting`/`deleteLocalSetting` over encrypted SQLite (or equivalent)
    - Ensure secrets are never persisted in plaintext and never exposed to renderer after save
    - _Requirements: 1.6, 2.5, 4.5_

  - [x] 3.3 Implement local device id and local logs writer
    - Generate stable per-device id on first launch and persist in local storage
    - Implement `writeLocalLog` with PII/secret redaction
    - _Requirements: 1.4, 1.6_

  - [x]* 3.4 Write unit tests for Local Encrypted Storage and log redaction
    - Verify roundtrip encrypt/decrypt and that API-key-shaped values are redacted in logs
    - _Requirements: 1.6, 4.5_

- [x] 4. Implement Auth Service and API-key login flow
  - [x] 4.1 Implement `validateApiKey` in backend Auth Service
    - Perform a lightweight test request against the Provider for the supplied API key
    - Return structured `ValidationResult` (`ok` or `error` with provider code/message)
    - _Requirements: 2.2, 2.3, 4.2, 4.3_

  - [x] 4.2 Implement `createLocalSession` with explicit user confirmation
    - Require `confirmedByUser: true` payload before saving secret locally
    - Persist API key encrypted via Desktop Shell's Local Encrypted Storage
    - Return `Session` of kind `local` without API key in payload
    - _Requirements: 2.4, 2.5, 2.8, 4.5_

  - [x] 4.3 Build login UI for API-key flow in Desktop and shared UI
    - Login screen with "Enter API key" / "Sign in with Gmail" choice
    - API key entry, Provider selection, validation feedback, save confirmation modal
    - Surface provider error messages on validation failure
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x]* 4.4 Write unit tests for Auth Service local session flow
    - Cover invalid key rejection, missing confirmation rejection, session shape
    - _Requirements: 2.2, 2.3, 2.4, 2.5_

  - [x]* 4.5 Write property test for sync confirmation gate
    - **Property 8: Local settings never sync to cloud without explicit user confirmation**
    - **Validates: Requirements 2.8, 3.7**
    - _Requirements: 2.8, 3.7_

- [~] 5. Checkpoint - Ensure foundation tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement Settings Store and provider/key management
  - [x] 6.1 Implement `upsertApiKey`, `removeApiKey`, `listApiKeyMetadata` for local scope
    - Encrypt before persistence, expose only `ApiKeyMetadata` (fingerprint, createdAt, lastValidatedAt)
    - Successful delete returns success without error UI
    - _Requirements: 4.1, 4.2, 4.4, 4.5_

  - [x] 6.2 Implement `Custom_Agent` CRUD with name uniqueness validation
    - Reject names colliding with Builtin_Agent names or other Custom_Agent within scope
    - Require non-empty `systemPrompt`
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 6.3 Implement `resolveApiKeySecret` server-side gateway
    - Accept only signed `ServerComponentToken` from authorized components
    - Never return decrypted key to client-facing endpoints
    - _Requirements: 3.7, 4.5_

  - [x] 6.4 Build provider/API key management screen and Custom Agents editor
    - List metadata only (no full keys), add/update/delete flows, fingerprint display
    - Custom agents editor with name conflict feedback
    - _Requirements: 4.1, 4.4, 12.1, 12.2, 12.3_

  - [x]* 6.5 Write property test for API key metadata listing safety
    - **Property 9: API_Key is never returned by metadata listing**
    - **Validates: Requirements 3.7**
    - _Requirements: 3.7_

  - [x]* 6.6 Write property test for Custom_Agent name uniqueness
    - **Property 13: Custom_Agent cannot use duplicate Builtin_Agent name**
    - **Validates: Requirements 12.3**
    - _Requirements: 12.3_

  - [x]* 6.7 Write property test for delete-success behavior
    - **Property 15: Successful key deletion never produces error UI**
    - **Validates: Requirements 4.4**
    - _Requirements: 4.4_

- [x] 7. Implement Model Catalog
  - [x] 7.1 Implement `listModelsForUser` with per-provider isolation and short TTL cache
    - Query each configured provider independently; isolate failures per provider
    - Invalidate cache on API key change for the affected provider
    - Label `source: "platform-fallback"` results distinctly from user-key models
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x] 7.2 Build Model selection UI with fallback labeling
    - Group models by provider, surface per-provider error states without blocking others
    - Visually mark fallback/basic models
    - _Requirements: 5.2, 5.3, 5.5_

  - [x]* 7.3 Write property test for Model_Catalog provider isolation
    - **Property 7: Provider failure in Model_Catalog does not remove other providers' models**
    - **Validates: Requirements 5.3**
    - _Requirements: 5.3_

- [x] 8. Implement Task Builder and create-task validation
  - [x] 8.1 Build Task Builder screen
    - Prompt input, Model selector, Auto/Manual toggle, agent picker
    - Disable launch button while prompt is empty
    - _Requirements: 6.1, 6.2, 6.3, 6.5_

  - [x] 8.2 Implement `Orchestrator.createTask` input validation
    - Trim/non-empty prompt check, model availability check, valid API key (or confirmed fallback) check
    - Manual_Mode requires ≥ 1 participant; Auto_Mode must produce non-empty ordered set
    - Return `taskId` and persist initial `TaskState`
    - _Requirements: 6.4, 6.6, 6.7, 6.8_

  - [x]* 8.3 Write property test for empty-prompt rejection
    - **Property 3: Empty prompt can never create Task**
    - **Validates: Requirements 6.4, 6.5**
    - _Requirements: 6.4, 6.5_

  - [x]* 8.4 Write property test for Manual_Mode zero-agents rejection
    - **Property 4: Manual_Mode with zero agents can never create Task**
    - **Validates: Requirements 6.6**
    - _Requirements: 6.6_

- [x] 9. Implement Orchestrator pipeline state machine
  - [x] 9.1 Implement `TaskState` and pipeline transitions
    - Encode states: created, researching, coding, reviewing, fixing, boss_eval, completed, stopped_limit, error
    - Encode transitions per design state diagram (Researcher → Coder → Reviewer → (Fixer → Reviewer)* → Boss)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7_

  - [x] 9.2 Implement Review_Cycle counting, limits and Boss approval constraints
    - Increment cycle on Reviewer→Fixer→Reviewer loop and on Boss "не соответствует" feedback
    - Stop with `stopped_limit` when `reviewCycles >= maxReviewCycles` (default 5)
    - Disallow Boss "соответствует" before at least one Review_Cycle
    - _Requirements: 7.8, 8.5, 8.6, 14.1, 14.4_

  - [x]* 9.3 Write property test for Review_Cycle bound
    - **Property 1: Review_Cycle never exceeds maxReviewCycles**
    - **Validates: Requirements 7.8, 8.5, 8.6**
    - _Requirements: 7.8, 8.5, 8.6_

  - [x]* 9.4 Write property test for Boss approval precondition
    - **Property 2: Boss cannot approve before at least one Review_Cycle**
    - **Validates: Requirements 14.1**
    - _Requirements: 14.1_

- [x] 10. Implement Artifact Store
  - [x] 10.1 Implement `writeArtifact` with versioning and content hashing
    - Append-only versions starting at 1; same `contentHash` is no-op (no version increment)
    - Persist `authoredByAgentId`, `fileName`, `mimeType`, `bytes`
    - _Requirements: 7.4, 7.7, 11.7_

  - [x] 10.2 Implement `getArtifact`, `listArtifacts`, and `getDiff`
    - Diff is generated only on explicit request between two versions
    - _Requirements: 11.4, 11.5_

  - [x] 10.3 Build File_Artifact viewer and Diff viewer UI
    - Show content on artifact selection; show diff only on explicit version comparison action
    - Never auto-open diff in response to other UI events
    - _Requirements: 11.4, 11.5, 11.7_

  - [x]* 10.4 Write property test for idempotent same-content write
    - **Property 6: File_Artifact same-content write is idempotent**
    - **Validates: Requirements 7.4 (artifact atomicity), 11.7**
    - _Requirements: 7.4, 11.7_

  - [x]* 10.5 Write property test for diff non-auto-display
    - **Property 11: Diff is never displayed automatically**
    - **Validates: Requirements 11.5**
    - _Requirements: 11.5_

- [x] 11. Implement Trace Event Bus
  - [x] 11.1 Implement `publish`/`subscribe` with monotonic per-task `sequence`
    - Persist `TraceRecord` entries (thought, tool_call, artifact_change, status)
    - _Requirements: 9.5, 11.2, 11.7_

  - [x] 11.2 Implement SSE/WebSocket streaming endpoint for trace
    - Per-task and per-agent subscriptions; server-side buffering on slow clients
    - _Requirements: 11.3, 11.6_

  - [x] 11.3 Build Agent_Trace UI panel with delayed update handling
    - Show participating agents, statuses, live records, tool calls, artifact changes
    - Show "Updating..." / "Delayed" indicator when latency > 2s, never block UI
    - _Requirements: 11.1, 11.2, 11.3, 11.6, 11.8_

  - [x]* 11.4 Write property test for ordered task history
    - **Property 12: Task history remains ordered by timestamp/sequence**
    - **Validates: Requirements 10.1, 10.5, 10.6, 10.7**
    - _Requirements: 10.1, 10.5, 10.6, 10.7_

- [~] 12. Checkpoint - Ensure orchestrator, artifacts and trace tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement Web_Search_Tool with DuckDuckGo backend
  - [x] 13.1 Implement DuckDuckGo search adapter
    - Free backend (no paid keys), 5s timeout, basic rate limiting, structured `SearchResult`
    - Return descriptive error on failure without throwing into agent runtime
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 13.2 Wire web search invocations into Agent_Trace
    - Record query and short result summary as `tool_call` trace record
    - _Requirements: 9.5_

  - [x]* 13.3 Write unit tests for Web_Search_Tool error and timeout handling
    - Cover empty response, network error, timeout, rate-limit cases
    - _Requirements: 9.4_

- [x] 14. Implement Agent Runtime and Builtin Agents
  - [x] 14.1 Implement `AgentRunner` with model adapter and Agent_Message normalization
    - Provider call adapter, structured output parsing, normalization of malformed outputs
    - Wrap unreadable outputs as `type: "error"` Agent_Message; persist before handoff (≤ 500 ms)
    - Pass message history to agents bounded by 200 messages or 8 MB
    - _Requirements: 10.6, 10.7, 10.8, 10.9_

  - [x] 14.2 Implement Researcher and Coder builtin agents
    - Researcher: enrich prompt within 60 seconds using model + Web_Search_Tool; tolerate search failure
    - Coder: produce single File_Artifact atomically and hand off to Reviewer
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 14.3 Implement Reviewer and Fixer builtin agents
    - Reviewer: produce defects list or no-defects confirmation
    - Fixer: apply defects to File_Artifact and return updated version atomically
    - _Requirements: 7.1, 7.5, 7.6, 7.7_

  - [x] 14.4 Implement Boss builtin agent with verdict logic
    - Compare final artifact with original prompt, return "соответствует" or "не соответствует" with notes
    - Honor "approve only after ≥ 1 Review_Cycle" constraint via Orchestrator gate
    - _Requirements: 7.1, 7.10, 7.11, 14.1_

  - [x]* 14.5 Write property test for Agent_Message normalization invariant
    - **Property 5: Agent_Message normalization always returns valid Agent_Message**
    - **Validates: Requirements 10.8, 10.9**
    - _Requirements: 10.8, 10.9_

  - [x]* 14.6 Write unit tests for builtin agent permission enforcement
    - Verify each builtin role exposes only the tools listed in design (Researcher: web_search; Coder: web_search/file_read/file_write; Reviewer: web_search/file_read/artifact_diff; Fixer: web_search/file_read/file_write/artifact_diff; Boss: file_read/artifact_diff)
    - Verify Custom_Agent equivalence for Web_Search_Tool/Agent_Message/Agent_Trace access
    - _Requirements: 7.1, 12.6_

- [~] 15. Wire end-to-end pipeline and Final_Report
  - [x] 15.1 Connect agents through the pipeline state machine
    - Drive Researcher → Coder → Reviewer → (Fixer → Reviewer)* → Boss using TaskState transitions
    - Persist Agent_Messages and emit trace events at each step
    - _Requirements: 7.1, 8.1, 8.2, 8.3, 8.4, 8.7_

  - [x] 15.2 Implement Final_Report generation and Task History
    - Build `FinalReport` with originalPrompt, finalArtifacts, bossSummary, participants, reviewCyclesPerformed
    - Status `completed` on Boss approval, `stopped_limit` on cycle exhaustion
    - Persist for later viewing in Task History
    - _Requirements: 8.6, 8.7, 14.2, 14.3, 14.4, 14.5_

  - [x]* 15.3 Write integration test for full Researcher→...→Boss pipeline
    - Use mocked provider/model adapter and DuckDuckGo stub
    - Verify both `completed` and `stopped_limit` outcomes
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 14.2, 14.4_

  - [ ] 15.4 Build Final_Report viewer UI screen in `packages/shared-ui`
    - Render `FinalReport` fields: original prompt, status (`completed` / `stopped_limit`), Boss summary, outstanding issues, participants, review cycles performed
    - List final `File_Artifact` references with a "Download" action that calls `ArtifactClient.getArtifact` and routes bytes through `DesktopShell.exportFile` on Desktop and a browser download on Web
    - Wire screen via Client SDK `getFinalReport(taskId)` and `getArtifact`; expose mount points consumed by Desktop and Web shells
    - _Requirements: 14.2, 14.3, 14.4, 11.7, 11.8_

  - [ ]* 15.5 Write unit tests for Final_Report viewer screen
    - Cover `completed` vs `stopped_limit` rendering, outstanding issues display, and download action invoking the export port for the requested artifact version
    - _Requirements: 14.2, 14.3, 14.4_

  - [ ] 15.6 Build Task History viewer UI screen in `packages/shared-ui`
    - List persisted Tasks for current scope (local or cloud) with status, created/updated timestamps, participants and final review cycles
    - Open a stored Task into the existing Agent_Trace, File_Artifact and Final_Report screens for read-only viewing
    - Wire via Client SDK; reuse the same screens on Desktop and Web shells
    - _Requirements: 11.7, 14.5_

  - [ ]* 15.7 Write unit tests for Task History viewer screen
    - Cover empty history, ordering by `updatedAt`, and navigation into Final_Report / Agent_Trace / File_Artifact screens
    - _Requirements: 11.7, 14.5_

- [~] 16. Checkpoint - Ensure full pipeline tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [~] 17. Implement Gmail OAuth and cloud sync
  - [x] 17.1 Implement `beginGoogleOAuth` and `completeGoogleOAuth`
    - Request minimal scopes; validate OAuth state; create or restore user by Google sub
    - _Requirements: 3.1, 3.2_

  - [x] 17.2 Implement Cloud_Settings_Store with encrypted secret fields
    - Cloud-scoped tables for api_keys, custom_agents, preferences
    - Provide stored API keys/settings to authorized session on second-device login
    - _Requirements: 3.3, 3.4, 3.7_

  - [x] 17.3 Implement `upgradeLocalSessionToGoogle` with merge report
    - Require explicit confirmation flags for syncing settings and API keys
    - Apply conflict policy: cloud wins for same provider; copy non-conflicting custom agents; preserve conflicts as local-only
    - Return `MergeReport`
    - _Requirements: 2.7, 2.8, 3.6_

  - [x] 17.4 Build Gmail login UI flow and local-to-cloud upgrade UI
    - OAuth redirect handling, retry-later message on settings load failure, sync confirmation modal, merge result display
    - Wire `gmailLoginScreen` into Desktop `loginBootstrap` and Web shell `oauthCallback`
    - _Requirements: 3.1, 3.5, 3.6, 2.7_

  - [ ]* 17.5 Write property test for safe cloud login failure
    - **Property 14: Cloud login fails safely if settings cannot load**
    - **Validates: Requirements 3.5**
    - _Requirements: 3.5_

- [~] 18. Implement Web App secondary interface
  - [x] 18.1 Build Web Shell with routing and OAuth callback handling
    - Use secure HTTP-only cookies for session, no local encrypted storage
    - _Requirements: 1.2, 1.7, 3.1_

  - [~] 18.2 Reuse Shared UI for task creation, trace, artifact and final report screens
    - Wire Client SDK; mount login, model selection, task builder, agent trace, artifact viewer, Final_Report viewer and Task History screens from `packages/shared-ui`
    - Ensure parity with Desktop in Agent_Trace, File_Artifact, Final_Report and Task History viewing behavior
    - _Requirements: 1.7, 11.8, 14.3, 14.5_

  - [ ]* 18.3 Write integration tests for parity with desktop core flows
    - Task creation, trace streaming, artifact viewing, final report viewing
    - _Requirements: 1.7, 11.8_

- [~] 19. Implement Fallback Model Manager
  - [x] 19.1 Implement `getFallbackOptions` and `canUseFallback` policy
    - Only explicitly configured cheap/free fallback models allowed
    - Premium fallback disabled unless platform owner enables it
    - Denial-reason precedence: not_configured → policy_disabled → premium_disabled → rate_limited → allowed
    - _Requirements: 5.5, 13.3, 13.5, 13.6, 13.7_

  - [x] 19.2 Implement user notification before fallback and `recordFallbackUsage` rate limiting
    - Surface a notification step before switching from user API_Key to platform fallback
    - Expose `recordFallbackUsage` on the manager backed by `FallbackUsageStore.recordUsage`
    - Enforce per-scope/per-provider daily rate limits
    - _Requirements: 13.3, 13.4, 13.6_

  - [ ]* 19.3 Write property test for fallback policy enforcement
    - **Property 10: Fallback is never used unless policy allows it**
    - **Validates: Requirements 13.3, 13.5, 13.7**
    - _Requirements: 13.3, 13.5, 13.7_

- [~] 20. Final hardening and packaging
  - [x] 20.1 Add secret redaction in logs, error boundaries and structured error responses
    - Ensure no API keys appear in local or server logs; redact tokens in error payloads
    - Extend Desktop Shell `redaction` to backend gateway and trace event payloads
    - _Requirements: 1.6, 3.7, 4.5_

  - [x] 20.2 Configure Windows installer/packaging and update mechanism
    - Build/release scripts for Tauri (or Electron) bundle; auto-update channel
    - _Requirements: 1.1, 1.3, 1.4_

  - [ ]* 20.3 Write integration tests for sync errors and fallback flows
    - Cloud sync failure during active session preserves local pending changes
    - Fallback is offered, requires notification, and is rate-limited
    - _Requirements: 3.6, 13.3, 13.4, 13.6_

- [~] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP. They cover unit, integration and property-based tests.
- Each task references specific requirements from `requirements.md` for traceability.
- Property-based tests are tied to the 15 properties listed in `design.md` → "Testing Strategy" → "Property-based tests"; each property is its own sub-task and is annotated with both the property number and the requirements clause it validates.
- Checkpoints are placed after foundation, after orchestrator/artifacts/trace, after the full pipeline, and at the end.
- The plan delivers Windows Desktop App (the primary product) end-to-end before Web App, in line with the desktop-first architecture in the design.
- Status legend used in this plan: `[x]` complete, `[ ]` not started, `[~]` in progress / partial, with `*` suffix marking optional sub-tasks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.5", "3.4", "4.1", "6.1", "6.2", "6.3", "7.1", "9.1", "10.1", "11.1", "13.1"] },
    { "id": 4, "tasks": ["4.2", "4.5", "6.5", "6.6", "6.7", "7.3", "9.2", "10.2", "10.4", "10.5", "11.2", "11.4", "13.2", "13.3", "14.1", "17.1"] },
    { "id": 5, "tasks": ["4.3", "6.4", "7.2", "8.1", "8.2", "9.3", "9.4", "10.3", "11.3", "14.2", "14.3", "14.4", "14.5", "17.2"] },
    { "id": 6, "tasks": ["4.4", "8.3", "8.4", "14.6", "15.1", "17.3", "17.5", "19.1"] },
    { "id": 7, "tasks": ["15.2", "18.1", "19.2", "19.3", "20.1"] },
    { "id": 8, "tasks": ["15.3", "15.4", "15.6", "17.4", "20.2"] },
    { "id": 9, "tasks": ["15.5", "15.7", "18.2"] },
    { "id": 10, "tasks": ["18.3", "20.3"] }
  ]
}
```
