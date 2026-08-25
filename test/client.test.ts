import { describe, expect, it } from 'vitest';

import {
  ForgeApiError,
  ForgeConfigurationError,
  ForgePollTimeoutError,
  ForgeRateLimitError,
} from '../src/client/errors.js';
import { ForgeClient } from '../src/client/http.js';
import { extractNextCursor, extractSelfLink, normalizeResponse } from '../src/client/jsonapi.js';
import { pollUntilTerminal } from '../src/client/polling.js';
import {
  RateLimiter,
  parseRateLimitHeaders,
  parseRetryAfterSeconds,
} from '../src/client/rate-limit.js';
import { instantSleep, jsonApiCollection, jsonApiResource, stubFetch } from './helpers.js';

const API_KEY = 'test-token';

function makeClient(
  stub: ReturnType<typeof stubFetch>,
  overrides: Record<string, unknown> = {},
): ForgeClient {
  return new ForgeClient({
    apiKey: API_KEY,
    fetch: stub.fetch,
    sleep: instantSleep,
    rateLimiter: new RateLimiter({ sleep: instantSleep }),
    ...overrides,
  });
}

describe('ForgeClient construction', () => {
  it('refuses to build without an API token', () => {
    expect(() => new ForgeClient({ apiKey: '' })).toThrow(ForgeConfigurationError);
    expect(() => new ForgeClient({ apiKey: '   ' })).toThrow(ForgeConfigurationError);
  });

  it('points at the base URL declared by the OpenAPI document', async () => {
    const stub = stubFetch([{ body: jsonApiResource('servers', 1, { name: 'web-1' }) }]);
    await makeClient(stub).request({ method: 'GET', path: '/orgs/acme/servers/1' });

    expect(stub.requests[0]?.url).toBe('https://forge.laravel.com/api/orgs/acme/servers/1');
  });

  it('strips a trailing slash from a custom base URL', async () => {
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub, { baseUrl: 'https://example.test/api/' }).request({
      method: 'GET',
      path: '/orgs/acme/servers',
    });

    expect(stub.requests[0]?.url).toBe('https://example.test/api/orgs/acme/servers');
  });
});

