# Local MCP server

The local MCP server exposes these nine tools over standard input/output:

- `brain_get_context`, `brain_search`, `brain_get_detail`
- `brain_save_decision`, `brain_save_failure`, `brain_finish_run`
- `brain_confirm_memory`, `brain_supersede_memory`, `brain_forget`

It never opens a database connection. Every tool call is authenticated and forwarded to the
Second Brain HTTP API. Keep the API credential in the MCP host's user-level secret store or
environment configuration; do not add it to `.env`, a repository config file, or an agent prompt.

## Start

Set these values in the MCP host environment, then run `npm run mcp`:

```powershell
$env:SECOND_BRAIN_API_URL = "http://127.0.0.1:3000"
$env:SECOND_BRAIN_MCP_ACCESS_TOKEN = "<short-lived-mcp-jwt>"
$env:SECOND_BRAIN_MCP_REQUEST_TIMEOUT_MS = "10000" # optional
npm run mcp
```

`SECOND_BRAIN_MCP_ACCESS_TOKEN` must carry only the capabilities intended for this local
session. The server sends no logs to standard output, since that stream is reserved for MCP
JSON-RPC.

All write tools require `idempotency_key`. If a write returns
`DEPENDENCY_UNAVAILABLE`, retry the exact same request with the same key. `brain_forget` uses a
read-only `preview` followed by an `execute` request with the matching short-lived
`preview_token`; execution additionally requires `expected_revision`, `confirmation`, and an
idempotency key.
