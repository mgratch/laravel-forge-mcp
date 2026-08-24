/**
 * Shared types describing a single Forge API operation and how it becomes an
 * MCP tool.
 *
 * These types are consumed by both the generator (which writes
 * `src/generated/operations.ts`) and the runtime (which turns each descriptor
 * into a registered tool), so they are the contract between the two.
 */

/** HTTP methods used by the Forge API. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Whether Forge completes the operation before responding.
 *
 * `async` operations return `202 Accepted`, usually with no body; the caller
 * must poll the affected resource to observe completion. 105 of the 273
 * documented operations are async.
 *
 * @see https://forge.laravel.com/docs/api-reference/introduction
 */
export type ProcessingMode = 'sync' | 'async';

/** A path or query parameter, carried through from the OpenAPI document. */
export interface OperationParameter {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  /** Raw JSON Schema fragment from the OpenAPI document. */
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * One Forge API operation, flattened into everything the runtime needs to
 * expose it as a tool. Generated — see `scripts/generate-operations.ts`.
 */
export interface OperationDescriptor {
  /** snake_case MCP tool name, unique across the server. */
  readonly name: string;
  /** Laravel route name from the OpenAPI document, e.g. `organizations.servers.index`. */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Path template with `{param}` placeholders, relative to the API base URL. */
  readonly path: string;
  /** OpenAPI tag, used to group tools in the generated documentation. */
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly processingMode: ProcessingMode;
  readonly pathParams: readonly OperationParameter[];
  readonly queryParams: readonly OperationParameter[];
  /**
   * Name of the request body schema in `components.schemas`, when the operation
   * references one.
   */
  readonly bodySchema: string | undefined;
  /**
   * The request body schema written inline in the OpenAPI document rather than
   * referenced by name.
   *
   * Four Forge operations do this — including `POST .../servers`, which creates
   * a machine — so an implementation that only follows `$ref` silently produces
   * tools with no body fields at all.
   */
  readonly bodySchemaInline: Readonly<Record<string, unknown>> | undefined;
  readonly bodyRequired: boolean;
  /**
   * Destroys infrastructure or irreversibly removes data. Registered only when
   * `FORGE_MCP_ALLOW_DESTRUCTIVE=1`.
   */
  readonly destructive: boolean;
  /** Requires a `confirm` argument echoing the target before it will run. */
  readonly requiresConfirm: boolean;
}
