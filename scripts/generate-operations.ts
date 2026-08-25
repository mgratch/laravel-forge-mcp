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
/**
 * Path to the OpenAPI document. Overridable so tests can drive the generator
 * against a mutated spec and assert that it fails closed.
 */
const SPEC_PATH = process.env['FORGE_SPEC_PATH'] ?? resolve(HERE, '../spec/forge.openapi.json');
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
  // Archiving detaches a server from Forge; the spec calls it "Archive a
  // server". The DELETE on this collection is the RECOVERY direction
  // ("Unarchive a server"), so it is deliberately not listed here — see
  // REVIEWED_SAFE_MUTATION_OPERATION_IDS.
  'organizations.servers.archives.store',
  // Sites — removes the site and its files.
  'organizations.servers.sites.destroy',
  // Databases and database users — irreversible data loss.
  'organizations.servers.database.schemas.destroy',
  'organizations.servers.database.users.destroy',
  // Backups — removes recovery points, and a restore overwrites a live database.
  'organizations.servers.database.backups.destroy',
  'organizations.servers.database.backups.instances.destroy',
  'organizations.servers.database.backups.instances.restores.store',
  // Teams, roles and access — account-level structural change. The acceptance
  // criteria classify team mutation as destructive, so the whole surface lives
  // here rather than being split across confirmation-gated entries.
  'organizations.teams.store',
  'organizations.teams.update',
  'organizations.teams.destroy',
  'organizations.roles.store',
  'organizations.roles.destroy',
  'organizations.teams.invites.store',
  'organizations.teams.members.update',
  'organizations.teams.servers.store',
  'organizations.teams.server-credentials.store',
  'organizations.teams.recipes.store',
  'organizations.teams.invites.destroy',
  'organizations.teams.recipes.destroy',
  'organizations.roles.update',
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
  // Server and service lifecycle — can interrupt everything on the box.
  'organizations.servers.actions.store', // reboot / power-cycle the server
  'organizations.servers.services.nginx.actions.store',
  'organizations.servers.services.mysql.actions.store',
  'organizations.servers.services.postgres.actions.store',
  'organizations.servers.services.redis.actions.store',
  'organizations.servers.services.supervisor.actions.store',
  'organizations.servers.services.php.actions.store',

  // Removing these is recoverable, but the gap is an outage: queue workers stop
  // consuming, scheduled work stops running, TLS or routing breaks, or an
  // access control disappears. "Recreatable" is not the same as "safe".
  'organizations.servers.background-processes.destroy',
  'organizations.servers.background-processes.actions.store',
  'organizations.servers.scheduled-jobs.destroy',
  'organizations.servers.sites.scheduled-jobs.destroy',
  'organizations.servers.firewall-rules.destroy',
  'organizations.servers.sites.security-rules.destroy',
  'organizations.servers.sites.redirect-rules.destroy',
  'organizations.servers.sites.domains.destroy',
  'organizations.servers.sites.domains.certificates.destroy',
  'organizations.servers.sites.domains.certificates.actions.store',
  'organizations.servers.sites.domains.actions.store',
  'organizations.servers.sites.integrations.horizon.destroy',
  'organizations.servers.sites.integrations.octane.destroy',
  'organizations.servers.sites.integrations.reverb.destroy',
  'organizations.servers.sites.integrations.pulse.destroy',
  'organizations.servers.sites.integrations.laravel-scheduler.destroy',
  'organizations.servers.sites.integrations.laravel-maintenance.store',
  'organizations.servers.sites.deployments.push-to-deploy.destroy',
  'organizations.servers.nginx.templates.destroy',
  'organizations.servers.php.opcache.destroy',

  // Recovery direction for an archived server: reconnects it to Forge. Not
  // destructive, but consequential enough to confirm.
  'organizations.servers.archives.destroy',

  // Live nginx configuration. The API has no `nginx -t` equivalent, so a bad
  // write returns 202 and can take the site down with no validation step and no
  // documented way back short of restoring the previous content by hand.
  'organizations.servers.sites.nginx.update',
  'organizations.servers.sites.domains.nginx.update',
  'organizations.servers.php.versions.configs.fpm.update',
  'organizations.servers.php.versions.configs.pool.update',
  'organizations.servers.php.versions.configs.cli.update',

  // Team and access mutation — changes who can reach the infrastructure.
]);

