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

/** Methods RFC 9110 defines as idempotent, before per-operation corrections. */
const IDEMPOTENT_METHODS = new Set(['get', 'put', 'delete']);

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
  // Execution, which subsumes deletion. Each of these accepts caller-authored
  // code, or a credential that runs it, so leaving any of them outside the
  // switch would let an agent reproduce the consequence of every tool the
  // switch hides.
  'organizations.servers.sites.commands.store',
  'organizations.recipes.runs.store',
  'organizations.servers.background-processes.store',
  'organizations.servers.background-processes.update',
  'organizations.servers.scheduled-jobs.store',
  'organizations.servers.sites.scheduled-jobs.store',
  // Additive, and still destructive by consequence: it installs a
  // caller-supplied public key for a caller-chosen user, so whoever holds the
  // private half has persistent shell access from then on.
  'organizations.servers.ssh-keys.store',
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
  'forge-recipes.runs.store',
  'organization.recipes.store',
  'organizations.recipes.update',
  'organizations.servers.key.update',
  'organizations.servers.sites.deployments.deploy-hook.update',
  'organizations.servers.sites.deployments.script.update',
  'organizations.servers.sites.environment.update',
  'organizations.servers.sites.load-balancing-nodes.update',
  'organizations.servers.sites.deployments.store',
  'organizations.servers.firewall-rules.store',
  'organizations.servers.php.site-version.update',
  'organizations.servers.sites.update',
  'organizations.servers.sites.redirect-rules.store',
  'organizations.servers.sites.security-rules.store',
  'organizations.servers.sites.security-rules.update',
  'organizations.servers.network.update',
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
  'organizations.recipes.destroy',
  'organizations.server-credentials.vpcs.store',
  'organizations.servers.database.backups.instances.store',
  'organizations.servers.database.backups.store',
  'organizations.servers.database.backups.update',
  'organizations.servers.database.password.update',
  'organizations.servers.database.schemas.store',
  'organizations.servers.database.schemas.synchronizations.store',
  'organizations.servers.database.users.store',
  'organizations.servers.database.users.update',
  'organizations.servers.logs.destroy',
  'organizations.servers.monitors.destroy',
  'organizations.servers.monitors.store',
  'organizations.servers.nginx.templates.store',
  'organizations.servers.nginx.templates.update',
  'organizations.servers.php.cli-version.update',
  'organizations.servers.php.max-execution-time.update',
  'organizations.servers.php.max-upload-size.update',
  'organizations.servers.php.opcache.store',
  'organizations.servers.php.versions.store',
  'organizations.servers.php.versions.update',
  'organizations.servers.sites.commands.destroy',
  'organizations.servers.sites.composer.credentials.destroy',
  'organizations.servers.sites.composer.credentials.store',
  'organizations.servers.sites.composer.credentials.update',
  'organizations.servers.sites.deploy-key.store',
  'organizations.servers.sites.deployments.push-to-deploy.store',
  'organizations.servers.sites.deployments.status.destroy',
  'organizations.servers.sites.domains.certificates.store',
  'organizations.servers.sites.domains.store',
  'organizations.servers.sites.domains.update',
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
  'organizations.servers.sites.logs.application.destroy',
  'organizations.servers.sites.logs.nginx-access.destroy',
  'organizations.servers.sites.logs.nginx-error.destroy',
  'organizations.servers.sites.npm.credentials.destroy',
  'organizations.servers.sites.npm.credentials.store',
  'organizations.servers.sites.npm.credentials.update',
  'organizations.servers.sites.store',
  'organizations.servers.sites.storeOnBalancer',
  'organizations.servers.sites.webhooks.destroy',
  'organizations.servers.sites.webhooks.store',
  'organizations.servers.store',
  'organizations.servers.update',
  'organizations.storage-providers.store',
  'organizations.storage-providers.update',
]);

/**
 * Operations whose HTTP verb overstates their safety to retry.
 *
 * RFC 9110 lets a client retry an idempotent method after an ambiguous failure,
 * because repeating it has the same effect as sending it once. Forge breaks
 * that assumption for two PUTs: both *regenerate* a credential, so a retry
 * after a network drop or a 5xx mints a second one and may invalidate the first
 * response the caller never saw.
 *
 * Retry safety is therefore an operation-level fact, not a property of the
 * verb — and the same fact drives the `idempotentHint` advertised to MCP
 * clients, so behaviour and metadata cannot drift.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110#name-idempotent-methods
 */
