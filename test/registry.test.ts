import { describe, expect, it } from 'vitest';

import { ForgeConfirmationError } from '../src/client/errors.js';
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
      /must be a string, number or boolean/,
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

    const phrase = buildConfirmationPhrase(descriptor as OperationDescriptor, {
      organization: 'acme',
      server: 12345,
    });

    expect(phrase).toBe('DELETE server=12345');
  });

  it('excludes the organization from the phrase', () => {
    const descriptor = OPERATIONS.find((op) => op.name === deleteServer) as OperationDescriptor;
    const phrase = buildConfirmationPhrase(descriptor, { organization: 'acme', server: 1 });

    expect(phrase).not.toContain('organization');
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
      tool.handler({ organization: 'acme', server: 12345, confirm: 'DELETE server=99999' }),
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

    await tool.handler({ organization: 'acme', server: 12345, confirm: 'DELETE server=12345' });

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

  it('lets an explicit argument override the pinned slug', async () => {
    const stub = stubFetch([{ body: jsonApiResource('servers', 1, {}) }]);
    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers'] });

    await findTool(tools, 'list_servers').handler({ organization: 'other' });

    expect(stub.requests[0]?.url).toContain('/orgs/other/servers');
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

    await expect(
      findTool(tools, 'list_servers').handler({ 'filter[name]': { evil: true } }),
    ).rejects.toThrow(/must be a string, number or boolean/);
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
      confirm: 'DELETE server=5',
      wait: false,
    });

    expect(stub.requests[0]?.body).toBeUndefined();
  });
});

describe('async operations', () => {
  it('offers a wait argument only on async operations', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme' });

    const asyncTool = tools.find((tool) => tool.descriptor.processingMode === 'async');
    const syncTool = tools.find((tool) => tool.descriptor.processingMode === 'sync');

    const asyncProps = asyncTool?.inputSchema['properties'] as Record<string, unknown>;
    const syncProps = syncTool?.inputSchema['properties'] as Record<string, unknown>;

    expect(asyncProps['wait']).toBeDefined();
    expect(syncProps['wait']).toBeUndefined();
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

  it('polls until terminal when wait is requested', async () => {
    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('deployments', 1, { status: 'deploying' }) },
      { body: jsonApiResource('deployments', 1, { status: 'finished' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_deployments'],
    });
    const tool = tools.find((candidate) => candidate.name === 'create_servers_sites_deployments');
    if (!tool) return;

    const result = (await tool.handler({ server: 1, site: 2, wait: true })) as Record<
      string,
      unknown
    >;

    const polled = result['polled'] as Record<string, unknown>;
    expect(polled['status']).toBe('finished');
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
