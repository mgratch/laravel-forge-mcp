import { describe, expect, it } from 'vitest';

import {
  assertNoAliasCollisions,
  isAliasedParamName,
  toSafeParamName,
} from '../src/tools/param-names.js';
import { OPERATIONS } from '../src/generated/operations.js';

/**
 * The regression this file exists for: Forge's list endpoints declare
 * JSON:API query parameters (`page[size]`, `filter[name]`), those names went
 * straight into `inputSchema.properties`, and a bracketed property name makes
 * the whole schema invalid — so the tool was dropped at load rather than
 * sanitised. 46 of 238 tools disappeared that way, every one of them a
 * paginated list endpoint, with nothing logged to say so.
 */

/** What an MCP tool schema permits as a property name. */
const SAFE_PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

describe('toSafeParamName', () => {
  it('leaves an already-safe name alone', () => {
    expect(toSafeParamName('server')).toBe('server');
    expect(toSafeParamName('sort')).toBe('sort');
    expect(toSafeParamName('include')).toBe('include');
  });

  it('flattens the pagination parameters', () => {
    expect(toSafeParamName('page[size]')).toBe('page_size');
    expect(toSafeParamName('page[cursor]')).toBe('page_cursor');
  });

  it('flattens filters, including dotted ones', () => {
    expect(toSafeParamName('filter[name]')).toBe('filter_name');
    expect(toSafeParamName('filter[permissions.name]')).toBe('filter_permissions_name');
  });

  it('is stable: aliasing an alias changes nothing', () => {
    expect(toSafeParamName(toSafeParamName('page[size]'))).toBe('page_size');
  });

  it('reports whether a name was rewritten', () => {
    expect(isAliasedParamName('page[size]')).toBe(true);
    expect(isAliasedParamName('server')).toBe(false);
  });
});

describe('assertNoAliasCollisions', () => {
  it('accepts distinct aliases', () => {
    expect(() =>
      assertNoAliasCollisions(['page[size]', 'page[cursor]', 'filter[name]'], 'list_servers'),
    ).not.toThrow();
  });

  it('refuses two wire names that collapse onto one property', () => {
    expect(() => assertNoAliasCollisions(['filter[a.b]', 'filter[a_b]'], 'list_things')).toThrow(
      /both "filter\[a\.b\]" and "filter\[a_b\]"/,
    );
  });

  it('tolerates the same name twice', () => {
    expect(() => assertNoAliasCollisions(['page[size]', 'page[size]'], 'list_x')).not.toThrow();
  });
});

describe('every generated operation', () => {
  it('produces query parameter aliases an MCP schema will accept', () => {
    const offenders: string[] = [];

    for (const op of OPERATIONS) {
      for (const param of op.queryParams) {
        const alias = toSafeParamName(param.name);
        if (!SAFE_PROPERTY_NAME.test(alias))
          offenders.push(`${op.name}: ${param.name} -> ${alias}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never collides two parameters onto one property', () => {
    for (const op of OPERATIONS) {
      expect(() =>
        assertNoAliasCollisions(
          op.queryParams.map((p) => p.name),
          op.name,
        ),
      ).not.toThrow();
    }
  });

  it('still carries the paginated list endpoints the bug removed', () => {
    const paginated = OPERATIONS.filter((op) =>
      op.queryParams.some((p) => p.name.startsWith('page[')),
    );

    // The exact population that was being dropped.
    expect(paginated.length).toBe(46);
    expect(paginated.map((op) => op.name)).toContain('list_servers_sites');
  });
});
