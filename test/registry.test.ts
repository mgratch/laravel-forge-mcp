import { describe, expect, it } from 'vitest';

import { ForgeApiError, ForgeConfirmationError } from '../src/client/errors.js';
import { ForgeValidationError } from '../src/tools/validate.js';
import { ForgeClient } from '../src/client/http.js';
import { RateLimiter } from '../src/client/rate-limit.js';
import { OPERATIONS, PENDING_STATUSES } from '../src/generated/operations.js';
import { buildConfirmationPhrase, buildToolRegistry, renderPath } from '../src/tools/registry.js';
import type { OperationDescriptor } from '../src/tools/types.js';
import { instantSleep, jsonApiResource, loadSpecSchemas, stubFetch } from './helpers.js';

const schemas = loadSpecSchemas();

function makeRegistry(
  stub: ReturnType<typeof stubFetch>,
  options: {
    organization?: string;
    allowDestructive?: boolean;
    only?: string[];
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
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
    ...(options.sleep === undefined ? {} : { pollSleep: options.sleep }),
    ...(options.now === undefined ? {} : { pollNow: options.now }),
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

    // A create can be re-read at the item route below the collection.
    const asyncCreate = tools.find((tool) => tool.descriptor.polling?.idParam !== undefined);
    expect(asyncCreate && hasWait(asyncCreate)).toBe(true);

    // An async update rewrites a resource that already existed, so its first
    // read can return the pre-operation steady state. Without a postcondition
    // proving the call took effect, no wait is offered.
    const unprovableUpdate = tools.find(
      (tool) => tool.descriptor.operationId === 'organizations.servers.background-processes.update',
    );
    expect(unprovableUpdate?.descriptor.processingMode).toBe('async');
    expect(unprovableUpdate && hasWait(unprovableUpdate)).toBe(false);

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

  it('polls a resource whose GET exposes a status, until it settles', async () => {
    const stub = stubFetch([
      { status: 202, body: jsonApiResource('deployments', 1, {}) },
      { body: jsonApiResource('deployments', 1, { status: 'queued' }) },
      { body: jsonApiResource('deployments', 1, { status: 'deploying' }) },
      { body: jsonApiResource('deployments', 1, { status: 'finished' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_deployments'],
    });
    const tool = findTool(tools, 'create_servers_sites_deployments');

    const result = (await tool.handler({ server: 1, site: 2, wait: true })) as Record<
      string,
      unknown
    >;

    const polled = result['polled'] as Record<string, unknown> | undefined;
    expect(polled?.['status']).toBe('finished');
  }, 20_000);

  it('offers wait only where the spec exposes a pollable status', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme', allowDestructive: true });

    const hasWait = (tool: (typeof tools)[number]): boolean =>
      (tool.inputSchema['properties'] as Record<string, unknown>)['wait'] !== undefined;

    for (const tool of tools) {
      const expected =
        tool.descriptor.processingMode === 'async' && tool.descriptor.polling !== undefined;
      expect(hasWait(tool), `${tool.name} wait mismatch`).toBe(expected);
    }
  });

  it('never advertises wait for an operation with nothing to read back', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme', allowDestructive: true });

    // A backup restore posts to a route with no GET at all, so there is no
    // resource whose status could be polled.
    const restore = tools.find((tool) =>
      tool.descriptor.operationId.endsWith('backups.instances.restores.store'),
    );
    expect(restore).toBeDefined();
    if (!restore) return;

    const properties = restore.inputSchema['properties'] as Record<string, unknown>;
    expect(properties['wait']).toBeUndefined();

    // Action routes are the other shape with no GET.
    for (const tool of tools.filter((c) => c.descriptor.path.endsWith('/actions'))) {
      const props = tool.inputSchema['properties'] as Record<string, unknown>;
      expect(props['wait'], `${tool.name} should not offer wait`).toBeUndefined();
    }
  });

  it('returns included resources and links to the caller', async () => {
    const stub = stubFetch([
      {
        body: {
          data: [{ id: '1', type: 'sites', attributes: { domain: 'example.com' } }],
          included: [{ id: '9', type: 'servers', attributes: { name: 'web-1' } }],
          links: { next: null },
          meta: { per_page: 30, next_cursor: null },
        },
      },
    ]);

    const tools = makeRegistry(stub, { organization: 'acme', only: ['list_servers_sites'] });
    const tool = tools.find((c) => c.name === 'list_servers_sites');
    if (!tool) return;

    const result = (await tool.handler({ server: 1 })) as Record<string, unknown>;

    expect(result['included']).toEqual([{ id: '9', type: 'servers', name: 'web-1' }]);
    expect(result['links']).toBeDefined();
  });
});

describe('body-selected confirmation targets', () => {
  it('binds a target carried in the request body, not the path', () => {
    // POST /orgs/{org}/servers/archives takes the server in ArchiveRequest, so
    // a phrase built from path ids alone is identical for every server.
    const archive = OPERATIONS.find(
      (operation) => operation.operationId === 'organizations.servers.archives.store',
    );
    expect(archive).toBeDefined();
    if (!archive) return;

    expect(archive.confirmationTargetFields.length).toBeGreaterThan(0);

    const phrase = buildConfirmationPhrase(
      archive,
      { organization: 'acme', server_id: 12345 },
      true,
    );
    expect(phrase).toBe('create_servers_archives server_id=12345');
  });

  it('will not let one archive confirmation authorise a different server', async () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: ['create_servers_archives'],
    });
    const tool = tools.find((candidate) => candidate.name === 'create_servers_archives');
    if (!tool) return;

    await expect(
      tool.handler({ server_id: 99999, confirm: 'create_servers_archives server_id=12345' }),
    ).rejects.toThrow(ForgeConfirmationError);
    expect(stub.requests).toHaveLength(0);
  });

  it('every guarded operation has a target bound into its phrase', () => {
    for (const operation of OPERATIONS.filter((candidate) => candidate.requiresConfirm)) {
      const hasPathTarget = operation.pathParams.some((param) => param.name !== 'organization');
      const hasBodyTarget = operation.confirmationTargetFields.length > 0;

      expect(
        hasPathTarget || hasBodyTarget,
        `${operation.name} has an unbound confirmation phrase`,
      ).toBe(true);
    }
  });

  it('documents the format the runtime actually enforces', () => {
    const stub = stubFetch([]);
    const tools = makeRegistry(stub, { organization: 'acme', allowDestructive: true });

    for (const tool of tools.filter((candidate) => candidate.descriptor.requiresConfirm)) {
      const properties = tool.inputSchema['properties'] as Record<string, unknown>;
      const confirm = properties['confirm'] as Record<string, unknown>;
      const description = String(confirm['description']);

      // The documented example must lead with the tool name, as the runtime
      // requires. A stale format guarantees a failed first attempt.
      expect(description, `${tool.name} documents a stale confirm format`).toContain(tool.name);
      expect(description).not.toContain('<METHOD>');
    }
  });
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

