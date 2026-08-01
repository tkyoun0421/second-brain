import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";

import type { Database } from "#app/database.js";
import type { Principal } from "#app/principal.js";
import type { MemoryCaptureInput, SyncItem } from "#app/schemas.js";
import { captureMemory, heartbeatSyncRun, reconcileSyncRun, syncItemIdempotencyKey, syncItemRequestHash } from "#app/services.js";

const principal: Principal = {
  principalId: "11111111-1111-4111-8111-111111111111",
  principalType: "github_sync",
  userId: "22222222-2222-4222-8222-222222222222",
  permissions: new Set(["github_sync:checkpoint", "github_source:write"]),
  repositoryNodeIds: new Set(["R_reconcile_test"]),
};

test("sync item idempotency ignores an observation timestamp change", () => {
  const initial = {
    idempotency_key: "gh:R_reconcile_test:issue:1:stable-content-hash",
    resource_type: "issue",
    operation: "upsert",
    observed_at: "2026-07-31T00:00:00.000Z",
    issue: {},
  } as SyncItem;
  const observedAgain = { ...initial, observed_at: "2026-07-31T01:00:00.000Z" };

  assert.equal(syncItemRequestHash(initial), syncItemRequestHash(observedAgain));
  assert.equal(syncItemIdempotencyKey(initial), `v2:${initial.idempotency_key}`);
});

test("heartbeat types its JSONB parameters explicitly", async () => {
  const queries: string[] = [];
  const database: Database = {
    async transaction(_principal, action) {
      return action({
        async query<Row extends QueryResultRow>(text: string) {
          queries.push(text);
          if (text.includes("insert into public.idempotency_records")) return { rows: [{ id: "1" }] as unknown as Row[], rowCount: 1 };
          if (text.includes("from public.sync_runs sr")) {
            return {
              rows: [{ sync_run_id: "99", mode: "incremental", status: "running", id: "77", github_node_id: "R_reconcile_test" }] as unknown as Row[],
              rowCount: 1,
            };
          }
          if (text.includes("set counts = counts || jsonb_build_object")) return { rows: [{ updated_at: "2026-07-31T00:00:00.000Z" }] as unknown as Row[], rowCount: 1 };
          return { rows: [] as Row[], rowCount: 1 };
        },
      });
    },
    async close() {},
  };

  await heartbeatSyncRun(
    database,
    principal,
    "33333333-3333-4333-8333-333333333333",
    "github:heartbeat:0001",
    "hash",
    "99",
    { stream: "issues", pages_completed: 1, items_accepted: 100, observed_through: "2026-07-31T00:00:00.000Z" },
  );

  const heartbeat = queries.find((query) => query.includes("set counts = counts || jsonb_build_object"));
  assert.match(heartbeat ?? "", /'stream', \$1::text/);
  assert.match(heartbeat ?? "", /'pages_completed', \$2::integer/);
  assert.match(heartbeat ?? "", /'items_accepted', \$3::integer/);
});

test("reconcile tombstones prior missing candidates before marking the current misses", async () => {
  const queries: string[] = [];
  const database: Database = {
    async transaction(_principal, action) {
      return action({
        async query<Row extends QueryResultRow>(text: string) {
          queries.push(text);
          if (text.includes("insert into public.idempotency_records")) return { rows: [{ id: "1" }] as unknown as Row[], rowCount: 1 };
          if (text.includes("from public.sync_runs sr")) {
            return {
              rows: [{ sync_run_id: "99", mode: "reconcile", status: "running", id: "77", github_node_id: "R_reconcile_test" }] as unknown as Row[],
              rowCount: 1,
            };
          }
          if (text.includes("update public.source_records as source")) return { rows: [{ source_type: "github_issue" }] as unknown as Row[], rowCount: 1 };
          if (text.includes("update public.source_records\n            set lifecycle_status = 'missing_candidate'")) {
            return { rows: [{ source_type: "github_comment" }] as unknown as Row[], rowCount: 1 };
          }
          return { rows: [] as Row[], rowCount: 0 };
        },
      });
    },
    async close() {},
  };

  const result = await reconcileSyncRun(database, principal, "33333333-3333-4333-8333-333333333333", "github:reconcile:0001", "hash", "99");
  assert.equal(result.replayed, false);
  assert.deepEqual(result.response.body.data, {
    sync_run_id: "99",
    missing_candidates: { issues: 0, comments: 1 },
    tombstones: { issues: 1, comments: 0 },
  });
  assert.ok(queries.findIndex((query) => query.includes("update public.source_records as source")) < queries.findIndex((query) => query.includes("set lifecycle_status = 'missing_candidate'")));
});

test("automatic capture persists only a proposed memory with importance metadata", async () => {
  const queries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const capturePrincipal: Principal = { ...principal, permissions: new Set(["memory:propose"]) };
  const database: Database = {
    async transaction(_principal, action) {
      return action({
        async query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]) {
          queries.push({ text, values });
          if (text.includes("insert into public.idempotency_records")) return { rows: [{ id: "1" }] as unknown as Row[], rowCount: 1 };
          if (text.includes("insert into public.memory_scopes")) return { rows: [{ id: "2", repository_id: null }] as unknown as Row[], rowCount: 1 };
          if (text.includes("insert into public.memories")) return { rows: [{ id: "3", revision: "1", created_at: "2026-07-31T00:00:00.000Z", confirmed_at: null }] as unknown as Row[], rowCount: 1 };
          if (text.includes("from public.agent_runs")) return { rows: [] as Row[], rowCount: 0 };
          if (text.includes("insert into public.source_records")) return { rows: [{ id: "4" }] as unknown as Row[], rowCount: 1 };
          if (text.includes("insert into public.source_snapshots")) return { rows: [{ id: "5" }] as unknown as Row[], rowCount: 1 };
          return { rows: [] as Row[], rowCount: 1 };
        },
      });
    },
    async close() {},
  };
  const input: MemoryCaptureInput = {
    candidate: {
      kind: "decision",
      statement: "Keep production health checks enabled.",
      rationale: "Deploy readiness depends on it.",
      scope: { type: "global", id: "global" },
      tags: ["deployment"],
      trigger: "agent_checkpoint",
      source: { source_type: "agent_run", source_id: "100", source_uri: null, source_excerpt: "Healthcheck passed." },
      occurred_at: "2026-07-31T00:00:00.000Z",
      signals: { reusability: 3, impact: 3, scope: 2, evidence: 2, noise_penalty: 0 },
      decision: { alternatives: ["Skip health checks"] },
    },
  };

  const result = await captureMemory(database, capturePrincipal, "33333333-3333-4333-8333-333333333333", "mcp:capture:stored:0001", "hash", input);

  assert.equal(result.response.statusCode, 201);
  assert.equal((result.response.body.data as { outcome: string }).outcome, "stored");
  const memoryInsert = queries.find((query) => query.text.includes("insert into public.memories"));
  assert.match(memoryInsert?.text ?? "", /importance_score, importance_reasons, capture_trigger, auto_capture_key/);
  assert.match(memoryInsert?.text ?? "", /on conflict \(owner_id, auto_capture_key\)/);
  assert.equal(memoryInsert?.values?.[5], "proposed");
  assert.equal(memoryInsert?.values?.[11], 10);
  assert.equal(memoryInsert?.values?.[13], "agent_checkpoint");
});
