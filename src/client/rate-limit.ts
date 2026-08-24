/**
 * Client-side rate limiting for the Forge API.
 *
 * Forge allows 60 requests per minute per authenticated user and returns
 * `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` on every
 * response.
 *
 * @see https://forge.laravel.com/docs/api-reference/rate-limiting
 *
 * An MCP server is a poor citizen by default: a single agent turn can fan out
 * into dozens of calls, and 105 of the API's operations are async and need
 * polling. So this limiter does two things:
 *
 *   1. Paces requests locally against a sliding window, before they are sent.
 *   2. Believes the server over itself — when a response reports the real
 *      remaining budget, that value replaces the local estimate.
 */

/** The limiter's full view of the budget, including its local estimate. */
export interface RateLimitView extends RateLimitSnapshot {
  /** Requests the limiter has recorded within the current local window. */
  readonly localWindowCount: number;
}

/** Rate limit state parsed from response headers. */
export interface RateLimitSnapshot {
  readonly limit: number | undefined;
  readonly remaining: number | undefined;
  /** Epoch seconds at which the window resets, when the server reports it. */
  readonly reset: number | undefined;
}

export interface RateLimiterOptions {
  /** Requests permitted per window. Defaults to Forge's documented 60. */
  readonly maxRequests?: number;
  /** Window length in milliseconds. Defaults to 60_000. */
  readonly windowMs?: number;
  /**
   * Stop issuing requests when the server-reported remaining budget falls to or
   * below this value, holding the difference back for retries and polling.
   */
  readonly reserve?: number;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
  /** Injectable sleep, for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_RESERVE = 2;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Parses the `X-RateLimit-*` family from a response. */
export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const toNumber = (value: string | null): number | undefined => {
    if (value === null || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    limit: toNumber(headers.get('x-ratelimit-limit')),
    remaining: toNumber(headers.get('x-ratelimit-remaining')),
    reset: toNumber(headers.get('x-ratelimit-reset')),
  };
}

/**
 * Reads the wait implied by a 429 response.
 *
 * `Retry-After` is preferred (seconds, per RFC 9110). `X-RateLimit-Reset` is
 * used as a fallback, and is interpreted as epoch seconds — Forge sends an
 * absolute timestamp, but some proxies rewrite it to a relative delta, so a
 * value that is implausibly small is treated as a delta instead.
 */
export function parseRetryAfterSeconds(
  headers: Headers,
  now: () => number = Date.now,
): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }

  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const value = Number(reset);
    if (!Number.isFinite(value) || value < 0) return undefined;

    // An epoch timestamp is far larger than any plausible relative delay.
    const looksAbsolute = value > 1_000_000_000;
    if (!looksAbsolute) return value;

    const deltaSeconds = value - Math.floor(now() / 1000);
    return deltaSeconds > 0 ? deltaSeconds : 0;
  }

  return undefined;
}

/**
 * Sliding-window limiter that paces outbound requests and defers to
 * server-reported budget when it is available.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly reserve: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Timestamps of requests issued within the current window. */
  private timestamps: number[] = [];

  /** Most recent server-reported state, when the API has told us. */
  private serverState: RateLimitSnapshot | undefined;

  /** Serialises acquisition so concurrent callers cannot both pass the check. */
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.reserve = options.reserve ?? DEFAULT_RESERVE;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Waits until it is safe to issue another request, then records it. */
  public async acquire(): Promise<void> {
    const run = this.queue.then(() => this.acquireInternal());
    // Keep the chain alive even if one acquisition throws.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Folds a response's rate-limit headers into the limiter's state. */
  public observe(headers: Headers): void {
    const snapshot = parseRateLimitHeaders(headers);
    if (snapshot.limit === undefined && snapshot.remaining === undefined) return;
    this.serverState = snapshot;
  }

  /** Current view of the budget, for diagnostics. */
  public get snapshot(): RateLimitView {
    this.evictExpired();
    return {
      limit: this.serverState?.limit ?? this.maxRequests,
      remaining: this.serverState?.remaining ?? this.maxRequests - this.timestamps.length,
      reset: this.serverState?.reset,
      localWindowCount: this.timestamps.length,
    };
  }

  private async acquireInternal(): Promise<void> {
    // The server's own count is authoritative when it is nearly exhausted.
    const serverRemaining = this.serverState?.remaining;
    if (serverRemaining !== undefined && serverRemaining <= this.reserve) {
      const waitMs = this.millisUntilServerReset();
      if (waitMs > 0) {
        await this.sleep(waitMs);
        // The window has rolled over; the stale snapshot no longer applies.
        this.serverState = undefined;
        this.timestamps = [];
      }
    }

    this.evictExpired();

    while (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      if (oldest === undefined) break;
      const waitMs = oldest + this.windowMs - this.now();
      if (waitMs <= 0) {
        this.evictExpired();
        continue;
      }
      await this.sleep(waitMs);
      this.evictExpired();
    }

    this.timestamps.push(this.now());
  }

  private millisUntilServerReset(): number {
    const reset = this.serverState?.reset;
    if (reset === undefined) return this.windowMs;

    // Absolute epoch seconds vs. a relative delta — same heuristic as
    // parseRetryAfterSeconds.
    const looksAbsolute = reset > 1_000_000_000;
    const deltaMs = looksAbsolute ? reset * 1000 - this.now() : reset * 1000;
    if (!Number.isFinite(deltaMs)) return this.windowMs;
    return Math.max(0, Math.min(deltaMs, this.windowMs));
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.windowMs;
    let firstLive = 0;
    while (firstLive < this.timestamps.length) {
      const stamp = this.timestamps[firstLive];
      if (stamp === undefined || stamp > cutoff) break;
      firstLive += 1;
    }
    if (firstLive > 0) this.timestamps = this.timestamps.slice(firstLive);
  }
}