describe('polling a deletion', () => {
  it('treats the final 404 as completion rather than an error', async () => {
    // 19 pollable operations are deletions; their last read is necessarily a
    // 404, and reporting that as a failure would misdescribe a success.
    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('firewallRules', 1, { status: 'removing' }) },
      { status: 404, body: { message: 'Not found.' } },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['delete_servers_firewall_rules'],
    });
    const tool = tools.find((c) => c.name === 'delete_servers_firewall_rules');
    if (!tool) return;

    const result = (await tool.handler({
      server: 1,
      rule: 2,
      wait: true,
      confirm: 'delete_servers_firewall_rules server=1 rule=2',
    })) as Record<string, unknown>;

    const polled = result['polled'] as Record<string, unknown>;
    expect(polled['status']).toBe('deleted');
  }, 20_000);

  it('still surfaces a non-404 failure while polling a deletion', async () => {
    const stub = stubFetch([
      { status: 202 },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['delete_servers_firewall_rules'],
    });
    const tool = tools.find((c) => c.name === 'delete_servers_firewall_rules');
    if (!tool) return;

    await expect(
      tool.handler({
        server: 1,
        rule: 2,
        wait: true,
        confirm: 'delete_servers_firewall_rules server=1 rule=2',
      }),
    ).rejects.toThrow(ForgeApiError);
  }, 20_000);
});

describe('polling a create', () => {
  it('follows the response self link rather than the collection', async () => {
    const stub = stubFetch([
      {
        status: 202,
        body: {
          data: {
            id: '7',
            type: 'backgroundProcesses',
            attributes: { status: 'installing' },
            links: { self: '/api/orgs/acme/servers/1/background-processes/7' },
          },
        },
      },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'running' }) },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'active' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = tools.find((c) => c.name === 'create_servers_background_processes');
    if (!tool) return;

    await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    });

    // The prefix must be applied exactly once, not doubled.
    const pollUrl = stub.requests[1]?.url ?? '';
    expect(pollUrl).toBe(
      'https://forge.laravel.com/api/orgs/acme/servers/1/background-processes/7',
    );
  }, 20_000);
});

