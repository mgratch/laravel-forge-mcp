/**
 * Reporting for Forge's OAuth scopes.
 *
 * A Forge API token is minted with a chosen subset of the 62 scopes the API
 * declares, and that subset is the only privilege boundary Forge enforces
 * server-side: a token without `server:delete` cannot delete a server whatever
 * a client does. `FORGE_MCP_ALLOW_DESTRUCTIVE` and the confirmation phrases sit
 * on top of it as ergonomics, not as the wall.
 *
 * Choosing scopes well therefore matters more than any client-side switch —
 * which is why this report also names the scopes that permit more than their
 * name suggests, rather than presenting a tidy "read-only" set that is not one.
 *
 * @see https://forge.laravel.com/profile/api
 */

import { FORGE_SCOPES, OPERATIONS } from './generated/operations.js';
import type { OperationDescriptor } from './tools/types.js';

/** Scopes that appear on at least one operation which changes something. */
function mutatingScopes(): Set<string> {
  const scopes = new Set<string>();
  for (const operation of OPERATIONS) {
    if (operation.method === 'GET') continue;
    for (const scope of operation.scopes) scopes.add(scope);
  }
  return scopes;
}

/** Scopes that unlock reads and nothing else. */
export function readOnlyScopes(): string[] {
  const mutating = mutatingScopes();
  const scopes = new Set<string>();

  for (const operation of OPERATIONS) {
    if (operation.method !== 'GET') continue;
    for (const scope of operation.scopes) if (!mutating.has(scope)) scopes.add(scope);
  }

  return [...scopes].sort();
}

/**
 * Scopes whose name reads as "view" but which also permit writes.
 *
 * Worth surfacing loudly: `server:view` gates all ten scheduled-job endpoints,
 * *including create and delete*, and a scheduled job carries an arbitrary
 * command plus the user to run it as. A token granted what looks like read
 * access can therefore execute code. Forge declares dedicated
 * `server:create-schedulers` / `server:delete-schedulers` scopes, but the
 * document does not apply them to those endpoints.
 */
export function misleadingScopes(): Map<string, OperationDescriptor[]> {
  const mutating = mutatingScopes();
  const result = new Map<string, OperationDescriptor[]>();

  for (const scope of Object.keys(FORGE_SCOPES)) {
    if (!scope.endsWith(':view') || !mutating.has(scope)) continue;

    const writes = OPERATIONS.filter(
      (operation) => operation.method !== 'GET' && operation.scopes.includes(scope),
    );
    if (writes.length > 0) result.set(scope, writes);
  }

  return result;
}

/** A named starting point, defined by the scopes it grants. */
export interface ScopeProfile {
  readonly name: string;
  readonly summary: string;
  readonly scopes: readonly string[];
}

/** Tools a scope set unlocks. */
export function toolsFor(scopes: readonly string[]): OperationDescriptor[] {
  const held = new Set(scopes);
  return OPERATIONS.filter((operation) => operation.scopes.every((scope) => held.has(scope)));
}

/** Scopes a set of operations needs, deduplicated and sorted. */
export function scopesFor(operations: readonly OperationDescriptor[]): string[] {
  const scopes = new Set<string>();
  for (const operation of operations) for (const scope of operation.scopes) scopes.add(scope);
  return [...scopes].sort();
}

/** Profiles, widest-useful last. Computed, so they cannot drift from the surface. */
export function profiles(): ScopeProfile[] {
  const readOnly = readOnlyScopes();

  const inspect = [
    ...readOnly,
    'server:view',
    'site:meta',
    'recipe:view',
    'credential:view',
    'server:manage-logs',
    'storage:manage',
  ].sort();

  return [
    {
      name: 'read-only',
      summary:
        'Genuinely read-only: every scope here unlocks GET requests and nothing else. ' +
        'Only three of the 62 scopes qualify, so this covers less than you might expect.',
      scopes: readOnly,
    },
    {
      name: 'inspect',
      summary:
        'Read the whole estate — servers, sites, logs, credentials. NOT read-only: see the ' +
        'warning below, because server:view also permits creating scheduled jobs.',
      scopes: inspect,
    },
    {
      name: 'deploy',
      summary: 'Inspect, plus trigger deployments and edit the deployment script.',
      scopes: [...inspect, 'site:manage-deploys'].sort(),
    },
    {
      name: 'full',
      summary: 'The entire API, including destructive and execution capabilities.',
      scopes: scopesFor(OPERATIONS),
    },
  ];
}

/** Renders the `--scopes` report. */
export function renderScopeReport(): string {
  const lines: string[] = [
    'Laravel Forge API token scopes',
    '',
    'Create a token at https://forge.laravel.com/profile/api and select its scopes. They',
    'cannot be widened afterwards — mint a new token instead.',
    '',
    'Declare the same set in FORGE_SCOPES and this server registers only the tools that',
    'token can use, so a missing scope shows up as an absent tool rather than a 403',
    'halfway through a task.',
    '',
    'PROFILES',
    '',
  ];

  for (const profile of profiles()) {
    lines.push(
      `  ${profile.name}  —  ${toolsFor(profile.scopes).length} tools, ${profile.scopes.length} scopes`,
      `  ${profile.summary}`,
      '',
      `    FORGE_SCOPES="${profile.scopes.join(',')}"`,
      '',
    );
  }

  const misleading = misleadingScopes();
  if (misleading.size > 0) {
    lines.push(
      'SCOPES THAT PERMIT MORE THAN THEIR NAME SUGGESTS',
      '',
      '  Read these before granting them. A scope ending in :view that also gates writes is',
      '  not a read-only grant, whatever it is called.',
      '',
    );

    for (const [scope, writes] of misleading) {
      lines.push(`  ${scope} also permits:`);
      for (const operation of writes) {
        const flag = operation.destructive ? ' [destructive]' : '';
        lines.push(`     ${operation.method.padEnd(6)} ${operation.name}${flag}`);
      }
      lines.push('');
    }
  }

  const counts = new Map<string, number>();
  for (const operation of OPERATIONS) {
    for (const scope of operation.scopes) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const destructive = new Set(scopesFor(OPERATIONS.filter((operation) => operation.destructive)));

  lines.push(
    'EVERY SCOPE',
    '',
    '  * unlocks a destructive or execution capability. Those tools also stay hidden unless',
    '  FORGE_MCP_ALLOW_DESTRUCTIVE=1, but withholding the scope is the stronger control:',
    '  Forge enforces it, this server only hides.',
    '',
  );

  for (const scope of Object.keys(FORGE_SCOPES).sort()) {
    const flag = destructive.has(scope) ? '*' : ' ';
    const count = counts.get(scope) ?? 0;
    const tools = count === 0 ? '  no tools' : `${String(count).padStart(3)} tools`;
    lines.push(`  ${flag} ${scope.padEnd(32)} ${tools}  ${FORGE_SCOPES[scope] ?? ''}`);
  }

  lines.push('');
  return lines.join('\n');
}
