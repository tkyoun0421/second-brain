import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { McpApiClient } from "#app/mcp-api-client.js";
import { createMcpServer } from "#app/mcp-server.js";

test("MCP server exposes all ten tools and translates API calls", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const api = new McpApiClient({
    apiBaseUrl: "http://127.0.0.1:3000/",
    accessToken: "test-token",
    requestTimeoutMs: 1_000,
    async fetch(url, init) {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ request_id: "req-test", data: { forwarded: true } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const server = createMcpServer(api);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "brain_capture_auto_memory", "brain_confirm_memory", "brain_finish_run", "brain_forget", "brain_get_context",
      "brain_get_detail", "brain_save_decision", "brain_save_failure", "brain_search", "brain_supersede_memory",
    ]);

    const context = await client.callTool({ name: "brain_get_context", arguments: {
      repository: { id: "R_test", name: "example/test" }, task: "Use relevant context",
    } });
    assert.equal(context.isError, undefined);
    assert.equal(requests[0]?.url, "http://127.0.0.1:3000/v1/context/query");
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      repository: { github_repository_id: "R_test", full_name: "example/test" }, task: "Use relevant context", paths: [], tags: [],
      limits: { max_memories: 20, max_per_kind: 5, max_estimated_tokens: 3_000 },
    });

    await client.callTool({ name: "brain_save_decision", arguments: {
      idempotency_key: "mcp-test-decision-1", statement: "Use pnpm.", scope: { type: "repository", id: "1" },
      status_intent: "confirmed", confirmation: { origin: "explicit_user", source: { type: "user_message", id: "msg-1" } },
    } });
    assert.equal(requests[1]?.init.headers instanceof Headers ? requests[1].init.headers.get("x-idempotency-key") : (requests[1]?.init.headers as Record<string, string>)["x-idempotency-key"], "mcp-test-decision-1");
    const decision = JSON.parse(String(requests[1]?.init.body));
    assert.equal(decision.status, "confirmed");
    assert.deepEqual(decision.sources, [{ source_type: "user_message", source_id: "msg-1", source_uri: null, source_excerpt: null }]);

    await client.callTool({ name: "brain_finish_run", arguments: {
      idempotency_key: "mcp-test-run-key-1", session_id: "session-1", agent: "codex", goal: "Test MCP", started_at: "2026-07-31T00:00:00Z", finished_at: "2026-07-31T00:01:00Z", result: "success", changed_files: ["src/mcp-server.ts"],
    } });
    const run = JSON.parse(String(requests[2]?.init.body));
    assert.equal(run.result, "succeeded");
    assert.deepEqual(run.changed_files, [{ path: "src/mcp-server.ts", operation: "modified" }]);

    await client.callTool({ name: "brain_forget", arguments: {
      mode: "preview", memory_id: "42", expected_revision: 3, reason_code: "user_requested", delete_linked_source: false,
    } });
    assert.equal(requests[3]?.url, "http://127.0.0.1:3000/v1/memories/42/forget-preview");
    assert.equal(requests[3]?.init.headers instanceof Headers ? requests[3].init.headers.get("x-idempotency-key") : (requests[3]?.init.headers as Record<string, string>)["x-idempotency-key"], undefined);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("MCP server exposes API dependency errors as failed tool results", async () => {
  const api = new McpApiClient({
    apiBaseUrl: "http://127.0.0.1:3000", accessToken: "test-token", requestTimeoutMs: 1_000,
    async fetch() { throw new TypeError("network down"); },
  });
  const server = createMcpServer(api);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "brain_get_detail", arguments: { memory_id: "42" } });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(String(content[0]?.text));
    assert.equal(payload.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(payload.error.retryable, true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("MCP capture tool forwards a structured candidate to the automatic capture endpoint", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const api = new McpApiClient({
    apiBaseUrl: "http://127.0.0.1:3000", accessToken: "test-token", requestTimeoutMs: 1_000,
    async fetch(url, init) {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ request_id: "req-capture", data: { outcome: "stored" } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const server = createMcpServer(api);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "brain_capture_auto_memory", arguments: {
      idempotency_key: "mcp-capture-test-key-0001",
      kind: "decision",
      statement: "Keep API health checks enabled.",
      rationale: "Deploy readiness depends on it.",
      scope: { type: "repository", id: "42" },
      tags: ["deployment"],
      trigger: "agent_checkpoint",
      source: { type: "agent_run", id: "100", excerpt: "Healthcheck passed." },
      occurred_at: "2026-07-31T00:00:00Z",
      signals: { reusability: 3, impact: 3, scope: 2, evidence: 2, noise_penalty: 0 },
      decision: { alternatives: ["Skip the healthcheck"] },
    } });

    assert.equal(result.isError, undefined);
    assert.equal(requests[0]?.url, "http://127.0.0.1:3000/v1/memories/capture");
    assert.equal(requests[0]?.init.headers instanceof Headers ? requests[0].init.headers.get("x-idempotency-key") : (requests[0]?.init.headers as Record<string, string>)["x-idempotency-key"], "mcp-capture-test-key-0001");
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      candidate: {
        kind: "decision",
        statement: "Keep API health checks enabled.",
        rationale: "Deploy readiness depends on it.",
        scope: { type: "repository", id: "42" },
        tags: ["deployment"],
        trigger: "agent_checkpoint",
        source: { source_type: "agent_run", source_id: "100", source_uri: null, source_excerpt: "Healthcheck passed." },
        occurred_at: "2026-07-31T00:00:00Z",
        signals: { reusability: 3, impact: 3, scope: 2, evidence: 2, noise_penalty: 0 },
        decision: { alternatives: ["Skip the healthcheck"] },
      },
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