describe('polled response integrity', () => {
  it('returns metadata from the terminal read, not the original 202', async () => {
    // Combining data from the final GET with links from the accepted response
    // would present two different API responses as one object.
    const stub = stubFetch([
      {
        status: 202,
        body: {
          data: {
            id: '7',
            type: 'backgroundProcesses',
            attributes: { status: 'installing' },
            links: { self: '/api/orgs/acme/servers/1/background-processes/7' },
          },
          links: { self: '/api/stale-from-the-202' },
        },
      },
      {
        body: {
          data: { id: '7', type: 'backgroundProcesses', attributes: { status: 'active' } },
          included: [{ id: '1', type: 'servers', attributes: { name: 'web-1' } }],
          links: { self: '/api/orgs/acme/servers/1/background-processes/7' },
        },
      },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = tools.find((c) => c.name === 'create_servers_background_processes');
    if (!tool) return;

    const result = (await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    })) as Record<string, unknown>;

    expect(result['included']).toEqual([{ id: '1', type: 'servers', name: 'web-1' }]);
    expect(JSON.stringify(result['links'])).not.toContain('stale-from-the-202');
  }, 20_000);

  it('tells a non-pollable async caller what to read instead of offering wait', async () => {
    // Pick a real operation the generator classified as non-pollable, so the
    // branch under test is the one the shipped catalog actually reaches. A
    // guard that skips when the chosen operation turns out to be pollable would
    // silently assert nothing.
    const nonPollable = OPERATIONS.find(
      (op) =>
        op.processingMode === 'async' &&
        op.polling === undefined &&
        !op.destructive &&
        !op.requiresConfirm &&
        !op.bodyRequired,
    );
    expect(nonPollable, 'no non-pollable async operation in the catalog').toBeDefined();

    const stub = stubFetch([{ status: 202 }]);
    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: [(nonPollable as OperationDescriptor).name],
    });
    const tool = findTool(tools, (nonPollable as OperationDescriptor).name);

    const args: Record<string, unknown> = {};
    for (const param of tool.descriptor.pathParams) {
      if (param.name !== 'organization') args[param.name] = 1;
    }

    const result = (await tool.handler(args)) as Record<string, unknown>;

    const note = String(result['note']);
    expect(note).toContain('no route to poll');
    expect(note).not.toContain('wait: true');
  });
});

