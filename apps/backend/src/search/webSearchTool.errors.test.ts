/**
 * Unit tests for Web_Search_Tool error and timeout handling (task 13.3).
 *
 * Covers the four failure modes called out in the task description:
 *
 *   1. Empty backend response  → structured `{ kind: "error" }` result.
 *   2. Network error           → structured `{ kind: "error" }` result, no throw.
 *   3. Timeout (5 seconds)     → structured `{ kind: "error" }` result, no throw.
 *   4. Rate-limit denial       → structured `{ kind: "error" }` result, inner
 *                                 backend never invoked.
 *
 * The tests use an injected `HttpClient` stub for the DuckDuckGo adapter
 * and a fake `Clock` for the rate limiter — no real network and no real
 * timers are involved. Vitest fake timers drive the adapter's
 * `setTimeout` so the 5-second timeout branch can be exercised
 * deterministically.
 *
 * Validates: Requirement 9.4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DuckDuckGoSearch,
  SlidingWindowRateLimiter,
  WebSearchToolImpl,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "./index.js";

/** Build an `HttpResponse` whose `text()` returns `body`. */
function jsonResponse(body: string, status = 200): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  };
}

/**
 * Minimal stub HTTP client whose `send` is the supplied handler. Records
 * the requests it received so tests can assert call counts and URLs.
 */
function stubHttpClient(
  handler: (req: HttpRequest) => Promise<HttpResponse>,
): HttpClient & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    async send(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      return handler(req);
    },
  };
}

