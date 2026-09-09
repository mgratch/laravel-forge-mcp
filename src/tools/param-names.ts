/**
 * Forge's list endpoints take JSON:API-style query parameters — `page[size]`,
 * `page[cursor]`, `filter[name]` — and the OpenAPI document names them exactly
 * that way. A tool's `inputSchema` cannot: property names are restricted to
 * `^[a-zA-Z0-9_.-]{1,64}$`, so a bracketed key makes the whole schema invalid
 * and the tool is dropped at load time rather than merely sanitised.
 *
 * That silently cost this server 46 of its 238 tools — every paginated list
 * endpoint, since pagination is where those parameters live. `list_servers`,
 * `list_servers_sites` and the rest were declared and then discarded, so the
 * server looked healthy while the operations a caller reaches for first were
 * simply absent, with no error anywhere to explain it.
 *
 * So the schema advertises a safe alias and the request still sends the wire
 * name. The mapping is total and reversible for the shapes Forge actually
 * uses, and `assertNoAliasCollisions` refuses to let two parameters land on
 * one alias rather than letting the later quietly win.
 */

/** Property names an MCP tool schema may use. */
const SAFE_PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * `page[size]` -> `page_size`, `filter[permissions.name]` -> `filter_permissions_name`.
 *
 * Dots are folded into underscores even though the pattern permits them: a
 * caller typing `filter_permissions.name` would be guessing at which
 * separators survived, and one rule is easier to predict than two.
 */
export function toSafeParamName(wireName: string): string {
  if (SAFE_PROPERTY_NAME.test(wireName) && !wireName.includes('.')) return wireName;

  const safe = wireName
    .replace(/\[/g, '_')
    .replace(/\]/g, '')
    .replace(/\./g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/_$/, '');

  return safe.slice(0, 64);
}

/** True when the schema key differs from the name that goes on the wire. */
export function isAliasedParamName(wireName: string): boolean {
  return toSafeParamName(wireName) !== wireName;
}

/**
 * Two wire names collapsing onto one alias would make a parameter
 * unaddressable, and the failure would look like "the filter is ignored"
 * rather than anything to do with naming. Callers pass every parameter name
 * for one operation.
 *
 * @throws if any alias is claimed twice.
 */
export function assertNoAliasCollisions(wireNames: readonly string[], toolName: string): void {
  const seen = new Map<string, string>();

  for (const wireName of wireNames) {
    const alias = toSafeParamName(wireName);
    const previous = seen.get(alias);

    if (previous !== undefined && previous !== wireName) {
      throw new Error(
        `Tool "${toolName}" maps both "${previous}" and "${wireName}" onto the schema property ` +
          `"${alias}". One of them would be unreachable; rename it in the generator.`,
      );
    }

    seen.set(alias, wireName);
  }
}
