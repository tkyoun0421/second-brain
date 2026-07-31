import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "./app.js";
import type { PrincipalVerifier } from "./auth.js";
import type { Database } from "./database.js";
import { ApiError } from "./errors.js";
import type { Principal } from "./principal.js";

const principal: Principal = {
  principalId: "11111111-1111-4111-8111-111111111111",
  principalType: "mcp_agent",
  userId: "22222222-2222-4222-8222-222222222222",
  permissions: new Set(["memory:propose"]),
  repositoryNodeIds: new Set(),
};

const verifier: PrincipalVerifier = {
  async verify() {
    return principal;
  },
};

const database: Database = {
  async transaction() {
    throw new Error("database should not be called by this test");
  },
  async close() {},
};

test("health endpoint does not require authentication", async () => {
  const app = buildApp({ database, verifier });
  const response = await app.inject({ method: "GET", url: "/v1/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.status, "ok");
  await app.close();
});

test("protected endpoints return the contract authentication envelope", async () => {
  const unauthenticated: PrincipalVerifier = {
    async verify() {
      throw new ApiError({
        statusCode: 401,
        code: "UNAUTHENTICATED",
        message: "인증 정보를 확인할 수 없습니다.",
      });
    },
  };
  const app = buildApp({ database, verifier: unauthenticated });
  const response = await app.inject({
    method: "GET",
    url: "/v1/github/repositories/R_example/checkpoint",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");
  await app.close();
});

test("memory input with a token is rejected before opening a database transaction", async () => {
  const app = buildApp({ database, verifier });
  const response = await app.inject({
    method: "POST",
    url: "/v1/memories/decisions",
    headers: { "x-idempotency-key": "mcp:test:decision:0001" },
    payload: {
      statement: "패키지 관리자를 고정한다.",
      rationale: null,
      scope: { type: "global", id: "global" },
      status: "proposed",
      confidence: 0.8,
      decision: { alternatives: [], decided_at: "2026-07-31T00:00:00Z" },
      sources: [{
        source_type: "user_message",
        source_id: "message-1",
        source_uri: null,
        source_excerpt: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      }],
      valid_from: "2026-07-31T00:00:00Z",
      valid_until: null,
      tags: [],
    },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "SENSITIVE_DATA_DETECTED");
  await app.close();
});
