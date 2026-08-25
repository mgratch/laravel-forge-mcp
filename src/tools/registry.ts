/**
 * Turns generated operation descriptors into registered MCP tools.
 *
 * One descriptor becomes one tool. The factory handles everything common to
 * all of them — path templating, query assembly, body extraction, the
 * confirmation guard, optional polling — so there is no per-endpoint code to
 * drift from the API.
 */

import { createHash } from 'node:crypto';

import type { ForgeClient, ForgeResponse } from '../client/http.js';
import { ForgeApiError, ForgeConfirmationError } from '../client/errors.js';
import { extractSelfLink } from '../client/jsonapi.js';
import { pollUntilTerminal, readStatus, statusSettles } from '../client/polling.js';
import {
  CONFIRMATION_DIGEST_FIELDS,
  DEFAULT_PENDING_STATUSES,
  PENDING_STATUSES,
} from '../generated/operations.js';
import { buildInputSchema, type JsonSchema, type SchemaRegistry } from './schema.js';
import type { OperationDescriptor, PollingPlan } from './types.js';
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
  /** Overrides every operation's polling budget. See `ServerConfig`. */
  readonly pollTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** Injectable sleep and clock, so long-wait tests need no wall-clock time. */
  readonly pollSleep?: (ms: number) => Promise<void>;
  readonly pollNow?: () => number;
}

/** Path parameter carrying the organization slug throughout the API. */
const ORGANIZATION_PARAM = 'organization';

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

  // Body-selected targets and effect-changing fields, declared per operation by
  // the generator. Without these, archiving a server — whose target is in the
  // body, not the path — would have the same phrase for every server.
  const effects = descriptor.confirmationTargetFields
    .map((field) => {
      const value = args[field];
      if (value === undefined || value === null) return undefined;

      // Where the payload is the hazard, bind it by digest: the phrase stays
      // usable and secret-free, but changing one character of the command,
      // script or `.env` invalidates the approval.
      if (DIGEST_FIELDS.has(field)) return `${field}=${digestOf(value)}`;

      return `${field}=${stringifyParam(field, value)}`;
    })
    .filter((part): part is string => part !== undefined);

  const parts = [descriptor.name, ...identifiers, ...effects];
  return parts.join(' ');
}

const DIGEST_FIELDS = new Set(CONFIRMATION_DIGEST_FIELDS);

/**
 * Renders a value as a short, stable SHA-256 prefix.
 *
 * Sixteen hex characters is 64 bits — far beyond any accidental collision
 * between two payloads a caller might confuse, while staying short enough that
 * a human can compare the phrase at a glance. Objects and arrays are hashed
 * over their canonical JSON so key order cannot change the digest.
 */
function digestOf(value: unknown): string {
  const canonical =
    typeof value === 'string' ? value : JSON.stringify(value, Object.keys(value ?? {}).sort());

  return `sha256:${createHash('sha256')
    .update(canonical ?? '', 'utf8')
    .digest('hex')
    .slice(0, 16)}`;
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
              `Confirmation phrase. Must exactly equal "${descriptor.name} <field>=<value> ..." ` +
              `— the tool name, then this operation's target identifiers in the order they are ` +
              `declared. Example: "${buildExampleConfirmation(descriptor, defaultOrganization !== undefined)}". ` +
              (descriptor.confirmationTargetFields.some((field) => DIGEST_FIELDS.has(field))
                ? 'Fields shown as sha256:<digest> are bound by the first 16 hex characters of ' +
                  'the SHA-256 of the value you are sending, so the payload you approve is the ' +
                  'payload that runs. '
                : '') +
              'The tool refuses to run and issues no request without an exact match.',
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
        executeOperation({
          descriptor,
          args,
          client,
          defaultOrganization,
          validator,
          pollTimeoutMs: options.pollTimeoutMs,
          pollIntervalMs: options.pollIntervalMs,
          pollSleep: options.pollSleep,
          pollNow: options.pollNow,
        }),
    });
  }

  return tools;
}

/**
 * Whether `wait` should be advertised for this operation.
 *
 * The generator decides this from the OpenAPI document, emitting a plan naming
 * the read path, the placeholder its created resource's id fills, and whether
 * completion means "status settled" or "resource gone". Inferring any of it
 * from the HTTP method gets it wrong: `DELETE .../deployments/status` resets
 * state on an endpoint that keeps answering, so waiting for a 404 would hang,
 * while an nginx-config PUT reads back file content with no status, which a
 * status poll would call finished on the first read.
 */
function supportsPolling(descriptor: OperationDescriptor): boolean {
  return descriptor.processingMode === 'async' && descriptor.polling !== undefined;
}

/**
 * The statuses that mean "keep polling" for the resource a plan reads.
 *
 * Falls back to the default vocabulary for resources whose status is a
 * free-form string rather than an enum.
 */
