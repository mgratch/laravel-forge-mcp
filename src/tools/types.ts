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
 * How an asynchronous operation is observed reaching completion.
 *
 * `status` re-reads the resource until its `status`/`state` settles.
 * `absence` re-reads it until the API answers 404, which is the only signal a
 * deletion gives — several deletable Forge resources report no status at all.
 * `readiness` waits for `is_ready`, which is how `ServerResource` — and so
 * server provisioning, the longest-running operation in the API — reports
 * completion, having no status field at all.
 */
export type PollCompletion = 'status' | 'absence' | 'readiness';

/**
 * Everything the runtime needs to poll one operation to completion.
 *
 * A plan rather than a boolean flag, because three things vary per operation
 * and none of them can be recovered at runtime: which path reads the affected
 * resource, which placeholder in that path the created resource's id fills, and
 * whether completion means "settled" or "gone".
 */
export interface PollingPlan {
  /** Read-path template, with `{param}` placeholders. */
  readonly path: string;
  /**
   * Placeholder in `path` filled from the created resource's `data.id`.
   *
   * Set for creates, whose read path is the item route beneath the collection
   * they posted to and therefore carries one placeholder the request itself
   * never supplied. Forge does not always return a `self` link — a
   * `BackgroundProcessResource`, for instance, requires only `id` and `type` —
   * so rendering this template with the returned id is what makes the new
   * resource addressable.
   */
  readonly idParam?: string;
  readonly completion: PollCompletion;
  /**
   * JSON:API resource type, selecting the status vocabulary.
   *
   * `undefined` when the read path's response does not declare one, in which
   * case the default vocabulary applies.
   */
  readonly resourceType?: string;
  /**
   * Postcondition proving *this* invocation took effect.
   *
   * A `202` says Forge accepted the work, not that it has begun. Polling a
   * resource that already existed can otherwise read its pre-operation steady
   * state and mistake it for completion — enabling maintenance mode reads
   * `enabled: false` before it reads `enabling`. Creates cannot hit this (the
   * resource is new) and deletions cannot either (a 404 is unambiguous), so
   * this is set exactly on the mutations that need it, and the generator
   * refuses to plan such an operation without one.
   */
  readonly expect?: { readonly field: string; readonly equals: unknown };
  /** How long to keep polling before giving up. */
  readonly timeoutMs: number;
  /** Delay between the first two polls. */
  readonly initialIntervalMs: number;
  /** Upper bound on the backoff interval. */
  readonly maxIntervalMs: number;
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
   * Request-body fields that identify or change this operation's target.
   *
   * Appended to the confirmation phrase. Needed because several guarded
   * operations select their target in the body rather than the path — archiving
   * a server and restoring a backup among them — so a phrase built from path
   * ids alone would be identical for every target.
   */
  readonly confirmationTargetFields: readonly string[];
  /**
   * OAuth scopes this operation requires, as the document declares them.
   *
   * Empty for the thirteen read-only reference endpoints (providers, regions,
   * sizes, predefined roles, permissions) that any token may read.
   *
   * This is the only privilege boundary Forge enforces *server-side*: a token
   * is minted with a chosen scope set, so one without `server:delete` cannot
   * delete a server whatever the client does. `FORGE_MCP_ALLOW_DESTRUCTIVE`
   * and the confirmation phrases sit on top of that as ergonomics, not as the
   * wall.
   */
  readonly scopes: readonly string[];
  /**
   * Whether the confirmation phrase binds the whole request body by digest.
   *
   * True for every guarded operation that accepts a body. Enumerating "the
   * fields that matter" is a losing game: one omission lets the approved effect
   * change, and a recipe approved to run as `forge` could be sent as `root`
   * because only its script was bound. Digesting the canonical body binds every
   * field, present and future, without putting secrets into the phrase.
   */
  readonly confirmBindsBody: boolean;
  /**
   * Whether repeating this request has the same effect as sending it once.
   *
   * Derived from the HTTP method per RFC 9110, then corrected per operation:
   * Forge uses PUT for two credential *regenerations*, where a retry after an
   * ambiguous failure mints a second credential. Drives both the retry decision
   * and the `idempotentHint` advertised to MCP clients, so the two cannot
   * drift.
   *
   * @see https://www.rfc-editor.org/rfc/rfc9110#name-idempotent-methods
   */
  readonly idempotent: boolean;
  /**
   * How completion is observed, or `undefined` when it cannot be.
   *
   * Derived from the document rather than inferred from the HTTP method, which
   * is wrong in both directions — see the generator.
   */
  readonly polling: PollingPlan | undefined;
  /**
   * Destroys infrastructure or irreversibly removes data. Registered only when
   * `FORGE_MCP_ALLOW_DESTRUCTIVE=1`.
   */
  readonly destructive: boolean;
  /** Requires a `confirm` argument echoing the target before it will run. */
  readonly requiresConfirm: boolean;
}