/**
 * Mutating operations reviewed and deliberately left unguarded.
 *
 * This list is what makes the safety classification **fail closed**. Without
 * it, a destructive operation added to a future version of the Forge spec would
 * appear in no guard table and ship as an ordinary tool — failing open, in the
 * direction that costs someone their infrastructure.
 *
 * Generation therefore refuses to run when any non-read operation (POST, PUT,
 * PATCH, DELETE) appears in none of the three lists, forcing a human to decide
 * where it belongs. Restricting that check to DELETE would miss exactly the
 * operations that hurt most: a restore, a team mutation, or a service action is
 * a POST.
 *
 * Everything here creates or removes something recreatable whose absence does
 * not interrupt a running service.
 */
const REVIEWED_SAFE_MUTATION_OPERATION_IDS = new Set<string>([
  'forge-recipes.runs.store',
  'organization.recipes.store',
  'organizations.recipes.destroy',
  'organizations.recipes.runs.store',
  'organizations.recipes.update',
  'organizations.server-credentials.vpcs.store',
  'organizations.servers.background-processes.store',
  'organizations.servers.background-processes.update',
  'organizations.servers.database.backups.instances.store',
  'organizations.servers.database.backups.store',
  'organizations.servers.database.backups.update',
  'organizations.servers.database.password.update',
  'organizations.servers.database.schemas.store',
  'organizations.servers.database.schemas.synchronizations.store',
  'organizations.servers.database.users.store',
  'organizations.servers.database.users.update',
  'organizations.servers.firewall-rules.store',
  'organizations.servers.key.update',
  'organizations.servers.logs.destroy',
  'organizations.servers.monitors.destroy',
  'organizations.servers.monitors.store',
  'organizations.servers.network.update',
  'organizations.servers.nginx.templates.store',
  'organizations.servers.nginx.templates.update',
  'organizations.servers.php.cli-version.update',
  'organizations.servers.php.max-execution-time.update',
  'organizations.servers.php.max-upload-size.update',
  'organizations.servers.php.opcache.store',
  'organizations.servers.php.site-version.update',
  'organizations.servers.php.versions.store',
  'organizations.servers.php.versions.update',
  'organizations.servers.scheduled-jobs.store',
  'organizations.servers.sites.commands.destroy',
  'organizations.servers.sites.commands.store',
  'organizations.servers.sites.composer.credentials.destroy',
  'organizations.servers.sites.composer.credentials.store',
  'organizations.servers.sites.composer.credentials.update',
  'organizations.servers.sites.deploy-key.store',
  'organizations.servers.sites.deployments.deploy-hook.update',
  'organizations.servers.sites.deployments.push-to-deploy.store',
  'organizations.servers.sites.deployments.script.update',
  'organizations.servers.sites.deployments.status.destroy',
  'organizations.servers.sites.deployments.store',
  'organizations.servers.sites.domains.certificates.store',
  'organizations.servers.sites.domains.store',
  'organizations.servers.sites.domains.update',
  'organizations.servers.sites.environment.update',
  'organizations.servers.sites.healthcheck.update',
  'organizations.servers.sites.heartbeats.destroy',
  'organizations.servers.sites.heartbeats.store',
  'organizations.servers.sites.heartbeats.update',
  'organizations.servers.sites.integrations.horizon.store',
  'organizations.servers.sites.integrations.inertia.store',
  'organizations.servers.sites.integrations.laravel-maintenance.destroy',
  'organizations.servers.sites.integrations.laravel-scheduler.store',
  'organizations.servers.sites.integrations.octane.store',
  'organizations.servers.sites.integrations.pulse.store',
  'organizations.servers.sites.integrations.reverb.store',
  'organizations.servers.sites.load-balancing-nodes.update',
  'organizations.servers.sites.logs.application.destroy',
  'organizations.servers.sites.logs.nginx-access.destroy',
  'organizations.servers.sites.logs.nginx-error.destroy',
  'organizations.servers.sites.npm.credentials.destroy',
  'organizations.servers.sites.npm.credentials.store',
  'organizations.servers.sites.npm.credentials.update',
  'organizations.servers.sites.redirect-rules.store',
  'organizations.servers.sites.scheduled-jobs.store',
  'organizations.servers.sites.security-rules.store',
  'organizations.servers.sites.security-rules.update',
  'organizations.servers.sites.store',
  'organizations.servers.sites.storeOnBalancer',
  'organizations.servers.sites.update',
  'organizations.servers.sites.webhooks.destroy',
  'organizations.servers.sites.webhooks.store',
  'organizations.servers.ssh-keys.store',
  'organizations.servers.store',
  'organizations.servers.update',
  'organizations.storage-providers.store',
  'organizations.storage-providers.update',
]);

