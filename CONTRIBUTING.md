# Contributing

Thanks for helping out.

## Getting started

```bash
git clone https://github.com/mgratch/laravel-forge-mcp.git
cd laravel-forge-mcp
npm install
npm run check
```

`npm run check` runs format, lint, typecheck and tests — the same gate CI enforces on Node 22
and 24.

## The generated surface

`src/generated/operations.ts` and `docs/TOOLS.md` are **generated**. Do not edit them by hand:

```bash
npm run generate   # spec/forge.openapi.json -> src/generated/operations.ts
npm run docs       # -> docs/TOOLS.md
```

CI fails if either is stale relative to the vendored spec.

## Adding coverage for a new Forge endpoint

You do not add tools by hand. Refresh the vendored spec and regenerate:

```bash
curl -o spec/forge.openapi.json https://forge.laravel.com/api/docs.openapi
npm run generate && npm run docs && npm run check
```

If generation fails with "Override references unknown operationId", Forge renamed or removed an
operation that was classified as destructive. **Do not delete the entry to make the error go
away** — find the new `operationId` and update the table, or the operation silently loses its
guard.

## Safety classification

`scripts/generate-operations.ts` holds two tables:

- `DESTRUCTIVE_OPERATION_IDS` — destroys infrastructure or irreversibly removes data. Registered
  only when `FORGE_MCP_ALLOW_DESTRUCTIVE=1`.
- `CONFIRM_REQUIRED_OPERATION_IDS` — not a deletion, but can interrupt a live service.

Classify by **consequence, not HTTP verb**. `DELETE .../deployments/status` clears a stuck flag and
is harmless; `DELETE .../servers/{server}` destroys a machine.

When in doubt, guard it. A needless confirmation costs one extra argument; a missing one can cost
someone's production database.

## Tests

Tests must be deterministic and must never touch the network. Use `stubFetch` from
`test/helpers.ts` to queue canned responses, and inject `sleep`/`now` so retry and polling tests
run instantly.

New behaviour needs a test. Bug fixes need a test that fails before the fix.

## Style

- TypeScript strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- No `any`. Use `unknown` and narrow.
- Comments explain **why**, not what. If a workaround exists because of an API quirk, say which
  quirk and link the documentation.
- Prettier and ESLint are not negotiable; run `npm run format:fix && npm run lint:fix`.

## Reporting a security issue

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
