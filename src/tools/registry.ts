/**
 * Turns generated operation descriptors into registered MCP tools.
 *
 * One descriptor becomes one tool. The factory handles everything common to
 * all of them — path templating, query assembly, body extraction, the
 * confirmation guard, optional polling — so there is no per-endpoint code to
 * drift from the API.
 */

import type { ForgeClient } from '../client/http.js';
import { ForgeConfirmationError } from '../client/errors.js';
import { pollUntilTerminal } from '../client/polling.js';
import { buildInputSchema, type JsonSchema, type SchemaRegistry } from './schema.js';
import type { OperationDescriptor } from './types.js';

/**
 * Renders a path or query value as a string.
 *
 * Path and query parameters are scalars in every Forge operation. Anything else
 * is a caller error, and silently interpolating "[object Object]" into a URL
 * would produce a confusing 404 instead of a clear message.
 */
function stringifyParam(name: string, value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return value.toString();
    default:
      throw new TypeError(
        `Parameter "${name}" must be a string, number or boolean, received ${
          value === null ? 'null' : typeof value
        }.`,
      );
  }
}

/** A tool ready to hand to the MCP server. */
export interface RegisteredTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly descriptor: OperationDescriptor;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface RegistryOptions {
  readonly client: ForgeClient;
  readonly operations: readonly OperationDescriptor[];
  readonly schemas: SchemaRegistry;
  /** Organization slug injected into every path, when configured. */
  readonly defaultOrganization: string | undefined;
  /** When false, destructive operations are not registered at all. */
  readonly allowDestructive: boolean;
}

/** Path parameter carrying the organization slug throughout the API. */
const ORGANIZATION_PARAM = 'organization';

/**
 * Builds the confirmation phrase a guarded tool demands.
 *
 * The phrase names the operation and its target, so a model cannot satisfy the
 * guard with a generic "yes" and cannot confirm one resource while acting on
 * another.
 */
export function buildConfirmationPhrase(
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
): string {
  const identifiers = descriptor.pathParams
    .filter((param) => param.name !== ORGANIZATION_PARAM)
    .map((param) => {
      const value = args[param.name];
      return value === undefined ? undefined : `${param.name}=${stringifyParam(param.name, value)}`;
    })
    .filter((part): part is string => part !== undefined);

  const target = identifiers.length > 0 ? identifiers.join(' ') : descriptor.path;
  return `${descriptor.method} ${target}`;
}