/**
 * Body fields that identify or change the target of a guarded operation.
 *
 * Path parameters alone are not enough. Several guarded operations select their
 * target in the **request body**: `POST /orgs/{org}/servers/archives` carries
 * the server in `ArchiveRequest`, and a backup restore carries the destination
 * database. For those, a phrase built only from path ids is constant across
 * targets, so one confirmation would authorise archiving any server simply by
 * changing the body.
 *
 * Keyed by `operationId`; every listed field is appended to the confirmation
 * phrase when present. Generation fails if a guarded operation has neither a
 * non-organization path parameter nor an entry here, so a new body-selected
 * destructive operation cannot ship with an unbound confirmation.
 */
const CONFIRMATION_TARGET_FIELDS: Record<string, readonly string[]> = {
  // Detaching vs destroying is a query argument, and changes the consequence.
  'organizations.servers.destroy': ['preserve_at_provider'],
  // Target server lives in the body, not the path.
  'organizations.servers.archives.store': ['server_id'],
  // Restores overwrite a caller-selected database.
  'organizations.servers.database.backups.instances.restores.store': ['database_id'],
  // One route, two very different effects.
  'organizations.servers.actions.store': ['action'],
  'organizations.servers.services.nginx.actions.store': ['action'],
  'organizations.servers.services.mysql.actions.store': ['action'],
  'organizations.servers.services.postgres.actions.store': ['action'],
  'organizations.servers.services.redis.actions.store': ['action'],
  'organizations.servers.services.supervisor.actions.store': ['action'],
  'organizations.servers.services.php.actions.store': ['action', 'version'],
  'organizations.servers.background-processes.actions.store': ['action'],
  'organizations.servers.sites.domains.actions.store': ['action'],
  'organizations.servers.sites.domains.certificates.actions.store': ['action'],
  // Team and access mutation identify the subject in the body.
  'organizations.teams.store': ['name'],
  'organizations.roles.store': ['name'],
  'organizations.teams.invites.store': ['email'],
  'organizations.teams.servers.store': ['server_id'],
  'organizations.teams.server-credentials.store': ['credential_id'],
  'organizations.teams.recipes.store': ['recipe_id'],
};

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
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, unknown>;
  'x-processingMode'?: 'sync' | 'async';
}

interface OpenApiDocument {
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation | undefined>>;
  components?: { schemas?: Record<string, unknown> };
}

/**
 * Collects every argument name an operation accepts: path, query and request
 * body, resolving `$ref` and `allOf`.
 *
 * Used to verify the confirmation-target overrides against the actual schema. A
 * configured field that no longer exists would be silently omitted from the
 * phrase at runtime — because its value is simply `undefined` — leaving the
 * confirmation unbound from the target it was meant to name.
 */
function collectArgumentNames(
  operation: OpenApiOperation,
  schemas: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();

  for (const parameter of operation.parameters ?? []) {
    if (parameter.in === 'path' || parameter.in === 'query') names.add(parameter.name);
  }

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;

    const ref = record['$ref'];
    if (typeof ref === 'string') {
      visit(schemas[ref.replace('#/components/schemas/', '')], depth + 1);
      return;
    }

    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const branches = record[key];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, depth + 1);
    }

    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const name of Object.keys(properties)) names.add(name);
    }
  };

  visit(operation.requestBody?.content?.['application/json']?.schema, 0);
  return names;
}

