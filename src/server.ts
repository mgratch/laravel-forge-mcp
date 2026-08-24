/**
 * MCP server assembly.
 *
 * Wires the Forge client, the generated operation table and the tool factory
 * into a `Server` that speaks the Model Context Protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { ForgeApiError, ForgeConfirmationError, ForgeError } from './client/errors.js';
import { ForgeClient } from './client/http.js';
import type { ServerConfig } from './config.js';
import { FORGE_API_BASE_URL, OPERATIONS } from './generated/operations.js';
import { buildToolRegistry, type RegisteredTool } from './tools/registry.js';
import type { SchemaRegistry } from './tools/schema.js';

/** Package identity reported in the MCP handshake. */
export const SERVER_NAME = 'laravel-forge-mcp';
export const SERVER_VERSION = '0.1.0';

export interface CreateServerOptions {
  readonly config: ServerConfig;
  /** `components.schemas` from the vendored OpenAPI document. */
  readonly schemas: SchemaRegistry;
  /** Injectable client, for tests. */
  readonly client?: ForgeClient;
}

export interface CreatedServer {
  readonly server: Server;
  readonly tools: readonly RegisteredTool[];
  readonly client: ForgeClient;
}

/**
 * Builds the server and registers every permitted tool.
 *
 * The tool list is fixed at construction: `allowDestructive` decides whether
 * destructive operations exist at all, so a client never sees a tool it is not
 * allowed to call.
 */
export function createServer(options: CreateServerOptions): CreatedServer {
  const { config, schemas } = options;

  const client =
    options.client ??
    new ForgeClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || FORGE_API_BASE_URL,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    });

  const tools = buildToolRegistry({
    client,
    operations: OPERATIONS,
    schemas,
    defaultOrganization: config.organization,
    allowDestructive: config.allowDestructive,
  });

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
      annotations: {
        title: tool.title,
        readOnlyHint: tool.descriptor.method === 'GET',
        destructiveHint: tool.descriptor.destructive,
        idempotentHint: ['GET', 'PUT', 'DELETE'].includes(tool.descriptor.method),
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);

    if (!tool) {
      return errorResult(
        `Unknown tool "${request.params.name}". ` +
          (OPERATIONS.some((op) => op.name === request.params.name)
            ? 'That operation is destructive and is only registered when FORGE_MCP_ALLOW_DESTRUCTIVE=1.'
            : 'Call tools/list to see the available tools.'),
      );
    }

    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return errorResult(describeError(error));
    }
  });

  return { server, tools, client };
}

/** MCP reports tool failures in-band, so the model can react and retry. */
function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Renders an error into something a model can act on. */
function describeError(error: unknown): string {
  if (error instanceof ForgeConfirmationError) return error.message;

  if (error instanceof ForgeApiError) {
    const hint = errorHint(error.status);
    return hint === undefined ? error.message : `${error.message}\n\n${hint}`;
  }

  if (error instanceof ForgeError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}

/** Maps documented status codes to the action that usually resolves them. */
function errorHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return 'The API token was rejected. Check FORGE_API_KEY at https://forge.laravel.com/profile/api';
    case 403:
      return 'The token lacks the OAuth scope for this operation, or the organization does not permit it.';
    case 404:
      return 'The resource does not exist, or belongs to a different organization. Verify the organization slug and resource ids with the matching list tool.';
    case 409:
      return 'The resource is in a conflicting state — often another operation is already running on it.';
    case 422:
      return 'Validation failed. The per-field detail above names the offending parameters.';
    case 429:
      return 'Rate limit exceeded. Forge allows 60 requests per minute; the client retries automatically, so repeated failures mean sustained overuse.';
    case 503:
      return 'Forge is in maintenance. Retry shortly.';
    default:
      return undefined;
  }
}
