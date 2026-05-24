/**
 * Public surface of `@ai-agent-orchestrator/web` (task 18.1).
 *
 * The Web Shell currently ships:
 *
 *   • A tiny client-side router (`shell/router.ts`).
 *   • Secure HTTP-only session cookie helpers (`shell/sessionCookie.ts`).
 *   • A server-side OAuth callback handler that delegates to
 *     `GoogleOAuthService.completeGoogleOAuth` from task 17.1
 *     (`shell/oauthCallback.ts`).
 *   • A minimal landing-page mount that wires the router and shows
 *     placeholder views for the five required routes
 *     (`shell/bootstrap.ts`).
 *
 * Validates: Requirements 1.2, 1.7, 3.1.
 */

export const webAppName = "AI Agent Orchestrator (Web)";

export * from "./shell/index.js";