/** Substitutes `{param}` placeholders, URL-encoding each value. */
export function renderPath(
  template: string,
  values: Record<string, unknown>,
): { readonly path: string; readonly consumed: Set<string> } {
  const consumed = new Set<string>();

  const path = template.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = values[name];

    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required path parameter "${name}" for ${template}`);
    }

    consumed.add(name);
    return encodeURIComponent(stringifyParam(name, value));
  });

  return { path, consumed };
}

/**
 * Assembles the tool list.
 *
 * Destructive operations are omitted entirely unless `allowDestructive` is set,
 * so an agent cannot discover a tool it is not permitted to call.
 */
export function buildToolRegistry(options: RegistryOptions): RegisteredTool[] {
  const { client, operations, schemas, defaultOrganization, allowDestructive } = options;

  const tools: RegisteredTool[] = [];

  for (const descriptor of operations) {
    if (descriptor.destructive && !allowDestructive) continue;

    // A pinned organization is injected server-side and hidden from the model.
    const omitParams = new Set<string>();
    if (defaultOrganization !== undefined) omitParams.add(ORGANIZATION_PARAM);

    const supportsWait = descriptor.processingMode === 'async';

    const inputSchema = buildInputSchema({
      pathParams: descriptor.pathParams,
      queryParams: descriptor.queryParams,
      bodySchemaName: descriptor.bodySchema,
      bodyRequired: descriptor.bodyRequired,
      registry: schemas,
      omitParams,
      requiresConfirm: descriptor.requiresConfirm,
      ...(descriptor.requiresConfirm
        ? {
            confirmDescription:
              'Confirmation phrase. Must exactly equal "<METHOD> <param>=<value> ..." naming ' +
              'this operation and its target — for example "DELETE server=12345". The tool ' +
              'refuses to run without it. Call the matching read tool first if you are unsure ' +
              'of the target.',
          }
        : {}),
      supportsWait,
    });

    tools.push({
      name: descriptor.name,
      title: descriptor.summary,
      description: buildDescription(descriptor),
      inputSchema,
      descriptor,
      handler: async (args) => executeOperation({ descriptor, args, client, defaultOrganization }),
    });
  }

  return tools;
}

/** Composes the description a model reads before choosing a tool. */
function buildDescription(descriptor: OperationDescriptor): string {
  const parts: string[] = [descriptor.description];

  if (descriptor.processingMode === 'async') {
    parts.push(
      'This operation is asynchronous: Forge returns 202 Accepted and completes in the ' +
        'background. Pass wait: true to poll until it settles.',
    );
  }

  if (descriptor.destructive) {
    parts.push(
      'DESTRUCTIVE: this permanently removes infrastructure or data and cannot be undone. ' +
        'Requires a matching confirm argument.',
    );
  } else if (descriptor.requiresConfirm) {
    parts.push(
      'HIGH IMPACT: this can interrupt live services. Requires a matching confirm argument.',
    );
  }

  parts.push(`Forge API: ${descriptor.method} ${descriptor.path}`);

  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

interface ExecuteOptions {
  readonly descriptor: OperationDescriptor;
  readonly args: Record<string, unknown>;
  readonly client: ForgeClient;
  readonly defaultOrganization: string | undefined;
}

/** Runs one operation: validate guard, build the request, optionally poll. */
async function executeOperation(options: ExecuteOptions): Promise<unknown> {
  const { descriptor, args, client, defaultOrganization } = options;

  const resolvedArgs: Record<string, unknown> = { ...args };
  if (defaultOrganization !== undefined && resolvedArgs[ORGANIZATION_PARAM] === undefined) {
    resolvedArgs[ORGANIZATION_PARAM] = defaultOrganization;
  }

  if (descriptor.requiresConfirm) {
    const expected = buildConfirmationPhrase(descriptor, resolvedArgs);
    const received = resolvedArgs['confirm'];
    const receivedString = typeof received === 'string' ? received : undefined;

    if (receivedString?.trim() !== expected) {
      throw new ForgeConfirmationError(descriptor.name, expected, receivedString);
    }
  }

  const { path, consumed } = renderPath(descriptor.path, resolvedArgs);

  const query: Record<string, string | number | boolean | undefined> = {};
  for (const param of descriptor.queryParams) {
    const value = resolvedArgs[param.name];
    if (value === undefined || value === null) continue;
    query[param.name] = value as string | number | boolean;
    consumed.add(param.name);
  }

  const body = extractBody(descriptor, resolvedArgs, consumed);

  const response = await client.request({
    method: descriptor.method,
    path,
    query,
    ...(body === undefined ? {} : { body }),
  });

  const shouldWait = descriptor.processingMode === 'async' && resolvedArgs['wait'] === true;
  if (!shouldWait) {
    return {
      status: response.status,
      accepted: response.accepted,
      data: response.data,
      ...(response.meta === undefined ? {} : { meta: response.meta }),
      ...(response.accepted
        ? {
            note:
              'Forge accepted the request and is completing it in the background. ' +
              'Re-read the resource to observe the result, or pass wait: true.',
          }
        : {}),
    };
  }

  // Poll the collection/resource the operation acted on. For a write, that is
  // the same path with the write verb swapped for GET.
  const polled = await pollUntilTerminal(async () => {
    const read = await client.request({ method: 'GET', path, query: {} });
    return read.data;
  });

  return {
    status: response.status,
    accepted: response.accepted,
    data: polled.value,
    polled: {
      status: polled.status,
      attempts: polled.attempts,
      elapsedMs: polled.elapsedMs,
    },
  };
}

/**
 * Pulls the request body out of the flattened argument object.
 *
 * `buildInputSchema` either lifts body properties to the top level or nests
 * them under `body` when a name would collide with a path/query parameter, so
 * both shapes are accepted here.
 */
function extractBody(
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
  consumed: ReadonlySet<string>,
): unknown {
  if (descriptor.bodySchema === undefined) return undefined;

  const nested = args['body'];
  if (nested !== undefined) return nested;

  const body: Record<string, unknown> = {};
  const reserved = new Set([...consumed, 'confirm', 'wait', 'body']);

  for (const [key, value] of Object.entries(args)) {
    if (reserved.has(key)) continue;
    if (value === undefined) continue;
    body[key] = value;
  }

  if (Object.keys(body).length === 0) {
    // A required-but-empty body is still sent, because some Forge endpoints
    // expect `{}` rather than no body at all.
    return descriptor.bodyRequired ? {} : undefined;
  }

  return body;
}