describe('request headers', () => {
  it('sends bearer auth and the documented Accept header', async () => {
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub).request({ method: 'GET', path: '/user' });

    const headers = stub.requests[0]?.headers ?? {};
    expect(headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(headers['accept']).toBe('application/json');
  });

  it('sends Content-Type even without a body, as the docs require', async () => {
    // Forge documents Accept and Content-Type as required on every request.
    // @see https://forge.laravel.com/docs/api-reference/introduction
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub).request({ method: 'GET', path: '/user' });

    expect(stub.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('sends Content-Type and a JSON body on writes', async () => {
    const stub = stubFetch([{ status: 202 }]);
    await makeClient(stub).request({
      method: 'PUT',
      path: '/orgs/acme/servers/1/sites/2/nginx',
      body: { config: 'server { }' },
    });

    expect(stub.requests[0]?.headers['content-type']).toBe('application/json');
    expect(stub.requests[0]?.body).toEqual({ config: 'server { }' });
  });
});

describe('query parameters', () => {
  it('serialises query values and drops undefined', async () => {
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub).request({
      method: 'GET',
      path: '/orgs/acme/servers',
      query: { 'page[size]': 30, 'filter[name]': 'web-1', 'filter[status]': undefined },
    });

    const url = new URL(stub.requests[0]?.url ?? '');
    expect(url.searchParams.get('page[size]')).toBe('30');
    expect(url.searchParams.get('filter[name]')).toBe('web-1');
    expect(url.searchParams.has('filter[status]')).toBe(false);
  });
});

describe('error mapping', () => {
  it('raises ForgeApiError with the status and Forge message', async () => {
    const stub = stubFetch([{ status: 404, body: { message: 'Server not found.' } }]);

    await expect(
      makeClient(stub).request({ method: 'GET', path: '/orgs/acme/servers/999' }),
    ).rejects.toMatchObject({ name: 'ForgeApiError', status: 404 });
  });

  it('surfaces per-field detail from a 422', async () => {
    const stub = stubFetch([
      {
        status: 422,
        body: {
          message: 'The given data was invalid.',
          errors: { command: ['The command field is required.'] },
        },
      },
    ]);

    await expect(
      makeClient(stub).request({ method: 'POST', path: '/orgs/acme/servers/1/sites/2/commands' }),
    ).rejects.toThrow(/command: The command field is required/);
  });

  it('does not retry a 404', async () => {
    const stub = stubFetch([{ status: 404, body: { message: 'Not found.' } }]);

    await expect(
      makeClient(stub).request({ method: 'GET', path: '/orgs/acme/servers/999' }),
    ).rejects.toThrow(ForgeApiError);
    expect(stub.requests).toHaveLength(1);
  });

  it('retries a 500 and succeeds on a later attempt', async () => {
    const stub = stubFetch([
      { status: 500, body: { message: 'Server error.' } },
      { body: jsonApiResource('servers', 1, { name: 'web-1' }) },
    ]);

    const result = await makeClient(stub).request({ method: 'GET', path: '/orgs/acme/servers/1' });

    expect(stub.requests).toHaveLength(2);
    expect(result.data).toMatchObject({ id: '1', name: 'web-1' });
  });

  it('gives up after maxRetries', async () => {
    const stub = stubFetch([
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
    ]);

    await expect(
      makeClient(stub, { maxRetries: 1 }).request({ method: 'GET', path: '/user' }),
    ).rejects.toThrow(ForgeApiError);
    expect(stub.requests).toHaveLength(2);
  });

  it('does not retry a POST after a 5xx, because the outcome is unknown', async () => {
    // Forge may have created the resource and failed while responding; a retry
    // would create a second one, and the API offers no idempotency key.
    const stub = stubFetch([{ status: 500, body: { message: 'boom' } }]);

    await expect(
      makeClient(stub).request({ method: 'POST', path: '/orgs/acme/servers' }),
    ).rejects.toThrow(ForgeApiError);
    expect(stub.requests).toHaveLength(1);
  });

  it('does retry an idempotent PUT after a 5xx', async () => {
    const stub = stubFetch([{ status: 500, body: { message: 'boom' } }, { status: 202 }]);

    const result = await makeClient(stub).request({
      method: 'PUT',
      path: '/orgs/acme/servers/1/sites/2/nginx',
      body: { config: 'server { }' },
    });

    expect(result.status).toBe(202);
    expect(stub.requests).toHaveLength(2);
  });

  it('retries a POST after a 429, because the request was never processed', async () => {
    const stub = stubFetch([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '1' } },
      { status: 202 },
    ]);

    const result = await makeClient(stub).request({ method: 'POST', path: '/orgs/acme/servers' });

    expect(result.status).toBe(202);
    expect(stub.requests).toHaveLength(2);
  });

  it('does not retry a POST after a network failure', async () => {
    const stub = stubFetch([{ throws: new TypeError('socket hang up') }]);

    await expect(
      makeClient(stub).request({ method: 'POST', path: '/orgs/acme/servers' }),
    ).rejects.toThrow(TypeError);
    expect(stub.requests).toHaveLength(1);
  });

  it('classifies 429 as a rate-limit error carrying the retry delay', async () => {
    const stub = stubFetch([
      { status: 429, body: { message: 'Too many requests.' }, headers: { 'retry-after': '7' } },
      { body: {} },
    ]);

    const client = makeClient(stub);
    const result = await client.request({ method: 'GET', path: '/user' });

    // Retried automatically, so the caller sees success.
    expect(result.status).toBe(200);
    expect(stub.requests).toHaveLength(2);
  });

  it('waits the full Retry-After even when it exceeds the backoff cap', async () => {
    const slept: number[] = [];
    const stub = stubFetch([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '60' } },
      { body: {} },
    ]);

    const client = new ForgeClient({
      apiKey: API_KEY,
      fetch: stub.fetch,
      sleep: async (ms) => {
        slept.push(ms);
        await Promise.resolve();
      },
      rateLimiter: new RateLimiter({ sleep: instantSleep }),
    });

    await client.request({ method: 'GET', path: '/user' });

    // Capping this to 30s would knowingly re-send before Forge's stated delay.
    expect(slept).toContain(60_000);
  });

  it('exposes retryAfterSeconds when a 429 is not retried away', async () => {
    const stub = stubFetch([
      { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '12' } },
    ]);

    await expect(
      makeClient(stub, { maxRetries: 0 }).request({ method: 'GET', path: '/user' }),
    ).rejects.toMatchObject({ name: 'ForgeRateLimitError', retryAfterSeconds: 12 });
  });
});