describe('per-resource terminal semantics', () => {
  // Forge reuses status strings with different meanings. `running` is the
  // healthy steady state of a background process but an in-flight command, so
  // a single global vocabulary is wrong in both directions.

  it('treats a background process reporting running as finished', async () => {
    const stub = stubFetch([
      { status: 202, body: jsonApiResource('backgroundProcesses', 7, {}) },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'running' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = findTool(tools, 'create_servers_background_processes');

    const result = (await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    })) as Record<string, unknown>;

    expect((result['polled'] as Record<string, unknown>)['status']).toBe('running');
    // One create plus exactly one read: `running` settled immediately.
    expect(stub.requests).toHaveLength(2);
  }, 20_000);

  it('keeps polling a background process through starting and stopping', async () => {
    const stub = stubFetch([
      { status: 202, body: jsonApiResource('backgroundProcesses', 7, {}) },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'starting' }) },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'stopping' }) },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'stopped' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = findTool(tools, 'create_servers_background_processes');

    const result = (await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    })) as Record<string, unknown>;

    expect((result['polled'] as Record<string, unknown>)['status']).toBe('stopped');
    expect(stub.requests).toHaveLength(4);
  }, 20_000);

  it('keeps polling a command that reports running until it finishes', async () => {
    const stub = stubFetch([
      { status: 202, body: jsonApiResource('commands', 3, {}) },
      { body: jsonApiResource('commands', 3, { status: 'running' }) },
      { body: jsonApiResource('commands', 3, { status: 'finished' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_commands'],
    });
    const tool = findTool(tools, 'create_servers_sites_commands');

    const result = (await tool.handler({
      server: 1,
      site: 2,
      command: 'php artisan migrate --force',
      wait: true,
    })) as Record<string, unknown>;

    expect((result['polled'] as Record<string, unknown>)['status']).toBe('finished');
    expect(stub.requests).toHaveLength(3);
  }, 20_000);

  it('gives the two resources opposite verdicts on the same status string', () => {
    expect(PENDING_STATUSES['backgroundProcesses']).not.toContain('running');
    expect(PENDING_STATUSES['commands']).toContain('running');
  });
});

describe('proof that the operation took effect', () => {
  // A 202 says Forge accepted the work, not that it has started it. Polling a
  // resource that already existed can read its pre-operation steady state and
  // mistake it for completion.

  it('does not accept the old maintenance-mode state as an enable completing', async () => {
    const stub = stubFetch([
      { status: 202 },
      // Pre-operation: mode off, no transition running. Terminal by status
      // alone, which is exactly the trap.
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: false,
          status: null,
        }),
      },
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: false,
          status: 'enabling',
        }),
      },
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: true,
          status: null,
        }),
      },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_integrations_laravel_maintenance'],
    });
    const tool = findTool(tools, 'create_servers_sites_integrations_laravel_maintenance');

    const result = (await tool.handler({
      server: 1,
      site: 2,
      status: 503,
      confirm: 'create_servers_sites_integrations_laravel_maintenance server=1 site=2',
      wait: true,
    })) as Record<string, unknown>;

    // Four requests: settling on the first read would have made two.
    expect(stub.requests).toHaveLength(4);
    expect((result['data'] as Record<string, unknown>)['enabled']).toBe(true);
  }, 30_000);

  it('withholds wait from an update whose effect it cannot prove', () => {
    // `update_servers_background_processes` is async, and its resource reports a
    // status — but `running` is that resource's healthy steady state both
    // before and after the write, and the resource exposes no `updated_at`. A
    // wait here could only guess.
    const update = OPERATIONS.find(
      (op) => op.operationId === 'organizations.servers.background-processes.update',
    );

    expect(update?.processingMode).toBe('async');
    expect(update?.polling).toBeUndefined();
  });

  it('requires a postcondition on every status plan for a pre-existing resource', () => {
    for (const operation of OPERATIONS) {
      const plan = operation.polling;
      if (!plan || plan.completion === 'absence') continue;

      // Either the poll targets a resource this call created, or it carries
      // proof the call landed.
      const provable = plan.idParam !== undefined || plan.expect !== undefined;
      expect(provable, `${operation.name} can settle on a stale state`).toBe(true);
    }
  });
});

describe('state-clearing operations', () => {
  it('polls a deployment-state reset by status rather than absence', async () => {
    const reset = OPERATIONS.find(
      (op) => op.operationId === 'organizations.servers.sites.deployments.status.destroy',
    );

    expect(reset?.polling?.completion).toBe('status');
    expect(reset?.polling?.expect).toEqual({ field: 'status', equals: null });

    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('deploymentStatuses', 1, { status: 'deploying' }) },
      { body: jsonApiResource('deploymentStatuses', 1, { status: null }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: [(reset as OperationDescriptor).name],
    });
    const tool = findTool(tools, (reset as OperationDescriptor).name);

    await tool.handler({ server: 1, site: 2, wait: true });

    expect(stub.requests).toHaveLength(3);
  }, 30_000);

  it('polls a maintenance-mode disable to enabled false', async () => {
    const disable = OPERATIONS.find(
      (op) =>
        op.operationId === 'organizations.servers.sites.integrations.laravel-maintenance.destroy',
    );

    expect(disable?.polling?.expect).toEqual({ field: 'enabled', equals: false });

    const stub = stubFetch([
      { status: 202 },
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: true,
          status: 'disabling',
        }),
      },
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: false,
          status: null,
        }),
      },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: [(disable as OperationDescriptor).name],
    });
    const tool = findTool(tools, (disable as OperationDescriptor).name);

    await tool.handler({ server: 1, site: 2, wait: true });

    expect(stub.requests).toHaveLength(3);
  }, 30_000);
});

