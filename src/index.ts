import { existsSync } from "node:fs";
import { SupabaseJwtVerifier } from "#app/common/auth/auth.service.js";
import { buildApp } from "#app/app.js";
import { loadConfig } from "#app/common/config/config.js";
import { PostgresDatabase } from "#app/common/database/database.js";
import {
  StaticDashboardAccessTokenProvider,
  SupabasePasswordDashboardAccessTokenProvider,
} from "#app/modules/verification/dashboard-access-token-provider.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const config = loadConfig();
const database = new PostgresDatabase(config.DATABASE_URL);
const dashboardTokenProvider = config.SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL
  && config.SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD
  && config.SUPABASE_PUBLISHABLE_KEY
  ? new SupabasePasswordDashboardAccessTokenProvider({
    supabaseUrl: config.SUPABASE_URL,
    publishableKey: config.SUPABASE_PUBLISHABLE_KEY,
    email: config.SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL,
    password: config.SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD,
  })
  : config.SECOND_BRAIN_MCP_ACCESS_TOKEN
    ? new StaticDashboardAccessTokenProvider(config.SECOND_BRAIN_MCP_ACCESS_TOKEN)
    : undefined;
const app = buildApp({
  database,
  verifier: new SupabaseJwtVerifier({
    jwksUrl: new URL("/auth/v1/.well-known/jwks.json", config.SUPABASE_URL),
    issuer: config.SUPABASE_JWT_ISSUER,
    audience: config.SUPABASE_JWT_AUDIENCE,
  }),
  forgetPreviewSecret: config.MEMORY_FORGET_PREVIEW_SECRET,
  ...(dashboardTokenProvider ? { dashboardTokenProvider } : {}),
});

const close = async () => {
  await app.close();
  await database.close();
};

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: config.HOST, port: config.PORT });
