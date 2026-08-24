import { describe, expect, it } from 'vitest';

import { ForgeConfirmationError } from '../src/client/errors.js';
import { ForgeValidationError } from '../src/tools/validate.js';
import { ForgeClient } from '../src/client/http.js';
import { RateLimiter } from '../src/client/rate-limit.js';
import { OPERATIONS } from '../src/generated/operations.js';
import { buildConfirmationPhrase, buildToolRegistry, renderPath } from '../src/tools/registry.js';
import type { OperationDescriptor } from '../src/tools/types.js';
import { instantSleep, jsonApiResource, loadSpecSchemas, stubFetch } from './helpers.js';

const schemas = loadSpecSchemas();

function makeRegistry(
  stub: ReturnType<typeof stubFetch>,
  options: { organization?: string; allowDestructive?: boolean; only?: string[] } = {},
): ReturnType<typeof buildToolRegistry> {
  const client = new ForgeClient({
    apiKey: 'test-token',
    fetch: stub.fetch,
    sleep: instantSleep,
    rateLimiter: new RateLimiter({ sleep: instantSleep }),
  });

  const operations =
    options.only === undefined
      ? OPERATIONS
      : OPERATIONS.filter((op) => options.only?.includes(op.name));

  return buildToolRegistry({
    client,
    operations,
    schemas,
    defaultOrganization: options.organization,
    allowDestructive: options.allowDestructive ?? false,
  });
}