function pendingStatusesFor(plan: PollingPlan): ReadonlySet<string> {
  const declared =
    plan.resourceType === undefined ? undefined : PENDING_STATUSES[plan.resourceType];
  return new Set(declared ?? DEFAULT_PENDING_STATUSES);
}

/**
 * Renders a worked example of the confirmation phrase for a tool's description.
 *
 * Generated from the same fields the runtime uses, so the documented format
 * cannot drift from the enforced one — the previous hard-coded example
 * guaranteed a failed first attempt for any agent that followed it.
 */
function buildExampleConfirmation(
  descriptor: OperationDescriptor,
  organizationPinned: boolean,
): string {
  const parts = [descriptor.name];

  for (const param of descriptor.pathParams) {
    if (param.name === ORGANIZATION_PARAM && organizationPinned) continue;
    parts.push(`${param.name}=<${param.name}>`);
  }

  for (const field of descriptor.confirmationTargetFields) {
    // Mirror the digest form, so an agent that copies the example does not
    // learn to send the raw payload and fail its first attempt.
    parts.push(DIGEST_FIELDS.has(field) ? `${field}=sha256:<digest>` : `${field}=<${field}>`);
  }

  return parts.join(' ');
}

/** Composes the description a model reads before choosing a tool. */
function buildDescription(descriptor: OperationDescriptor): string {
  const parts: string[] = [descriptor.description];

  if (descriptor.processingMode === 'async') {
    parts.push(
      supportsPolling(descriptor)
        ? 'This operation is asynchronous: Forge returns 202 Accepted and completes in the ' +
            'background. Pass wait: true to poll until it settles.'
        : 'This operation is asynchronous: Forge returns 202 Accepted and completes in the ' +
            'background. It exposes no route to poll, so re-read the affected resource to ' +
            'observe the result.',
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
  readonly pollTimeoutMs: number | undefined;
  readonly pollIntervalMs: number | undefined;
  readonly pollSleep: ((ms: number) => Promise<void>) | undefined;
  readonly pollNow: (() => number) | undefined;
}

/** Runs one operation: validate guard, build the request, optionally poll. */
async function executeOperation(options: ExecuteOptions): Promise<unknown> {
  const {
    descriptor,
    args,
    client,
    defaultOrganization,
    validator,
    pollTimeoutMs,
    pollIntervalMs,
    pollSleep,
    pollNow,
  } = options;

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
    // Forge uses PUT for two credential regenerations, so retry safety is an
    // operation-level fact rather than a property of the verb.
    idempotent: descriptor.idempotent,
  });

  // Polling only makes sense when Forge deferred the work. A 200 or 204 means
  // it is already done, so there is nothing to wait for — and a poll started
  // against one would loop for a completion signal that already passed.
  const shouldWait =
    supportsPolling(descriptor) && resolvedArgs['wait'] === true && response.accepted;
  if (!shouldWait) {
    return {
      status: response.status,
      accepted: response.accepted,
      data: response.data,
      ...(response.meta === undefined ? {} : { meta: response.meta }),
      // Without these, a caller paying for `include=` never receives the
      // expanded resources the client already parsed.
      ...(response.included === undefined ? {} : { included: response.included }),
      ...(response.links === undefined ? {} : { links: response.links }),
      ...(response.accepted
        ? {
            note: supportsPolling(descriptor)
              ? 'Forge accepted the request and is completing it in the background. ' +
                'Re-read the resource to observe the result, or pass wait: true.'
              : 'Forge accepted the request and is completing it in the background. This ' +
                'operation exposes no route to poll, so use the matching read or list tool to ' +
                'observe the result.',
          }
        : {}),
    };
  }

  // Below here `wait: true` was requested on an operation the generator gave a
  // plan, so the plan is present.
  const plan = descriptor.polling as PollingPlan;

  // Resolve the read path. A `self` link from the response is authoritative;
  // otherwise the plan's template is rendered from the call's own arguments,
  // plus the created resource's id where the template needs one. Forge does not
  // always return a self link — `BackgroundProcessResource` requires only `id`
  // and `type` — so falling back to the id is what makes a create pollable.
  const selfLink = extractSelfLink(response.data);
  let pollPath = selfLink;

  if (pollPath === undefined) {
    const pathArgs: Record<string, unknown> = { ...resolvedArgs };

    if (plan.idParam !== undefined) {
      const createdId = extractResourceId(response.data);
      if (createdId === undefined) {
        return {
          status: response.status,
          accepted: response.accepted,
          data: response.data,
          ...(response.meta === undefined ? {} : { meta: response.meta }),
          ...(response.included === undefined ? {} : { included: response.included }),
          ...(response.links === undefined ? {} : { links: response.links }),
          note:
            'Forge accepted the request but returned neither a self link nor a resource id, so ' +
            'the new resource could not be polled. Read it back from its collection to observe ' +
            'completion.',
        };
      }
      pathArgs[plan.idParam] = createdId;
    }

    pollPath = renderPath(plan.path, pathArgs).path;
  }

  const pending = pendingStatusesFor(plan);
  const settles = statusSettles(pending);

  // A deletion finishes when the resource stops existing, so its final read is
  // a 404. Treating that as an error would report a successful delete as a
  // failure.
  const absence = plan.completion === 'absence';

  const polled = await pollUntilTerminal<ForgeResponse>(
    async () => {
      try {
        return await client.request({ method: 'GET', path: pollPath, query: {} });
      } catch (error) {
        if (absence && error instanceof ForgeApiError && error.status === 404) {
          return {
            status: 404,
            accepted: false,
            data: { status: 'deleted' },
            meta: undefined,
            links: undefined,
            included: undefined,
          };
        }
        throw error;
      }
    },
    {
      // Server provisioning runs an order of magnitude longer than a config
      // change, so the budget is per operation rather than one global default.
      timeoutMs: pollTimeoutMs ?? plan.timeoutMs,
      initialIntervalMs: pollIntervalMs ?? plan.initialIntervalMs,
      maxIntervalMs: Math.max(pollIntervalMs ?? plan.initialIntervalMs, plan.maxIntervalMs),
      ...(pollSleep === undefined ? {} : { sleep: pollSleep }),
      ...(pollNow === undefined ? {} : { now: pollNow }),
      // The status lives on the resource, not on the response envelope.
      readStatus: (value) => readStatus((value as ForgeResponse).data),
      // In absence mode a *missing* status means the resource is still there,
      // which is the opposite of what it means when waiting for one to settle.
      // A resource that reports a settled status will never 404, so that counts
      // as done too and the poll cannot hang on a soft-deleted record.
      isTerminal: buildTerminalPredicate(plan, settles),
    },
  );

  const terminal = polled.value;

  return {
    status: response.status,
    accepted: response.accepted,
    data: terminal.data,
    ...(terminal.meta === undefined ? {} : { meta: terminal.meta }),
    ...(terminal.included === undefined ? {} : { included: terminal.included }),
    ...(terminal.links === undefined ? {} : { links: terminal.links }),
    polled: {
      status: polled.status,
      attempts: polled.attempts,
      elapsedMs: polled.elapsedMs,
      completion: plan.completion,
      path: pollPath,
    },
  };
}