const NON_IDEMPOTENT_OPERATION_IDS = new Set<string>([
  // Regenerates the server's SSH key pair and returns the new public key.
  'organizations.servers.key.update',
  // Regenerates the deployment-hook token used to trigger deployments.
  'organizations.servers.sites.deployments.deploy-hook.update',
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
  // Readable identifiers only. Everything a guarded body carries is bound by
  // the whole-body digest instead, so nothing here needs to echo a payload.
  'organization.recipes.store': ['name'],
  // A recipe run's hazard is *where* it runs, so the phrase names the servers
  // readably as well as digesting them with the rest of the body.
  'organizations.recipes.runs.store': ['servers'],
  'forge-recipes.runs.store': ['servers'],

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
 * Statuses that mean "still working", classified by value.
 *
 * Forge has no single status vocabulary: the same string means different things
 * on different resources. `running` is the healthy steady state of a background
 * process but an in-flight `CommandStatus`, so one global set of non-terminal
 * values is wrong in both directions — it polls a finished background process
 * until timeout, and reports a still-executing command as finished.
 *
 * Classification therefore happens per value with per-resource overrides, and
 * the generator fails closed on any enum value it cannot classify.
 *
 * @see https://forge.laravel.com/api/docs.openapi — `components.schemas.*Resource`
 */
const PENDING_BY_VALUE: ReadonlySet<string> = new Set([
  'connecting',
  'creating',
  'deleting',
  'deploying',
  'disabling',
  'enabling',
  'installing',
  'pending',
  'queued',
  'removing',
  'renewing',
  'restarting',
  'restoring',
  'securing',
  'starting',
  'stopping',
  'syncing',
  'uninstalling',
  'updating',
  'waiting',
]);

/** Statuses that mean the operation has settled, successfully or not. */
const TERMINAL_BY_VALUE: ReadonlySet<string> = new Set([
  'backoff',
  'beating',
  'cancelled',
  'deployed',
  'disabled',
  'enabled',
  'exited',
  'failed',
  'failed-build',
  'failed-runner',
  'failed-unknown',
  'fatal',
  'finished',
  'installed',
  'maintenance',
  'missing',
  'never-deployed',
  'running',
  'stopped',
  'success',
  'timeout',
  'unknown',
]);

/**
 * Per-resource corrections to the value tables above.
 *
 * Each entry names a status whose meaning on that resource contradicts its
 * usual one:
 *
 *   - `commands` / `recipeLogs` — `running` is in-flight here, not a steady
 *     state, so polling must continue until `finished`.
 *   - `heartbeats` — `pending` is the resting state of a heartbeat that has not
 *     fired yet, not work in progress.
 *
 * `laravelMaintenanceIntegrations` deliberately has no entry: its `enabling`
 * and `disabling` values do read as transitions, because the resource carries a
 * separate `enabled: boolean` for the mode itself and a *nullable* `status`.
 * A null status means no transition is running, which the runtime already
 * settles on.
 */
const RESOURCE_STATUS_OVERRIDES: Readonly<
  Record<string, Readonly<Record<string, 'pending' | 'terminal'>>>
> = {
  commands: { running: 'pending' },
  recipeLogs: { running: 'pending' },
  heartbeats: { pending: 'terminal' },
};

/** A resource's JSON:API `type` and the statuses that mean "keep polling". */
interface ResourceVocabulary {
  readonly resourceType: string;
  readonly pending: readonly string[];
}

/** Resolves `$ref`, and `anyOf`/`oneOf` minus its null branch, to one schema. */
function resolveSchema(node: unknown, schemas: Record<string, unknown>, depth = 0): unknown {
  if (depth > 8 || typeof node !== 'object' || node === null) return node;
  const record = node as Record<string, unknown>;

  const ref = record['$ref'];
  if (typeof ref === 'string') {
    return resolveSchema(schemas[ref.replace('#/components/schemas/', '')], schemas, depth + 1);
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = record[key];
    if (!Array.isArray(branches)) continue;

    // `anyOf: [Enum, null]` is how Forge marks a nullable status.
    const meaningful = branches.filter((branch) => {
      const type = (branch as { type?: unknown }).type;
      return type !== 'null';
    });
    if (meaningful.length === 1) return resolveSchema(meaningful[0], schemas, depth + 1);
  }

  return record;
}

/**
 * Reads every resource schema's status vocabulary out of the document.
 *
 * A resource schema is recognised by a literal `type` enum — the JSON:API
 * member that names the resource — plus a `status` or `state` attribute.
 */
function collectResourceVocabularies(
  schemas: Record<string, unknown>,
): Map<string, ResourceVocabulary> {
  const byType = new Map<string, ResourceVocabulary>();
  const unclassified: string[] = [];

  for (const schema of Object.values(schemas)) {
    if (typeof schema !== 'object' || schema === null) continue;
    const properties = (schema as { properties?: Record<string, unknown> }).properties;
    if (!properties) continue;

    const typeEnum = (properties['type'] as { enum?: unknown[] } | undefined)?.enum;
    const resourceType = typeEnum?.[0];
    if (typeof resourceType !== 'string') continue;

    const attributes = (properties['attributes'] as { properties?: Record<string, unknown> })
      ?.properties;
    if (!attributes) continue;

    const statusSchema = resolveSchema(attributes['status'] ?? attributes['state'], schemas);
    const values = (statusSchema as { enum?: unknown[] } | undefined)?.enum;
    if (!Array.isArray(values)) continue;

    const overrides = RESOURCE_STATUS_OVERRIDES[resourceType] ?? {};
    const pending: string[] = [];

    for (const raw of values) {
      if (typeof raw !== 'string') continue;
      const value = raw.toLowerCase();
      const override = overrides[value];

      if (override === 'pending') pending.push(value);
      else if (override === 'terminal') continue;
      else if (PENDING_BY_VALUE.has(value)) pending.push(value);
      else if (TERMINAL_BY_VALUE.has(value)) continue;
      else unclassified.push(`${resourceType}.${value}`);
    }

    byType.set(resourceType, { resourceType, pending });
  }

  if (unclassified.length > 0) {
    throw new Error(
      `${unclassified.length} resource status value(s) are not classified:\n` +
        unclassified.map((entry) => `  - ${entry}`).join('\n') +
        '\n\nAdd each to PENDING_BY_VALUE (work is still in flight) or ' +
        'TERMINAL_BY_VALUE (the operation has settled) in ' +
        'scripts/generate-operations.ts, or add a RESOURCE_STATUS_OVERRIDES entry ' +
        'when the value means something different on that resource. Leaving it ' +
        'unclassified would make polling either hang or finish early.',
    );
  }

  // A stale override is worse than none: it silently contributes nothing while
  // looking like the case is handled.
  for (const resourceType of Object.keys(RESOURCE_STATUS_OVERRIDES)) {
    if (!byType.has(resourceType)) {
      throw new Error(
        `RESOURCE_STATUS_OVERRIDES names resource type "${resourceType}", which no longer ` +
          'declares a status enum in the Forge spec.',
      );
    }
  }

  for (const value of PENDING_BY_VALUE) {
    if (TERMINAL_BY_VALUE.has(value)) {
      throw new Error(`Status "${value}" is listed as both pending and terminal.`);
    }
  }

  return byType;
}

/**
 * Postconditions that prove *this* invocation took effect.
 *
 * A `202` says Forge accepted the work, not that it has started it. Polling a
 * resource that already existed can therefore read its *pre-operation* steady
 * state and mistake it for completion: enabling maintenance mode reads
 * `enabled: false` before it reads `enabling`, and both a settled status and a
 * missing one look terminal.
 *
 * A create does not have this problem — the resource it polls did not exist
 * before the call — and neither does a deletion, whose completion signal is an
 * unambiguous 404. Every *other* status poll needs an operation-specific
 * postcondition, and the generator refuses to emit a plan without one rather
 * than advertise a `wait` that can return a false success.
 *
 * Values are compared against the flattened resource, so an attribute name is
 * enough. `null` is a real expected value here: clearing a stuck deployment
 * leaves `DeploymentStatusResource.status` null.
 */
const POLL_POSTCONDITIONS: Readonly<
  Record<string, { readonly field: string; readonly equals: unknown }>
> = {
  'organizations.servers.sites.integrations.laravel-maintenance.store': {
    field: 'enabled',
    equals: true,
  },
  'organizations.servers.sites.integrations.laravel-maintenance.destroy': {
    field: 'enabled',
    equals: false,
  },
  'organizations.servers.sites.deployments.status.destroy': { field: 'status', equals: null },
};

/**
 * How long to keep polling, per completion mode.
 *
 * Server provisioning is an order of magnitude slower than everything else:
 * Forge's own API documentation puts ordinary provisioning at roughly ten
 * minutes and recommends polling about every two minutes. The 120-second
 * default that suits a config change would fail every real provision.
 *
 * @see https://forge.laravel.com/docs/servers/provisioning
 */
const POLL_TIMING: Readonly<
  Record<string, { timeoutMs: number; initialIntervalMs: number; maxIntervalMs: number }>
> = {
  readiness: { timeoutMs: 1_800_000, initialIntervalMs: 15_000, maxIntervalMs: 120_000 },
  default: { timeoutMs: 120_000, initialIntervalMs: 2_000, maxIntervalMs: 10_000 },
};

/**
 * The attribute Forge uses to signal that a provisioned resource is usable.
 *
 * `ServerResource` reports no `status`; provisioning finishes when `is_ready`
 * flips to true, which is the only completion signal `POST /orgs/{org}/servers`
 * — the longest-running operation in the API — ever gives.
 */
const READINESS_FIELD = 'is_ready';

/** How the runtime observes an asynchronous operation reaching completion. */
type PollCompletion = 'status' | 'absence' | 'readiness';

/** Everything the runtime needs to poll one operation to completion. */
interface PollingPlan {
  /** Read-path template, with `{param}` placeholders. */
  readonly path: string;
  /**
   * Placeholder in `path` filled from the created resource's `data.id`.
   *
   * Set for creates, whose read path is the item route under the collection
   * they posted to and therefore carries one placeholder the request itself
   * never supplied.
   */
  readonly idParam: string | undefined;
  readonly completion: PollCompletion;
  /** JSON:API resource type, selecting the status vocabulary. */
  readonly resourceType: string | undefined;
  /** Postcondition proving this invocation took effect. See POLL_POSTCONDITIONS. */
  readonly expect: { readonly field: string; readonly equals: unknown } | undefined;
  readonly timeoutMs: number;
  readonly initialIntervalMs: number;
  readonly maxIntervalMs: number;
}

/** What a GET on some path reads back. */
interface ReadTarget {
  readonly resourceType: string | undefined;
  readonly hasStatus: boolean;
  /** True when the resource reports readiness instead of a status. */
  readonly hasReadiness: boolean;
  /** True when the GET answers with an array — a collection, not one resource. */
  readonly isCollection: boolean;
}

/** Describes what a GET on `path` returns, or undefined when there is no GET. */
function describeReadPath(
  path: string,
  document: OpenApiDocument,
  schemas: Record<string, unknown>,
): ReadTarget | undefined {
  const getOperation = document.paths[path]?.['get'];
  if (!getOperation) return undefined;

  const responses: Record<string, unknown> = getOperation.responses ?? {};

  for (const code of ['200', '201']) {
    const response = responses[code];
    if (typeof response !== 'object' || response === null) continue;

    const content = (response as { content?: Record<string, { schema?: unknown }> }).content ?? {};
    for (const media of Object.values(content)) {
      const envelope = resolveSchema(media.schema, schemas) as
        { properties?: Record<string, unknown> } | undefined;

      let data = resolveSchema(envelope?.properties?.['data'], schemas) as
        { properties?: Record<string, unknown>; items?: unknown } | undefined;

      // A list response wraps the resource in an array; the item describes it.
      const isCollection = data?.items !== undefined;
      if (isCollection) data = resolveSchema(data?.items, schemas) as typeof data;

      const properties = data?.properties;
      if (!properties) continue;

      const typeEnum = (properties['type'] as { enum?: string[] } | undefined)?.enum;
      const resourceType = typeof typeEnum?.[0] === 'string' ? typeEnum[0] : undefined;

      const attributes = (properties['attributes'] as { properties?: Record<string, unknown> })
        ?.properties;
      const hasStatus =
        attributes !== undefined &&
        (attributes['status'] !== undefined || attributes['state'] !== undefined);

      const readiness = attributes?.[READINESS_FIELD] as { type?: unknown } | undefined;
      const hasReadiness = readiness?.type === 'boolean';

      return { resourceType, hasStatus, hasReadiness, isCollection };
    }
  }

  return undefined;
}

/**
 * Derives the polling plan for one operation, or undefined when completion
 * cannot be observed.
 *
 * A plan rather than a boolean, because the runtime needs three things a flag
 * cannot carry: which path to read, which placeholder the created resource's id
 * fills, and whether completion means "status settled" or "resource gone".
 *
 * Rules, all derived from the document:
 *
 *   - A create posts to a collection, whose own GET is a list and carries no
 *     status. The created resource lives at the item route below it, reached
 *     through the response's `self` link or, when Forge omits one, by rendering
 *     that route with the returned id.
 *   - A deletion finishes when the resource stops existing, so it polls its own
 *     item route until 404. This applies only to true item routes: `DELETE
 *     .../deployments/status` and `DELETE .../integrations/horizon` clear state
 *     on an endpoint that keeps answering afterwards, so absence would never
 *     arrive.
 *   - An update polls the path it wrote to, provided that path reads back a
 *     status. An nginx-config PUT reads back file content with no status, which
 *     a status poll would call finished on the first read.
 */
function completionFor(target: ReadTarget): PollCompletion | undefined {
  if (target.hasStatus) return 'status';
  if (target.hasReadiness) return 'readiness';
  return undefined;
}

function buildPollingPlan(
  path: string,
  method: string,
  operationId: string,
  document: OpenApiDocument,
  schemas: Record<string, unknown>,
): PollingPlan | undefined {
  // Seven operations are tagged async but document a 200/204 success: Forge
  // completes them inline. Nothing was deferred, so there is nothing to wait
  // for, and `DELETE .../logs/{key}` — which clears a log's *content* and
  // leaves the key readable — would loop until timeout waiting for a 404 that
  // never comes. The runtime enforces the same rule against the response it
  // actually received; this keeps `wait` off the schema in the first place.
  if (document.paths[path]?.[method]?.responses?.['202'] === undefined) return undefined;

  const expect = POLL_POSTCONDITIONS[operationId];

  const timed = (
    plan: Omit<PollingPlan, 'timeoutMs' | 'initialIntervalMs' | 'maxIntervalMs'>,
  ): PollingPlan => ({
    ...plan,
    ...(POLL_TIMING[plan.completion] ?? POLL_TIMING['default']!),
  });

  if (method === 'delete') {
    const target = describeReadPath(path, document, schemas);
    if (!target || target.isCollection) return undefined;

    // A path ending in a placeholder addresses one resource, so deleting it
    // makes the resource disappear and a 404 is unambiguous completion.
    if (path.endsWith('}')) {
      return timed({
        path,
        idParam: undefined,
        completion: 'absence',
        resourceType: target.resourceType,
        expect: undefined,
      });
    }

    // Otherwise the DELETE clears state on an endpoint that keeps answering —
    // resetting a stuck deployment, disabling an integration. Absence would
    // never arrive, but the same GET may still expose the state to watch. It
    // needs a postcondition, because the resource existed beforehand.
    const completion = completionFor(target);
    if (completion === undefined || expect === undefined) return undefined;

    return timed({
      path,
      idParam: undefined,
      completion,
      resourceType: target.resourceType,
      expect,
    });
  }

  if (method === 'post') {
    const itemPath = Object.keys(document.paths).find(
      (candidate) =>
        candidate.startsWith(`${path}/{`) &&
        candidate.slice(path.length + 1).split('/').length === 1,
    );

    const readPath = itemPath ?? path;
    const target = describeReadPath(readPath, document, schemas);
    const completion = target === undefined ? undefined : completionFor(target);
    if (target === undefined || completion === undefined) return undefined;

    // Without an item route below it, the only readable path is the one posted
    // to. That is pollable when it reads back a single resource — an action
    // endpoint such as `.../integrations/laravel-maintenance` — but not when it
    // reads back a list, which carries no status of its own and would look
    // instantly finished.
    if (itemPath === undefined && target.isCollection) return undefined;

    const idParam =
      itemPath === undefined ? undefined : itemPath.slice(path.length + 2, itemPath.length - 1);

    // A create polls a resource that did not exist before the call, so its
    // first read cannot be a stale pre-operation state. An action endpoint
    // rewrites something that did, and needs a postcondition.
    if (idParam === undefined && expect === undefined) return undefined;

    return timed({
      path: readPath,
      idParam,
      completion,
      resourceType: target.resourceType,
      expect: idParam === undefined ? expect : undefined,
    });
  }

  const target = describeReadPath(path, document, schemas);
  const completion = target === undefined ? undefined : completionFor(target);
  if (target === undefined || completion === undefined) return undefined;

  // `GET .../servers/{server}/network` answers with an array of
  // `ServerResource`, so its `is_ready` belongs to the array *item*, not to any
  // single resource the caller could poll. A list carries no completion state
  // of its own, and the runtime's readers deliberately refuse arrays, so a plan
  // pointed at one could never terminate.
  if (target.isCollection) return undefined;

  // An update rewrites a resource that already existed, so its status can read
  // back as the pre-operation steady state. Without a postcondition proving
  // this call took effect, no `wait` is advertised at all.
  if (expect === undefined) return undefined;

  return {
    ...timed({
      path,
      idParam: undefined,
      completion,
      resourceType: target.resourceType,
      expect,
    }),
  };
}

/** Attribute names declared by a JSON:API resource type, for validating overrides. */
function resourceAttributes(
  resourceType: string | undefined,
  schemas: Record<string, unknown>,
): Set<string> | undefined {
  if (resourceType === undefined) return undefined;

  for (const schema of Object.values(schemas)) {
    const properties = (schema as { properties?: Record<string, unknown> })?.properties;
    const typeEnum = (properties?.['type'] as { enum?: string[] } | undefined)?.enum;
    if (typeEnum?.[0] !== resourceType) continue;

    const attributes = (properties?.['attributes'] as { properties?: Record<string, unknown> })
      ?.properties;
    if (attributes) return new Set(Object.keys(attributes));
  }

  return undefined;
}

/** Serialises a polling plan into the generated file, omitting absent fields. */
function formatPollingPlan(plan: PollingPlan | undefined): string {
  if (!plan) return 'undefined';

  const parts = [`path: ${JSON.stringify(plan.path)}`];
  if (plan.idParam !== undefined) parts.push(`idParam: ${JSON.stringify(plan.idParam)}`);
  parts.push(`completion: ${JSON.stringify(plan.completion)}`);
  if (plan.resourceType !== undefined) {
    parts.push(`resourceType: ${JSON.stringify(plan.resourceType)}`);
  }
  if (plan.expect !== undefined) {
    parts.push(
      `expect: { field: ${JSON.stringify(plan.expect.field)}, equals: ${JSON.stringify(
        plan.expect.equals,
      )} }`,
    );
  }
  parts.push(`timeoutMs: ${plan.timeoutMs}`);
  parts.push(`initialIntervalMs: ${plan.initialIntervalMs}`);
  parts.push(`maxIntervalMs: ${plan.maxIntervalMs}`);

  return `{ ${parts.join(', ')} }`;
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
  let asyncCount = 0;
  let pollableCount = 0;
  const postconditionPlans = new Map<string, PollingPlan>();
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

      // A guarded operation with a request body binds that whole body by
      // digest. Enumerating "the fields that matter" is a losing game — one
      // omission lets the approved effect change, and a recipe approved to run
      // as `forge` could be sent as `root` because only its script was bound.
      const hasRequestBody =
        operation.requestBody?.content?.['application/json']?.schema !== undefined;

      if (requiresConfirm) {
        const hasPathTarget = pathParams.some((param) => param.name !== 'organization');
        if (!hasPathTarget && targetFields.length === 0 && !hasRequestBody) {
          unboundConfirmations.push(operationId);
        }

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

      // Only asynchronous operations are ever polled, so only they carry a plan.
      const isAsync = operation['x-processingMode'] === 'async';
      const pollingPlan = isAsync
        ? buildPollingPlan(path, method, operationId, spec, schemaComponents)
        : undefined;
      if (isAsync) {
        asyncCount += 1;
        if (pollingPlan) {
          pollableCount += 1;
          if (pollingPlan.expect !== undefined) postconditionPlans.set(operationId, pollingPlan);
        }
      }

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
          `    confirmBindsBody: ${requiresConfirm && hasRequestBody},`,
          `    idempotent: ${IDEMPOTENT_METHODS.has(method) && !NON_IDEMPOTENT_OPERATION_IDS.has(operationId)},`,
          `    polling: ${formatPollingPlan(pollingPlan)},`,
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
    ...NON_IDEMPOTENT_OPERATION_IDS,
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

  // A postcondition naming an operation or field the spec no longer has would
  // silently never be satisfied, turning every `wait: true` on it into a
  // timeout.
  for (const [operationId, condition] of Object.entries(POLL_POSTCONDITIONS)) {
    if (!seenOperationIds.has(operationId)) {
      throw new Error(
        `POLL_POSTCONDITIONS references unknown operationId "${operationId}". ` +
          'The Forge spec changed — re-check the table in scripts/generate-operations.ts.',
      );
    }

    const plan = postconditionPlans.get(operationId);
    if (!plan) {
      throw new Error(
        `POLL_POSTCONDITIONS names "${operationId}", which no longer produces a polling plan. ` +
          'Remove the entry or restore the plan.',
      );
    }

    const attributes = resourceAttributes(plan.resourceType, schemaComponents);
    if (attributes !== undefined && !attributes.has(condition.field)) {
      throw new Error(
        `POLL_POSTCONDITIONS expects "${operationId}" to settle on "${condition.field}", which ` +
          `"${plan.resourceType ?? 'the polled resource'}" does not declare. A postcondition ` +
          'that can never be satisfied turns every wait into a timeout.',
      );
    }
  }

  const vocabularies = collectResourceVocabularies(schemaComponents);
  const defaultPending = PENDING_BY_VALUE;

  const pendingEntries = [...vocabularies.values()]
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType))
    .map(
      (vocabulary) =>
        `  ${JSON.stringify(vocabulary.resourceType)}: ${JSON.stringify([...vocabulary.pending].sort())},`,
    )
    .join('\n');

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
 * ${pollableCount} of the ${asyncCount} asynchronous operations can be polled to completion.
 */

import type { OperationDescriptor } from '../tools/types.js';

/** Base URL declared by the OpenAPI document. */
export const FORGE_API_BASE_URL = ${JSON.stringify(baseUrl)};

/**
 * Statuses that mean "still working", per JSON:API resource type.
 *
 * Forge reuses status strings with different meanings across resources —
 * \`running\` is the healthy steady state of a background process but an
 * in-flight command — so completion cannot be decided from one global set.
 * Anything absent from a resource's list is terminal for that resource.
 */
export const PENDING_STATUSES: Readonly<Record<string, readonly string[]>> = {
${pendingEntries}
};

/**
 * Fallback vocabulary for resources whose status is a free-form string rather
 * than an enum. Deliberately excludes \`running\`, which is a steady state
 * everywhere except the two command-like resources — and both of those declare
 * an enum, so they never reach this fallback.
 */
export const DEFAULT_PENDING_STATUSES: readonly string[] = ${JSON.stringify(
    [...defaultPending].sort(),
  )};

/** Every operation in the Forge API, in document order. */
export const OPERATIONS: readonly OperationDescriptor[] = [
`;

  writeFileSync(OUT_PATH, `${header}${descriptors.join('\n')}\n] as const;\n`, 'utf8');

  process.stdout.write(
    `Generated ${descriptors.length} operations ` +
      `(${destructiveCount} destructive, ${confirmCount} confirmation-gated, ` +
      `${pollableCount}/${asyncCount} async pollable) -> ${OUT_PATH}\n`,
  );
}

main();
