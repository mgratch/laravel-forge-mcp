/**
 * Polling helper for asynchronous Forge operations.
 *
 * 105 of the API's 273 operations answer `202 Accepted` and finish in the
 * background, usually with no response body. Callers observe completion by
 * re-reading the affected resource until its state settles.
 *
 * @see https://forge.laravel.com/docs/api-reference/introduction
 *
 * Polling is opt-in per tool call rather than automatic: it costs requests
 * against the 60/min budget, and an agent often wants to fire an action and
 * move on. Tools for async operations therefore accept a `wait` argument.
 */

import { ForgePollTimeoutError } from './errors.js';

/**
 * States that mean "still working". Everything else is treated as terminal.
 *
 * Drawn from the enums the OpenAPI document declares for the resources that
 * async operations touch (`ResourceState`, `DeploymentStatus`, `CommandStatus`).
 */
export const NON_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'pending',
  'queued',
  'installing',
  'updating',
  'deploying',
  'building',
  'restarting',
  'provisioning',
  'configuring',
  'renewing',
  'running',
  'waiting',
  'syncing',
  'restoring',
  'deleting',
  'removing',
]);

export interface PollOptions {
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

/** True when a status string means the operation has settled. */
export function isTerminalStatus(status: string | undefined): boolean {
  if (status === undefined) return true;
  return !NON_TERMINAL_STATES.has(status.toLowerCase());
}

/**
 * Polls `read` with exponential backoff until the resource reaches a terminal
 * state or the timeout expires.
 *
 * A resource with no `status`/`state` field is considered terminal on the first
 * read — there is nothing to wait for.
 */
export async function pollUntilTerminal<T>(
  read: () => Promise<T>,
  options: PollOptions = {},
): Promise<PollResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialIntervalMs = options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const startedAt = now();
  let interval = initialIntervalMs;
  let attempts = 0;
  let lastStatus: string | undefined;

  for (;;) {
    attempts += 1;
    const value = await read();
    lastStatus = readStatus(value);

    if (isTerminalStatus(lastStatus)) {
      return { value, status: lastStatus, attempts, elapsedMs: now() - startedAt };
    }

    const elapsed = now() - startedAt;
    if (elapsed + interval >= timeoutMs) {
      throw new ForgePollTimeoutError(
        `Operation did not reach a terminal state within ${Math.round(timeoutMs / 1000)}s ` +
          `(last status: ${lastStatus ?? 'unknown'}). ` +
          'The operation may still be running — re-read the resource to check.',
        lastStatus,
        elapsed,
      );
    }

    await sleep(interval);
    interval = Math.min(interval * 2, maxIntervalMs);
  }
}

/** Exposed so callers can surface the last value after a timeout, if they hold one. */
export type { ForgePollTimeoutError };

/** Outcome of waiting for a resource to disappear. */
export interface AbsenceResult {
  readonly absent: boolean;
  readonly attempts: number;
}

/**
 * Polls until a read fails with 404, which is how a deletion reports success.
 *
 * Treating that 404 as an error — as a status-based poll would — turns a
 * successful delete into a spurious failure.
 */
export async function pollUntilAbsent(
  read: () => Promise<void>,
  options: PollOptions = {},
): Promise<AbsenceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const startedAt = now();
  let interval = options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  let attempts = 0;

  for (;;) {
    attempts += 1;

    try {
      await read();
    } catch (error) {
      // 404 means the resource is gone: the deletion completed.
      if (typeof error === 'object' && error !== null && 'status' in error) {
        if (error.status === 404) return { absent: true, attempts };
      }
      throw error;
    }

    const elapsed = now() - startedAt;
    if (elapsed + interval >= timeoutMs) return { absent: false, attempts };

    await sleep(interval);
    interval = Math.min(interval * 2, options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS);
  }
}
