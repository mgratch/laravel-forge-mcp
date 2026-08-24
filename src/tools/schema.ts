/**
 * Converts OpenAPI 3.1 schema fragments into JSON Schema suitable for an MCP
 * tool's `inputSchema`.
 *
 * The Forge document is already JSON Schema at heart, so most of this is
 * pass-through. What it must fix are the places OpenAPI and the JSON Schema
 * dialect MCP clients expect diverge, and the places where a raw copy would
 * produce an unusable tool signature:
 *
 *   - `$ref` pointers must be resolved, because the tool schema travels alone.
 *   - Recursive `$ref` cycles must not hang the resolver.
 *   - `nullable: true` (OpenAPI 3.0 style) becomes a type union.
 *   - Descriptions carry the Mintlify HTML footer, which is stripped.
 */

import type { OperationParameter } from './types.js';

/** A JSON Schema object, loose enough to carry any OpenAPI fragment. */
export type JsonSchema = Record<string, unknown>;

/** The `components.schemas` map from the OpenAPI document. */
export type SchemaRegistry = Readonly<Record<string, JsonSchema>>;

/** Guards against unbounded recursion on self-referential schemas. */
const MAX_RESOLUTION_DEPTH = 12;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips the Mintlify processing-mode footer and any HTML tags. */
export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/Processing mode:\s*<small><code>\w+<\/code><\/small>/gi, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

/**
 * Inlines `$ref` pointers and normalises OpenAPI-isms.
 *
 * @param schema   Fragment to resolve.
 * @param registry `components.schemas` from the document.
 * @param depth    Current recursion depth; beyond the cap, the reference is
 *                 replaced with a permissive object so the tool stays usable.
 */
export function resolveSchema(schema: unknown, registry: SchemaRegistry, depth = 0): JsonSchema {
  if (!isRecord(schema)) return {};

  if (depth > MAX_RESOLUTION_DEPTH) {
    return { type: 'object', description: 'Recursive schema truncated.' };
  }

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    const target = registry[name];
    if (!target) return { type: 'object', description: `Unresolved reference: ${ref}` };

    // Sibling keys alongside a $ref (description, etc.) override the target's.
    const { $ref: _discard, ...siblings } = schema;
    return { ...resolveSchema(target, registry, depth + 1), ...stripUnsupported(siblings) };
  }

  const output: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case 'properties': {
        if (!isRecord(value)) break;
        const properties: JsonSchema = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          properties[propName] = resolveSchema(propSchema, registry, depth + 1);
        }
        output['properties'] = properties;
        break;
      }

      case 'items':
        output['items'] = resolveSchema(value, registry, depth + 1);
        break;

      case 'allOf':
      case 'anyOf':
      case 'oneOf': {
        if (!Array.isArray(value)) break;
        const branches = value.map((branch) => resolveSchema(branch, registry, depth + 1));

        // `allOf` is merged rather than passed through: many MCP clients do not
        // implement schema composition, and the Forge document uses `allOf`
        // only to extend a base object.
        if (key === 'allOf') {
          Object.assign(output, mergeAllOf(branches));
          break;
        }

        output[key] = branches;
        break;
      }

      case 'nullable': {
        // OpenAPI 3.0 style. 3.1 uses a type array, which is what MCP clients
        // understand, so translate.
        if (value !== true) break;
        const existingType = output['type'] ?? schema['type'];
        if (typeof existingType === 'string') {
          output['type'] = [existingType, 'null'];
        } else if (Array.isArray(existingType)) {
          const types = (existingType as unknown[]).filter(
            (entry): entry is string => typeof entry === 'string',
          );
          if (!types.includes('null')) output['type'] = [...types, 'null'];
        }
        break;
      }

      case 'description': {
        const cleaned = cleanText(value);
        if (cleaned !== undefined) output['description'] = cleaned;
        break;
      }

      case 'example':
      case 'examples':
      case 'xml':
      case 'externalDocs':
      case 'discriminator':
      case 'deprecated':
      case 'readOnly':
      case 'writeOnly':
        // Not meaningful in a tool signature; dropped to keep schemas small.
        break;

      default:
        output[key] = value;
    }
  }

  // `nullable` may have been processed before `type` was copied.
  if (schema['nullable'] === true && output['type'] === undefined) {
    const type = schema['type'];
    if (typeof type === 'string') output['type'] = [type, 'null'];
  }

  return output;
}

