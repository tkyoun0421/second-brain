import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";

import { buildApp } from "#app/app.js";
import type { PrincipalVerifier } from "#app/auth.js";
import type { Database } from "#app/database.js";
import { ApiError } from "#app/errors.js";
import type { Principal } from "#app/principal.js";

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
  const app = buildApp({ database, verifier, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const response = await app.inject({ method: "GET", url: "/v1/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.status, "ok");
  await app.close();
});

test("API route registry keeps the public HTTP contract stable", async () => {
  const app = buildApp({ database, verifier, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const routes = [
    ["GET", "/v1/health"],
    ["GET", "/verification"],
    ["GET", "/verification/memories/inbox"],
    ["GET", "/v1/github/repositories/:github_repository_id/checkpoint"],
    ["POST", "/v1/github/sync-runs"],
    ["POST", "/v1/github/sync-runs/:sync_run_id/heartbeat"],
    ["POST", "/v1/github/sync-runs/:sync_run_id/items"],
    ["POST", "/v1/github/sync-runs/:sync_run_id/complete"],
    ["POST", "/v1/github/sync-runs/:sync_run_id/reconcile"],
    ["POST", "/v1/context/query"],
    ["POST", "/v1/memories/search"],
    ["GET", "/v1/memories/inbox"],
    ["GET", "/v1/memories/:memory_id"],
    ["POST", "/v1/memories/decisions"],
    ["POST", "/v1/memories/failures"],
    ["POST", "/v1/memories/capture"],
    ["POST", "/v1/agent-runs/finish"],
    ["POST", "/v1/memories/:memory_id/confirm"],
    ["POST", "/v1/memories/:memory_id/supersede"],
    ["POST", "/v1/memories/:memory_id/forget-preview"],
    ["POST", "/v1/memories/:memory_id/forget"],
  ] as const;

  for (const [method, url] of routes) {
    assert.equal(app.hasRoute({ method, url }), true, `${method} ${url} must stay registered`);
  }

  await app.close();
});

test("verification dashboard is public and exposes the visual check controls", async () => {
  const unauthenticated: PrincipalVerifier = {
    async verify() {
      throw new Error("the verification dashboard should not authenticate");
    },
  };
  const app = buildApp({ database, verifier: unauthenticated, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const response = await app.inject({ method: "GET", url: "/verification" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/html/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.body, /자동 중요도 캡처 미리보기/);
  assert.match(response.body, /Memory Inbox · 실제 저장된 제안/);
  assert.doesNotMatch(response.body, /inboxToken/);
  assert.match(response.body, /id="checkpoint-button"/);
  await app.close();
});

test("verification Inbox proxy uses only the server-configured token", async () => {
  const authorizations: Array<string | undefined> = [];
  const dashboardVerifier: PrincipalVerifier = {
    async verify(authorization) {
      authorizations.push(authorization);
      return { ...principal, permissions: new Set(["memory:read"]) };
    },
  };
  const dashboardDatabase: Database = {
    async transaction(_principal, action) {
      return action({
        async query<Row extends QueryResultRow>() {
          return { rows: [] as Row[], rowCount: 0 };
        },
      });
    },
    async close() {},
  };
  const app = buildApp({
    database: dashboardDatabase,
    verifier: dashboardVerifier,
    forgetPreviewSecret: "test-forget-preview-secret-at-least-32",
    dashboardAccessToken: "server-only-dashboard-token",
  });
  const response = await app.inject({ method: "GET", url: "/verification/memories/inbox?limit=10" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, { items: [], next_cursor: null, total_count: 0 });
  assert.deepEqual(authorizations, ["Bearer server-only-dashboard-token"]);
  await app.close();
});

test("verification Inbox proxy remains disabled until its server token is configured", async () => {
  const app = buildApp({ database, verifier, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const response = await app.inject({ method: "GET", url: "/verification/memories/inbox" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DASHBOARD_TOKEN_NOT_CONFIGURED");
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
  const app = buildApp({ database, verifier: unauthenticated, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const response = await app.inject({
    method: "GET",
    url: "/v1/github/repositories/R_example/checkpoint",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");
  await app.close();
});

test("memory input with a token is rejected before opening a database transaction", async () => {
  const app = buildApp({ database, verifier, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
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

test("automatic capture discards a low-value transient failure without opening a database transaction", async () => {
  const app = buildApp({ database, verifier, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const response = await app.inject({
    method: "POST",
    url: "/v1/memories/capture",
    headers: { "x-idempotency-key": "mcp:test:capture:discard:0001" },
    payload: {
      candidate: {
        kind: "failure",
        statement: "A local command timed out once.",
        rationale: null,
        scope: { type: "global", id: "global" },
        tags: ["transient"],
        trigger: "error_resolution",
        source: {
          source_type: "agent_run",
          source_id: "100",
          source_uri: null,
          source_excerpt: "One timeout occurred.",
        },
        occurred_at: "2026-07-31T00:00:00Z",
        signals: { reusability: 0, impact: 1, scope: 0, evidence: 0, noise_penalty: 1 },
        failure: {
          resolution_status: "observed",
          symptom: "The command timed out once.",
          environment: null,
          attempts: [],
          cause_or_hypothesis: null,
          resolution: null,
          verification: [],
        },
      },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, {
    outcome: "discarded",
    importance: {
      importance_score: 0,
      reasons: ["low_reuse", "low_impact", "narrow_scope", "limited_evidence", "noise_penalty"],
      policy_version: "importance-v1",
    },
  });
  await app.close();
});

test("Memory Inbox parses list filters and serves the static inbox route", async () => {
  const calls: Array<readonly unknown[] | undefined> = [];
  const memoryReadVerifier: PrincipalVerifier = {
    async verify() {
      return { ...principal, permissions: new Set(["memory:read"]) };
    },
  };
  const inboxDatabase: Database = {
    async transaction(_principal, action) {
      return action({
        async query<Row extends QueryResultRow>(_text: string, values?: readonly unknown[]) {
          calls.push(values);
          return { rows: [] as Row[], rowCount: 0 };
        },
      });
    },
    async close() {},
  };
  const app = buildApp({ database: inboxDatabase, verifier: memoryReadVerifier, forgetPreviewSecret: "test-forget-preview-secret-at-least-32" });
  const response = await app.inject({ method: "GET", url: "/v1/memories/inbox?limit=2&kinds=learning&tags=inbox" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, { items: [], next_cursor: null, total_count: 0 });
  assert.deepEqual(calls[0], [principal.userId, [], ["learning"], ["inbox"], null, null, null, 3]);
  await app.close();
});
