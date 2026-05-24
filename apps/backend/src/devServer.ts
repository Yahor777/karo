/**
 * Minimal development health server (`pnpm dev:backend`).
 *
 * The backend is a library of service modules consumed by the desktop
 * and web apps. There is no full HTTP gateway yet; this dev server is
 * intentionally tiny — it brings up a Node `http` server that exposes
 * `/health`, `/version` and `/ready` endpoints so a developer can:
 *
 *   • verify the backend bundle compiles and runs (`pnpm dev:backend`);
 *   • point the web app's `vite.config.ts` proxy at this port for
 *     local end-to-end smoke tests;
 *   • observe the backend service registry via `/version`.
 *
 * Production deployments wire the same service modules behind a real
 * HTTP gateway (see `design.md` → "Backend"). This file is dev-only.
 *
 * Validates: nothing — this is operational glue.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { backendServiceName } from "./index.js";

const DEFAULT_PORT = 4000;

interface DevServerOptions {
  readonly port?: number;
  readonly logger?: { info: (msg: string) => void };
}

export interface DevServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export function startDevServer(
  options: DevServerOptions = {},
): Promise<DevServerHandle> {
  const port = options.port ?? Number(process.env["BACKEND_PORT"] ?? DEFAULT_PORT);
  const log = options.logger ?? { info: (m: string) => console.log(m) };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (method !== "GET") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    if (url.startsWith("/health")) {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.startsWith("/ready")) {
      res.statusCode = 200;
      res.end(JSON.stringify({ ready: true }));
      return;
    }

    if (url.startsWith("/version")) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          service: backendServiceName,
          version: process.env["npm_package_version"] ?? "0.0.0",
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found", path: url }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      log.info(`[backend dev] listening on http://127.0.0.1:${String(port)}`);
      log.info(`[backend dev] try: curl http://127.0.0.1:${String(port)}/health`);
      resolve({
        port,
        close(): Promise<void> {
          return new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
          });
        },
      });
    });
  });
}

// CLI entrypoint: when this file is run directly via `node`, start the
// server. Inside Vitest / library imports it stays inert.
const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /devServer\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isCli) {
  void startDevServer().catch((err: unknown) => {
    console.error("[backend dev] failed to start:", err);
    process.exit(1);
  });
}
