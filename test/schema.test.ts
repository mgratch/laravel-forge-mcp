import { describe, expect, it } from 'vitest';

import { buildInputSchema, cleanText, resolveSchema } from '../src/tools/schema.js';
import type { SchemaRegistry } from '../src/tools/schema.js';
import { loadSpecSchemas } from './helpers.js';

const specSchemas = loadSpecSchemas();

describe('cleanText', () => {
  it('strips the Mintlify processing-mode footer', () => {
    const raw = 'List all servers.\n\nProcessing mode: <small><code>sync</code></small>';
    expect(cleanText(raw)).toBe('List all servers.');
  });

  it('strips HTML and collapses whitespace', () => {
    expect(cleanText('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('returns undefined for empty or non-string input', () => {
    expect(cleanText('')).toBeUndefined();
    expect(cleanText('   ')).toBeUndefined();
    expect(cleanText(undefined)).toBeUndefined();
    expect(cleanText(42)).toBeUndefined();
  });
});

describe('resolveSchema', () => {
  const registry: SchemaRegistry = {
    Simple: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    Wrapper: { $ref: '#/components/schemas/Simple' },
    SelfReferential: {
      type: 'object',
      properties: { child: { $ref: '#/components/schemas/SelfReferential' } },
    },
  };

  it('inlines a $ref', () => {
    const result = resolveSchema({ $ref: '#/components/schemas/Simple' }, registry);
    expect(result['type']).toBe('object');
    expect(result['required']).toEqual(['name']);
  });

  it('follows a chain of refs', () => {
    const result = resolveSchema({ $ref: '#/components/schemas/Wrapper' }, registry);
    expect((result['properties'] as Record<string, unknown>)['name']).toBeDefined();
  });

  it('reports an unresolved reference instead of throwing', () => {
    const result = resolveSchema({ $ref: '#/components/schemas/Missing' }, registry);
    expect(String(result['description'])).toContain('Unresolved reference');
  });

  it('terminates on a self-referential schema', () => {
    const result = resolveSchema({ $ref: '#/components/schemas/SelfReferential' }, registry);
    expect(result).toBeTypeOf('object');
  });

  it('converts OpenAPI 3.0 nullable into a type union', () => {
    const result = resolveSchema({ type: 'string', nullable: true }, registry);
    expect(result['type']).toEqual(['string', 'null']);
  });

  it('does not duplicate null in an existing type array', () => {
    const result = resolveSchema({ type: ['string', 'null'], nullable: true }, registry);
    expect(result['type']).toEqual(['string', 'null']);
  });

  it('merges allOf branches into one object', () => {
    const result = resolveSchema(
      {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      },
      registry,
    );

    const properties = result['properties'] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['a', 'b']);
    expect((result['required'] as string[]).sort()).toEqual(['a', 'b']);
  });

  it('preserves anyOf and oneOf as unions', () => {
    const result = resolveSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }, registry);
    expect(Array.isArray(result['oneOf'])).toBe(true);
  });

  it('drops keys that are meaningless in a tool signature', () => {
    const result = resolveSchema(
      { type: 'string', example: 'web-1', readOnly: true, deprecated: true },
      registry,
    );

    expect(result['example']).toBeUndefined();
    expect(result['readOnly']).toBeUndefined();
    expect(result['deprecated']).toBeUndefined();
  });

  it('returns an empty object for a non-object input', () => {
    expect(resolveSchema('nope', registry)).toEqual({});
    expect(resolveSchema(null, registry)).toEqual({});
  });
});

describe('buildInputSchema', () => {
  const baseOptions = {
    pathParams: [
      {
        name: 'organization',
        required: true,
        description: 'Org slug.',
        schema: { type: 'string' },
      },
      { name: 'server', required: true, description: 'Server id.', schema: { type: 'integer' } },
    ],
    queryParams: [
      {
        name: 'page[size]',
        required: false,
        description: 'Items per page.',
        schema: { type: 'integer' },
      },
    ],
    bodySchemaName: undefined,
    bodyRequired: false,
    registry: specSchemas,
    requiresConfirm: false,
    supportsWait: false,
  } as const;

  it('includes path and query parameters', () => {
    const schema = buildInputSchema(baseOptions);
    const properties = schema['properties'] as Record<string, unknown>;

    expect(properties['organization']).toBeDefined();
    expect(properties['server']).toBeDefined();
    expect(properties['page[size]']).toBeDefined();
  });

  it('marks only required parameters as required', () => {
    const schema = buildInputSchema(baseOptions);
    const required = schema['required'] as string[];

    expect(required).toContain('organization');
    expect(required).toContain('server');
    expect(required).not.toContain('page[size]');
  });

  it('omits parameters the server supplies itself', () => {
    const schema = buildInputSchema({ ...baseOptions, omitParams: new Set(['organization']) });
    const properties = schema['properties'] as Record<string, unknown>;

    expect(properties['organization']).toBeUndefined();
    expect(properties['server']).toBeDefined();
  });

  it('adds a required confirm field when the operation is guarded', () => {
    const schema = buildInputSchema({ ...baseOptions, requiresConfirm: true });
    const properties = schema['properties'] as Record<string, unknown>;

    expect(properties['confirm']).toBeDefined();
    expect(schema['required'] as string[]).toContain('confirm');
  });

  it('adds an optional wait field for async operations', () => {
    const schema = buildInputSchema({ ...baseOptions, supportsWait: true });
    const properties = schema['properties'] as Record<string, unknown>;

    expect(properties['wait']).toBeDefined();
    expect(schema['required'] as string[] | undefined).not.toContain('wait');
  });

  it('lifts body properties to the top level when they cannot collide', () => {
    const schema = buildInputSchema({
      ...baseOptions,
      bodySchemaName: 'UpdateNginxConfigurationRequest',
      bodyRequired: true,
    });

    const properties = schema['properties'] as Record<string, unknown>;
    expect(properties['config']).toBeDefined();
    expect(properties['body']).toBeUndefined();
  });

  it('nests the body when a property would shadow a path parameter', () => {
    const registry: SchemaRegistry = {
      Colliding: {
        type: 'object',
        properties: { server: { type: 'string' } },
        required: ['server'],
      },
    };

    const schema = buildInputSchema({
      ...baseOptions,
      registry,
      bodySchemaName: 'Colliding',
      bodyRequired: true,
    });

    const properties = schema['properties'] as Record<string, unknown>;
    expect(properties['body']).toBeDefined();
    expect(schema['required'] as string[]).toContain('body');
    // The path parameter keeps its own meaning.
    expect((properties['server'] as Record<string, unknown>)['type']).toBe('integer');
  });

  it('forbids unknown properties', () => {
    expect(buildInputSchema(baseOptions)['additionalProperties']).toBe(false);
  });
});