/** Shallow-merges `allOf` branches, concatenating `required` and `properties`. */
function mergeAllOf(branches: JsonSchema[]): JsonSchema {
  const merged: JsonSchema = {};
  const properties: JsonSchema = {};
  const required = new Set<string>();

  for (const branch of branches) {
    for (const [key, value] of Object.entries(branch)) {
      if (key === 'properties' && isRecord(value)) {
        Object.assign(properties, value);
        continue;
      }
      if (key === 'required' && Array.isArray(value)) {
        for (const name of value as unknown[]) {
          if (typeof name === 'string') required.add(name);
        }
        continue;
      }
      merged[key] = value;
    }
  }

  if (Object.keys(properties).length > 0) merged['properties'] = properties;
  if (required.size > 0) merged['required'] = [...required];
  if (merged['type'] === undefined && Object.keys(properties).length > 0) {
    merged['type'] = 'object';
  }

  return merged;
}

/** Removes keys that are not valid JSON Schema in a tool signature. */
function stripUnsupported(schema: JsonSchema): JsonSchema {
  const { example: _e, examples: _es, xml: _x, ...rest } = schema;
  return rest;
}

/**
 * Builds the complete `inputSchema` for one operation.
 *
 * Path parameters, query parameters and the request body are flattened into a
 * single object, because MCP tools take one argument object. Body properties
 * are lifted to the top level when they cannot collide with a path or query
 * parameter, and nested under `body` when they could — collisions are rare but
 * silent corruption would be worse than an extra level of nesting.
 */
export function buildInputSchema(options: {
  readonly pathParams: readonly OperationParameter[];
  readonly queryParams: readonly OperationParameter[];
  readonly bodySchemaName: string | undefined;
  /** Inline body schema, for operations that do not use a `$ref`. */
  readonly bodySchemaInline?: Readonly<Record<string, unknown>> | undefined;
  readonly bodyRequired: boolean;
  readonly registry: SchemaRegistry;
  readonly omitParams?: ReadonlySet<string>;
  readonly requiresConfirm: boolean;
  readonly confirmDescription?: string;
  readonly supportsWait: boolean;
}): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  const omit = options.omitParams ?? new Set<string>();

  for (const param of options.pathParams) {
    if (omit.has(param.name)) continue;
    properties[param.name] = {
      ...resolveSchema(param.schema, options.registry),
      ...(param.description === '' ? {} : { description: param.description }),
    };
    if (param.required) required.push(param.name);
  }

  for (const param of options.queryParams) {
    if (omit.has(param.name)) continue;
    properties[param.name] = {
      ...resolveSchema(param.schema, options.registry),
      ...(param.description === '' ? {} : { description: param.description }),
    };
    if (param.required) required.push(param.name);
  }

  const rawBodySchema =
    options.bodySchemaName !== undefined
      ? { $ref: `#/components/schemas/${options.bodySchemaName}` }
      : options.bodySchemaInline;

  if (rawBodySchema !== undefined) {
    const bodySchema = resolveSchema(rawBodySchema, options.registry);

    const bodyProperties = isRecord(bodySchema['properties']) ? bodySchema['properties'] : {};
    const bodyRequired = Array.isArray(bodySchema['required'])
      ? bodySchema['required'].filter((name): name is string => typeof name === 'string')
      : [];

    const collides = Object.keys(bodyProperties).some((name) => name in properties);

    if (collides) {
      properties['body'] = bodySchema;
      if (options.bodyRequired) required.push('body');
    } else {
      Object.assign(properties, bodyProperties);
      if (options.bodyRequired) required.push(...bodyRequired);
    }
  }

  if (options.requiresConfirm) {
    properties['confirm'] = {
      type: 'string',
      description:
        options.confirmDescription ??
        'Required confirmation. Must exactly match the phrase given in the tool description.',
    };
    required.push('confirm');
  }

  if (options.supportsWait) {
    properties['wait'] = {
      type: 'boolean',
      default: false,
      description:
        'Poll the affected resource until it reaches a terminal state before returning. ' +
        'Costs additional requests against the 60/minute budget.',
    };
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
    additionalProperties: false,
  };
}
