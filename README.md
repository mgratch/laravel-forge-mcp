# laravel-forge-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Laravel Forge API](https://forge.laravel.com/docs/api-reference/introduction) — complete coverage
of all **273 documented operations**, with destructive operations gated behind an explicit opt-in
and a per-call confirmation.

Every tool is generated from Forge's own [OpenAPI document](https://forge.laravel.com/api/docs.openapi),
so the tool surface cannot silently drift from the API.

> **Built against the current API, not the deprecated one.** Forge's legacy
> `/api/v1` API is [deprecated and shuts down on 31 August 2026](https://forge.laravel.com/api-documentation).
> This server targets the current API at `https://forge.laravel.com/api`.

## Install

```bash
npm install -g laravel-forge-mcp
```

Or run without installing:

```bash
npx laravel-forge-mcp
```

## Configure

Generate a token at [forge.laravel.com/profile/api](https://forge.laravel.com/profile/api).

### Claude Desktop / Claude Code

```jsonc
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["-y", "laravel-forge-mcp"],
      "env": {
        "FORGE_API_KEY": "your-token",
        "FORGE_ORGANIZATION": "your-org-slug"
      }
    }
  }
}
```

### Environment variables

| Variable                      | Required | Default                         | Purpose                                                                                                            |
| ----------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `FORGE_API_KEY`               | yes      | —                               | API token.                                                                                                         |
| `FORGE_ORGANIZATION`          | no       | —                               | Organization **slug**. When set, `organization` disappears from every tool signature and is injected server-side.  |
| `FORGE_MCP_ALLOW_DESTRUCTIVE` | no       | `false`                         | Register destructive tools (server/site/database deletion, restores, team mutation). They still require `confirm`. |
| `FORGE_API_BASE_URL`          | no       | `https://forge.laravel.com/api` | Override the base URL, for testing against a mock.                                                                 |
| `FORGE_TIMEOUT_MS`            | no       | `30000`                         | Per-request timeout.                                                                                               |
| `FORGE_MAX_RETRIES`           | no       | `3`                             | Retry attempts for 429 and 5xx responses.                                                                          |

## Safety model

Forge's API can destroy production infrastructure. This server treats that as a design constraint
rather than a disclaimer.

**Two independent gates protect destructive operations:**

1. **Registration.** Tools that delete infrastructure or irreversibly remove data are not registered
   at all unless `FORGE_MCP_ALLOW_DESTRUCTIVE=1`. An agent cannot call — or even see — a tool that
   is switched off.

2. **Targeted confirmation.** When enabled, each still requires a `confirm` argument that names the
   operation _and its target_:

   ```jsonc
   { "server": 12345, "confirm": "DELETE server=12345" }
   ```

   A generic `"yes"` is refused, and so is a phrase naming a different server — so a model cannot
   satisfy the guard by pattern-matching, and cannot confirm one resource while acting on another.
   The request is never sent if the phrase does not match.

   When `FORGE_ORGANIZATION` is **not** pinned the phrase also carries the organization
   (`"DELETE organization=acme server=12345"`), because Forge ids are scoped per organization and a
   phrase without it would authorise the same id in any organization the token can reach.

**Confirmation also covers non-deletions that can take a site down.** Service actions are the
clearest case: the API exposes `stop` for nginx but has no `start`, so a careless stop has no
documented way back.

Classification lives in `scripts/generate-operations.ts` and is keyed by `operationId`. It is
decided by consequence, not HTTP verb — `DELETE .../deployments/status` merely clears a stuck
deployment flag and is not guarded, while `DELETE .../servers/{server}` destroys a machine and is.
If Forge renames an operation, generation **fails loudly** rather than silently un-guarding a tool.

See [`docs/TOOLS.md`](docs/TOOLS.md) for the full catalog, including which tools are gated.

## What the client handles for you

| Concern                                                                          | Behaviour                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Rate limiting](https://forge.laravel.com/docs/api-reference/rate-limiting)      | 60 req/min is paced locally _and_ reconciled against `X-RateLimit-Remaining`. 429s are retried using `Retry-After`.                   |
| [Async operations](https://forge.laravel.com/docs/api-reference/introduction)    | 105 operations return `202 Accepted`. Tools for them accept `wait: true` to poll with exponential backoff until the resource settles. |
| [JSON:API envelopes](https://forge.laravel.com/docs/api-reference/relationships) | `{data: {id, type, attributes: {…}}}` is flattened to `{id, type, …}` so models spend tokens on data, not structure.                  |
| [Cursor pagination](https://forge.laravel.com/docs/api-reference/pagination)     | `page[cursor]` / `meta.next_cursor` are handled; no page numbers or totals exist in this API.                                         |
| Errors                                                                           | 401/403/404/409/422/429/503 each carry a specific remediation hint. 422 responses surface Forge's per-field validation detail.        |
| Transient failures                                                               | 429 and 5xx are retried with full-jitter exponential backoff; 4xx are not, because they fail identically on retry.                    |

## Examples

Read a site's live nginx configuration:

```jsonc
// tool: get_servers_sites_nginx
{ "server": 12345, "site": 67890 }
```

Update it, then restart nginx (note the confirmation):

```jsonc
// tool: update_servers_sites_nginx
{ "server": 12345, "site": 67890, "config": "server {\n  client_max_body_size 30M;\n  …\n}" }

// tool: create_servers_services_nginx_actions
{ "server": 12345, "action": "reboot", "confirm": "POST server=12345" }
```

> The current API has **no `nginx -t` equivalent**. A bad configuration write returns `202` and can
> take a site down. Read the existing config first, change one thing, and verify the site still
> serves afterwards.

Deploy and wait for the result:

```jsonc
// tool: create_servers_sites_deployments
{ "server": 12345, "site": 67890, "wait": true }
```

Run a command and collect its output:

```jsonc
// tool: create_servers_sites_commands
{ "server": 12345, "site": 67890, "command": "php artisan migrate --force" }
// then: get_servers_sites_commands_output with the returned command id
```

## Known API quirks this server works around

Documented here because they will otherwise cost you an afternoon:

- **Read and write field names differ on config endpoints.** nginx reads `content` but writes
  `config`; the environment file reads `content` but writes `environment`; FPM config reads
  `configuration` but writes `config`. The generated schemas reflect the write shape, which is what
  a tool call needs.
- **Two incompatible PHP version enums.** Service actions and version installs take `php83`;
  `cli-version` and `site-version` take `8.3`.
- **`{phpVersion}` in a path is an integer resource id**, not a version string. List the versions
  first to resolve it.
- **Whole-file writes, never patches.** nginx, environment and FPM configs replace the entire file.
  Read, modify, then write — and be aware that concurrent edits will silently clobber each other.
- **No total count in list responses.** Cursor pagination only.

## Development

```bash
npm install
npm run generate   # rebuild src/generated/operations.ts from spec/forge.openapi.json
npm run docs       # rebuild docs/TOOLS.md
npm run check      # format + lint + typecheck + test
npm run build
```

### Updating to a newer Forge API

```bash
curl -o spec/forge.openapi.json https://forge.laravel.com/api/docs.openapi
npm run generate && npm run docs && npm run check
```

Generation fails if a guarded `operationId` has disappeared, which is deliberate: it forces a human
to re-check the safety classification instead of shipping an unguarded destructive tool. CI also
fails when the committed generated files are stale.

### Architecture

```
spec/forge.openapi.json      vendored API contract (the source of truth)
scripts/generate-operations  spec -> typed operation descriptors + safety flags
scripts/generate-docs        descriptors -> docs/TOOLS.md
src/client/                  HTTP, auth, rate limiting, retries, JSON:API, polling
src/tools/schema.ts          OpenAPI schema -> MCP inputSchema
src/tools/registry.ts        descriptor -> registered tool (guards, paths, body, polling)
src/server.ts                MCP wiring: tools/list, tools/call, error mapping
```

## Contributing

Issues and pull requests welcome. Please run `npm run check` before opening a PR — CI runs the same
commands on Node 20 and 22, and additionally verifies that generated files are current.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Not affiliated with or endorsed by Laravel. "Laravel" and "Forge" are trademarks of Laravel LLC.