describe('JSON:API normalisation', () => {
  it('flattens a single resource', () => {
    const result = normalizeResponse(
      jsonApiResource('servers', 7, { name: 'web-1', region: 'nyc3' }),
    );

    expect(result.data).toEqual({ id: '7', type: 'servers', name: 'web-1', region: 'nyc3' });
  });

  it('flattens a collection and keeps meta', () => {
    const result = normalizeResponse(
      jsonApiCollection('sites', [{ id: 1, attributes: { domain: 'example.com' } }], {
        next_cursor: 'abc',
      }),
    );

    expect(result.data).toEqual([{ id: '1', type: 'sites', domain: 'example.com' }]);
    expect(result.meta?.['next_cursor']).toBe('abc');
  });

  it('does not let an attribute named id mask the resource id', () => {
    const result = normalizeResponse({
      data: { id: '7', type: 'servers', attributes: { id: 'inner', name: 'web-1' } },
    });

    expect(result.data).toMatchObject({ id: '7', attribute_id: 'inner' });
  });

  it('keeps included resources so an include= query is not paid for in vain', () => {
    const result = normalizeResponse({
      data: { id: '1', type: 'sites', attributes: { domain: 'example.com' } },
      included: [{ id: '9', type: 'servers', attributes: { name: 'web-1' } }],
    });

    expect(result.included).toEqual([{ id: '9', type: 'servers', name: 'web-1' }]);
  });

  it('keeps a resource self link for asynchronous polling', () => {
    const result = normalizeResponse({
      data: {
        id: '1',
        type: 'servers',
        attributes: { name: 'web-1' },
        links: { self: '/api/orgs/acme/servers/1' },
      },
    });

    expect(extractSelfLink(result.data)).toBe('/api/orgs/acme/servers/1');
  });

  it('passes non-JSON:API bodies through untouched', () => {
    expect(normalizeResponse({ plain: true }).data).toEqual({ plain: true });
    expect(normalizeResponse('a raw string').data).toBe('a raw string');
    expect(normalizeResponse(null).data).toBeNull();
  });

  it('reads the next cursor only when one is present', () => {
    expect(extractNextCursor({ next_cursor: 'xyz' })).toBe('xyz');
    expect(extractNextCursor({ next_cursor: null })).toBeUndefined();
    expect(extractNextCursor(undefined)).toBeUndefined();
  });
});

