export const TEST_IDS = {
  appRoot: "app-root",
  topbar: "topbar",
  sidebar: "sidebar",
  sidebarNewChat: "sidebar-new-chat",
  sidebarConversationList: "sidebar-conversation-list",
  sidebarConversationItem: "sidebar-conversation-item",
  navChat: "nav-chat",
  navProject: "nav-project",
  navChanges: "nav-changes",
  navRuns: "nav-runs",
  navModels: "nav-models",
  navAgents: "nav-agents",
  navSettings: "nav-settings",
  chatThread: "chat-thread",
  chatMessageUser: "chat-message-user",
  chatMessageAssistant: "chat-message-assistant",
  chatMessageSafety: "chat-message-safety",
  chatMessagePlan: "chat-message-plan",
  chatMessageAnalysis: "chat-message-analysis",
  composer: "composer",
  composerTextarea: "composer-textarea",
  composerSend: "composer-send",
  composerAttach: "composer-attach",
  composerModeAuto: "composer-mode-auto",
  composerModeChat: "composer-mode-chat",
  composerModePlan: "composer-mode-plan",
  composerModeAgent: "composer-mode-agent",
  composerModelChip: "composer-model-chip",
  composerCommandMode: "composer-command-mode",
  composerWebMode: "composer-web-mode",
  composerContextTrigger: "composer-context-trigger",
  composerAdvancedToggle: "composer-advanced-toggle",
  composerAdvancedPanel: "composer-advanced-panel",
  contextUsagePopover: "context-usage-popover",
  contextUsageCopy: "context-usage-copy",
  rightPanel: "right-panel",
  rightTabPreview: "right-tab-preview",
  rightTabChanges: "right-tab-changes",
  rightTabDiff: "right-tab-diff",
  rightTabFiles: "right-tab-files",
  rightTabLogs: "right-tab-logs",
  rightTabUsage: "right-tab-usage",
  rightTabTerminal: "right-tab-terminal",
  clarificationCard: "clarification-card",
  clarificationOption: "clarification-option",
  clarificationCustomInput: "clarification-custom-input",
  clarificationContinue: "clarification-continue",
  safetyCard: "safety-card",
  planResult: "plan-result",
  analysisResult: "analysis-result",
  readonlyResult: "readonly-result",
  securityReviewResult: "security-review-result",
  agentCard: "agent-card",
  agentActivityDetails: "agent-activity-details",
  agentRunSummaryActions: "agent-run-summary-actions",
  agentSummaryOpenChanges: "agent-summary-open-changes",
  agentSummaryOpenPreview: "agent-summary-open-preview",
  agentSummaryOpenUsage: "agent-summary-open-usage",
  agentRecoverySummary: "agent-recovery-summary",
  changesApplyGate: "changes-apply-gate",
  changesApplyButton: "changes-apply-button",
  previewRunButton: "preview-run-button",
  previewReviewStagedChanges: "preview-review-staged-changes",
  previewChooseProject: "preview-choose-project",
  terminalPanel: "terminal-panel",
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

export function byTestId(testId: string): string {
  return `[data-testid="${cssEscape(testId)}"]`;
}

export function resolveSelector(input: { selector?: string; testId?: string }): string {
  if (input.selector !== undefined && input.selector.trim().length > 0) return input.selector;
  if (input.testId !== undefined && input.testId.trim().length > 0) return byTestId(input.testId);
  throw new Error("Expected selector or testId.");
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
