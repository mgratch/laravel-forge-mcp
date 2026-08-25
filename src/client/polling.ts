/**
 * Polling helper for asynchronous Forge operations.
 *
 * 105 of the API's 273 operations are marked asynchronous; 98 of those answer
 * `202 Accepted` and finish in the background, usually with no response body,
 * while the remaining seven document a 200 or 204 and complete inline. Callers
 * observe completion by re-reading the affected resource until its state
 * settles.
 *
 * @see https://forge.laravel.com/docs/api-reference/introduction
 *
 * Polling is opt-in per tool call rather than automatic: it costs requests
 * against the 60/min budget, and an agent often wants to fire an action and
 * move on. Tools for async operations therefore accept a `wait` argument.
 */

import { ForgePollTimeoutError } from './errors.js';

/**
 * Decides whether a poll has settled.
 *
 * Injected rather than fixed, because Forge has no single status vocabulary:
 * `running` is the healthy steady state of a background process but an
 * in-flight `CommandStatus`, and `starting`/`stopping` are transitional on some
 * resources and absent from others entirely. One global set of non-terminal
 * values is therefore wrong in both directions — it polls a finished background
 * process until timeout while reporting a still-executing command as finished.
 *
 * The per-resource vocabularies live in the generated catalog; the registry
 * composes them into one of these.
 *
 * @see https://forge.laravel.com/api/docs.openapi — `components.schemas.*Resource`
 */
export type TerminalPredicate<T> = (value: T, status: string | undefined) => boolean;

/**
 * Builds a predicate that settles when the status leaves a resource's pending
 * set.
 *
 * A resource with no `status`/`state` field is terminal on the first read —
 * there is nothing to wait for.
 */
export function statusSettles(
  pending: ReadonlySet<string>,
): (status: string | undefined) => boolean {
  return (status) => status === undefined || !pending.has(status.toLowerCase());
}

export interface PollOptions<T> {
  /** How long to keep polling before giving up. Defaults to 120 seconds. */
  readonly timeoutMs?: number;
  /** Delay between the first two polls. Defaults to 2 seconds. */
  readonly initialIntervalMs?: number;
  /** Upper bound on the backoff interval. Defaults to 10 seconds. */
  readonly maxIntervalMs?: number;
  /** Injectable sleep, for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
  /**
   * Reads the status from whatever the poll returns.
   *
   * Callers that poll a whole response envelope rather than a bare resource
   * supply this so the status is read from the right level.
   */
  readonly readStatus?: (value: unknown) => string | undefined;
  /**
   * Decides whether a read has settled.
   *
   * Defaults to "any status outside the supplied pending set, or no status at
   * all". Callers waiting for a resource to disappear supply their own, since
   * for them a missing status means the resource is still there.
   */
  readonly isTerminal?: TerminalPredicate<T>;
}

/** Outcome of a poll. */
export interface PollResult<T> {
  /** The resource as last read. */
  readonly value: T;
  /** The terminal state observed, when the resource reports one. */
  readonly status: string | undefined;
  readonly attempts: number;
  readonly elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INITIAL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_INTERVAL_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Reads a `status` or `state` field from a flattened resource.
 *
 * Forge is inconsistent about which name it uses, so both are accepted.
 */
export function readStatus(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  for (const key of ['status', 'state']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }

  return undefined;
}

/**
 * Polls `read` with exponential backoff until `isTerminal` accepts a result or
 * the timeout expires.
 *
 * With the default predicate, a resource with no `status`/`state` field settles
 * on the first read — there is nothing to wait for.
 */
export async function pollUntilTerminal<T>(
  read: () => Promise<T>,
  options: PollOptions<T> = {},
): Promise<PollResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialIntervalMs = options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const statusOf = options.readStatus ?? readStatus;
  const isTerminal =
    options.isTerminal ?? ((_value: T, status: string | undefined) => status === undefined);

  const startedAt = now();
  let interval = initialIntervalMs;
  let attempts = 0;
  let lastStatus: string | undefined;

  for (;;) {
    attempts += 1;
    const value = await read();
    lastStatus = statusOf(value);

    if (isTerminal(value, lastStatus)) {
      return { value, status: lastStatus, attempts, elapsedMs: now() - startedAt };
    }

    const elapsed = now() - startedAt;
    const remaining = timeoutMs - elapsed;

    // Give up only once the deadline has actually passed with a non-terminal
    // read. Throwing as soon as the *next* interval would cross it wastes the
    // tail of the budget — and with an interval anywhere near the timeout, the
    // effective budget would be a fraction of the configured one.
    if (remaining <= 0) {
      throw new ForgePollTimeoutError(
        `Operation did not reach a terminal state within ${Math.round(timeoutMs / 1000)}s ` +
          `(last status: ${lastStatus ?? 'unknown'}). ` +
          'The operation may still be running — re-read the resource to check.',
        lastStatus,
        elapsed,
      );
    }

    // Never sleep past the deadline: the last read happens *at* it.
    await sleep(Math.min(interval, remaining));
    interval = Math.min(interval * 2, maxIntervalMs);
  }
}

/** Exposed so callers can surface the last value after a timeout, if they hold one. */
export type { ForgePollTimeoutError };