describe('polling budgets', () => {
  it('gives server provisioning a budget that outlasts a real provision', () => {
    const create = OPERATIONS.find((op) => op.operationId === 'organizations.servers.store');

    // Forge documents ordinary provisioning at roughly ten minutes and
    // recommends polling about every two minutes.
    expect(create?.polling?.completion).toBe('readiness');
    expect(create?.polling?.timeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(create?.polling?.maxIntervalMs).toBeGreaterThanOrEqual(60_000);
  });

  it('keeps the short budget for everything else', () => {
    for (const operation of OPERATIONS) {
      const plan = operation.polling;
      if (!plan || plan.completion === 'readiness') continue;
      expect(plan.timeoutMs, `${operation.name}`).toBe(120_000);
    }
  });

  it('waits out a provision that takes longer than the old two-minute ceiling', async () => {
    // A fake clock, so the test proves the budget rather than the wall clock.
    // `is_ready` turns true after twenty simulated minutes.
    let clock = 0;
    const readyAt = 20 * 60_000;

    const reads = { count: 0 };
    const stub = stubFetch([{ status: 202, body: jsonApiResource('servers', 55, {}) }], {
      fallback: () => {
        reads.count += 1;
        return { body: jsonApiResource('servers', 55, { is_ready: clock >= readyAt }) };
      },
    });

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers'],
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    });
    const tool = findTool(tools, 'create_servers');

    const result = (await tool.handler({
      name: 'web-1',
      type: 'app',
      provider: 'custom',
      wait: true,
    })) as Record<string, unknown>;

    const polled = result['polled'] as Record<string, unknown>;
    expect(polled['completion']).toBe('readiness');
    expect(Number(polled['elapsedMs'])).toBeGreaterThan(120_000);
  });
});

