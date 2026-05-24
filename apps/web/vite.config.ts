import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const alias = (sub: string): string => resolve(repoRoot, sub);

/**
 * Vite configuration for the Web App renderer.
 *
 * The dev server runs on port 5173 (Vite's default). The web app does
 * not bundle any local-encrypted-storage API by design — session
 * state lives in the secure HTTP-only cookie set by the server-side
 * `handleOAuthCallback` (`apps/web/src/shell/oauthCallback.ts`).
 *
 * Workspace package paths are resolved through aliases so the
 * renderer can import shared-ui / shared-core / client-sdk /
 * validation directly from source — same convention as the desktop
 * Vite config.
 */
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  base: "./",
  resolve: {
    alias: {
      "@ai-agent-orchestrator/shared-core": alias(
        "packages/shared-core/src/index.ts",
      ),
      "@ai-agent-orchestrator/shared-ui": alias(
        "packages/shared-ui/src/index.ts",
      ),
      "@ai-agent-orchestrator/client-sdk": alias(
        "packages/client-sdk/src/index.ts",
      ),
      "@ai-agent-orchestrator/validation": alias(
        "packages/validation/src/index.ts",
      ),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
