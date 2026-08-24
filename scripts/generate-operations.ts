/**
 * Generates `src/generated/operations.ts` from the vendored Laravel Forge
 * OpenAPI document.
 *
 * Every MCP tool this server exposes is derived from one OpenAPI operation, so
 * the tool surface cannot drift from the API: re-running `npm run generate`
 * against a newer spec is the only way tools change. Nothing here is written by
 * hand except the small override tables below, which exist because two things
 * are genuinely not derivable from the document:
 *
 *   1. Which operations are destructive. The spec has no such marker, and
 *      "DELETE" alone is a bad proxy — `DELETE .../deployments/status` merely
 *      clears a stuck deployment flag, while `DELETE .../servers/{server}`
 *      destroys a machine.
 *   2. Readable tool names. `operationId` is dot-delimited Laravel route naming
 *      ("organizations.servers.background-processes.index") which makes poor
 *      tool names, so we derive a snake_case name and verify uniqueness.
 *
 * Run: npm run generate
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(HERE, '../spec/forge.openapi.json');
const OUT_PATH = resolve(HERE, '../src/generated/operations.ts');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Operations that destroy infrastructure or irreversibly remove data.
 *
 * Membership is decided by consequence, not by HTTP verb. Anything listed here
 * is registered only when `FORGE_MCP_ALLOW_DESTRUCTIVE=1`, and always requires
 * a `confirm` argument that echoes the exact target.
 *
 * Keyed by `operationId` so a path change in the spec surfaces as a build-time
 * "unknown operationId" error rather than silently un-guarding a tool.
 */
const DESTRUCTIVE_OPERATION_IDS = new Set<string>([
  // Servers — destroys or detaches a machine.
  'organizations.servers.destroy',
  'organizations.servers.archives.destroy',
  // Sites — removes the site and its files.
  'organizations.servers.sites.destroy',
  // Databases and database users — irreversible data loss.
  'organizations.servers.database.schemas.destroy',
  'organizations.servers.database.users.destroy',
  // Backups — removes recovery points, and a restore overwrites a live database.
  'organizations.servers.database.backups.destroy',
  'organizations.servers.database.backups.instances.destroy',
  'organizations.servers.database.backups.instances.restores.store',
  // Teams and roles — account-level structural change.
  'organizations.teams.destroy',
  'organizations.roles.destroy',
  'organizations.teams.members.destroy',
  'organizations.teams.servers.destroy',
  'organizations.teams.server-credentials.destroy',
  // Keys and providers — can lock Forge out of a server or a provider.
  'organizations.servers.ssh-keys.destroy',
  'organizations.storage-providers.destroy',
  // PHP — uninstalling a version breaks every site bound to it.
  'organizations.servers.php.versions.destroy',
  // Deploy key removal breaks future deployments for the site.
  'organizations.servers.sites.deploy-key.destroy',
]);

/**
 * Operations whose effect is severe enough to warrant confirmation even though
 * they are not deletions. Stopping nginx is the clearest case: the API exposes
 * `stop` but has no `start`, so an agent can take a site down with no
 * documented way to bring it back.
 *
 * @see https://forge.laravel.com/docs/api-reference/introduction
 */
const CONFIRM_REQUIRED_OPERATION_IDS = new Set<string>([
  'organizations.servers.actions.store', // reboot / power-cycle the server
  'organizations.servers.services.nginx.actions.store',
  'organizations.servers.services.mysql.actions.store',
  'organizations.servers.services.postgres.actions.store',
  'organizations.servers.services.redis.actions.store',
  'organizations.servers.services.supervisor.actions.store',
  'organizations.servers.services.php.actions.store',
]);

/**
 * Laravel resource-route suffix -> verb used in the generated tool name.
 * Anything not listed keeps its own final segment (e.g. `.log.show`).
 */
const ACTION_VERBS: Record<string, string> = {
  index: 'list',
  show: 'get',
  store: 'create',
  update: 'update',
  destroy: 'delete',
};

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  responses?: Record<string, unknown>;
  'x-processingMode'?: 'sync' | 'async';
}

