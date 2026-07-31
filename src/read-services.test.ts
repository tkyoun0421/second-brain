import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";

import type { Database, SqlClient } from "./database.js";
import { listMemoryInbox } from "./read-services.js";
import type { Principal } from "./principal.js";

const principal: Principal = {
  principalId: "11111111-1111-4111-8111-111111111111",
  principalType: "mcp_agent",
  userId: "22222222-2222-4222-8222-222222222222",
  permissions: new Set(["memory:read"]),
  repositoryNodeIds: new Set(["R_repo"]),
};

const memory = (id: string, createdAt: string) => ({
  id,
  kind: "learning" as const,
  statement: `memory ${id}`,
  rationale: null,
  status: "proposed" as const,
  confidence: "0.7",
  revision: "1",
  valid_from: createdAt,
  valid_until: null,
  tags: ["inbox"],
  importance_score: "8",
  importance_reasons: ["reusable"],
  capture_trigger: "agent_checkpoint",
  scope_type: "global" as const,
  scope_key: "global",
  repository_node_id: null,
  created_at: createdAt,
  updated_at: createdAt,
  supersedes_id: null,
});

test("Memory Inbox lists only proposed memories with owner-scoped importance pagination", async () => {
  const queries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const client: SqlClient = {
    async query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (text.includes("from public.memories m")) {
        return { rows: [
          memory("9", "2026-07-31T02:00:00.000Z"),
          memory("8", "2026-07-31T01:00:00.000Z"),
        ] as unknown as Row[], rowCount: 2 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
  const database: Database = {
    async transaction(_principal, action) { return action(client); },
    async close() {},
  };

  const result = await listMemoryInbox(database, principal, {
    kinds: ["learning"], tags: ["inbox"], limit: 1, cursor: null,
  });

  assert.deepEqual(result.items.map((item) => item.id), ["9"]);
  assert.deepEqual(JSON.parse(Buffer.from(result.next_cursor ?? "", "base64url").toString("utf8")), {
    importance_score: 8, created_at: "2026-07-31T02:00:00.000Z", id: "9",
  });
  assert.match(queries[0]?.text ?? "", /m\.owner_id = \$1/);
  assert.match(queries[0]?.text ?? "", /m\.status = 'proposed'/);
  assert.match(queries[0]?.text ?? "", /order by coalesce\(m\.importance_score, -1\) desc, m\.created_at desc, m\.id desc/);
  assert.deepEqual(queries[0]?.values, [
    principal.userId, ["R_repo"], ["learning"], ["inbox"], null, null, null, 2,
  ]);
});
