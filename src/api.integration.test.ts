import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { buildApp } from "./app.js";
import type { PrincipalVerifier } from "./auth.js";
import { PostgresDatabase } from "./database.js";
import type { Principal } from "./principal.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerId = "00000000-0000-0000-0000-000000000101";

const principal: Principal = {
  principalId: "00000000-0000-0000-0000-000000000102",
  principalType: "github_sync",
  userId: ownerId,
  permissions: new Set([
    "github_sync:checkpoint", "github_source:write", "memory:propose", "memory:read", "memory:confirm",
    "memory:supersede", "agent_run:write", "context:read",
  ]),
  repositoryNodeIds: new Set(["R_api_test"]),
};

const verifier: PrincipalVerifier = { async verify() { return principal; } };

test("API persists a sync item and a proposed decision with RLS context", { skip: !databaseUrl }, async () => {
  const raw = new Pool({ connectionString: databaseUrl });
  const database = new PostgresDatabase(databaseUrl!);
  const app = buildApp({ database, verifier });
  try {
    await raw.query("insert into auth.users (id) values ($1) on conflict do nothing", [ownerId]);

    const startPayload = {
      repository: {
        github_id: "991001",
        node_id: "R_api_test",
        full_name: "example/api-test",
        html_url: "https://github.com/example/api-test",
        visibility: "private",
      },
      mode: "incremental",
      query_from: null,
      client_run_id: "api-integration-1",
    };
    const start = await app.inject({
      method: "POST",
      url: "/v1/github/sync-runs",
      headers: { "x-idempotency-key": "github:api-test:start:0001" },
      payload: startPayload,
    });
    assert.equal(start.statusCode, 201);
    const syncRunId = start.json().data.sync_run_id as string;
    const repositoryId = start.json().data.repository_id as string;

    const startReplay = await app.inject({
      method: "POST",
      url: "/v1/github/sync-runs",
      headers: { "x-idempotency-key": "github:api-test:start:0001" },
      payload: startPayload,
    });
    assert.equal(startReplay.statusCode, 201);
    assert.equal(startReplay.headers["idempotency-replayed"], "true");

    const batch = {
      items: [{
        idempotency_key: "github:api-test:issue:42:0001",
        resource_type: "issue",
        operation: "upsert",
        issue: {
          github_id: "991042",
          node_id: "I_api_test_42",
          number: 42,
          title: "API integration test",
          body: "first body",
          state: "open",
          state_reason: null,
          author_login: "octocat",
          locked: false,
          html_url: "https://github.com/example/api-test/issues/42",
          created_at: "2026-07-31T00:00:00Z",
          updated_at: "2026-07-31T00:01:00Z",
          closed_at: null,
          labels: [],
        },
        observed_at: "2026-07-31T00:02:00Z",
      }],
    };
    const items = await app.inject({
      method: "POST",
      url: `/v1/github/sync-runs/${syncRunId}/items`,
      headers: { "x-idempotency-key": "github:api-test:batch:0001" },
      payload: batch,
    });
    assert.equal(items.statusCode, 200, items.body);
    assert.equal(items.json().data.accepted_count, 1);

    const itemReplay = await app.inject({
      method: "POST",
      url: `/v1/github/sync-runs/${syncRunId}/items`,
      headers: { "x-idempotency-key": "github:api-test:batch:0001" },
      payload: batch,
    });
    assert.equal(itemReplay.statusCode, 200);
    assert.equal(itemReplay.headers["idempotency-replayed"], "true");

    const decision = await app.inject({
      method: "POST",
      url: "/v1/memories/decisions",
      headers: { "x-idempotency-key": "mcp:api-test:decision:0001" },
      payload: {
        statement: "API 수집은 멱등 키를 사용한다.",
        rationale: null,
        scope: { type: "repository", id: repositoryId },
        status: "proposed",
        confidence: 0.8,
        decision: { alternatives: [], decided_at: "2026-07-31T00:03:00Z" },
        sources: [{
          source_type: "user_message",
          source_id: "message-42",
          source_uri: null,
          source_excerpt: "멱등성 키를 넣어줘.",
        }],
        valid_from: "2026-07-31T00:03:00Z",
        valid_until: null,
        tags: ["api"],
      },
    });
    assert.equal(decision.statusCode, 201);
    const memoryId = decision.json().data.memory.id as string;
    const confirmPayload = {
      expected_revision: 1,
      confirmation: {
        origin: "explicit_user",
        source: { type: "user_message", id: "message-42-confirm" },
        confirmed_at: "2026-07-31T00:04:00Z",
      },
    };
    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/memories/${memoryId}/confirm`,
      headers: { "x-idempotency-key": "mcp:api-test:confirm:0001" },
      payload: confirmPayload,
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().data.revision, 2);

    const proposedReplacement = await app.inject({
      method: "POST",
      url: `/v1/memories/${memoryId}/supersede`,
      headers: { "x-idempotency-key": "mcp:api-test:supersede:0001" },
      payload: {
        expected_revision: 2,
        status_intent: "proposed",
        replacement: {
          kind: "decision",
          statement: "API records use a per-route idempotency key.",
          rationale: null,
          scope: { type: "repository", id: repositoryId },
          confidence: 0.9,
          sources: [{
            source_type: "user_message",
            source_id: "message-43",
            source_uri: null,
            source_excerpt: "Use a key for each route.",
          }],
          valid_from: "2026-07-31T00:05:00Z",
          valid_until: null,
          tags: ["api"],
        },
        confirmation: {
          origin: "agent_inference",
          source: { type: "agent", id: "agent-42" },
          confirmed_at: "2026-07-31T00:05:00Z",
        },
      },
    });
    assert.equal(proposedReplacement.statusCode, 201, proposedReplacement.body);
    const replacementId = proposedReplacement.json().data.replacement.memory_id as string;

    const replacementConfirmed = await app.inject({
      method: "POST",
      url: `/v1/memories/${replacementId}/confirm`,
      headers: { "x-idempotency-key": "mcp:api-test:confirm:0002" },
      payload: {
        expected_revision: 1,
        confirmation: {
          origin: "explicit_user",
          source: { type: "user_message", id: "message-44-confirm" },
          confirmed_at: "2026-07-31T00:06:00Z",
        },
      },
    });
    assert.equal(replacementConfirmed.statusCode, 200, replacementConfirmed.body);
    assert.equal(replacementConfirmed.json().data.superseded_memory_id, memoryId);

    const agentRunPayload = {
      session_id: "api-integration-session",
      agent: "codex",
      repository_id: repositoryId,
      goal: "Verify the memory state transitions.",
      started_at: "2026-07-31T00:00:00Z",
      finished_at: "2026-07-31T00:07:00Z",
      result: "succeeded",
      summary: "State transitions were recorded.",
      changed_files: [{ path: "src/services.ts", operation: "modified" }],
      commands_or_actions: [{ kind: "test", summary: "Run API integration test" }],
      verification: [{ kind: "test", name: "api", status: "passed", summary: "passed" }],
      used_memories: [{ memory_id: memoryId, rating: "helpful" }],
      created_memory_ids: [replacementId],
      failure_ids: [],
    };
    const agentRun = await app.inject({
      method: "POST",
      url: "/v1/agent-runs/finish",
      headers: { "x-idempotency-key": "mcp:api-test:finish:0001" },
      payload: agentRunPayload,
    });
    assert.equal(agentRun.statusCode, 201, agentRun.body);
    const agentRunReplay = await app.inject({
      method: "POST",
      url: "/v1/agent-runs/finish",
      headers: { "x-idempotency-key": "mcp:api-test:finish:0001" },
      payload: agentRunPayload,
    });
    assert.equal(agentRunReplay.statusCode, 201, agentRunReplay.body);
    assert.equal(agentRunReplay.headers["idempotency-replayed"], "true");

    const search = await app.inject({
      method: "POST",
      url: "/v1/memories/search",
      payload: { query: "API", limit: 10 },
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().data.items[0]?.id, replacementId, search.body);

    const detail = await app.inject({ method: "GET", url: `/v1/memories/${replacementId}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().data.sources[0].source_type, "user_message");

    const context = await app.inject({
      method: "POST",
      url: "/v1/context/query",
      payload: {
        repository: { github_repository_id: "R_api_test" },
        task: "멱등성 API를 구현한다.",
      },
    });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(context.json().data.decisions[0].id, replacementId);

    const counts = await raw.query<{ snapshot_count: string; memory_count: string; evidence_count: string }>(
      `select
         (select count(*)::text from public.source_snapshots where owner_id = $1) as snapshot_count,
         (select count(*)::text from public.memories where owner_id = $1) as memory_count,
         (select count(*)::text from public.memory_evidence where owner_id = $1) as evidence_count`,
      [ownerId],
    );
    assert.equal(counts.rows[0]?.snapshot_count, "3");
    assert.equal(counts.rows[0]?.memory_count, "2");
    assert.equal(counts.rows[0]?.evidence_count, "2");
  } finally {
    await app.close();
    await database.close();
    await raw.end();
  }
});
