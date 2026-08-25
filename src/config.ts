/**
 * Server configuration, read from the environment.
 *
 * Every option is documented in `.env.example`. Nothing here reads a config
 * file: an MCP server is launched by a client that controls its environment,
 * and a second source of truth invites drift.
 */

import { ForgeConfigurationError } from './client/errors.js';
import { DEFAULT_BASE_URL } from './client/http.js';

export interface ServerConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Organization slug to default to, when the operator pinned one. */
  readonly organization: string | undefined;
  /** Whether destructive tools are registered at all. */
  readonly allowDestructive: boolean;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /**
   * Overrides the per-operation polling budget when set.
   *
   * Each operation carries its own default — server provisioning gets thirty
   * minutes and a two-minute cadence, a config change gets two minutes — so
   * these exist for slow providers and impatient operators, not for ordinary
   * use.
   */
  readonly pollTimeoutMs: number | undefined;
  readonly pollIntervalMs: number | undefined;
}

/**
 * Reads the destructive-operations kill switch.
 *
 * Only the exact documented value `1` enables it. Accepting `true`/`yes`/`on`
 * as well would widen the set of ways a stray environment value can arm
 * infrastructure deletion, and a switch of this consequence should have exactly
 * one spelling. Any other non-empty value is a configuration error rather than
 * a silent "off", so a typo is loud instead of surprising.
 */
function readDestructiveFlag(value: string | undefined): boolean {
  if (value === undefined) return false;

  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (trimmed === '1') return true;

  throw new ForgeConfigurationError(
    `FORGE_MCP_ALLOW_DESTRUCTIVE must be exactly "1" to enable destructive tools, ` +
      `received "${value}". Unset it to keep them disabled.`,
  );
}

function readInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ForgeConfigurationError(`${label} must be a positive integer, received "${value}".`);
  }
  return parsed;
}

/**
 * Builds configuration from an environment map.
 *
 * @param env Defaults to `process.env`; injectable for tests.
 * @throws {ForgeConfigurationError} when `FORGE_API_KEY` is absent.
 */
/** Reads an optional positive integer, leaving the per-operation default in place when unset. */
function readOptionalInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return readInteger(raw, 0, name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const apiKey = env['FORGE_API_KEY']?.trim();

  if (!apiKey) {
    throw new ForgeConfigurationError(
      'FORGE_API_KEY is not set. Generate a token at https://forge.laravel.com/profile/api ' +
        'and expose it to the MCP server process.',
    );
  }

  const organization = env['FORGE_ORGANIZATION']?.trim();

  return {
    apiKey,
    baseUrl: env['FORGE_API_BASE_URL']?.trim() || DEFAULT_BASE_URL,
    organization: organization === '' ? undefined : organization,
    allowDestructive: readDestructiveFlag(env['FORGE_MCP_ALLOW_DESTRUCTIVE']),
    timeoutMs: readInteger(env['FORGE_TIMEOUT_MS'], 30_000, 'FORGE_TIMEOUT_MS'),
    maxRetries: readInteger(env['FORGE_MAX_RETRIES'], 3, 'FORGE_MAX_RETRIES'),
    pollTimeoutMs: readOptionalInteger(env['FORGE_POLL_TIMEOUT_MS'], 'FORGE_POLL_TIMEOUT_MS'),
    pollIntervalMs: readOptionalInteger(env['FORGE_POLL_INTERVAL_MS'], 'FORGE_POLL_INTERVAL_MS'),
  };
}
