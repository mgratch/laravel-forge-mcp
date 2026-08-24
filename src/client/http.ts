/**
 * HTTP client for the Laravel Forge API.
 *
 * Base URL, auth and headers follow the API reference:
 * @see https://forge.laravel.com/docs/api-reference/introduction
 *
 * Responsibilities kept here, so no tool has to think about them:
 *   - bearer auth and the required `Accept` / `Content-Type` headers
 *   - rate-limit pacing and 429 handling (60 req/min)
 *   - retry with exponential backoff for transient failures
 *   - JSON:API flattening
 *   - cursor pagination
 *   - request timeouts
 */

import { ForgeApiError, ForgeConfigurationError, ForgeRateLimitError } from './errors.js';
import { extractNextCursor, normalizeResponse, type NormalizedResponse } from './jsonapi.js';
import { RateLimiter, parseRetryAfterSeconds, type RateLimitView } from './rate-limit.js';

/** Default base URL, matching the `servers` entry in the OpenAPI document. */
export const DEFAULT_BASE_URL = 'https://forge.laravel.com/api';

export interface ForgeClientOptions {
  /** Forge API token. @see https://forge.laravel.com/profile/api */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Attempts for retryable failures (429/5xx/network). Defaults to 3. */
  readonly maxRetries?: number;
  /** Injected for tests; defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly rateLimiter?: RateLimiter;
  /** Injectable sleep, for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  readonly method: string;
  /** Path relative to the base URL, with placeholders already substituted. */
  readonly path: string;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/** A single API response, after normalisation. */
export interface ForgeResponse extends NormalizedResponse {
  readonly status: number;
  /** True for `202 Accepted` — the operation is still running server-side. */
  readonly accepted: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Thin wrapper over `fetch` that speaks Forge. */
export class ForgeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly rateLimiter: RateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: ForgeClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new ForgeConfigurationError(
        'A Forge API token is required. Set FORGE_API_KEY — generate one at https://forge.laravel.com/profile/api',
      );
    }

    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Issues one request, retrying transient failures. */
  public async request(options: RequestOptions): Promise<ForgeResponse> {
    const url = this.buildUrl(options.path, options.query);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.backoffDelay(attempt, lastError));
      }

      await this.rateLimiter.acquire();

      try {
        return await this.attempt(options, url);
      } catch (error) {
        lastError = error;

        if (!isSafeToRetry(error, options.method) || attempt === this.maxRetries) throw error;
      }
    }

    // Unreachable: the loop either returns or throws.
    throw lastError instanceof Error ? lastError : new Error('Forge request failed');
  }

  /**
   * Walks every page of a cursor-paginated collection.
   *
   * @param maxPages Safety valve — an unbounded walk can exhaust the 60/min
   *                 budget on a large account.
   */
  public async requestAllPages(
    options: RequestOptions,
    maxPages = 20,
  ): Promise<{ readonly data: unknown[]; readonly pages: number; readonly truncated: boolean }> {
    const collected: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (; pages < maxPages; pages += 1) {
      const query: Record<string, string | number | boolean | undefined> = {
        ...options.query,
        ...(cursor === undefined ? {} : { 'page[cursor]': cursor }),
      };

      const response = await this.request({ ...options, query });
      if (Array.isArray(response.data)) {
        collected.push(...response.data);
      } else if (response.data !== null) {
        collected.push(response.data);
      }

      cursor = extractNextCursor(response.meta);
      if (cursor === undefined) {
        return { data: collected, pages: pages + 1, truncated: false };
      }
    }

    return { data: collected, pages, truncated: true };
  }

  /** Current rate-limit view, for diagnostics. */
  public get rateLimitSnapshot(): RateLimitView {
    return this.rateLimiter.snapshot;
  }

  private async attempt(options: RequestOptions, url: string): Promise<ForgeResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    // Honour a caller-supplied signal alongside the timeout.
    const onExternalAbort = (): void => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      // Built conditionally: under `exactOptionalPropertyTypes`, an explicit
      // `body: undefined` is not assignable to `RequestInit`.
      const init: RequestInit = {
        method: options.method,
        headers: this.buildHeaders(),
        signal: controller.signal,
      };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }

      const response = await this.fetchImpl(url, init);

      this.rateLimiter.observe(response.headers);

      const text = await response.text();
      const parsed = parseBody(text);

      if (!response.ok) {
        throw this.toError(response, options.method, url, parsed);
      }

      const normalized = normalizeResponse(parsed);
      return {
        ...normalized,
        status: response.status,
        accepted: response.status === 202,
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private buildHeaders(): Record<string, string> {
    // Forge documents both headers as required on every request, not only on
    // those carrying a body.
    // @see https://forge.laravel.com/docs/api-reference/introduction
    return {
      Authorization: `Bearer ${this.apiKey}`,
      // The docs instruct clients to send `application/json` even though
      // responses are declared as `application/vnd.api+json`.
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'laravel-forge-mcp',
    };
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(this.resolveUrl(path));

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  /**
   * Resolves a request target that may be a bare path, an API-prefixed link, or
   * an absolute URL.
   *
   * JSON:API `self` links come back in whatever form Forge chose, and blindly
   * concatenating them onto the base URL produces `/api/api/orgs/...` or an
   * absolute URL glued after the base. Cross-origin links are refused outright
   * so a link in a response can never redirect an authenticated request
   * carrying the bearer token to another host.
   */
  private resolveUrl(pathOrUrl: string): string {
    const base = new URL(this.baseUrl);

    if (/^https?:\/\//i.test(pathOrUrl)) {
      const absolute = new URL(pathOrUrl);
      if (absolute.origin !== base.origin) {
        throw new ForgeConfigurationError(
          `Refusing to follow a cross-origin link: ${absolute.origin} is not ${base.origin}.`,
        );
      }
      return absolute.toString();
    }

    const normalized = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    const basePath = base.pathname.replace(/\/+$/, '');

    // The link already carries the API prefix (for example "/api/orgs/...").
    if (basePath !== '' && (normalized === basePath || normalized.startsWith(`${basePath}/`))) {
      return `${base.origin}${normalized}`;
    }

    return `${base.origin}${basePath}${normalized}`;
  }

  private toError(response: Response, method: string, url: string, body: unknown): ForgeApiError {
    const message = extractErrorMessage(body) ?? response.statusText ?? 'Request failed';
    const detail = `Forge API ${response.status}: ${message} (${method} ${url})`;

    if (response.status === 429) {
      return new ForgeRateLimitError(
        detail,
        method,
        url,
        body,
        parseRetryAfterSeconds(response.headers),
      );
    }

    return new ForgeApiError(detail, response.status, method, url, body);
  }

  private backoffDelay(attempt: number, lastError: unknown): number {
    // A 429 states exactly how long to wait. Honour it in full: capping it would
    // knowingly re-send before Forge's requested delay expires, which is worse
    // than waiting. MAX_RETRY_DELAY_MS bounds only our own computed backoff.
    if (lastError instanceof ForgeRateLimitError && lastError.retryAfterSeconds !== undefined) {
      return lastError.retryAfterSeconds * 1000;
    }

    const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    // Full jitter, to avoid synchronised retries across concurrent tool calls.
    const jittered = Math.random() * exponential;
    return Math.min(Math.max(jittered, RETRY_BASE_DELAY_MS), MAX_RETRY_DELAY_MS);
  }
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Some endpoints answer with a bare string body.
    return text;
  }
}

