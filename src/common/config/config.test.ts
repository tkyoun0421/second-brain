import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "#app/common/config/config.js";

const baseEnvironment = {
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/postgres",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_JWT_ISSUER: "https://example.supabase.co/auth/v1",
  MEMORY_FORGET_PREVIEW_SECRET: "test-forget-preview-secret-at-least-32",
};

test("dashboard automatic sign-in requires both mcp_agent credentials", () => {
  assert.throws(
    () => loadConfig({
      ...baseEnvironment,
      SUPABASE_PUBLISHABLE_KEY: "publishable-key",
      SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL: "dashboard-agent@example.com",
    }),
    /SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL and SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD must be configured together/,
  );
});

test("dashboard automatic sign-in accepts a complete server-only configuration", () => {
  const config = loadConfig({
    ...baseEnvironment,
    SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL: "dashboard-agent@example.com",
    SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD: "server-only-password",
  });

  assert.equal(config.SUPABASE_PUBLISHABLE_KEY, "publishable-key");
  assert.equal(config.SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL, "dashboard-agent@example.com");
});