describe("DuckDuckGoSearch error handling", () => {
  it("empty backend response returns a structured error result", async () => {
    const http = stubHttpClient((req) => {
      const body = req.url.includes("html.duckduckgo.com")
        ? "<html><body>No results</body></html>"
        : JSON.stringify({
            AbstractText: "",
            AbstractURL: "",
            Heading: "",
            Results: [],
            RelatedTopics: [],
          });
      return Promise.resolve(jsonResponse(body));
    });
    const adapter = new DuckDuckGoSearch({ httpClient: http });

    const result = await adapter.search("nothing-matches");

    expect(http.calls).toHaveLength(2);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("DuckDuckGo HTML returned no results");
      expect(result.reason).toContain("DuckDuckGo returned no results");
    }
  });

  it("parses regular DuckDuckGo HTML results before falling back to Instant Answer", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcline&amp;rut=x">Cline AI</a>
        <a class="result__snippet">Apache-2.0 coding agent.</a>
      </div>
    `;
    const http = stubHttpClient(() => Promise.resolve(jsonResponse(html)));
    const adapter = new DuckDuckGoSearch({ httpClient: http });

    const result = await adapter.search("cline ai", { limit: 5 });

    expect(http.calls).toHaveLength(1);
    expect(result).toEqual({
      kind: "ok",
      results: [
        {
          title: "Cline AI",
          url: "https://example.com/cline",
          snippet: "Apache-2.0 coding agent.",
        },
      ],
    });
  });

  it("network error returns a structured error result without throwing", async () => {
    const http = stubHttpClient(() => Promise.reject(new TypeError("fetch failed: ECONNRESET")));
    const adapter = new DuckDuckGoSearch({ httpClient: http });

    // The call must resolve, never throw.
    const result = await adapter.search("any-query");

    expect(http.calls).toHaveLength(1);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toMatch(/^DuckDuckGo request failed:/);
      expect(result.reason).toContain("ECONNRESET");
    }
  });

  it("non-2xx HTTP status returns a structured error result", async () => {
    const http = stubHttpClient(() =>
      Promise.resolve({
        status: 503,
        ok: false,
        text: () => Promise.resolve("Service Unavailable"),
      }),
    );
    const adapter = new DuckDuckGoSearch({ httpClient: http });

    const result = await adapter.search("query");

    expect(http.calls).toHaveLength(1);
    expect(result).toEqual({
      kind: "error",
      reason: "DuckDuckGo returned HTTP 503",
    });
  });

  describe("timeout handling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts the request after 5 seconds and returns a structured error", async () => {
      // The handler waits for the adapter's AbortController to fire before
      // rejecting with a DOMException-shaped AbortError, mirroring how
      // `fetch` behaves when the supplied signal is aborted mid-flight.
      const http = stubHttpClient(
        (req) =>
          new Promise<HttpResponse>((_resolve, reject) => {
            const signal = req.signal;
            if (!signal) {
              reject(new Error("test bug: adapter must pass a signal"));
              return;
            }
            const onAbort = (): void => {
              const abortErr: Error & { name: string } = new Error("The operation was aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            };
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }),
      );
      const adapter = new DuckDuckGoSearch({ httpClient: http, timeoutMs: 5_000 });

      const promise = adapter.search("slow-query");

      // Advance the fake clock past the 5-second timeout. The adapter's
      // internal `setTimeout` fires `controller.abort()`, which makes the
      // stub reject with an AbortError.
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await promise;

      expect(http.calls).toHaveLength(1);
      expect(result).toEqual({
        kind: "error",
        reason: "DuckDuckGo request timed out after 5000ms",
      });
    });

    it("does not abort or error when the response arrives before the timeout", async () => {
      const http = stubHttpClient(
        (req) =>
          new Promise<HttpResponse>((resolve) => {
            // Resolve well within the 5s window using a (faked) timer.
            setTimeout(() => {
              if (req.signal?.aborted) {
                return;
              }
              const body = req.url.includes("html.duckduckgo.com")
                ? "<html><body>No results</body></html>"
                : JSON.stringify({
                    AbstractText: "Snippet",
                    AbstractURL: "https://example.com/x",
                    Heading: "Title",
                  });
              resolve(jsonResponse(body));
            }, 100);
          }),
      );
      const adapter = new DuckDuckGoSearch({ httpClient: http, timeoutMs: 5_000 });

      const promise = adapter.search("fast-query");
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.results).toEqual([
          {
            title: "Title",
            url: "https://example.com/x",
            snippet: "Snippet",
          },
        ]);
      }
    });
  });
});

describe("WebSearchToolImpl rate-limit handling", () => {
  it("returns a structured error and skips the inner adapter when the limiter denies the call", async () => {
    // Adapter is wired but should never be invoked once the limit is reached.
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&amp;rut=x">Title</a>
        <a class="result__snippet">x</a>
      </div>
    `;
    const http = stubHttpClient(() => Promise.resolve(jsonResponse(html)));
    const adapter = new DuckDuckGoSearch({ httpClient: http });

    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter({
      maxCalls: 1,
      windowMs: 60_000,
      clock: () => now,
    });
    const tool = new WebSearchToolImpl({ adapter, rateLimiter: limiter });

    // First call consumes the only slot.
    const first = await tool.search("query-1");
    expect(first.kind).toBe("ok");
    expect(http.calls).toHaveLength(1);

    // Second call within the same window must be denied by the limiter
    // and surfaced as a structured error — no extra HTTP request issued.
    now += 1_000; // 1s later, still inside the 60s window.
    const second = await tool.search("query-2");

    expect(second.kind).toBe("error");
    if (second.kind === "error") {
      expect(second.reason).toMatch(/^Web search rate limit exceeded/);
      // retryAfterMs should reflect the remaining window (~59s).
      expect(second.reason).toContain("ms)");
    }
    // Crucially, the adapter was NOT called a second time.
    expect(http.calls).toHaveLength(1);
  });

  it("never throws when the inner adapter throws unexpectedly", async () => {
    // Defensive: a misbehaving adapter must not crash the agent runtime
    // (Requirement 9.4).
    const throwingAdapter = {
      search: () => Promise.reject(new Error("backend exploded")),
    };
    const tool = new WebSearchToolImpl({ adapter: throwingAdapter });

    const result = await tool.search("anything");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toMatch(/^Web search backend threw:/);
      expect(result.reason).toContain("backend exploded");
    }
  });
});
