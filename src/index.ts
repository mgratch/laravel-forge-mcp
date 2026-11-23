#!/usr/bin/env node
/**
 * laravel-forge-mcp — a Model Context Protocol server for the Laravel Forge API.
 *
 * Every tool is generated from Forge's own OpenAPI document, so the surface
 * cannot drift from the API.
 *
 * @see https://forge.laravel.com/docs/api-reference/introduction
 * @see https://github.com/mgratch/laravel-forge-mcp
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ForgeError } from './client/errors.js';
import { loadConfig } from './config.js';
import { renderScopeReport } from './scopes.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import type { SchemaRegistry } from './tools/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Loads `components.schemas` from the vendored OpenAPI document.
 *
 * The spec ships with the package (see `files` in package.json) so tool
 * schemas never depend on network access at startup.
 */
function loadSchemas(): SchemaRegistry {
  // `dist/index.js` and `src/index.ts` sit one level below the package root.
  const specPath = resolve(HERE, '../spec/forge.openapi.json');
  const raw = readFileSync(specPath, 'utf8');
  const document = JSON.parse(raw) as { components?: { schemas?: SchemaRegistry } };
  return document.components?.schemas ?? {};
}

async function main(): Promise<void> {
  // A reporting flag, not a server mode: it needs no token and starts no
  // transport, so it can be run before anyone has credentials at all.
  if (process.argv.includes('--scopes')) {
    process.stdout.write(renderScopeReport());
    return;
  }

  const config = loadConfig();
  const schemas = loadSchemas();

  const { server, tools } = createServer({ config, schemas });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP transport — diagnostics must go to stderr.
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready — ${tools.length} tools` +
      (config.allowDestructive ? ' (destructive operations enabled)' : '') +
      (config.organization === undefined ? '' : ` — org "${config.organization}"`) +
      (config.scopes === undefined ? '' : ` — ${config.scopes.size} scopes declared`) +
      '\n',
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof ForgeError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);

  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
});