/**
 * Whether an asynchronous operation can actually be observed to completion.
 *
 * Derived from the document rather than inferred from the HTTP method: an
 * operation is pollable only when the same path exposes a GET whose response
 * carries a `status` or `state` field. Method-based inference gets this wrong in
 * both directions — `DELETE .../deployments/status` *resets* state rather than
 * removing a resource, so waiting for a 404 would hang, and an nginx config PUT
 * reads back content with no status at all, which a status poll would treat as
 * instantly finished.
 */
function isPollable(
  path: string,
  method: string,
  document: OpenApiDocument,
  schemas: Record<string, unknown>,
): boolean {
  // A create posts to a collection, so the collection's own GET describes a
  // list and never carries a status. What matters is whether the *created*
  // resource is pollable, which is the item route: the same path plus an id
  // segment. The runtime reaches it through the response's `self` link.
  const readPath =
    method === 'post'
      ? (Object.keys(document.paths).find(
          (candidate) =>
            candidate.startsWith(`${path}/{`) &&
            candidate.slice(path.length + 1).split('/').length === 1,
        ) ?? path)
      : path;

  const getOperation = document.paths[readPath]?.['get'];
  if (!getOperation) return false;

  const responses: Record<string, unknown> = getOperation.responses ?? {};
  for (const code of ['200', '201']) {
    const response = responses[code];
    if (typeof response !== 'object' || response === null) continue;

    const content = (response as { content?: Record<string, { schema?: unknown }> }).content ?? {};
    for (const media of Object.values(content)) {
      const names = new Set<string>();
      const visit = (node: unknown, depth: number): void => {
        if (depth > 6 || typeof node !== 'object' || node === null) return;
        const record = node as Record<string, unknown>;

        const ref = record['$ref'];
        if (typeof ref === 'string') {
          visit(schemas[ref.replace('#/components/schemas/', '')], depth + 1);
          return;
        }

        for (const key of ['allOf', 'anyOf', 'oneOf']) {
          const branches = record[key];
          if (Array.isArray(branches)) for (const branch of branches) visit(branch, depth + 1);
        }

        const properties = record['properties'];
        if (typeof properties === 'object' && properties !== null) {
          const bag = properties as Record<string, unknown>;
          for (const name of Object.keys(bag)) names.add(name);
          visit(bag['data'], depth + 1);
          visit(bag['attributes'], depth + 1);
        }
      };

      visit(media.schema, 0);
      if (names.has('status') || names.has('state')) return true;
    }
  }

  return false;
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
  const unclassifiedMutations: string[] = [];
  const doubleClassified: string[] = [];
  const unboundConfirmations: string[] = [];
  const invalidTargetFields: string[] = [];
  const schemaComponents = spec.components?.schemas ?? {};

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

      // A request body is either a named $ref or written inline. Both must be
      // captured: four Forge operations use an inline `allOf`, and following
      // only $ref would emit those tools with no body fields.
      const bodySchemaRaw = operation.requestBody?.content?.['application/json']?.schema;
      const bodySchemaRef =
        typeof bodySchemaRaw?.['$ref'] === 'string' ? bodySchemaRaw['$ref'] : undefined;
      const bodySchemaName = bodySchemaRef?.replace('#/components/schemas/', '');
      const bodySchemaInline =
        bodySchemaRaw !== undefined && bodySchemaRef === undefined ? bodySchemaRaw : undefined;

      // Reads need no classification; every mutation does.
      if (method !== 'get') {
        const classifications = [
          DESTRUCTIVE_OPERATION_IDS.has(operationId),
          CONFIRM_REQUIRED_OPERATION_IDS.has(operationId),
          REVIEWED_SAFE_MUTATION_OPERATION_IDS.has(operationId),
        ].filter(Boolean).length;

        if (classifications === 0) unclassifiedMutations.push(operationId);
        if (classifications > 1) doubleClassified.push(operationId);
      }

      const isDestructive = DESTRUCTIVE_OPERATION_IDS.has(operationId);
      const requiresConfirm = isDestructive || CONFIRM_REQUIRED_OPERATION_IDS.has(operationId);

      const targetFields = CONFIRMATION_TARGET_FIELDS[operationId] ?? [];

      if (requiresConfirm) {
        const hasPathTarget = pathParams.some((param) => param.name !== 'organization');
        if (!hasPathTarget && targetFields.length === 0) unboundConfirmations.push(operationId);

        // A configured field that no longer exists in the schema is worse than
        // no entry at all: it looks bound while contributing nothing, because
        // its value is always undefined.
        const available = collectArgumentNames(operation, schemaComponents);
        for (const field of targetFields) {
          if (!available.has(field)) {
            invalidTargetFields.push(`${operationId} -> "${field}"`);
          }
        }
      }
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
          `    bodySchemaInline: ${
            bodySchemaInline === undefined ? 'undefined' : JSON.stringify(bodySchemaInline)
          },`,
          `    bodyRequired: ${Boolean(operation.requestBody?.required)},`,
          `    confirmationTargetFields: ${JSON.stringify(targetFields)},`,
          `    pollable: ${isPollable(path, method, spec, schemaComponents)},`,
          `    destructive: ${isDestructive},`,
          `    requiresConfirm: ${requiresConfirm},`,
          '  },',
        ].join('\n'),
      );
    }
  }

  // Fail loudly if an override no longer matches the spec, rather than quietly
  // shipping an unguarded destructive tool.
  for (const id of [
    ...DESTRUCTIVE_OPERATION_IDS,
    ...CONFIRM_REQUIRED_OPERATION_IDS,
    ...REVIEWED_SAFE_MUTATION_OPERATION_IDS,
  ]) {
    if (!seenOperationIds.has(id)) {
      throw new Error(
        `Override references unknown operationId "${id}". ` +
          'The Forge spec changed — re-check the guard tables in scripts/generate-operations.ts.',
      );
    }
  }

  // Fail closed: every mutation must be classified exactly once. A destructive
  // operation added by a future spec would otherwise ship unguarded simply by
  // being absent from the tables.
  if (unclassifiedMutations.length > 0) {
    throw new Error(
      `${unclassifiedMutations.length} mutating operation(s) are not classified:\n` +
        unclassifiedMutations.map((id) => `  - ${id}`).join('\n') +
        '\n\nAdd each to exactly one of DESTRUCTIVE_OPERATION_IDS (destroys ' +
        'infrastructure or data), CONFIRM_REQUIRED_OPERATION_IDS (can interrupt a live ' +
        'service), or REVIEWED_SAFE_MUTATION_OPERATION_IDS (recreatable, no interruption) ' +
        'in scripts/generate-operations.ts.',
    );
  }

  // Every guarded operation must have something that binds the confirmation to
  // a specific target: a path parameter other than the organization, or an
  // explicit body-field entry. Otherwise the phrase is constant and one
  // confirmation authorises every target.
  if (unboundConfirmations.length > 0) {
    throw new Error(
      `${unboundConfirmations.length} guarded operation(s) have no target bound into the ` +
        `confirmation phrase:\n` +
        unboundConfirmations.map((id) => `  - ${id}`).join('\n') +
        '\n\nAdd the identifying request-body field(s) to CONFIRMATION_TARGET_FIELDS in ' +
        'scripts/generate-operations.ts.',
    );
  }

  if (invalidTargetFields.length > 0) {
    throw new Error(
      `${invalidTargetFields.length} confirmation target field(s) do not exist in their ` +
        `operation's path, query or request body:\n` +
        invalidTargetFields.map((entry) => `  - ${entry}`).join('\n') +
        '\n\nForge renamed or removed them. Update CONFIRMATION_TARGET_FIELDS in ' +
        'scripts/generate-operations.ts — a stale entry leaves the confirmation unbound.',
    );
  }

  if (doubleClassified.length > 0) {
    throw new Error(
      `${doubleClassified.length} operation(s) appear in more than one classification table:\n` +
        doubleClassified.map((id) => `  - ${id}`).join('\n'),
    );
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
