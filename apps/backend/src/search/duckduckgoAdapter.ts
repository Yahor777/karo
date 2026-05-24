/**
 * DuckDuckGo adapter for the Web Search Tool.
 *
 * Uses DuckDuckGo's free HTML endpoint first, with the Instant Answer
 * JSON endpoint as a fallback. Both endpoints require no API key and no
 * subscription, satisfying the project's "free search for agents" rule.
 * The adapter never throws for backend failures; it returns structured
 * `{ kind: "error", reason }` results so agent runs can continue.
 */

import { fetchHttpClient, type HttpClient, type HttpResponse } from "./httpClient.js";
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_LIMIT,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type WebSearchTool,
} from "./types.js";

export interface DuckDuckGoSearchOptions {
  readonly httpClient?: HttpClient;
  /** Instant Answer JSON endpoint override, mainly for tests. */
  readonly endpoint?: string;
  /** HTML search endpoint override, mainly for tests. */
  readonly htmlEndpoint?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

const DEFAULT_ENDPOINT = "https://api.duckduckgo.com/";
const DEFAULT_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_USER_AGENT = "ai-agent-orchestrator/0.0 (+https://example.invalid/web-search-tool)";

export class DuckDuckGoSearch implements WebSearchTool {
  private readonly httpClient: HttpClient;
  private readonly endpoint: string;
  private readonly htmlEndpoint: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  public constructor(options: DuckDuckGoSearchOptions = {}) {
    this.httpClient = options.httpClient ?? fetchHttpClient;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.htmlEndpoint = options.htmlEndpoint ?? DEFAULT_HTML_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  public async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { kind: "error", reason: "Search query was empty" };
    }

    const limit = clampLimit(options?.limit);
    const htmlResult = await this.searchHtml(trimmed, limit);
    if (htmlResult.kind === "ok" && htmlResult.results.length > 0) {
      return htmlResult;
    }

    if (htmlResult.kind === "error" && htmlResult.reason !== "DuckDuckGo HTML returned no results") {
      return htmlResult;
    }

    const instantAnswerResult = await this.searchInstantAnswer(trimmed, limit);
    if (instantAnswerResult.kind === "ok") {
      return instantAnswerResult;
    }

    if (htmlResult.kind === "error") {
      return {
        kind: "error",
        reason: `${htmlResult.reason}; IA fallback: ${instantAnswerResult.reason}`,
      };
    }
    return instantAnswerResult;
  }

  private async searchHtml(query: string, limit: number): Promise<SearchResult> {
    const response = await this.send(
      buildHtmlEndpointUrl(this.htmlEndpoint, query),
      "text/html,application/xhtml+xml",
    );
    if (response.kind === "error") return response;

    const hits = extractHtmlHits(response.bodyText, limit);
    if (hits.length === 0) {
      return { kind: "error", reason: "DuckDuckGo HTML returned no results" };
    }
    return { kind: "ok", results: hits };
  }

  private async searchInstantAnswer(query: string, limit: number): Promise<SearchResult> {
    const response = await this.send(buildEndpointUrl(this.endpoint, query), "application/json");
    if (response.kind === "error") return response;

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      return {
        kind: "error",
        reason: "DuckDuckGo response was not valid JSON",
      };
    }