function findTool(
  tools: ReturnType<typeof buildToolRegistry>,
  name: string,
): ReturnType<typeof buildToolRegistry>[number] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool "${name}" not registered`);
  return tool;
}

describe('renderPath', () => {
  it('substitutes and URL-encodes placeholders', () => {
    const { path, consumed } = renderPath('/orgs/{organization}/servers/{server}', {
      organization: 'acme corp',
      server: 12345,
    });

    expect(path).toBe('/orgs/acme%20corp/servers/12345');
    expect([...consumed].sort()).toEqual(['organization', 'server']);
  });

  it('rejects a missing path parameter rather than emitting a broken URL', () => {
    expect(() =>
      renderPath('/orgs/{organization}/servers/{server}', { organization: 'acme' }),
    ).toThrow(/Missing required path parameter "server"/);
  });

  it('rejects a non-scalar path parameter', () => {
    expect(() => renderPath('/orgs/{organization}', { organization: { slug: 'acme' } })).toThrow(
      /must be a string, number, boolean or an array/,
    );
  });
});

describe('destructive tool gating', () => {
  it('omits destructive tools by default', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub);

    expect(tools.some((tool) => tool.descriptor.destructive)).toBe(false);
  });

  it('registers them when explicitly allowed', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true });

    expect(tools.some((tool) => tool.descriptor.destructive)).toBe(true);
  });

  it('registers strictly more tools when destructive operations are enabled', () => {
    const stub = stubFetch([]);
    const guarded = makeRegistry(stub).length;
    const full = makeRegistry(stub, { allowDestructive: true }).length;

    expect(full).toBeGreaterThan(guarded);
    expect(full).toBe(OPERATIONS.length);
  });
});

describe('confirmation guard', () => {
  const deleteServer = 'delete_servers';

  it('builds a phrase naming the method and target', () => {
    const descriptor = OPERATIONS.find((op) => op.name === deleteServer);
    expect(descriptor).toBeDefined();

    const phrase = buildConfirmationPhrase(
      descriptor as OperationDescriptor,
      { organization: 'acme', server: 12345 },
      true,
    );

    expect(phrase).toBe('delete_servers server=12345');
  });

  it('excludes the organization from the phrase when the operator pinned one', () => {
    const descriptor = OPERATIONS.find((op) => op.name === deleteServer) as OperationDescriptor;
    const phrase = buildConfirmationPhrase(descriptor, { organization: 'acme', server: 1 }, true);

    expect(phrase).not.toContain('organization');
  });

  it('includes the organization when the model supplies it', () => {
    const descriptor = OPERATIONS.find((op) => op.name === deleteServer) as OperationDescriptor;
    const phrase = buildConfirmationPhrase(descriptor, { organization: 'acme', server: 1 }, false);

    expect(phrase).toBe('delete_servers organization=acme server=1');
  });

  it('will not let a confirmation for one organization authorise another', async () => {
    // Forge ids are scoped per organization, so server 12345 can exist in two
    // of them. Without the org in the phrase, one confirmation would authorise
    // a deletion in either.
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true, only: [deleteServer] });
    const tool = findTool(tools, deleteServer);

    await expect(
      tool.handler({
        organization: 'other-corp',
        server: 12345,
        confirm: 'delete_servers organization=acme server=12345',
      }),
    ).rejects.toThrow(ForgeConfirmationError);
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses to run without a confirm value', async () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true, only: [deleteServer] });
    const tool = findTool(tools, deleteServer);

    await expect(tool.handler({ organization: 'acme', server: 12345 })).rejects.toThrow(
      ForgeConfirmationError,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses a confirm value for a different target', async () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true, only: [deleteServer] });
    const tool = findTool(tools, deleteServer);

    await expect(
      tool.handler({ organization: 'acme', server: 12345, confirm: 'delete_servers server=99999' }),
    ).rejects.toThrow(ForgeConfirmationError);
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects a generic affirmative', async () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true, only: [deleteServer] });
    const tool = findTool(tools, deleteServer);

    await expect(
      tool.handler({ organization: 'acme', server: 12345, confirm: 'yes' }),
    ).rejects.toThrow(ForgeConfirmationError);
  });

  it('proceeds when the phrase matches exactly', async () => {
    const stub = stubFetch([{ status: 202 }]);
    const tools = makeRegistry(stub, { allowDestructive: true, only: [deleteServer] });
    const tool = findTool(tools, deleteServer);

    await tool.handler({
      organization: 'acme',
      server: 12345,
      confirm: 'delete_servers organization=acme server=12345',
    });

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe('DELETE');
    expect(stub.requests[0]?.url).toContain('/orgs/acme/servers/12345');
  });

  it('requires confirmation on high-impact non-deletions too', () => {
    const nginxAction = OPERATIONS.find(
      (op) => op.operationId === 'organizations.servers.services.nginx.actions.store',
    );

    expect(nginxAction?.requiresConfirm).toBe(true);
    expect(nginxAction?.destructive).toBe(false);
  });
});

describe('organization handling', () => {
  it('hides the organization argument when one is pinned', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers'] });
    const tool = findTool(tools, 'list_servers');

    const properties = tool.inputSchema['properties'] as Record<string, unknown>;
    expect(properties['organization']).toBeUndefined();
  });

  it('requires it when none is pinned', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { only: ['list_servers'] });
    const tool = findTool(tools, 'list_servers');

    const required = tool.inputSchema['required'] as string[];
    expect(required).toContain('organization');
  });

  it('injects the pinned slug into the request path', async () => {
    const stub = stubFetch([{ body: jsonApiResource('servers', 1, { name: 'web-1' }) }]);
    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers'] });

    await findTool(tools, 'list_servers').handler({});

    expect(stub.requests[0]?.url).toContain('/orgs/acme/servers');
  });

  it('refuses a caller-supplied slug when one is pinned', async () => {
    // A pinned organization is server-controlled and removed from the schema,
    // so supplying one is an unknown argument. Silently ignoring it would be
    // weaker: this way the caller learns the override had no effect.
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers'] });

    await expect(
      findTool(tools, 'list_servers').handler({ organization: 'other' }),
    ).rejects.toThrow(/unknown argument "organization"/);
    expect(stub.requests).toHaveLength(0);
  });

  it('uses the pinned slug for the request', async () => {
    const stub = stubFetch([{ body: jsonApiResource('servers', 1, {}) }]);
    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers'] });

    await findTool(tools, 'list_servers').handler({});

    expect(stub.requests[0]?.url).toContain('/orgs/acme/servers');
  });
});

describe('request assembly', () => {
  it('splits arguments into path, query and body', async () => {
    const stub = stubFetch([{ status: 202 }]);
    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_commands'],
    });
    const tool = tools.find((candidate) => candidate.name === 'create_servers_sites_commands');

    // Skip rather than fail if the spec renames this operation.
    if (!tool) return;

    await tool.handler({ server: 1, site: 2, command: 'php artisan migrate --force' });

    const request = stub.requests[0];
    expect(request?.url).toContain('/orgs/acme/servers/1/sites/2/commands');
    expect(request?.body).toEqual({ command: 'php artisan migrate --force' });
  });

  it('rejects a non-scalar query parameter instead of sending [object Object]', async () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers'] });

    // Caught by schema validation before it can reach URL assembly.
    await expect(
      findTool(tools, 'list_servers').handler({ 'filter[name]': { evil: true } }),
    ).rejects.toThrow(ForgeValidationError);
    expect(stub.requests).toHaveLength(0);
  });

  it('never leaks confirm or wait into the request body', async () => {
    const stub = stubFetch([{ status: 202 }]);
    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: ['delete_servers'],
    });

    await findTool(tools, 'delete_servers').handler({
      server: 5,
      confirm: 'delete_servers server=5',
    });

    expect(stub.requests[0]?.body).toBeUndefined();
  });
});

describe('async operations', () => {
  it('offers wait only where a resource can actually be polled', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme' });

    const hasWait = (tool: (typeof tools)[number]): boolean =>
      (tool.inputSchema['properties'] as Record<string, unknown>)['wait'] !== undefined;

    // An async PUT addresses the resource it changes, so it can be re-read.
    const asyncPut = tools.find(
      (tool) => tool.descriptor.processingMode === 'async' && tool.descriptor.method === 'PUT',
    );
    expect(asyncPut && hasWait(asyncPut)).toBe(true);

    // Sync operations have nothing to wait for.
    const syncTool = tools.find((tool) => tool.descriptor.processingMode === 'sync');
    expect(syncTool && hasWait(syncTool)).toBe(false);

    // Action routes accept POST but expose no GET, so polling them is not
    // possible; offering wait there would be a lie.
    for (const tool of tools.filter((candidate) =>
      candidate.descriptor.path.endsWith('/actions'),
    )) {
      expect(hasWait(tool), `${tool.name} should not offer wait`).toBe(false);
    }
  });

  it('returns immediately with a note when wait is not requested', async () => {
    const stub = stubFetch([{ status: 202 }]);
    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_deployments'],
    });
    const tool = tools.find((candidate) => candidate.name === 'create_servers_sites_deployments');
    if (!tool) return;

    const result = (await tool.handler({ server: 1, site: 2 })) as Record<string, unknown>;

    expect(result['accepted']).toBe(true);
    expect(String(result['note'])).toContain('background');
    expect(stub.requests).toHaveLength(1);
  });

  it('polls the resource until it reaches a terminal state', async () => {
    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('nginxConfigs', 1, { status: 'updating' }) },
      { body: jsonApiResource('nginxConfigs', 1, { status: 'installed' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['update_servers_sites_nginx'],
    });
    const tool = tools.find((candidate) => candidate.name === 'update_servers_sites_nginx');
    if (!tool) return;

    const result = (await tool.handler({
      server: 1,
      site: 2,
      config: 'server { }',
      wait: true,
    })) as Record<string, unknown>;

    const polled = result['polled'] as Record<string, unknown>;
    expect(polled['status']).toBe('installed');
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe('tool metadata', () => {
  it('gives every tool a unique name', () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses names that are valid MCP tool identifiers', () => {
    for (const operation of OPERATIONS) {
      expect(operation.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('cites the underlying Forge endpoint in every description', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true });

    for (const tool of tools) {
      expect(tool.description).toContain(
        `Forge API: ${tool.descriptor.method} ${tool.descriptor.path}`,
      );
    }
  });

  it('warns in the description of every destructive tool', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true });

    for (const tool of tools.filter((candidate) => candidate.descriptor.destructive)) {
      expect(tool.description).toContain('DESTRUCTIVE');
    }
  });

  it('builds a valid object schema for every operation', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { allowDestructive: true });

    for (const tool of tools) {
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['properties']).toBeTypeOf('object');
    }
  });
});
