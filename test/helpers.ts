/**
 * Test helpers.
 *
 * No test in this suite touches the network. `stubFetch` returns a `fetch`
 * implementation backed by a queue of canned responses, and records every
 * request so assertions can inspect the exact URL, headers and body sent.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SchemaRegistry } from '../src/tools/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A canned response for the stubbed fetch. */
export interface StubResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Throw instead of responding, to exercise network-failure paths. */
  readonly throws?: Error;
}

/** One recorded outbound request. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FetchStub {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
  /** Responses still queued — a non-empty array at test end means an unused stub. */
  readonly remaining: () => number;
}

/**
 * Builds a `fetch` that replays `responses` in order.
 *
 * Running out of queued responses throws, so an unexpected extra request fails
 * loudly rather than hanging or returning undefined.
 */
/** Reads the target URL from any of the three shapes `fetch` accepts. */
function readUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function stubFetch(responses: readonly StubResponse[]): FetchStub {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];

  type FetchInput = Parameters<typeof globalThis.fetch>[0];

  const fetchImpl = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = readUrl(input);

    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders !== undefined) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }

    let parsedBody: unknown;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body) as unknown;
      } catch {
        parsedBody = init.body;
      }
    }

    requests.push({ url, method: init?.method ?? 'GET', headers, body: parsedBody });

    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(`stubFetch: unexpected request ${init?.method ?? 'GET'} ${url}`),
      );
    }
    if (next.throws) return Promise.reject(next.throws);

    const status = next.status ?? 200;
    const payload = next.body === undefined ? '' : JSON.stringify(next.body);

    return Promise.resolve(
      new Response(status === 204 || payload === '' ? null : payload, {
        status,
        headers: { 'content-type': 'application/vnd.api+json', ...next.headers },
      }),
    );
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, requests, remaining: () => queue.length };
}

/** A sleep that resolves immediately, so retry/poll tests do not take real time. */
export const instantSleep = async (): Promise<void> => {
  await Promise.resolve();
};

/** Wraps a value in Forge's JSON:API single-resource envelope. */
export function jsonApiResource(
  type: string,
  id: string | number,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return { data: { id: String(id), type, attributes } };
}

/** Wraps values in Forge's JSON:API collection envelope, with cursor meta. */
export function jsonApiCollection(
  type: string,
  items: ReadonlyArray<{ id: string | number; attributes: Record<string, unknown> }>,
  meta: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: items.map((item) => ({ id: String(item.id), type, attributes: item.attributes })),
    meta: { per_page: 30, next_cursor: null, prev_cursor: null, ...meta },
  };
}

/** Loads `components.schemas` from the vendored spec, for schema-building tests. */
export function loadSpecSchemas(): SchemaRegistry {
  const specPath = resolve(HERE, '../spec/forge.openapi.json');
  const document = JSON.parse(readFileSync(specPath, 'utf8')) as {
    components?: { schemas?: SchemaRegistry };
  };
  return document.components?.schemas ?? {};
}

/** Counts operations in the vendored spec, so tests need no hardcoded total. */
export function countSpecOperations(): number {
  const specPath = resolve(HERE, '../spec/forge.openapi.json');
  const document = JSON.parse(readFileSync(specPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  let total = 0;
  for (const item of Object.values(document.paths)) {
    for (const method of Object.keys(item)) {
      if (methods.has(method)) total += 1;
    }
  }
  return total;
}
