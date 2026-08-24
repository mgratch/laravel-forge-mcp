/**
 * Refreshes the vendored OpenAPI document and everything derived from it.
 *
 * One command, because a multi-step refresh is a refresh people get wrong:
 * download, sanity-check, replace atomically, regenerate operations and docs.
 * The generator's own fail-closed checks then decide whether the new spec is
 * safe to ship — an unclassified mutation stops the refresh here rather than
 * shipping unguarded.
 *
 * Run: npm run refresh-spec
 */

import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(HERE, '../spec/forge.openapi.json');
const SPEC_URL = 'https://forge.laravel.com/api/docs.openapi';

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, unknown>;
}

/** Refuses obviously broken downloads before they replace a working spec. */
function assertUsable(document: unknown): asserts document is OpenApiDocument {
  if (typeof document !== 'object' || document === null) {
    throw new Error('Downloaded spec is not a JSON object.');
  }

  const candidate = document as OpenApiDocument;

  if (typeof candidate.openapi !== 'string' || !candidate.openapi.startsWith('3.')) {
    throw new Error(`Unexpected OpenAPI version: ${String(candidate.openapi)}`);
  }

  const pathCount = Object.keys(candidate.paths ?? {}).length;
  if (pathCount < 50) {
    throw new Error(
      `Downloaded spec declares only ${pathCount} paths, which looks truncated. ` +
        'The vendored spec was left unchanged.',
    );
  }
}

async function main(): Promise<void> {
  process.stdout.write(`Downloading ${SPEC_URL}\n`);

  const response = await fetch(SPEC_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const document: unknown = await response.json();
  assertUsable(document);

  const pathCount = Object.keys(document.paths ?? {}).length;
  process.stdout.write(
    `Validated: OpenAPI ${String(document.openapi)}, ` +
      `${String(document.info?.title)} ${String(document.info?.version)}, ${pathCount} paths\n`,
  );

  // Write beside the target then rename, so an interrupted run cannot leave a
  // half-written spec in place.
  const temporaryPath = `${SPEC_PATH}.download`;
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, SPEC_PATH);

  const run = (script: string): void => {
    process.stdout.write(`\n> npm run ${script}\n`);
    execFileSync('npm', ['run', script], { stdio: 'inherit', cwd: resolve(HERE, '..') });
  };

  run('generate');
  run('docs');

  process.stdout.write(
    '\nSpec refreshed. Review the diff — new mutating operations must be classified ' +
      'in scripts/generate-operations.ts, and generation fails until they are.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
