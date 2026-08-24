/**
 * Runtime validation of tool arguments against the advertised input schema.
 *
 * The MCP protocol validates the *envelope* of a `tools/call` request, not the
 * `arguments` object inside it. Without this module a tool's `inputSchema` is
 * advisory: `additionalProperties: false`, `required`, enums and types would all
 * describe the contract without enforcing it, and a client could pass a
 * parameter the tool never exposed straight through to a request body.
 *
 * Validation therefore runs before the confirmation guard and before any
 * network call, so a malformed or smuggled argument fails with a clear message
 * and issues no request.
 *
 * Schemas come from an OpenAPI 3.1 document, whose dialect is JSON Schema
 * 2020-12.
 *
 * @see https://spec.openapis.org/oas/v3.1.0#schema-object
 */

import ajvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';

// Ajv 8 and ajv-formats are published as CommonJS with `export =`. Under
// NodeNext ESM resolution the callable value lives on `.default`, while the
// type does not — hence the narrow casts here rather than at each use site.
const Ajv2020 = ajvModule as unknown as typeof ajvModule.default;
const addFormats = ajvFormatsModule as unknown as typeof ajvFormatsModule.default;
type AjvInstance = InstanceType<typeof Ajv2020>;

import { ForgeError } from '../client/errors.js';
import type { JsonSchema } from './schema.js';

/** Raised when tool arguments do not satisfy the advertised schema. */
export class ForgeValidationError extends ForgeError {
  public override readonly name: string = 'ForgeValidationError';

  public constructor(
    public readonly toolName: string,
    public readonly issues: readonly string[],
  ) {
    super(
      `Invalid arguments for "${toolName}":\n` +
        issues.map((issue) => `  - ${issue}`).join('\n') +
        '\n\nNo request was sent. Check the tool schema and try again.',
    );
  }
}

/**
 * Builds the validator.
 *
 * `strict: false` because OpenAPI schemas legitimately carry annotation keywords
 * Ajv does not recognise; rejecting them would refuse valid Forge schemas.
 * `allErrors` so a caller sees every problem at once rather than fixing them one
 * round-trip at a time.
 */
function createAjv(): AjvInstance {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    allowUnionTypes: true,
  });

  // Forge schemas use `format` for dates, emails and URIs. Without this, those
  // keywords are ignored rather than enforced.
  addFormats(ajv);

  return ajv;
}

/** Renders one Ajv error as a message a model can act on. */
function describeError(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(root)' : error.instancePath.replace(/^\//, '');

  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    return `unknown argument "${String(extra)}" — this tool does not accept it`;
  }

  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    return `missing required argument "${String(missing)}"`;
  }

  if (error.keyword === 'enum') {
    const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    return `${path} must be one of: ${allowed.map((value) => JSON.stringify(value)).join(', ')}`;
  }

  return `${path} ${error.message ?? 'is invalid'}`;
}

/**
 * Compiles each tool's schema once and validates arguments against it.
 *
 * Compilation is the expensive part, so it happens at registration rather than
 * per call.
 */
export class ArgumentValidator {
  private readonly ajv: AjvInstance;
  private readonly validators = new Map<string, ValidateFunction>();

  public constructor() {
    this.ajv = createAjv();
  }

  /**
   * Compiles and caches the validator for one tool.
   *
   * A schema Ajv cannot compile is recorded as "no validator" rather than
   * throwing at startup: refusing to serve an otherwise working tool because of
   * an unusual schema would be a worse outcome than validating it loosely. The
   * failure is surfaced to the caller so it can be logged.
   */
  public register(
    toolName: string,
    schema: JsonSchema,
  ): { readonly compiled: boolean; readonly error?: string } {
    try {
      this.validators.set(toolName, this.ajv.compile(schema));
      return { compiled: true };
    } catch (error) {
      return {
        compiled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validates arguments for a tool.
   *
   * @param ignoreMissing Property names whose absence should not fail here.
   *   Used for `confirm`, so a guarded call reports the exact confirmation
   *   phrase it needs rather than a generic "missing required argument".
   * @throws {ForgeValidationError} when the arguments do not satisfy the schema.
   */
  public assertValid(
    toolName: string,
    args: Record<string, unknown>,
    ignoreMissing: readonly string[] = [],
  ): void {
    const validate = this.validators.get(toolName);
    if (!validate) return;

    if (validate(args)) return;

    const relevant = (validate.errors ?? []).filter((error) => {
      if (error.keyword !== 'required') return true;
      const missing = (error.params as { missingProperty?: string }).missingProperty;
      return missing === undefined || !ignoreMissing.includes(missing);
    });

    if (relevant.length === 0) return;

    throw new ForgeValidationError(toolName, relevant.map(describeError));
  }

  /** Whether a compiled validator exists, for diagnostics and tests. */
  public has(toolName: string): boolean {
    return this.validators.has(toolName);
  }
}
