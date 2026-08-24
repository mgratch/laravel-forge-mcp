/**
 * Flattens Forge's JSON:API responses into plain objects.
 *
 * The API answers with `application/vnd.api+json`, shaped as:
 *
 * ```json
 * { "data": { "id": "1", "type": "servers", "attributes": { "name": "web-1" },
 *             "relationships": { ... }, "links": { "self": { ... } } } }
 * ```
 *
 * Handing that envelope to a language model wastes tokens on structure and
 * buries the fields it needs. This module lifts `attributes` to the top level
 * alongside `id` and `type`, so the model sees `{ id, type, name, ... }`.
 *
 * @see https://forge.laravel.com/docs/api-reference/relationships
 */

/** A JSON:API resource object. */
interface JsonApiResource {
  id?: string | number;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
  links?: unknown;
  meta?: unknown;
}

interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[] | null;
  meta?: Record<string, unknown>;
  links?: Record<string, unknown>;
  included?: JsonApiResource[];
  errors?: unknown;
}

/** A flattened resource: identity merged with its attributes. */
export type FlatResource = Record<string, unknown>;

/** Result of normalising a response body. */
export interface NormalizedResponse {
  /** The flattened resource, or array of resources. `null` for empty bodies. */
  readonly data: FlatResource | FlatResource[] | null;
  /** Response `meta`, carrying pagination cursors when present. */
  readonly meta: Record<string, unknown> | undefined;
  /** Response `links`, carrying `next`/`prev` URLs when present. */
  readonly links: Record<string, unknown> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a value looks like a JSON:API document.
 *
 * A handful of Forge endpoints answer with plain JSON rather than
 * `vnd.api+json`, so detection is by shape rather than by content type.
 */
function isJsonApiDocument(value: unknown): value is JsonApiDocument {
  if (!isRecord(value)) return false;
  if (!('data' in value)) return false;

  const data = value['data'];
  if (data === null) return true;
  if (Array.isArray(data)) return data.every((item) => isRecord(item));
  return isRecord(data);
}

/** Merges a resource's identity and attributes into one flat object. */
function flattenResource(resource: JsonApiResource): FlatResource {
  const flat: FlatResource = {};

  if (resource.id !== undefined) flat['id'] = resource.id;
  if (resource.type !== undefined) flat['type'] = resource.type;

  if (isRecord(resource.attributes)) {
    for (const [key, value] of Object.entries(resource.attributes)) {
      // Identity wins: an attribute literally named "id" or "type" would
      // otherwise mask the resource's own identifiers.
      if (key === 'id' || key === 'type') {
        flat[`attribute_${key}`] = value;
        continue;
      }
      flat[key] = value;
    }
  }

  // Relationships are kept but not expanded — expansion is the API's job, via
  // the `include` query parameter.
  if (isRecord(resource.relationships) && Object.keys(resource.relationships).length > 0) {
    flat['relationships'] = resource.relationships;
  }

  return flat;
}

/**
 * Normalises any Forge response body.
 *
 * Non-JSON:API bodies pass through untouched, so plain-JSON and string
 * responses are safe to hand to this function.
 */
export function normalizeResponse(body: unknown): NormalizedResponse {
  if (!isJsonApiDocument(body)) {
    return {
      data: (body ?? null) as FlatResource | FlatResource[] | null,
      meta: undefined,
      links: undefined,
    };
  }

  const { data, meta, links } = body;

  const flattened: FlatResource | FlatResource[] | null =
    data === null || data === undefined
      ? null
      : Array.isArray(data)
        ? data.map(flattenResource)
        : flattenResource(data);

  return {
    data: flattened,
    meta: isRecord(meta) ? meta : undefined,
    links: isRecord(links) ? links : undefined,
  };
}

/**
 * Extracts the next-page cursor from a response.
 *
 * Forge paginates by opaque cursor, not page number: `meta.next_cursor` is fed
 * back as `page[cursor]`. A `null` cursor means the last page.
 *
 * @see https://forge.laravel.com/docs/api-reference/pagination
 */
export function extractNextCursor(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const cursor = meta['next_cursor'];
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}
