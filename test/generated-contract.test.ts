/**
 * Contract tests for the generated operation table.
 *
 * These assert properties of `src/generated/operations.ts` that must hold for
 * the server to be correct, so a regression in the generator fails here rather
 * than silently shipping a broken tool.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OPERATIONS } from '../src/generated/operations.js';
import { buildInputSchema } from '../src/tools/schema.js';
import { loadSpecSchemas } from './helpers.js';

const schemas = loadSpecSchemas();

interface SpecDocument {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
      }
    >
  >;
}

const spec = JSON.parse(readFileSync('./spec/forge.openapi.json', 'utf8')) as SpecDocument;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every operation in the spec, keyed by operationId. */
function specOperations(): Map<string, { schema: Record<string, unknown> | undefined }> {
  const map = new Map<string, { schema: Record<string, unknown> | undefined }>();
  for (const item of Object.values(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const id = operation.operationId;
      if (id === undefined) continue;
      map.set(id, { schema: operation.requestBody?.content?.['application/json']?.schema });
    }
  }
  return map;
}

describe('generated operation table', () => {
  it('covers every operation in the spec', () => {
    expect(OPERATIONS).toHaveLength(specOperations().size);
  });

  it('captures a body schema for every operation that documents one', () => {
    const missing: string[] = [];

    for (const [operationId, { schema }] of specOperations()) {
      if (schema === undefined) continue;

      const descriptor = OPERATIONS.find((operation) => operation.operationId === operationId);
      expect(descriptor, `no descriptor for ${operationId}`).toBeDefined();

      const captured =
        descriptor?.bodySchema !== undefined || descriptor?.bodySchemaInline !== undefined;
      if (!captured) missing.push(operationId);
    }

    // Four Forge operations write the body schema inline rather than via $ref
    // (POST /servers among them). Following only $ref drops their fields.
    expect(missing).toEqual([]);
  });

  it('produces body fields for operations whose schema is inline', () => {
    const inlineOperations = OPERATIONS.filter(
      (operation) => operation.bodySchemaInline !== undefined,
    );

    expect(inlineOperations.length).toBeGreaterThan(0);

    for (const operation of inlineOperations) {
      const schema = buildInputSchema({
        pathParams: operation.pathParams,
        queryParams: operation.queryParams,
        bodySchemaName: operation.bodySchema,
        bodySchemaInline: operation.bodySchemaInline,
        bodyRequired: operation.bodyRequired,
        registry: schemas,
        requiresConfirm: operation.requiresConfirm,
        supportsWait: operation.processingMode === 'async',
      });

      const properties = Object.keys(schema['properties'] as Record<string, unknown>);
      const reserved = new Set(['confirm', 'wait']);
      const pathNames = new Set(operation.pathParams.map((param) => param.name));
      const queryNames = new Set(operation.queryParams.map((param) => param.name));

      const bodyFields = properties.filter(
        (name) => !reserved.has(name) && !pathNames.has(name) && !queryNames.has(name),
      );

      expect(bodyFields.length, `${operation.name} exposes no body fields`).toBeGreaterThan(0);
    }
  });

  it('exposes the documented fields on create_servers specifically', () => {
    const createServer = OPERATIONS.find(
      (operation) => operation.operationId === 'organizations.servers.store',
    );
    expect(createServer).toBeDefined();
    if (!createServer) return;

    const schema = buildInputSchema({
      pathParams: createServer.pathParams,
      queryParams: createServer.queryParams,
      bodySchemaName: createServer.bodySchema,
      bodySchemaInline: createServer.bodySchemaInline,
      bodyRequired: createServer.bodyRequired,
      registry: schemas,
      requiresConfirm: createServer.requiresConfirm,
      supportsWait: createServer.processingMode === 'async',
    });

    const properties = Object.keys(schema['properties'] as Record<string, unknown>);
    expect(properties).toContain('name');
  });

  it('marks a plausible number of operations destructive', () => {
    const destructive = OPERATIONS.filter((operation) => operation.destructive);

    // A sanity band, not an exact count: zero means the guard tables silently
    // stopped matching, and a very large number means the classification is
    // catching harmless operations.
    expect(destructive.length).toBeGreaterThan(5);
    expect(destructive.length).toBeLessThan(40);
  });

  it('refuses to generate when a DELETE operation is unclassified', () => {
    // Proves the classification fails CLOSED: a destructive operation added by
    // a future spec cannot ship unguarded merely by being absent from the
    // tables. Runs the real generator against a spec carrying one unknown
    // DELETE and expects it to refuse.
    const mutatedSpec = JSON.parse(readFileSync('./spec/forge.openapi.json', 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };

    mutatedSpec.paths['/orgs/{organization}/servers/{server}/fictional-resource'] = {
      delete: {
        operationId: 'organizations.servers.fictional-resource.destroy',
        summary: 'Delete a fictional resource',
        description: 'Exists only in this test.',
        tags: ['Servers'],
        'x-processingMode': 'async',
        parameters: [
          { name: 'organization', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'server', in: 'path', required: true, schema: { type: 'integer' } },
        ],
      },
    };

    const directory = mkdtempSync(join(tmpdir(), 'forge-mcp-spec-'));
    const specPath = join(directory, 'forge.openapi.json');

    try {
      writeFileSync(specPath, JSON.stringify(mutatedSpec), 'utf8');

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/generate-operations.ts'],
        { encoding: 'utf8', env: { ...process.env, FORGE_SPEC_PATH: specPath } },
      );

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status, `generator should have failed:\n${output}`).not.toBe(0);
      expect(output).toContain('organizations.servers.fictional-resource.destroy');
      expect(output).toContain('not classified');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on a resource status value it cannot classify', () => {
    // An unclassified status would make polling either hang until timeout or
    // report an in-flight operation as finished, depending on which way the
    // default fell. Neither is acceptable silently.
    const mutatedSpec = JSON.parse(readFileSync('./spec/forge.openapi.json', 'utf8')) as {
      components: {
        schemas: Record<
          string,
          { properties?: { attributes?: { properties?: Record<string, { enum?: string[] }> } } }
        >;
      };
    };

    const statusSchema =
      mutatedSpec.components.schemas['BackgroundProcessResource']?.properties?.attributes
        ?.properties?.['status'];
    expect(statusSchema?.enum, 'spec no longer declares this enum').toBeDefined();
    statusSchema?.enum?.push('hibernating');

    const directory = mkdtempSync(join(tmpdir(), 'forge-mcp-spec-'));
    const specPath = join(directory, 'forge.openapi.json');

    try {
      writeFileSync(specPath, JSON.stringify(mutatedSpec), 'utf8');

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/generate-operations.ts'],
        { encoding: 'utf8', env: { ...process.env, FORGE_SPEC_PATH: specPath } },
      );

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status, `generator should have failed:\n${output}`).not.toBe(0);
      expect(output).toContain('backgroundProcesses.hibernating');
      expect(output).toContain('not classified');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives every pollable operation a plan it can actually execute', () => {
    for (const operation of OPERATIONS) {
      const plan = operation.polling;
      if (!plan) continue;

      // Only asynchronous operations are ever polled.
      expect(operation.processingMode, `${operation.name}`).toBe('async');

      // Every placeholder in the read path must be fillable: from the
      // operation's own path parameters, or from the created resource's id.
      const placeholders = [...plan.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const available = new Set(operation.pathParams.map((param) => param.name));
      if (plan.idParam !== undefined) available.add(plan.idParam);

      for (const placeholder of placeholders) {
        expect(
          available.has(placeholder as string),
          `${operation.name} cannot fill {${placeholder}}`,
        ).toBe(true);
      }

      // An id placeholder is only meaningful when the read path declares it.
      if (plan.idParam !== undefined) {
        expect(placeholders, `${operation.name}`).toContain(plan.idParam);
        expect(operation.method, `${operation.name}`).toBe('POST');
      }
    }
  });

  it('requires confirmation for every destructive operation', () => {
    for (const operation of OPERATIONS.filter((candidate) => candidate.destructive)) {
      expect(operation.requiresConfirm, `${operation.name} is unguarded`).toBe(true);
    }
  });
});
