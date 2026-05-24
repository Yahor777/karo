import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

const alias = (sub: string): string => resolve(rootDir, sub);

export default defineConfig({
  resolve: {
    alias: {
      "@ai-agent-orchestrator/shared-core": alias("packages/shared-core/src/index.ts"),
      "@ai-agent-orchestrator/shared-ui": alias("packages/shared-ui/src/index.ts"),
      "@ai-agent-orchestrator/client-sdk": alias("packages/client-sdk/src/index.ts"),
      "@ai-agent-orchestrator/validation": alias("packages/validation/src/index.ts"),
      "@ai-agent-orchestrator/agent-contracts": alias("packages/agent-contracts/src/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["apps/**/*.{test,spec}.{ts,tsx}", "packages/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.{ts,tsx}"],
      exclude: ["**/*.{test,spec}.{ts,tsx}", "**/dist/**"],
    },
  },
});