interface OpenApiDocument {
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

/** Strips the Mintlify "Processing mode: <small><code>sync</code></small>" footer. */
function cleanDescription(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/Processing mode:\s*<small><code>\w+<\/code><\/small>/gi, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSnakeCase(input: string): string {
  return input
    .replace(/[-.]/g, '_')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Derives a readable, unique snake_case tool name from an operationId.
 *
 * "organizations.servers.background-processes.index"
 *   -> drop the leading "organizations" (the org is resolved once at startup)
 *   -> trailing "index" becomes the leading verb "list"
 *   -> "list_servers_background_processes"
 */
function deriveToolName(operationId: string): string {
  const segments = operationId.split('.');
  if (segments[0] === 'organizations') segments.shift();

  const last = segments[segments.length - 1] ?? '';
  const verb = ACTION_VERBS[last];

  if (verb) {
    const subject = segments.slice(0, -1).join('_');
    return toSnakeCase(`${verb}_${subject}`);
  }

  // Non-resource routes ("...log.show", "...deploy-key.store") keep their shape
  // but still lead with a verb when the final segment is a known action.
  const secondLast = segments[segments.length - 2];
  const trailingVerb = secondLast ? ACTION_VERBS[last] : undefined;
  if (trailingVerb) {
    return toSnakeCase(`${trailingVerb}_${segments.slice(0, -1).join('_')}`);
  }

  return toSnakeCase(segments.join('_'));
}

function main(): void {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;
  const baseUrl = spec.servers?.[0]?.url ?? 'https://forge.laravel.com/api';

  const descriptors: string[] = [];
  const seenNames = new Map<string, string>();
  const seenOperationIds = new Set<string>();
  let destructiveCount = 0;
  let confirmCount = 0;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const operationId = operation.operationId;
      if (!operationId) {
        throw new Error(`Missing operationId for ${method.toUpperCase()} ${path}`);
      }
      seenOperationIds.add(operationId);

      let name = deriveToolName(operationId);
      const collision = seenNames.get(name);
      if (collision) {
        // Disambiguate deterministically rather than silently overwriting.
        name = toSnakeCase(operationId.replace(/^organizations\./, ''));
        if (seenNames.has(name)) {
          throw new Error(
            `Tool name collision that could not be resolved: "${name}" ` +
              `(${operationId} vs ${collision})`,
          );
        }
      }
      seenNames.set(name, operationId);

      const parameters = operation.parameters ?? [];
      const pathParams = parameters.filter((p) => p.in === 'path');
      const queryParams = parameters.filter((p) => p.in === 'query');

      const bodySchemaRef =
        operation.requestBody?.content?.['application/json']?.schema?.$ref ?? undefined;
      const bodySchemaName = bodySchemaRef?.replace('#/components/schemas/', '');

      const isDestructive = DESTRUCTIVE_OPERATION_IDS.has(operationId);
      const requiresConfirm = isDestructive || CONFIRM_REQUIRED_OPERATION_IDS.has(operationId);
      if (isDestructive) destructiveCount += 1;
      if (requiresConfirm) confirmCount += 1;

      const summary = operation.summary ?? operationId;
      const description = cleanDescription(operation.description) || summary;

      descriptors.push(
        [
          '  {',
          `    name: ${JSON.stringify(name)},`,
          `    operationId: ${JSON.stringify(operationId)},`,
          `    method: ${JSON.stringify(method.toUpperCase())},`,
          `    path: ${JSON.stringify(path)},`,
          `    tag: ${JSON.stringify(operation.tags?.[0] ?? 'Other')},`,
          `    summary: ${JSON.stringify(summary)},`,
          `    description: ${JSON.stringify(description)},`,
          `    processingMode: ${JSON.stringify(operation['x-processingMode'] ?? 'sync')},`,
          `    pathParams: ${JSON.stringify(
            pathParams.map((p) => ({
              name: p.name,
              required: p.required ?? true,
              description: cleanDescription(p.description),
              schema: p.schema ?? {},
            })),
          )},`,
          `    queryParams: ${JSON.stringify(
            queryParams.map((p) => ({
              name: p.name,
              required: p.required ?? false,
              description: cleanDescription(p.description),
              schema: p.schema ?? {},
            })),
          )},`,
          `    bodySchema: ${bodySchemaName ? JSON.stringify(bodySchemaName) : 'undefined'},`,
          `    bodyRequired: ${Boolean(operation.requestBody?.required)},`,
          `    destructive: ${isDestructive},`,
          `    requiresConfirm: ${requiresConfirm},`,
          '  },',
        ].join('\n'),
      );
    }
  }

  // Fail loudly if an override no longer matches the spec, rather than quietly
  // shipping an unguarded destructive tool.
  for (const id of [...DESTRUCTIVE_OPERATION_IDS, ...CONFIRM_REQUIRED_OPERATION_IDS]) {
    if (!seenOperationIds.has(id)) {
      throw new Error(
        `Override references unknown operationId "${id}". ` +
          'The Forge spec changed — re-check the guard tables in scripts/generate-operations.ts.',
      );
    }
  }

  const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by \`npm run generate\` from spec/forge.openapi.json
 * (${spec.info.title} ${spec.info.version}, OpenAPI 3.1.0).
 *
 * Source of truth: https://forge.laravel.com/api/docs.openapi
 * Human documentation: https://forge.laravel.com/docs/api-reference/introduction
 *
 * ${descriptors.length} operations · ${destructiveCount} destructive · ${confirmCount} confirmation-gated
 */

import type { OperationDescriptor } from '../tools/types.js';

/** Base URL declared by the OpenAPI document. */
export const FORGE_API_BASE_URL = ${JSON.stringify(baseUrl)};

/** Every operation in the Forge API, in document order. */
export const OPERATIONS: readonly OperationDescriptor[] = [
`;

  writeFileSync(OUT_PATH, `${header}${descriptors.join('\n')}\n] as const;\n`, 'utf8');

  process.stdout.write(
    `Generated ${descriptors.length} operations ` +
      `(${destructiveCount} destructive, ${confirmCount} confirmation-gated) -> ${OUT_PATH}\n`,
  );
}

main();
