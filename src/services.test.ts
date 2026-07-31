import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";

import type { Database } from "./database.js";
import type { Principal } from "./principal.js";
import type { SyncItem } from "./schemas.js";
import { reconcileSyncRun, syncItemIdempotencyKey, syncItemRequestHash } from "./services.js";

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
