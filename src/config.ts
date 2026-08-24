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
}

/** Values accepted as "true" for boolean environment variables. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function readBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return TRUTHY.has(value.trim().toLowerCase());
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
    allowDestructive: readBoolean(env['FORGE_MCP_ALLOW_DESTRUCTIVE']),
    timeoutMs: readInteger(env['FORGE_TIMEOUT_MS'], 30_000, 'FORGE_TIMEOUT_MS'),
    maxRetries: readInteger(env['FORGE_MAX_RETRIES'], 3, 'FORGE_MAX_RETRIES'),
  };
}
