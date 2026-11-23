import { describe, expect, it } from 'vitest';

import { ForgeConfigurationError } from '../src/client/errors.js';
import { loadConfig } from '../src/config.js';
import { FORGE_SCOPES, OPERATIONS } from '../src/generated/operations.js';
import {
  misleadingScopes,
  profiles,
  readOnlyScopes,
  renderScopeReport,
  toolsFor,
} from '../src/scopes.js';
import { hasScopesFor } from '../src/tools/registry.js';

describe('generated scopes', () => {
  it('gives every operation a scope list drawn from the declared catalogue', () => {
    for (const operation of OPERATIONS) {
      for (const scope of operation.scopes) {
        expect(FORGE_SCOPES[scope], `${operation.name} -> ${scope}`).toBeDefined();
      }
    }
  });

  it('leaves only the read-only reference endpoints unscoped', () => {
    const unscoped = OPERATIONS.filter((operation) => operation.scopes.length === 0);

    // Providers, regions, sizes, predefined roles, permissions and the org read.
    expect(unscoped).toHaveLength(13);
    for (const operation of unscoped) expect(operation.method, operation.name).toBe('GET');
  });
});

describe('FORGE_SCOPES', () => {
  it('is optional, and undeclared means unfiltered', () => {
    expect(loadConfig({ FORGE_API_KEY: 't' }).scopes).toBeUndefined();
    expect(loadConfig({ FORGE_API_KEY: 't', FORGE_SCOPES: '  ' }).scopes).toBeUndefined();
    expect(loadConfig({ FORGE_API_KEY: 't', FORGE_SCOPES: '*' }).scopes).toBeUndefined();
  });

  it('accepts commas, whitespace or both', () => {
    const commas = loadConfig({ FORGE_API_KEY: 't', FORGE_SCOPES: 'server:view,team:view' }).scopes;
    const spaces = loadConfig({ FORGE_API_KEY: 't', FORGE_SCOPES: 'server:view team:view' }).scopes;
    const mixed = loadConfig({
      FORGE_API_KEY: 't',
      FORGE_SCOPES: 'server:view,\n  team:view',
    }).scopes;

    for (const set of [commas, spaces, mixed]) {
      expect([...(set ?? [])].sort()).toEqual(['server:view', 'team:view']);
    }
  });

  it('rejects a scope Forge does not define, rather than silently hiding tools', () => {
    // A typo would otherwise remove every tool needing the scope it meant to name.
    expect(() => loadConfig({ FORGE_API_KEY: 't', FORGE_SCOPES: 'server:veiw' })).toThrow(
      ForgeConfigurationError,
    );
    expect(() => loadConfig({ FORGE_API_KEY: 't', FORGE_SCOPES: 'server:veiw' })).toThrow(
      /server:veiw/,
    );
  });
});

describe('scope filtering', () => {
  it('registers everything when scopes are undeclared', () => {
    for (const operation of OPERATIONS) {
      expect(hasScopesFor(operation, undefined), operation.name).toBe(true);
    }
  });

  it('keeps the unscoped reference endpoints whatever the token holds', () => {
    const held = new Set<string>();
    for (const operation of OPERATIONS.filter((candidate) => candidate.scopes.length === 0)) {
      expect(hasScopesFor(operation, held), operation.name).toBe(true);
    }
  });

  it('requires every scope an operation declares, not just one', () => {
    const multi = OPERATIONS.find((operation) => operation.scopes.length > 1);

    // Only meaningful if the spec still has a multi-scope operation.
    if (multi) {
      expect(hasScopesFor(multi, new Set([multi.scopes[0] as string]))).toBe(false);
      expect(hasScopesFor(multi, new Set(multi.scopes))).toBe(true);
    }
  });

  it('hides server deletion from a token that cannot delete servers', () => {
    const remove = OPERATIONS.find((operation) => operation.name === 'delete_servers');
    expect(remove?.scopes).toEqual(['server:delete']);

    expect(hasScopesFor(remove as (typeof OPERATIONS)[number], new Set(['server:view']))).toBe(
      false,
    );
  });
});

describe('scope report', () => {
  it('calls only genuinely read-only scopes read-only', () => {
    const readOnly = readOnlyScopes();

    for (const scope of readOnly) {
      const writes = OPERATIONS.filter(
        (operation) => operation.method !== 'GET' && operation.scopes.includes(scope),
      );
      expect(writes, `${scope} permits writes`).toHaveLength(0);
    }
  });

  it('names the :view scopes that permit writes', () => {
    const misleading = misleadingScopes();

    // Forge gates all ten scheduled-job endpoints — create and delete included —
    // behind server:view, while its purpose-built server:create-schedulers and
    // server:delete-schedulers scopes go to the Laravel Scheduler integration.
    // A scheduled job carries an arbitrary command and the user to run it as.
    expect([...misleading.keys()]).toContain('server:view');

    const writes = misleading.get('server:view') ?? [];
    expect(writes.some((operation) => operation.name === 'create_servers_scheduled_jobs')).toBe(
      true,
    );
  });

  it('reports profiles whose tool count matches their scopes', () => {
    for (const profile of profiles()) {
      const tools = toolsFor(profile.scopes);
      expect(tools.length, profile.name).toBeGreaterThan(0);

      for (const tool of tools) {
        for (const scope of tool.scopes) {
          expect(profile.scopes, `${profile.name} / ${tool.name}`).toContain(scope);
        }
      }
    }
  });

  it('renders without a token, so it can be run before credentials exist', () => {
    const report = renderScopeReport();

    expect(report).toContain('PROFILES');
    expect(report).toContain('SCOPES THAT PERMIT MORE THAN THEIR NAME SUGGESTS');
    expect(report).toContain('server:view');
    // Every declared scope is listed, including the fifteen no operation uses.
    for (const scope of Object.keys(FORGE_SCOPES)) expect(report).toContain(scope);
  });
});
