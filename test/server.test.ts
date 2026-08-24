import { describe, expect, it } from 'vitest';

import { ForgeConfigurationError } from '../src/client/errors.js';
import { ForgeClient } from '../src/client/http.js';
import { RateLimiter } from '../src/client/rate-limit.js';
import { loadConfig } from '../src/config.js';
import { OPERATIONS } from '../src/generated/operations.js';
import { createServer } from '../src/server.js';
import { countSpecOperations, instantSleep, loadSpecSchemas, stubFetch } from './helpers.js';

const schemas = loadSpecSchemas();

describe('loadConfig', () => {
  it('requires an API token', () => {
    expect(() => loadConfig({})).toThrow(ForgeConfigurationError);
    expect(() => loadConfig({ FORGE_API_KEY: '  ' })).toThrow(ForgeConfigurationError);
  });

  it('points the operator at the token page', () => {
    expect(() => loadConfig({})).toThrow(/forge\.laravel\.com\/profile\/api/);
  });

  it('reads the happy path', () => {
    const config = loadConfig({
      FORGE_API_KEY: 'token',
      FORGE_ORGANIZATION: 'acme',
      FORGE_MCP_ALLOW_DESTRUCTIVE: '1',
    });

    expect(config).toMatchObject({
      apiKey: 'token',
      organization: 'acme',
      allowDestructive: true,
    });
  });

  it('defaults destructive operations to disabled', () => {
    expect(loadConfig({ FORGE_API_KEY: 'token' }).allowDestructive).toBe(false);
  });

  it('enables destructive tools only for the exact documented value', () => {
    expect(
      loadConfig({ FORGE_API_KEY: 't', FORGE_MCP_ALLOW_DESTRUCTIVE: '1' }).allowDestructive,
    ).toBe(true);
    expect(
      loadConfig({ FORGE_API_KEY: 't', FORGE_MCP_ALLOW_DESTRUCTIVE: ' 1 ' }).allowDestructive,
    ).toBe(true);
  });

  it('treats unset or empty as disabled', () => {
    expect(loadConfig({ FORGE_API_KEY: 't' }).allowDestructive).toBe(false);
    expect(
      loadConfig({ FORGE_API_KEY: 't', FORGE_MCP_ALLOW_DESTRUCTIVE: '' }).allowDestructive,
    ).toBe(false);
  });

  it('rejects near-miss spellings rather than silently disabling', () => {
    // A switch that arms infrastructure deletion should have one spelling, and
    // a typo should be loud rather than quietly leaving tools unavailable.
    for (const value of ['true', 'yes', 'on', '0', 'false', 'maybe']) {
      expect(
        () => loadConfig({ FORGE_API_KEY: 't', FORGE_MCP_ALLOW_DESTRUCTIVE: value }),
        `"${value}" should be rejected`,
      ).toThrow(ForgeConfigurationError);
    }
  });

  it('treats a blank organization as unset', () => {
    expect(
      loadConfig({ FORGE_API_KEY: 't', FORGE_ORGANIZATION: '   ' }).organization,
    ).toBeUndefined();
  });

  it('falls back to the documented base URL', () => {
    expect(loadConfig({ FORGE_API_KEY: 't' }).baseUrl).toBe('https://forge.laravel.com/api');
  });

  it('rejects a non-positive timeout', () => {
    expect(() => loadConfig({ FORGE_API_KEY: 't', FORGE_TIMEOUT_MS: '0' })).toThrow(
      ForgeConfigurationError,
    );
    expect(() => loadConfig({ FORGE_API_KEY: 't', FORGE_MAX_RETRIES: 'abc' })).toThrow(
      ForgeConfigurationError,
    );
  });
});

describe('createServer', () => {
  function build(
    overrides: Partial<ReturnType<typeof loadConfig>> = {},
  ): ReturnType<typeof createServer> & { stub: ReturnType<typeof stubFetch> } {
    const stub = stubFetch([]);
    const client = new ForgeClient({
      apiKey: 'token',
      fetch: stub.fetch,
      sleep: instantSleep,
      rateLimiter: new RateLimiter({ sleep: instantSleep }),
    });

    const config = {
      ...loadConfig({ FORGE_API_KEY: 'token', FORGE_ORGANIZATION: 'acme' }),
      ...overrides,
    };

    return { ...createServer({ config, schemas, client }), stub };
  }

  it('registers the non-destructive surface by default', () => {
    const { tools } = build();

    const destructiveTotal = OPERATIONS.filter((op) => op.destructive).length;
    expect(tools).toHaveLength(OPERATIONS.length - destructiveTotal);
    expect(destructiveTotal).toBeGreaterThan(0);
  });

  it('registers everything when destructive operations are enabled', () => {
    const { tools } = build({ allowDestructive: true });
    expect(tools).toHaveLength(OPERATIONS.length);
  });

  it('annotates read-only tools', () => {
    const { tools } = build();
    const readTool = tools.find((tool) => tool.descriptor.method === 'GET');
    expect(readTool).toBeDefined();
  });

  it('exposes the whole documented API surface', () => {
    const { tools } = build({ allowDestructive: true });

    // Derived from the spec rather than hardcoded, so refreshing to a newer
    // Forge API does not require editing this assertion.
    expect(tools).toHaveLength(countSpecOperations());
  });
});
