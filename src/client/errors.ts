/**
 * Typed errors for the Forge API client.
 *
 * Every failure an agent can act on differently gets its own class, so callers
 * branch on a type rather than pattern-matching a message string.
 *
 * Status codes are those documented for the API:
 * @see https://forge.laravel.com/docs/api-reference/introduction
 */

/** Base class for every error this client raises. */
export class ForgeError extends Error {
  public override readonly name: string = 'ForgeError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Preserve the subclass name when compiled to ES2023 and re-thrown.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Configuration is missing or invalid — raised before any request is made. */
export class ForgeConfigurationError extends ForgeError {
  public override readonly name: string = 'ForgeConfigurationError';
}

/**
 * The API returned a non-2xx response.
 *
 * `body` is the parsed response when it was JSON, otherwise the raw text, so
 * callers can surface Forge's own validation messages (422 responses carry a
 * per-field `errors` object).
 */
export class ForgeApiError extends ForgeError {
  public override readonly name: string = 'ForgeApiError';

  public constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(message);
  }

  /**
   * True when retrying the identical request could plausibly succeed.
   *
   * 429 is retryable after the rate-limit window; 5xx are transient server
   * faults. 4xx other than 429 indicate a malformed or unauthorised request and
   * will fail identically on retry.
   *
   * Note this asks only whether the *status* is transient. Whether the request
   * is safe to repeat also depends on the method — see `isSafeToRetry`.
   */
  public get isRetryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }
}

/** Rate limit exceeded (HTTP 429). Default budget is 60 requests/minute. */
export class ForgeRateLimitError extends ForgeApiError {
  public override readonly name: string = 'ForgeRateLimitError';

  public constructor(
    message: string,
    method: string,
    url: string,
    body: unknown,
    /** Seconds until the limit resets, from `Retry-After` or `X-RateLimit-Reset`. */
    public readonly retryAfterSeconds: number | undefined,
  ) {
    super(message, 429, method, url, body);
  }
}

/** An async (202) operation did not reach a terminal state within the timeout. */
export class ForgePollTimeoutError extends ForgeError {
  public override readonly name: string = 'ForgePollTimeoutError';

  public constructor(
    message: string,
    public readonly lastStatus: string | undefined,
    public readonly elapsedMs: number,
  ) {
    super(message);
  }
}

/**
 * A destructive or confirmation-gated tool was invoked without a matching
 * `confirm` argument.
 */
export class ForgeConfirmationError extends ForgeError {
  public override readonly name: string = 'ForgeConfirmationError';

  public constructor(
    public readonly toolName: string,
    public readonly expected: string,
    public readonly received: string | undefined,
  ) {
    super(
      `"${toolName}" is a guarded operation and was not confirmed. ` +
        `Pass confirm: ${JSON.stringify(expected)} to proceed. ` +
        (received === undefined
          ? 'No confirm value was supplied.'
          : `Received ${JSON.stringify(received)}.`),
    );
  }
}
