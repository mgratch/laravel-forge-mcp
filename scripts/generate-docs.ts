/**
 * Generates `docs/TOOLS.md` — the full tool catalog — from the operation table.
 *
 * Keeping the catalog generated means the documented surface and the registered
 * surface cannot disagree; CI fails if the committed file is stale.
 *
 * Run: npm run docs
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPERATIONS } from '../src/generated/operations.js';
import type { OperationDescriptor } from '../src/tools/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, '../docs/TOOLS.md');

/** Anchor for the human-readable docs covering each OpenAPI tag. */
const TAG_DOC_LINKS: Record<string, string> = {
  Servers: 'https://forge.laravel.com/docs/servers/the-basics',
  Sites: 'https://forge.laravel.com/docs/sites/the-basics',
  Deployments: 'https://forge.laravel.com/docs/sites/deployments',
  Databases: 'https://forge.laravel.com/docs/resources/databases',
  Backups: 'https://forge.laravel.com/docs/resources/database-backups',
  'Scheduled Jobs': 'https://forge.laravel.com/docs/resources/scheduler',
  'Background Processes': 'https://forge.laravel.com/docs/resources/background-processes',
  Nginx: 'https://forge.laravel.com/docs/servers/nginx-templates',
  Logs: 'https://forge.laravel.com/docs/sites/logs',
  Commands: 'https://forge.laravel.com/docs/sites/commands',
  Monitors: 'https://forge.laravel.com/docs/servers/monitoring',
  'Firewall Rules': 'https://forge.laravel.com/docs/resources/network',
  'Security Rules': 'https://forge.laravel.com/docs/sites/network',
  'Redirect Rules': 'https://forge.laravel.com/docs/sites/network',
  'SSH Keys': 'https://forge.laravel.com/docs/ssh',
  Recipes: 'https://forge.laravel.com/docs/recipes',
  Organizations: 'https://forge.laravel.com/docs/organizations',
  Teams: 'https://forge.laravel.com/docs/teams',
  'Storage Providers': 'https://forge.laravel.com/docs/storage-providers',
  Providers: 'https://forge.laravel.com/docs/server-providers',
};

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function renderRow(operation: OperationDescriptor): string {
  const flags: string[] = [];
  if (operation.destructive) flags.push('**destructive**');
  else if (operation.requiresConfirm) flags.push('**confirm**');
  if (operation.processingMode === 'async') flags.push('async');

  return [
    '',
    `\`${operation.name}\``,
    `\`${operation.method} ${operation.path}\``,
    escapePipes(truncate(operation.summary, 80)),
    flags.join(', ') || '—',
    '',
  ].join(' | ');
}

function main(): void {
  const byTag = new Map<string, OperationDescriptor[]>();
  for (const operation of OPERATIONS) {
    const bucket = byTag.get(operation.tag) ?? [];
    bucket.push(operation);
    byTag.set(operation.tag, bucket);
  }

  const destructive = OPERATIONS.filter((operation) => operation.destructive);
  const confirmOnly = OPERATIONS.filter(
    (operation) => operation.requiresConfirm && !operation.destructive,
  );
  const asyncCount = OPERATIONS.filter((operation) => operation.processingMode === 'async').length;

  const lines: string[] = [
    '<!-- GENERATED FILE — run `npm run docs` to regenerate. -->',
    '',
    '# Tool catalog',
    '',
    `Every tool below maps to exactly one operation in the [Laravel Forge API](https://forge.laravel.com/docs/api-reference/introduction).`,
    '',
    `- **${OPERATIONS.length}** tools total`,
    `- **${asyncCount}** are asynchronous and accept \`wait: true\` to poll until the operation settles`,
    `- **${destructive.length}** are destructive and registered only when \`FORGE_MCP_ALLOW_DESTRUCTIVE=1\``,
    `- **${destructive.length + confirmOnly.length}** require a matching \`confirm\` argument`,
    '',
    '## Argument conventions',
    '',
    'Path parameters, query parameters and request-body fields are flattened into a single',
    'argument object. When a body field would collide with a path or query parameter, the body is',
    'nested under a `body` object instead.',
    '',
    '| Argument | Applies to | Meaning |',
    '| --- | --- | --- |',
    '| `organization` | every org-scoped tool | Organization **slug**. Omitted from the schema when `FORGE_ORGANIZATION` is set. |',
    '| `page[size]`, `page[cursor]` | list tools | [Cursor pagination](https://forge.laravel.com/docs/api-reference/pagination). Default page size is 30; there is no total count. |',
    '| `filter[…]` | list tools | [Exact-match filters](https://forge.laravel.com/docs/api-reference/filtering). No operators. |',
    '| `sort` | list tools | Field name, `-` prefix to reverse, comma-separated for multiple. |',
    '| `include` | a few list tools | [Relationship includes](https://forge.laravel.com/docs/api-reference/relationships). |',
    '| `wait` | async tools | Poll the resource until it reaches a terminal state. Costs extra requests. |',
    '| `confirm` | guarded tools | Must equal `"<METHOD> <param>=<value> …"` naming the target, e.g. `"DELETE server=12345"`. |',
    '',
  ];

  if (destructive.length > 0) {
    lines.push(
      '## Destructive tools',
      '',
      'These are hidden unless `FORGE_MCP_ALLOW_DESTRUCTIVE=1`, and always require `confirm`.',
      '',
      '| Tool | Endpoint |',
      '| --- | --- |',
      ...destructive.map(
        (operation) => `| \`${operation.name}\` | \`${operation.method} ${operation.path}\` |`,
      ),
      '',
    );
  }

  if (confirmOnly.length > 0) {
    lines.push(
      '## Confirmation-gated tools',
      '',
      'Not deletions, but able to interrupt a live service — stopping nginx has no `start`',
      'counterpart in the API, so a mistake is not trivially reversible.',
      '',
      '| Tool | Endpoint |',
      '| --- | --- |',
      ...confirmOnly.map(
        (operation) => `| \`${operation.name}\` | \`${operation.method} ${operation.path}\` |`,
      ),
      '',
    );
  }

  lines.push('## All tools by resource', '');

  for (const tag of [...byTag.keys()].sort()) {
    const operations = byTag.get(tag) ?? [];
    const docLink = TAG_DOC_LINKS[tag];

    lines.push(
      `### ${tag}`,
      '',
      ...(docLink === undefined ? [] : [`Forge documentation: ${docLink}`, '']),
      '| Tool | Endpoint | Summary | Flags |',
      '| --- | --- | --- | --- |',
      ...operations.map(renderRow).map((row) => row.trim()),
      '',
    );
  }

  writeFileSync(OUT_PATH, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`Wrote ${OPERATIONS.length} tools -> ${OUT_PATH}\n`);
}

main();
