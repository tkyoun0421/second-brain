import { SupabaseJwtVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";

const config = loadConfig();
const database = new PostgresDatabase(config.DATABASE_URL);
const app = buildApp({
  database,
  verifier: new SupabaseJwtVerifier({
    jwksUrl: new URL("/auth/v1/.well-known/jwks.json", config.SUPABASE_URL),
    issuer: config.SUPABASE_JWT_ISSUER,
    audience: config.SUPABASE_JWT_AUDIENCE,
  }),
  forgetPreviewSecret: config.MEMORY_FORGET_PREVIEW_SECRET,
});

const close = async () => {
  await app.close();
  await database.close();
};

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: "127.0.0.1", port: config.PORT });