/**
 * Composes the predicate that decides when a poll has settled.
 *
 * The three modes disagree about what any given read means, which is why one
 * predicate cannot serve all of them:
 *
 *   - `status` — the resource's status left its own pending set. No status at
 *     all means there is nothing to wait for, so the first read settles.
 *   - `absence` — only a 404 counts. Everything else means the resource is
 *     still there, *including* an ordinary terminal status: a background
 *     process being deleted answers `running` before it answers `removing`, so
 *     accepting a terminal status here would report a deletion as complete
 *     while the resource still exists. Waiting strictly for the 404 means a
 *     record Forge keeps will time out, which is the honest outcome — a
 *     timeout says "still there", a false success does not.
 *   - `readiness` — `ServerResource` carries no status at all; provisioning is
 *     finished when `is_ready` is true.
 */
function buildTerminalPredicate(
  plan: PollingPlan,
  settles: (status: string | undefined) => boolean,
): (value: ForgeResponse, status: string | undefined) => boolean {
  if (plan.completion === 'absence') return (value) => value.status === 404;

  if (plan.completion === 'readiness') {
    return (value) => readReadiness(value.data) === true;
  }

  // A settled status is not enough on its own for a resource that already
  // existed: its *previous* steady state settles too. The postcondition is what
  // proves this call took effect.
  const { expect } = plan;
  if (expect !== undefined) {
    return (value, status) =>
      settles(status) && readField(value.data, expect.field) === expect.equals;
  }

  return (_value, status) => settles(status);
}

/** Reads one flattened attribute, or undefined when the payload is not a single resource. */
function readField(data: unknown, field: string): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  return (data as Record<string, unknown>)[field];
}

/** Reads the flattened `is_ready` attribute, when the resource has one. */
function readReadiness(data: unknown): boolean | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)['is_ready'];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Reads the `id` of a JSON:API primary resource.
 *
 * A create returns the new resource's identity even when it omits a `self`
 * link, and that id plus the generated read-path template is enough to address
 * it.
 */
function extractResourceId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const id = (data as Record<string, unknown>)['id'];

  if (typeof id === 'string' && id.trim() !== '') return id;
  if (typeof id === 'number') return String(id);

  return undefined;
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