    const hits = extractHits(parsed, limit);
    if (hits.length === 0) {
      return { kind: "error", reason: "DuckDuckGo returned no results" };
    }
    return { kind: "ok", results: hits };
  }

  private async send(
    url: string,
    accept: string,
  ): Promise<
    | { readonly kind: "ok"; readonly bodyText: string }
    | { readonly kind: "error"; readonly reason: string }
  > {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: HttpResponse;
    try {
      response = await this.httpClient.send({
        url,
        signal: controller.signal,
        headers: {
          Accept: accept,
          "User-Agent": this.userAgent,
        },
      });
    } catch (err: unknown) {
      if (isAbortError(err) || controller.signal.aborted) {
        return {
          kind: "error",
          reason: `DuckDuckGo request timed out after ${String(this.timeoutMs)}ms`,
        };
      }
      return {
        kind: "error",
        reason: `DuckDuckGo request failed: ${describeError(err)}`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      return {
        kind: "error",
        reason: `DuckDuckGo returned HTTP ${String(response.status)}`,
      };
    }

    try {
      return { kind: "ok", bodyText: await response.text() };
    } catch (err: unknown) {
      return {
        kind: "error",
        reason: `DuckDuckGo response could not be read: ${describeError(err)}`,
      };
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  const intLimit = Math.floor(limit);
  if (intLimit < 1) return 1;
  if (intLimit > MAX_SEARCH_LIMIT) return MAX_SEARCH_LIMIT;
  return intLimit;
}

function buildEndpointUrl(endpoint: string, query: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  return url.toString();
}

function buildHtmlEndpointUrl(endpoint: string, query: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  return url.toString();
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.length > 200 ? `${err.message.slice(0, 200)}...` : err.message;
    return `${err.name}: ${message}`;
  }
  return "unknown error";
}

function extractHtmlHits(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seenUrls = new Set<string>();
  const resultPattern =
    /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;

  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html)) !== null) {
    const url = normalizeDuckDuckGoResultUrl(decodeHtml(match[1] ?? ""));
    const title = normalizeWhitespace(stripTags(decodeHtml(match[2] ?? "")));
    const snippet = normalizeWhitespace(stripTags(decodeHtml(match[3] ?? match[4] ?? "")));
    if (url.length === 0 || title.length === 0 || seenUrls.has(url)) continue;
    seenUrls.add(url);
    hits.push({ title, url, snippet });
    if (hits.length >= limit) return hits;
  }
  return hits;
}

function extractHits(payload: unknown, limit: number): SearchHit[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const root = payload as Record<string, unknown>;
  const hits: SearchHit[] = [];
  const seenUrls = new Set<string>();

  const tryAdd = (hit: SearchHit | null): void => {
    if (hit === null || seenUrls.has(hit.url)) return;
    seenUrls.add(hit.url);
    hits.push(hit);
  };

  const abstractUrl = stringOrEmpty(root["AbstractURL"]);
  const abstractText = stringOrEmpty(root["AbstractText"]);
  const heading = stringOrEmpty(root["Heading"]);
  if (abstractUrl.length > 0 && (abstractText.length > 0 || heading.length > 0)) {
    tryAdd({
      title: heading.length > 0 ? heading : abstractUrl,
      url: abstractUrl,
      snippet: abstractText,
    });
  }

  for (const item of asArray(root["Results"])) {
    tryAdd(toHit(item));
    if (hits.length >= limit) return hits;
  }

  for (const item of asArray(root["RelatedTopics"])) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if ("Topics" in record) {
      for (const sub of asArray(record["Topics"])) {
        tryAdd(toHit(sub));
        if (hits.length >= limit) return hits;
      }
      continue;
    }
    tryAdd(toHit(record));
    if (hits.length >= limit) return hits;
  }

  return hits;
}

function toHit(entry: unknown): SearchHit | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const url = stringOrEmpty(record["FirstURL"]);
  if (url.length === 0) return null;
  const rawText = stringOrEmpty(record["Text"]);
  const { title, snippet } = splitTitleSnippet(rawText, url);
  return { title, url, snippet };
}

function splitTitleSnippet(
  text: string,
  fallbackTitle: string,
): { title: string; snippet: string } {
  if (text.length === 0) return { title: fallbackTitle, snippet: "" };
  const sepIndex = text.indexOf(" - ");
  if (sepIndex < 0) return { title: text, snippet: "" };
  const title = text.slice(0, sepIndex).trim();
  const snippet = text.slice(sepIndex + 3).trim();
  return { title: title.length > 0 ? title : fallbackTitle, snippet };
}

function normalizeDuckDuckGoResultUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  try {
    const url = new URL(trimmed, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg !== null && uddg.length > 0) {
      return decodeURIComponent(uddg);
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}
