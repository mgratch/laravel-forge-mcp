# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/mgratch/laravel-forge-mcp/security/advisories/new)
rather than opening a public issue.

Please include reproduction steps and the impact you believe it has. You can expect an initial
response within a week.

## Scope

This server holds a Laravel Forge API token and can, when configured to, delete production
infrastructure. Issues of particular interest:

- Any path where a destructive tool executes **without** a matching `confirm` argument.
- Any path where `FORGE_MCP_ALLOW_DESTRUCTIVE` is not honoured.
- Leakage of the API token into logs, error messages or tool output.
- Path traversal or injection through path/query parameter interpolation.

## Handling your token

- The token is read from the environment and never written to disk.
- Diagnostics go to stderr; the token is not included in them.
- Errors surface Forge's response body, which does not contain the token — but if you find a case
  where it could, that is a reportable issue.

## Operating advice

- Leave `FORGE_MCP_ALLOW_DESTRUCTIVE` unset unless you specifically need deletions. The tools are
  not registered at all when it is off.
- Prefer a token scoped to the smallest set of permissions your workflow needs.
- Set `FORGE_ORGANIZATION` to pin one organization, so a mistake cannot reach another.