describe('cursor pagination', () => {
  it('follows next_cursor until it is exhausted', async () => {
    const stub = stubFetch([
      {
        body: jsonApiCollection('servers', [{ id: 1, attributes: { name: 'a' } }], {
          next_cursor: 'page-2',
        }),
      },
      {
        body: jsonApiCollection('servers', [{ id: 2, attributes: { name: 'b' } }], {
          next_cursor: null,
        }),
      },
    ]);

    const result = await makeClient(stub).requestAllPages({
      method: 'GET',
      path: '/orgs/acme/servers',
    });

    expect(result.data).toHaveLength(2);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);

    const secondUrl = new URL(stub.requests[1]?.url ?? '');
    expect(secondUrl.searchParams.get('page[cursor]')).toBe('page-2');
  });

  it('stops at maxPages and reports truncation', async () => {
    const stub = stubFetch([
      {
        body: jsonApiCollection('servers', [{ id: 1, attributes: {} }], { next_cursor: 'more' }),
      },
      {
        body: jsonApiCollection('servers', [{ id: 2, attributes: {} }], { next_cursor: 'more' }),
      },
    ]);

    const result = await makeClient(stub).requestAllPages(
      { method: 'GET', path: '/orgs/acme/servers' },
      2,
    );

    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(2);
  });
});

describe('202 Accepted', () => {
  it('flags accepted responses so callers know work continues server-side', async () => {
    const stub = stubFetch([{ status: 202 }]);

    const result = await makeClient(stub).request({
      method: 'POST',
      path: '/orgs/acme/servers/1/sites/2/deployments',
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe(202);
  });
});

describe('rate limiting', () => {
  it('parses the X-RateLimit family', () => {
    const headers = new Headers({
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '58',
      'x-ratelimit-reset': '1780000000',
    });

    expect(parseRateLimitHeaders(headers)).toEqual({
      limit: 60,
      remaining: 58,
      reset: 1780000000,
    });
  });

  it('prefers Retry-After over X-RateLimit-Reset', () => {
    const headers = new Headers({ 'retry-after': '5', 'x-ratelimit-reset': '1780000000' });
    expect(parseRetryAfterSeconds(headers)).toBe(5);
  });

  it('treats a large X-RateLimit-Reset as an absolute timestamp', () => {
    const now = (): number => 1_780_000_000_000;
    const headers = new Headers({ 'x-ratelimit-reset': '1780000030' });
    expect(parseRetryAfterSeconds(headers, now)).toBe(30);
  });

  it('treats a small X-RateLimit-Reset as a relative delay', () => {
    const headers = new Headers({ 'x-ratelimit-reset': '15' });
    expect(parseRetryAfterSeconds(headers)).toBe(15);
  });

  it('paces requests once the local window is full', async () => {
    let clock = 0;
    const slept: number[] = [];

    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
        await Promise.resolve();
      },
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(1000);
  });

  it('defers to the server when the reported budget is nearly spent', async () => {
    let clock = 1_000_000;
    const slept: number[] = [];

    const limiter = new RateLimiter({
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
        await Promise.resolve();
      },
      reserve: 2,
    });

    limiter.observe(new Headers({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '1' }));
    await limiter.acquire();

    expect(slept.length).toBeGreaterThan(0);
  });

  it('reserves the server-reported budget across concurrent acquisitions', async () => {
    const limiter = new RateLimiter({ sleep: instantSleep, reserve: 0 });
    limiter.observe(new Headers({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '3' }));

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    // Without reservation each caller keeps reading "3" until a response lands.
    expect(limiter.snapshot.remaining).toBe(0);
  });

  it('ignores an observation from an older reset window', () => {
    // A delayed response from the previous window says nothing about the
    // current one; adopting it would restore budget already spent.
    const limiter = new RateLimiter({ sleep: instantSleep });
    limiter.observe(
      new Headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1780000200' }),
    );
    limiter.observe(
      new Headers({ 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': '1780000100' }),
    );

    expect(limiter.snapshot.remaining).toBe(5);
  });

  it('ignores a stale larger remaining count for the same window', () => {
    const limiter = new RateLimiter({ sleep: instantSleep });
    limiter.observe(new Headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '100' }));
    limiter.observe(new Headers({ 'x-ratelimit-remaining': '40', 'x-ratelimit-reset': '100' }));

    expect(limiter.snapshot.remaining).toBe(5);
  });

  it('reports a snapshot for diagnostics', async () => {
    const limiter = new RateLimiter({ sleep: instantSleep });
    await limiter.acquire();

    const snapshot = limiter.snapshot;
    expect(snapshot.limit).toBe(60);
    expect(snapshot.localWindowCount).toBe(1);
  });

  it('is exposed on the client', async () => {
    const stub = stubFetch([{ body: {}, headers: { 'x-ratelimit-remaining': '42' } }]);
    const client = makeClient(stub);
    await client.request({ method: 'GET', path: '/user' });

    expect(client.rateLimitSnapshot.remaining).toBe(42);
  });
});

