/**
 * Minimal HTTP client abstraction used by the DuckDuckGo adapter.
 *
 * The adapter depends on this interface — not on `globalThis.fetch` —
 * so unit tests can supply a stub implementation and avoid real network
 * calls.
 *
 * Source: tasks.md → 13.1 ("Make HTTP client injectable so tests can stub.
 * Don't make real network calls in tests.").
 */

/**
 * Subset of `fetch`'s `Request` shape that the DuckDuckGo adapter relies on.
 * Only `GET` is needed today; if other verbs are required later, extend the
 * interface conservatively.
 */
export interface HttpRequest {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Subset of `Response` that the adapter actually consumes. Keeping this
 * narrow lets tests build trivial stub responses without recreating the
 * entire DOM `Response` API.
 */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/**
 * The injectable HTTP client. Implementations MUST honor `request.signal`
 * for timeout/cancellation and SHOULD throw an `AbortError`-like error when
 * the signal aborts mid-flight.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Default {@link HttpClient} backed by `globalThis.fetch`. Available on
 * Node ≥ 18 (the engines field in `package.json` requires `>=18.18.0`)
 * and on every supported renderer/web environment.
 *
 * The implementation is intentionally tiny — no retry, no caching — so
 * the adapter remains the single source of truth for timeout, error
 * shaping and rate limiting.
 */
export const fetchHttpClient: HttpClient = {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const init: RequestInit = {
      method: "GET",
    };
    if (request.signal) {
      init.signal = request.signal;
    }
    if (request.headers) {
      init.headers = { ...request.headers };
    }
    const response = await fetch(request.url, init);
    return {
      status: response.status,
      ok: response.ok,
      text: () => response.text(),
    };
  },
};
