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
import { extractSelfLink } from '../client/jsonapi.js';
import { pollUntilTerminal } from '../client/polling.js';
import { buildInputSchema, type JsonSchema, type SchemaRegistry } from './schema.js';
import type { OperationDescriptor } from './types.js';
import { ArgumentValidator } from './validate.js';

/**
 * Renders a path or query value as a string.
 *
 * Path and query parameters are scalars in every Forge operation. Anything else
 * is a caller error, and silently interpolating "[object Object]" into a URL
 * would produce a confusing 404 instead of a clear message.
 */
function stringifyParam(name: string, value: unknown): string {
  // `sort` and `include` are declared as arrays in the OpenAPI document and are
  // serialised comma-separated (OpenAPI `style: form`, `explode: false`), which
  // is what Forge's filtering and relationship docs describe.
  //
  // @see https://forge.laravel.com/docs/api-reference/filtering
  // @see https://forge.laravel.com/docs/api-reference/relationships
  if (Array.isArray(value)) {
    return value.map((entry, index) => stringifyParam(`${name}[${index}]`, entry)).join(',');
  }

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
        `Parameter "${name}" must be a string, number, boolean or an array of those, received ${
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
  /** Injectable validator, for tests. */
  readonly validator?: ArgumentValidator;
}

/** Path parameter carrying the organization slug throughout the API. */
const ORGANIZATION_PARAM = 'organization';

/**
 * Body fields that change *what a guarded operation does*, not merely its
 * inputs, and therefore belong in the confirmation phrase.
 *
 * `action` is the clearest case: one route serves both "reboot nginx" and "stop
 * nginx", so a phrase omitting it lets a confirmation for the recoverable
 * variant authorise the one with no documented way back.
 */
const EFFECT_FIELDS = ['action', 'preserve_at_provider', 'version'] as const;

/**
 * Builds the confirmation phrase a guarded tool demands.
 *
 * The phrase must identify the operation **and** everything about its effect
 * that the caller could vary, so that a confirmation cannot be replayed against
 * a different call. Three things go into it:
 *
 *  1. **The tool name.** Path shape alone is ambiguous: seven guarded routes
 *     share `POST /orgs/{org}/servers/{server}/...`, so a phrase built only from
 *     the method and ids would let a confirmation for an nginx reboot authorise
 *     a whole-server power-cycle.
 *  2. **The target ids**, so one resource's confirmation cannot act on another.
 *     The organization is included unless the operator pinned one — Forge ids
 *     are scoped per organization, so without it the same id in another
 *     organization would match.
 *  3. **Effect-changing fields** such as `action`, so "reboot" and "stop" are
 *     not interchangeable.
 *
 * @param organizationPinned Whether the server injects the organization itself.
 */
export function buildConfirmationPhrase(
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
  organizationPinned = false,
): string {
  const identifiers = descriptor.pathParams
    .filter((param) => !(param.name === ORGANIZATION_PARAM && organizationPinned))
    .map((param) => {
      const value = args[param.name];
      return value === undefined ? undefined : `${param.name}=${stringifyParam(param.name, value)}`;
    })
    .filter((part): part is string => part !== undefined);

  const effects = EFFECT_FIELDS.map((field) => {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    return `${field}=${stringifyParam(field, value)}`;
  }).filter((part): part is string => part !== undefined);

  const parts = [descriptor.name, ...identifiers, ...effects];
  return parts.join(' ');
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

  const validator = options.validator ?? new ArgumentValidator();
  const tools: RegisteredTool[] = [];

  for (const descriptor of operations) {
    if (descriptor.destructive && !allowDestructive) continue;

    // A pinned organization is injected server-side and hidden from the model.
    const omitParams = new Set<string>();
    if (defaultOrganization !== undefined) omitParams.add(ORGANIZATION_PARAM);

    const supportsWait = supportsPolling(descriptor);

    const inputSchema = buildInputSchema({
      pathParams: descriptor.pathParams,
      queryParams: descriptor.queryParams,
      bodySchemaName: descriptor.bodySchema,
      bodySchemaInline: descriptor.bodySchemaInline,
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

    validator.register(descriptor.name, inputSchema);

    tools.push({
      name: descriptor.name,
      title: descriptor.summary,
      description: buildDescription(descriptor),
      inputSchema,
      descriptor,
      handler: async (args) =>
        executeOperation({ descriptor, args, client, defaultOrganization, validator }),
    });
  }

  return tools;
}

/**
 * Whether an asynchronous operation has a completion state worth polling.
 *
 * Polling only means something when there is a resource to re-read that reports
 * a status. Three shapes have none, and offering `wait` for them would be a lie:
 *
 *  - **Creates** answer on a collection URL. Re-reading it returns a list, which
 *    has no status and would be treated as instantly terminal. The created
 *    resource's own URL is only knowable from the response, so `wait` is offered
 *    only when the API returns a `self` link, checked at call time.
 *  - **Action routes** (`.../actions`) accept POST but have no GET, so there is
 *    nothing to poll.
 *  - **Deletions** complete by the resource ceasing to exist. That is handled
 *    explicitly rather than by polling for a status that will never appear.
 *
 * Updates to an addressable resource — the common case, such as writing an
 * nginx config — are the shape where polling genuinely works.
 */
function supportsPolling(descriptor: OperationDescriptor): boolean {
  if (descriptor.processingMode !== 'async') return false;
  if (descriptor.path.endsWith('/actions')) return false;

  // A PUT/PATCH addresses the resource it modifies, so the same URL can be read
  // back. DELETE is handled by absence, and POST is handled via the self link.
  return descriptor.method === 'PUT' || descriptor.method === 'PATCH';
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
  readonly validator: ArgumentValidator;
}

/** Runs one operation: validate guard, build the request, optionally poll. */
async function executeOperation(options: ExecuteOptions): Promise<unknown> {
  const { descriptor, args, client, defaultOrganization, validator } = options;

  // Enforce the advertised schema before anything else. Without this the schema
  // is advisory and a raw client could smuggle a field the tool never exposed.
  //
  // A missing `confirm` is deliberately excused here so the confirmation guard
  // below can report the exact phrase required, which is far more useful than
  // "missing required argument".
  validator.assertValid(descriptor.name, args, descriptor.requiresConfirm ? ['confirm'] : []);

  const resolvedArgs: Record<string, unknown> = { ...args };

  // A pinned organization is server-controlled, not a default. Letting a caller
  // override it would allow a cross-organization call — and, because the pinned
  // value is omitted from the confirmation phrase, one that was never named in
  // the confirmation.
  if (defaultOrganization !== undefined) {
    resolvedArgs[ORGANIZATION_PARAM] = defaultOrganization;
  }

  if (descriptor.requiresConfirm) {
    const expected = buildConfirmationPhrase(
      descriptor,
      resolvedArgs,
      defaultOrganization !== undefined,
    );
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
    // Validated rather than cast: an object here would otherwise serialise as
    // "[object Object]" and silently produce a wrong query, which surfaces as a
    // confusing empty result instead of an error.
    query[param.name] = stringifyParam(param.name, value);
    consumed.add(param.name);
  }

  const body = extractBody(descriptor, resolvedArgs, consumed);

  const response = await client.request({
    method: descriptor.method,
    path,
    query,
    ...(body === undefined ? {} : { body }),
  });

  const shouldWait = supportsPolling(descriptor) && resolvedArgs['wait'] === true;
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

  // Poll the resource's own URL. `self` from the response is authoritative;
  // for a PUT/PATCH the request path already addresses the resource, so it is a
  // sound fallback.
  const selfLink = extractSelfLink(response.data);
  const pollPath = selfLink ?? path;

  const polled = await pollUntilTerminal(async () => {
    const read = await client.request({ method: 'GET', path: pollPath, query: {} });
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
  if (descriptor.bodySchema === undefined && descriptor.bodySchemaInline === undefined) {
    return undefined;
  }

  const nested = args['body'];
  if (nested !== undefined) return nested;

  const body: Record<string, unknown> = {};
  const reserved = new Set([...consumed, 'confirm', 'wait', 'body']);

  for (const [key, value] of Object.entries(args)) {
    if (reserved.has(key)) continue;
    if (value === undefined) continue;
    // Assigning "__proto__" through bracket notation mutates the object's
    // prototype rather than adding a field. No Forge schema uses these names.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    Object.defineProperty(body, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  if (Object.keys(body).length === 0) {
    // A required-but-empty body is still sent, because some Forge endpoints
    // expect `{}` rather than no body at all.
    return descriptor.bodyRequired ? {} : undefined;
  }

  return body;
}
