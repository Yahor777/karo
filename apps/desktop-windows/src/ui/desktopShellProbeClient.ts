/**
 * Renderer-side `ProbeHttpClient` adapter that routes provider probes
 * through the Tauri shell instead of the WebView's `fetch`.
 *
 * Why this exists:
 *
 *   The Tauri 2 WebView enforces both a Content-Security-Policy
 *   (`connect-src 'self' ipc: tauri:`) AND the browser's same-origin
 *   policy. Outbound HTTPS requests to provider domains
 *   (`api.fireworks.ai`, `api.openai.com`, …) are blocked by both
 *   layers — `fetch` rejects with `TypeError: Failed to fetch` before
 *   any request reaches the network. Adding the provider domains to
 *   `connect-src` would not help either, because the providers do
 *   not return `Access-Control-Allow-Origin` headers for
 *   `tauri://localhost` origins.
 *
 *   The fix is to NEVER call `fetch` from the renderer. The Rust side
 *   (`src-tauri/src/lib.rs::shell_provider_probe`) issues the request
 *   via `reqwest`, which has neither WebView CSP nor CORS to worry
 *   about, and returns the verbatim status / body.
 *
 *   This module wraps `desktopShell.probeProvider(...)` in the
 *   `ProbeHttpClient` shape that `RendererLoginGateway` expects, so
 *   the gateway can stay agnostic of the transport.
 *
 * Validates: Requirements 1.6, 2.2, 2.3, 4.2, 4.3.
 */

import type { ProbeHttpClient } from "@ai-agent-orchestrator/client-sdk";

import type { DesktopShell } from "../shell/types.js";

export interface DesktopShellProbeClientOptions {
  readonly desktopShell: DesktopShell;
}

/**
 * Builds a {@link ProbeHttpClient} backed by the Tauri shell. The
 * gateway calls `client.send({ url, method, headers, body, signal })`
 * exactly like it would with `fetch`; the wrapper translates the call
 * into a single `desktopShell.probeProvider(...)` invocation.
 *
 * Cancellation:
 *
 *   The Tauri command does not currently support mid-flight
 *   cancellation, but the gateway's `signal` is honoured at the
 *   renderer side: if the signal is already aborted on entry the
 *   wrapper short-circuits without calling the shell. A signal that
 *   aborts mid-flight does not interrupt the Rust request, but the
 *   gateway's outer timeout still fires.
 */
export function createDesktopShellProbeClient(
  options: DesktopShellProbeClientOptions,
): ProbeHttpClient {
  const shell = options.desktopShell;
  return {
    async send(input) {
      if (input.signal?.aborted === true) {
        // Mirrors the spec'd `fetch` behaviour for an already-aborted
        // signal — throw an `AbortError` shape the gateway recognises.
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      const probeRequest: {
        url: string;
        method: "GET" | "POST";
        headers: Record<string, string>;
        body?: string;
      } = {
        url: input.url,
        method: input.method,
        headers: { ...input.headers },
      };
      if (input.body !== undefined) probeRequest.body = input.body;
      const response = await shell.probeProvider(probeRequest);
      return {
        ok: response.ok,
        status: response.status,
        text: () => Promise.resolve(response.body),
      };
    },
  };
}