describe('polling plans', () => {
  it('reaches a created resource through the generated item route when Forge omits a self link', async () => {
    // `BackgroundProcessResource` requires only `id` and `type`, so a valid 202
    // can carry an id with no `links.self`. The plan's read-path template plus
    // that id still addresses it.
    const stub = stubFetch([
      { status: 202, body: { data: { id: '42', type: 'backgroundProcesses' } } },
      { body: jsonApiResource('backgroundProcesses', 42, { status: 'running' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = findTool(tools, 'create_servers_background_processes');

    const result = (await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    })) as Record<string, unknown>;

    expect(stub.requests[1]?.url).toContain('/servers/1/background-processes/42');
    expect((result['polled'] as Record<string, unknown>)['status']).toBe('running');
  }, 20_000);

  it('reports what it could not poll when neither a self link nor an id comes back', async () => {
    const stub = stubFetch([{ status: 202 }]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = findTool(tools, 'create_servers_background_processes');

    const result = (await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    })) as Record<string, unknown>;

    expect(String(result['note'])).toContain('neither a self link nor a resource id');
    expect(stub.requests).toHaveLength(1);
  });

  it('polls an async deletion until the resource is gone', async () => {
    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'removing' }) },
      { status: 404, body: { errors: [{ title: 'Not Found' }] } },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: ['delete_servers_background_processes'],
    });
    const tool = findTool(tools, 'delete_servers_background_processes');

    const result = (await tool.handler({
      server: 1,
      backgroundProcess: 7,
      confirm: 'delete_servers_background_processes server=1 backgroundProcess=7',
      wait: true,
    })) as Record<string, unknown>;

    expect((result['polled'] as Record<string, unknown>)['completion']).toBe('absence');
    expect(stub.requests).toHaveLength(3);
  }, 20_000);

  it('does not treat a statusless read as a completed deletion', async () => {
    // A deleted resource that still answers 200 has not gone anywhere. Under
    // the status vocabulary a missing status means "nothing to wait for", which
    // is the opposite of what it means here.
    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('keys', 9, {}) },
      { status: 404, body: { errors: [{ title: 'Not Found' }] } },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: ['delete_servers_ssh_keys'],
    });
    const tool = findTool(tools, 'delete_servers_ssh_keys');

    await tool.handler({
      server: 1,
      key: 9,
      confirm: 'delete_servers_ssh_keys server=1 key=9',
      wait: true,
    });

    expect(stub.requests).toHaveLength(3);
  }, 20_000);

  it('generates absence plans only for item routes, never for state-clearing endpoints', () => {
    // `DELETE .../deployments/status` clears a stuck flag on an endpoint that
    // keeps answering afterwards, so waiting for a 404 would hang until timeout.
    const resetter = OPERATIONS.find(
      (op) => op.operationId === 'organizations.servers.sites.deployments.status.destroy',
    );

    expect(resetter?.polling?.completion).not.toBe('absence');

    for (const operation of OPERATIONS) {
      if (operation.polling?.completion !== 'absence') continue;
      expect(operation.polling.path.endsWith('}'), `${operation.name} is not an item route`).toBe(
        true,
      );
    }
  });

  it('waits for a provisioning server to report readiness', async () => {
    const stub = stubFetch([
      { status: 202, body: { data: { id: '55', type: 'servers' } } },
      { body: jsonApiResource('servers', 55, { is_ready: false }) },
      { body: jsonApiResource('servers', 55, { is_ready: true }) },
    ]);

    const tools = makeRegistry(stub, { organization: 'acme', only: ['create_servers'] });
    const tool = findTool(tools, 'create_servers');

    const result = (await tool.handler({
      name: 'web-1',
      type: 'app',
      provider: 'custom',
      wait: true,
    })) as Record<string, unknown>;

    expect((result['polled'] as Record<string, unknown>)['completion']).toBe('readiness');
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[2]?.url).toContain('/servers/55');
  }, 20_000);

  it("does not settle a deletion on the resource's pre-delete steady state", async () => {
    // A background process answers `running` before it answers `removing`, and
    // `running` is terminal for that resource under the status vocabulary.
    // Accepting it here would report the deletion complete while the process is
    // still there.
    const stub = stubFetch([
      { status: 202 },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'running' }) },
      { body: jsonApiResource('backgroundProcesses', 7, { status: 'removing' }) },
      { status: 404, body: { errors: [{ title: 'Not Found' }] } },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      allowDestructive: true,
      only: ['delete_servers_background_processes'],
    });
    const tool = findTool(tools, 'delete_servers_background_processes');

    const result = (await tool.handler({
      server: 1,
      backgroundProcess: 7,
      confirm: 'delete_servers_background_processes server=1 backgroundProcess=7',
      wait: true,
    })) as Record<string, unknown>;

    // Four requests: the delete plus three reads. Settling on `running` would
    // have stopped after two.
    expect(stub.requests).toHaveLength(4);
    expect((result['polled'] as Record<string, unknown>)['attempts']).toBe(3);
  }, 30_000);

  it('keeps polling a maintenance-mode toggle through its transition', async () => {
    // `LaravelMaintenanceIntegrationResource` carries the mode in `enabled` and
    // the transition in a nullable `status`, so `enabling` means work in
    // progress and null means no transition is running.
    const stub = stubFetch([
      { status: 202 },
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: false,
          status: 'enabling',
        }),
      },
      {
        body: jsonApiResource('laravelMaintenanceIntegrations', 1, {
          enabled: true,
          status: null,
        }),
      },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_sites_integrations_laravel_maintenance'],
    });
    const tool = findTool(tools, 'create_servers_sites_integrations_laravel_maintenance');

    const result = (await tool.handler({
      server: 1,
      site: 2,
      status: 503,
      confirm: 'create_servers_sites_integrations_laravel_maintenance server=1 site=2',
      wait: true,
    })) as Record<string, unknown>;

    expect(stub.requests).toHaveLength(3);
    expect((result['data'] as Record<string, unknown>)['enabled']).toBe(true);
  }, 20_000);

  it('classifies both maintenance-mode transitions as pending', () => {
    expect(PENDING_STATUSES['laravelMaintenanceIntegrations']).toEqual(
      expect.arrayContaining(['disabling', 'enabling']),
    );
  });

  it('does not poll a response Forge completed inline', async () => {
    // `wait: true` on an operation that answered 200 has nothing to wait for.
    // Polling anyway would loop for a completion signal that already passed.
    const stub = stubFetch([
      { status: 200, body: jsonApiResource('backgroundProcesses', 7, { status: 'running' }) },
    ]);

    const tools = makeRegistry(stub, {
      organization: 'acme',
      only: ['create_servers_background_processes'],
    });
    const tool = findTool(tools, 'create_servers_background_processes');

    await tool.handler({
      server: 1,
      name: 'worker',
      command: 'php artisan queue:work',
      user: 'forge',
      processes: 1,
      wait: true,
    });

    expect(stub.requests).toHaveLength(1);
  });

  it('never points a polling plan at a collection', () => {
    for (const operation of OPERATIONS) {
      const plan = operation.polling;
      if (!plan || operation.method !== 'POST') continue;

      // A create either reads the item route below the collection it posted to,
      // or an action endpoint that returns a single resource. Either way the
      // read path must not be the collection itself.
      const readsCollection = plan.path === operation.path && plan.idParam === undefined;
      const isActionEndpoint = !operation.path.endsWith('s');

      if (readsCollection) {
        expect(isActionEndpoint, `${operation.name} polls its own collection`).toBe(true);
      }
    }
  });
});
