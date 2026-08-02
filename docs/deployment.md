# Production deployment

This service is ready for any container host that provides an HTTPS ingress and injects runtime secrets. Do not publish a database URL, `service_role` key, or application secret in the repository, an image, or a GitHub Actions environment.

## Prerequisites

1. Create a Supabase project and obtain its PostgreSQL connection string from the project dashboard. Use the transaction pooler for a horizontally scaled API; direct connections are suitable for a single long-lived instance.
2. Apply every SQL file in `supabase/migrations/` to that database in lexical order, using the SQL editor or the Supabase CLI authenticated to the target project.
3. Configure the Supabase JWT issuer and the custom-claim issuance path described in [operations.md](operations.md). The API must be able to read the project JWKS at `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`.
4. Choose a container host with a managed HTTPS domain. Configure its health check as `GET /v1/health`.

## Container configuration

Build from the repository `Dockerfile`. Set these values in the host's secret/configuration store:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Supabase PostgreSQL connection URL; secret |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_JWT_ISSUER` | `https://<project-ref>.supabase.co/auth/v1` |
| `SUPABASE_JWT_AUDIENCE` | `authenticated`, unless the issued JWT uses another audience |
| `MEMORY_FORGET_PREVIEW_SECRET` | independently generated 32+ character secret |
| `HOST` | `0.0.0.0` |
| `PORT` | supplied by the host, otherwise `3000` |

Terminate TLS at the platform ingress and only use the HTTPS public URL for MCP and GitHub Actions. Keep the runtime service private if the platform supports private ingress plus a trusted gateway.

## Verification and activation

1. Deploy and call `https://<api-domain>/v1/health`; expect `{"data":{"status":"ok"}}`.
2. Mint a short-lived least-privilege MCP JWT and run an authenticated context query against the HTTPS URL.
3. Add the production URL as GitHub Actions secret `SECOND_BRAIN_API_URL`, plus `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SECOND_BRAIN_GITHUB_SYNC_EMAIL`, and `SECOND_BRAIN_GITHUB_SYNC_PASSWORD`. The workflow signs in as the repository-scoped `github_sync` technical account each time it runs.
4. Run **GitHub Issue Sync** manually in `incremental` mode, check the run result, then run `reconcile` once after verifying the imported records.

If an API token or database URL is exposed, revoke/rotate it before proceeding.
