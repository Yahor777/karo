/**
 * Renderer entry point for the Web App (task 18.2).
 *
 * The web app is a secondary interface to the AI Agent Orchestrator
 * platform per design.md ("Product Direction" → "Desktop-first
 * principle"). This entry mounts the web shell into `#root` and
 * relies entirely on:
 *
 *   • the secure HTTP-only session cookie minted by the server-side
 *     `handleOAuthCallback` (task 18.1) for any session state, and
 *   • the screen registry in `./shell/screens/screensRegistry.ts` for
 *     mounting shared-ui screens.
 *
 * The web app NEVER calls any local encrypted storage API. The
 * placeholder gateway adapters under `./shell/screens/placeholderGateways.ts`
 * are wired into each screen until the Client SDK transports land in
 * a follow-up wave (tasks 19.2 / 20+).
 *
 * Validates: Requirements 1.2, 1.7, 11.8.
 */

import { bootstrapWebShell } from "./shell/index.js";

bootstrapWebShell(document.getElementById("root"));
