# Local MCP server

The local MCP server exposes these nine tools over standard input/output:

- `brain_get_context`, `brain_search`, `brain_get_detail`
- `brain_save_decision`, `brain_save_failure`, `brain_finish_run`
- `brain_confirm_memory`, `brain_supersede_memory`, `brain_forget`

It never opens a database connection. Every tool call is authenticated and forwarded to the
Second Brain HTTP API. Keep the API credential in the MCP host's user-level secret store or
environment configuration; do not add it to the API server's `.env`, a repository config file, or
an agent prompt.

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

The API must already be running and reachable from the MCP host. The current API process listens
on loopback, so the default local URL is `http://127.0.0.1:3000`. A remote HTTPS API requires a
separate network deployment decision; this repository does not configure a public listener or
proxy.

## MCP host configuration

Configure the MCP client to launch a long-lived stdio child process with this repository as its
working directory and the three variables above in its *user-level* environment. The exact config
file differs between clients, but its equivalent values are:

```json
{
  "command": "node",
  "args": ["--import", "tsx", "<repository>/src/mcp-server.ts"],
  "cwd": "<repository>",
  "env": {
    "SECOND_BRAIN_API_URL": "http://127.0.0.1:3000",
    "SECOND_BRAIN_MCP_ACCESS_TOKEN": "<short-lived-mcp-jwt>",
    "SECOND_BRAIN_MCP_REQUEST_TIMEOUT_MS": "10000"
  }
}
```

Replace `<repository>` with an absolute local path. Node.js 22 and installed dependencies are
required. Using `node --import tsx` avoids wrapper output on the MCP protocol stream; `npm run mcp`
remains convenient for an interactive local launch. Do not place the token in a shared workspace
configuration that is committed to Git.

The token must be a verified API JWT whose `principal_type` is `mcp_agent`, with only the needed
`permissions` and GitHub node IDs in `repository_ids`. See [운영 환경 설정](operations.md) for the
required claim shape and API server variables.

All write tools require `idempotency_key`. If a write returns
`DEPENDENCY_UNAVAILABLE`, retry the exact same request with the same key. `brain_forget` uses a
read-only `preview` followed by an `execute` request with the matching short-lived
`preview_token`; execution additionally requires `expected_revision`, `confirmation`, and an
idempotency key.