/** Pulls the most useful message out of a Forge error body. */
function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim() !== '') return body.slice(0, 500);
  if (typeof body !== 'object' || body === null) return undefined;

  const record = body as Record<string, unknown>;

  const message = record['message'];
  if (typeof message === 'string' && message.trim() !== '') {
    // 422 responses carry per-field detail that is far more actionable than
    // the generic top-level message.
    const errors = record['errors'];
    if (typeof errors === 'object' && errors !== null) {
      const fields = Object.entries(errors as Record<string, unknown>)
        .map(
          ([field, messages]) =>
            `${field}: ${Array.isArray(messages) ? messages.join(', ') : String(messages)}`,
        )
        .join('; ');
      if (fields !== '') return `${message} — ${fields}`;
    }
    return message;
  }

  const errors = record['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown> | undefined;
    const detail = first?.['detail'] ?? first?.['title'];
    if (typeof detail === 'string') return detail;
  }

  return undefined;
}

/** Network-level failures (DNS, socket, abort) leave the outcome unknown. */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

/**
 * Methods that can be repeated without changing the outcome.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * Decides whether a failed request may be sent again.
 *
 * The status alone is not enough. A 5xx or a dropped connection means the
 * outcome is *unknown*: Forge may have already created the resource and then
 * failed while responding. Repeating a POST in that state can create a second
 * server or a second backup, and this API offers no idempotency key to make
 * that safe. Non-idempotent methods are therefore never retried on 5xx or
 * network failure — the caller sees the error and decides, which is the only
 * honest behaviour when the result is genuinely ambiguous.
 *
 * A 429 is different: the request was *rejected* without being processed, so
 * repeating it is safe for any method.
 */
function isSafeToRetry(error: unknown, method: string): boolean {
  const idempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());

  if (error instanceof ForgeApiError) {
    if (error.status === 429) return true;
    return idempotent && error.isRetryable;
  }

  return idempotent && isNetworkError(error);
}
