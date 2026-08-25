/**
 * End-to-end protocol tests.
 *
 * These drive the server through a real MCP client over an in-memory transport,
 * so they exercise the same code path a Claude Desktop or Claude Code client
 * takes: `tools/list`, `tools/call`, and the error envelope.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ForgeClient } from '../src/client/http.js';
import { RateLimiter } from '../src/client/rate-limit.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { instantSleep, jsonApiCollection, loadSpecSchemas, stubFetch } from './helpers.js';

const schemas = loadSpecSchemas();

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function connect(options: {
  responses?: Parameters<typeof stubFetch>[0];
  allowDestructive?: boolean;
}): Promise<{ client: Client; stub: ReturnType<typeof stubFetch> }> {
  const stub = stubFetch(options.responses ?? []);

  const forgeClient = new ForgeClient({
    apiKey: 'token',
    fetch: stub.fetch,
    sleep: instantSleep,
    rateLimiter: new RateLimiter({ sleep: instantSleep }),
  });

  const config = {
    ...loadConfig({ FORGE_API_KEY: 'token', FORGE_ORGANIZATION: 'acme' }),
    allowDestructive: options.allowDestructive ?? false,
  };

  const { server } = createServer({ config, schemas, client: forgeClient });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  openClients.push(client);

  return { client, stub };
}

describe('tools/list', () => {
  it('advertises the tool surface', async () => {
    const { client } = await connect({});
    const result = await client.listTools();

    expect(result.tools.length).toBeGreaterThan(200);
  });

  it('gives every tool a description and an object input schema', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('hides destructive tools unless they are enabled', async () => {
    const guarded = await connect({});
    const guardedTools = await guarded.client.listTools();
    expect(guardedTools.tools.some((tool) => tool.name === 'delete_servers')).toBe(false);

    const full = await connect({ allowDestructive: true });
    const fullTools = await full.client.listTools();
    expect(fullTools.tools.some((tool) => tool.name === 'delete_servers')).toBe(true);
  });

  it('marks read-only tools with the readOnly hint', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();

    const listServers = tools.find((tool) => tool.name === 'list_servers');
    expect(listServers?.annotations?.readOnlyHint).toBe(true);
  });

  it('marks destructive tools with the destructive hint', async () => {
    const { client } = await connect({ allowDestructive: true });
    const { tools } = await client.listTools();

    const deleteServer = tools.find((tool) => tool.name === 'delete_servers');
    expect(deleteServer?.annotations?.destructiveHint).toBe(true);
  });
});

describe('tools/call', () => {
  it('returns the flattened resource for a successful read', async () => {
    const { client } = await connect({
      responses: [
        {
          body: jsonApiCollection('servers', [
            { id: 1, attributes: { name: 'web-1', region: 'nyc3' } },
          ]),
        },
      ],
    });

    const result = await client.callTool({ name: 'list_servers', arguments: {} });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('web-1');
  });

  it('reports a Forge API error in-band with a remediation hint', async () => {
    const { client } = await connect({
      responses: [{ status: 401, body: { message: 'Unauthenticated.' } }],
    });

    const result = await client.callTool({ name: 'list_servers', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('401');
    expect(text).toContain('forge.laravel.com/profile/api');
  });

  it('explains that a hidden destructive tool needs the env flag', async () => {
    const { client } = await connect({});

    const result = await client.callTool({ name: 'delete_servers', arguments: { server: 1 } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('FORGE_MCP_ALLOW_DESTRUCTIVE');
  });

  it('rejects an entirely unknown tool', async () => {
    const { client } = await connect({});

    const result = await client.callTool({ name: 'not_a_real_tool', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('tools/list');
  });

  it('refuses a guarded call without confirmation, and issues no request', async () => {
    const { client, stub } = await connect({ allowDestructive: true });

    const result = await client.callTool({
      name: 'delete_servers',
      arguments: { server: 12345 },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('delete_servers server=12345');
    expect(stub.requests).toHaveLength(0);
  });

  it('performs a guarded call when the confirmation matches', async () => {
    const { client, stub } = await connect({
      allowDestructive: true,
      responses: [{ status: 202 }],
    });

    const result = await client.callTool({
      name: 'delete_servers',
      arguments: { server: 12345, confirm: 'delete_servers server=12345' },
    });

    expect(result.isError).toBeFalsy();
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe('DELETE');
  });

  it('rejects an argument the tool never advertised, without issuing a request', async () => {
    // The MCP protocol validates the envelope, not `arguments`. Without runtime
    // validation, `additionalProperties: false` would be advisory and a raw
    // client could smuggle a field straight into the request body.
    const { client, stub } = await connect({});

    const result = await client.callTool({
      name: 'list_servers',
      arguments: { not_a_real_argument: 'smuggled' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('not_a_real_argument');
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects a required argument of the wrong type, without issuing a request', async () => {
    const { client, stub } = await connect({});

    const result = await client.callTool({
      name: 'get_servers',
      arguments: { server: { nested: 'object' } },
    });

    expect(result.isError).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });

  it('maps a 429 to rate-limit guidance', async () => {
    const { client } = await connect({
      responses: [
        { status: 429, body: { message: 'Too many attempts.' } },
        { status: 429, body: { message: 'Too many attempts.' } },
        { status: 429, body: { message: 'Too many attempts.' } },
        { status: 429, body: { message: 'Too many attempts.' } },
      ],
    });

    const result = await client.callTool({ name: 'list_servers', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('60 requests per minute');
  });

  it('maps a 422 to validation guidance', async () => {
    const { client } = await connect({
      responses: [{ status: 422, body: { message: 'Invalid.', errors: { name: ['required'] } } }],
    });

    const result = await client.callTool({ name: 'list_servers', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

    expect(text).toContain('Validation failed');
    expect(text).toContain('name: required');
  });
});
