import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWT_ISSUER: z.string().url(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default("authenticated"),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  MEMORY_FORGET_PREVIEW_SECRET: z.string().min(32),
  // Legacy fallback for the loopback-only verification dashboard proxy. Do not expose it to the browser.
  SECOND_BRAIN_MCP_ACCESS_TOKEN: z.string().min(1).optional(),
  // Server-only mcp_agent credentials used to obtain short-lived dashboard access tokens.
  SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL: z.string().email().optional(),
  SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD: z.string().min(1).optional(),
  // Keep local development private by default. Container platforms must opt in
  // to the public interface explicitly through HOST=0.0.0.0.
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
}).superRefine((value, context) => {
  const hasDashboardEmail = Boolean(value.SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL);
  const hasDashboardPassword = Boolean(value.SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD);
  if (hasDashboardEmail !== hasDashboardPassword) {
    context.addIssue({
      code: "custom",
      message: "SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL and SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD must be configured together.",
      path: ["SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL"],
    });
  }
  if (hasDashboardEmail && !value.SUPABASE_PUBLISHABLE_KEY) {
    context.addIssue({
      code: "custom",
      message: "SUPABASE_PUBLISHABLE_KEY is required for dashboard automatic sign-in.",
      path: ["SUPABASE_PUBLISHABLE_KEY"],
    });
  }
});

export type AppConfig = z.infer<typeof environmentSchema>;

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => environmentSchema.parse(environment);
