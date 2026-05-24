import { defineConfig } from "vite";

/**
 * Vite configuration for the Windows Desktop App renderer.
 *
 * The dev server port (1420) matches `tauri.conf.json`'s `devUrl`.
 * Tauri injects `__TAURI_INTERNALS__` into the renderer at runtime;
 * `@tauri-apps/api/core` is therefore safe to dynamic-import from
 * `src/main.ts`.
 */
export default defineConfig({
  // Tauri expects a fixed port and cannot fall back, so we fail loudly
  // if it's already in use.
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  // Produce assets relative to the bundle root so Tauri can load them
  // from the `frontendDist` directory.
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