describe('ForgeRateLimitError', () => {
  it('is retryable, unlike a 4xx', () => {
    const rateLimited = new ForgeRateLimitError('x', 'GET', 'u', null, 3);
    const notFound = new ForgeApiError('x', 404, 'GET', 'u', null);

    expect(rateLimited.isRetryable).toBe(true);
    expect(notFound.isRetryable).toBe(false);
  });
});

describe('self link resolution', () => {
  it('does not double the API prefix on an /api-prefixed link', async () => {
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub).request({ method: 'GET', path: '/api/orgs/acme/servers/1' });

    expect(stub.requests[0]?.url).toBe('https://forge.laravel.com/api/orgs/acme/servers/1');
  });

  it('accepts a bare path', async () => {
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub).request({ method: 'GET', path: '/orgs/acme/servers/1' });

    expect(stub.requests[0]?.url).toBe('https://forge.laravel.com/api/orgs/acme/servers/1');
  });

  it('accepts an absolute same-origin link', async () => {
    const stub = stubFetch([{ body: {} }]);
    await makeClient(stub).request({
      method: 'GET',
      path: 'https://forge.laravel.com/api/orgs/acme/servers/1',
    });

    expect(stub.requests[0]?.url).toBe('https://forge.laravel.com/api/orgs/acme/servers/1');
  });

  it('refuses a cross-origin link rather than sending the token elsewhere', async () => {
    const stub = stubFetch([]);

    await expect(
      makeClient(stub).request({ method: 'GET', path: 'https://evil.example/api/orgs/acme' }),
    ).rejects.toThrow(/cross-origin/i);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('polling deadlines', () => {
  it('takes a final read at the deadline rather than giving up before it', async () => {
    // The old guard threw as soon as the *next* interval would cross the
    // deadline, discarding the tail of the budget: a 120s plan stopped at 114s.
    let clock = 0;
    const reads: number[] = [];

    const result = await pollUntilTerminal(
      () => {
        reads.push(clock);
        // Terminal only on the very last permissible read.
        return Promise.resolve({ status: clock >= 10_000 ? 'finished' : 'deploying' });
      },
      {
        timeoutMs: 10_000,
        initialIntervalMs: 4_000,
        maxIntervalMs: 4_000,
        sleep: (ms: number) => {
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
        isTerminal: (_value: { status: string }, status: string | undefined) =>
          status === 'finished',
      },
    );

    expect(result.status).toBe('finished');
    expect(reads.at(-1)).toBe(10_000);
  });

  it('never sleeps past the deadline, however large the interval', async () => {
    let clock = 0;
    const slept: number[] = [];

    await expect(
      pollUntilTerminal(() => Promise.resolve({ status: 'deploying' }), {
        timeoutMs: 5_000,
        // An interval far larger than the whole budget: without clamping, the
        // effective budget would be a fraction of the configured one.
        initialIntervalMs: 60_000,
        maxIntervalMs: 60_000,
        sleep: (ms: number) => {
          slept.push(ms);
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
        isTerminal: (_value: { status: string }, status: string | undefined) =>
          status === 'finished',
      }),
    ).rejects.toThrow(ForgePollTimeoutError);

    expect(slept).toEqual([5_000]);
    expect(clock).toBe(5_000);
  });
});
