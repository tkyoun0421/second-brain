import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { McpApiClient, McpApiError, loadMcpApiClientConfig } from "./mcp-api-client.js";

const version = "0.1.0";
const memoryId = z.string().regex(/^\d+$/, "memory_id must be a positive integer string");
const timestamp = z.string().datetime({ offset: true });
const scope = z.object({ type: z.enum(["global", "organization", "repository", "project", "path", "task"]), id: z.string().trim().min(1).max(1_000) });
const source = z.object({
  type: z.enum(["github_issue", "github_comment", "user_message", "test_result", "document", "agent_run", "policy_event"]),
  id: z.string().trim().min(1).max(1_000),
  uri: z.string().url().nullable().optional(),
  excerpt: z.string().max(2_000).nullable().optional(),
});
const confirmation = z.object({
  origin: z.enum(["explicit_user", "agent_inference", "verified_execution", "policy_enforcement"]),
  source: source.pick({ type: true, id: true }),
  confirmed_at: timestamp.optional(),
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };

const success = (data: unknown, requestId?: string): ToolResult => {
  const payload = {
    ok: true,
    data,
    meta: { contract_version: "v1", generated_at: new Date().toISOString(), ...(requestId ? { request_id: requestId } : {}) },
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
};

const failure = (error: unknown): ToolResult => {
  const apiError = error instanceof McpApiError
    ? error
    : new McpApiError("INTERNAL", "The MCP server could not process this tool call.", true);
  const payload = {
    ok: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      retryable: apiError.retryable,
      ...(apiError.details === undefined ? {} : { details: apiError.details }),
    },
    meta: { contract_version: "v1", generated_at: new Date().toISOString(), ...(apiError.requestId ? { request_id: apiError.requestId } : {}) },
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
};

const toApiSource = (value: z.infer<typeof source>) => ({
  source_type: value.type,
  source_id: value.id,
  source_uri: value.uri ?? null,
  source_excerpt: value.excerpt ?? null,
});

const toApiConfirmation = (value: z.infer<typeof confirmation>) => ({
  origin: value.origin,
  source: value.source,
  confirmed_at: value.confirmed_at ?? new Date().toISOString(),
});

const apiResult = async (call: () => Promise<{ requestId?: string; data: unknown }>) => {
  try {
    const result = await call();
    return success(result.data, result.requestId);
  } catch (error) {
    return failure(error);
  }
};

export const createMcpServer = (api: McpApiClient) => {
  const server = new McpServer({ name: "second-brain", version });

  server.registerTool("brain_get_context", {
    title: "Get relevant context", description: "Read the active, relevant memories for the current repository task.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      repository: z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1).optional(), local_path: z.string().optional() }),
      task: z.string().max(10_000), paths: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      token_budget: z.number().int().min(100).max(3_000).default(3_000), per_kind_limit: z.number().int().min(1).max(20).default(5),
      total_limit: z.number().int().min(1).max(20).default(20),
    },
  }, (input) => apiResult(() => api.post("/v1/context/query", {
    repository: { github_repository_id: input.repository.id, full_name: input.repository.name }, task: input.task, paths: input.paths, tags: input.tags,
    limits: { max_memories: input.total_limit, max_per_kind: input.per_kind_limit, max_estimated_tokens: input.token_budget },
  })));

  server.registerTool("brain_search", {
    title: "Search memories", description: "Search memories by text, type, scope, and active or inbox state.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      query: z.string().trim().min(1).max(500), kinds: z.array(z.enum(["learning", "decision", "preference", "failure", "procedure", "constraint"])).max(6).optional(),
      scopes: z.array(scope).max(50).optional(), mode: z.enum(["active", "inbox"]).default("active"),
      statuses: z.array(z.enum(["proposed", "confirmed", "verified"])).max(3).optional(), tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(1_000).nullable().default(null),
    },
  }, (input) => apiResult(async () => {
    const defaultStatuses = input.mode === "inbox" ? ["proposed"] : ["confirmed", "verified"];
    const statuses = input.statuses ?? defaultStatuses;
    if (input.mode === "inbox" && statuses.some((value) => value !== "proposed")) throw new McpApiError("INVALID_ARGUMENT", "inbox mode only permits proposed status.", false);
    if (input.mode === "active" && statuses.some((value) => value === "proposed")) throw new McpApiError("INVALID_ARGUMENT", "active mode does not permit proposed status.", false);
    return api.post("/v1/memories/search", { query: input.query, kinds: input.kinds, scopes: input.scopes, statuses, tags: input.tags, limit: input.limit, cursor: input.cursor });
  }));

  server.registerTool("brain_get_detail", {
    title: "Get memory detail", description: "Read a single memory and its evidence summary.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { memory_id: memoryId, include_source_excerpt: z.boolean().default(true), include_history: z.boolean().default(true) },
  }, (input) => apiResult(() => api.get(`/v1/memories/${input.memory_id}`)));

  server.registerTool("brain_capture_auto_memory", {
    title: "Capture important memory candidate",
    description: "Evaluate a task decision or failure by importance, then discard it or save it as a proposed Inbox memory.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      idempotency_key: z.string().trim().min(16).max(200),
      kind: z.enum(["decision", "failure"]),
      statement: z.string().trim().min(1).max(2_000),
      rationale: z.string().max(10_000).nullable(),
      scope,
      tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
      trigger: z.enum(["agent_checkpoint", "user_choice", "error_resolution"]),
      source,
      occurred_at: timestamp.default(() => new Date().toISOString()),
      signals: z.object({
        reusability: z.number().int().min(0).max(3), impact: z.number().int().min(0).max(3),
        scope: z.number().int().min(0).max(2), evidence: z.number().int().min(0).max(2),
        noise_penalty: z.number().int().min(0).max(3),
      }),
      decision: z.object({ alternatives: z.array(z.string().trim().min(1).max(500)).max(50) }).optional(),
      failure: z.object({
        resolution_status: z.enum(["observed", "investigating", "hypothesis", "resolved", "verified", "recurring"]),
        symptom: z.string().trim().min(1).max(10_000), environment: z.string().max(10_000).nullable(),
        attempts: z.array(z.string().trim().min(1).max(10_000)).max(50),
        cause_or_hypothesis: z.string().max(10_000).nullable(), resolution: z.string().max(10_000).nullable(),
        verification: z.array(z.string().max(10_000)).max(50),
      }).optional(),
    },
  }, (input) => apiResult(async () => {
    if (input.kind === "decision" && !input.decision) {
      throw new McpApiError("INVALID_ARGUMENT", "decision is required when kind is decision.", false);
    }
    if (input.kind === "failure" && !input.failure) {
      throw new McpApiError("INVALID_ARGUMENT", "failure is required when kind is failure.", false);
    }
    return api.post("/v1/memories/capture", {
      candidate: {
        kind: input.kind,
        statement: input.statement,
        rationale: input.rationale,
        scope: input.scope,
        tags: input.tags,
        trigger: input.trigger,
        source: toApiSource(input.source),
        occurred_at: input.occurred_at,
        signals: input.signals,
        ...(input.kind === "decision" ? { decision: input.decision } : { failure: input.failure }),
      },
    }, input.idempotency_key);
  }));

  server.registerTool("brain_save_decision", {
    title: "Save decision", description: "Store a proposed or explicitly user-confirmed decision.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      idempotency_key: z.string().trim().min(16).max(200), statement: z.string().trim().min(1).max(2_000), rationale: z.string().max(10_000).nullable().optional(),
      alternatives_not_chosen: z.array(z.string().trim().min(1).max(500)).max(50).default([]), scope, tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
      valid_from: timestamp.default(() => new Date().toISOString()), valid_until: timestamp.nullable().default(null), status_intent: z.enum(["proposed", "confirmed"]),
      confidence: z.number().min(0).max(1).optional(), sources: z.array(source).min(1).max(50).optional(), confirmation,
    },
  }, (input) => apiResult(() => api.post("/v1/memories/decisions", {
    statement: input.statement, rationale: input.rationale ?? null, scope: input.scope, status: input.status_intent,
    confidence: input.confidence ?? (input.status_intent === "confirmed" ? 1 : 0.7), decision: { alternatives: input.alternatives_not_chosen, decided_at: input.valid_from },
    sources: (input.sources ?? [input.confirmation.source]).map(toApiSource), confirmation: toApiConfirmation(input.confirmation),
    valid_from: input.valid_from, valid_until: input.valid_until, tags: input.tags,
  }, input.idempotency_key)));

  server.registerTool("brain_save_failure", {
    title: "Save failure", description: "Store a failure, investigation, or verified resolution as a memory.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      idempotency_key: z.string().trim().min(16).max(200), title: z.string().trim().min(1).max(2_000), symptom: z.string().trim().min(1).max(10_000),
      environment: z.string().max(10_000).nullable().optional(), attempts: z.array(z.object({ description: z.string().trim().min(1).max(10_000), outcome: z.string().max(10_000).optional() })).max(50).default([]),
      cause: z.object({ statement: z.string().max(10_000).nullable(), certainty: z.enum(["unknown", "hypothesis", "confirmed"]) }).optional(), resolution: z.string().max(10_000).nullable().optional(),
      verification: z.object({ status: z.enum(["passed", "failed", "skipped", "not_run"]), summary: z.string().max(10_000).nullable(), source: source.pick({ type: true, id: true }).nullable() }).default({ status: "not_run", summary: null, source: null }),
      failure_status: z.enum(["observed", "investigating", "hypothesis", "resolved", "verified", "recurring"]), memory_status_intent: z.enum(["proposed", "confirmed", "verified"]),
      scope, tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]), valid_from: timestamp.default(() => new Date().toISOString()), valid_until: timestamp.nullable().default(null), confidence: z.number().min(0).max(1).default(0.7),
      sources: z.array(source).min(1).max(50).optional(), confirmation,
    },
  }, (input) => apiResult(() => {
    const evidence = input.sources ?? [input.confirmation.source];
    if (input.verification.source) evidence.push(input.verification.source);
    return api.post("/v1/memories/failures", {
      statement: input.title, rationale: null, scope: input.scope, status: input.memory_status_intent, confidence: input.confidence,
      sources: evidence.map(toApiSource), confirmation: toApiConfirmation(input.confirmation), valid_from: input.valid_from, valid_until: input.valid_until, tags: input.tags,
      failure: { resolution_status: input.failure_status, symptom: input.symptom, environment: input.environment ?? null, attempts: input.attempts.map((attempt) => [attempt.description, attempt.outcome].filter(Boolean).join(": ")),
        cause_or_hypothesis: input.cause?.statement ?? null, resolution: input.resolution ?? null, verification: input.verification.summary ? [input.verification.summary] : [] },
    }, input.idempotency_key);
  }));

  server.registerTool("brain_finish_run", {
    title: "Finish agent run", description: "Record an agent run, verification summary, and memory feedback.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      idempotency_key: z.string().trim().min(16).max(200), session_id: z.string().trim().min(1).max(500), agent: z.string().trim().min(1).max(255),
      repository_id: z.string().regex(/^\d+$/).nullable().optional(), goal: z.string().trim().min(1).max(10_000), started_at: timestamp, finished_at: timestamp,
      result: z.enum(["success", "partial", "failed", "aborted"]), summary: z.string().max(10_000).nullable().optional(), changed_files: z.array(z.union([z.string().trim().min(1).max(2_000), z.object({ path: z.string().trim().min(1).max(2_000), operation: z.enum(["created", "modified", "deleted"]).optional() })])).max(1_000).default([]),
      actions: z.array(z.object({ kind: z.string().trim().min(1).max(100), summary: z.string().trim().min(1).max(10_000) })).max(1_000).default([]),
      verification: z.array(z.object({ kind: z.string().trim().min(1).max(100), name: z.string().max(500).optional(), status: z.enum(["passed", "failed", "skipped", "not_run"]), summary: z.string().trim().min(1).max(10_000), source_id: z.string().max(1_000).optional() })).max(1_000).default([]),
      used_memories: z.array(z.object({ memory_id: memoryId, feedback: z.enum(["helpful", "irrelevant", "outdated", "incorrect", "conflicting"]) })).max(1_000).default([]), created_memory_ids: z.array(memoryId).max(1_000).default([]), failure_ids: z.array(memoryId).max(1_000).default([]),
    },
  }, (input) => apiResult(() => api.post("/v1/agent-runs/finish", {
    session_id: input.session_id, agent: input.agent, repository_id: input.repository_id ?? null, goal: input.goal, started_at: input.started_at, finished_at: input.finished_at,
    result: ({ success: "succeeded", partial: "partial", failed: "failed", aborted: "cancelled" } as const)[input.result], summary: input.summary ?? null,
    changed_files: input.changed_files.map((file) => typeof file === "string" ? { path: file, operation: "modified" } : file), commands_or_actions: input.actions, verification: input.verification,
    used_memories: input.used_memories.map(({ memory_id, feedback }) => ({ memory_id, rating: feedback })), created_memory_ids: input.created_memory_ids, failure_ids: input.failure_ids,
  }, input.idempotency_key)));

  server.registerTool("brain_confirm_memory", {
    title: "Confirm memory", description: "Convert a proposed memory to confirmed only with explicit user confirmation.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: { idempotency_key: z.string().trim().min(16).max(200), memory_id: memoryId, expected_revision: z.number().int().positive(), confirmation },
  }, (input) => apiResult(() => api.post(`/v1/memories/${input.memory_id}/confirm`, { expected_revision: input.expected_revision, confirmation: toApiConfirmation(input.confirmation) }, input.idempotency_key)));

  server.registerTool("brain_supersede_memory", {
    title: "Supersede memory", description: "Create a same-kind, same-scope replacement for an active memory.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      idempotency_key: z.string().trim().min(16).max(200), existing_memory_id: memoryId, expected_existing_revision: z.number().int().positive(), status_intent: z.enum(["proposed", "confirmed"]), confirmation,
      replacement: z.object({ kind: z.enum(["learning", "decision", "preference", "failure", "procedure", "constraint"]), statement: z.string().trim().min(1).max(2_000), rationale: z.string().max(10_000).nullable().optional(), scope, confidence: z.number().min(0).max(1).default(0.7), sources: z.array(source).min(1).max(50).optional(), valid_from: timestamp.default(() => new Date().toISOString()), valid_until: timestamp.nullable().default(null), tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]), failure: z.object({ resolution_status: z.enum(["observed", "investigating", "hypothesis", "resolved", "verified", "recurring"]), symptom: z.string().trim().min(1).max(10_000), environment: z.string().max(10_000).nullable().optional(), attempts: z.array(z.string().max(10_000)).max(50).default([]), cause_or_hypothesis: z.string().max(10_000).nullable().optional(), resolution: z.string().max(10_000).nullable().optional(), verification: z.array(z.string().max(10_000)).max(50).default([]) }).optional() }),
    },
  }, (input) => apiResult(() => api.post(`/v1/memories/${input.existing_memory_id}/supersede`, {
    expected_revision: input.expected_existing_revision, status_intent: input.status_intent, confirmation: toApiConfirmation(input.confirmation), replacement: { ...input.replacement, sources: (input.replacement.sources ?? [input.confirmation.source]).map(toApiSource) },
  }, input.idempotency_key)));

  server.registerTool("brain_forget", {
    title: "Forget memory", description: "Preview or execute a guarded memory deletion. Execute requires a recent matching preview token.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      mode: z.enum(["preview", "execute"]), memory_id: memoryId, expected_revision: z.number().int().positive(), reason_code: z.enum(["user_requested", "sensitive_data", "retention_expired", "unauthorized_source"]), delete_linked_source: z.boolean().default(false),
      preview_token: z.string().min(1).max(8_000).optional(), confirmation: confirmation.optional(), idempotency_key: z.string().trim().min(16).max(200).optional(),
    },
  }, (input) => apiResult(() => {
    const previewPayload = { expected_revision: input.expected_revision, reason_code: input.reason_code, delete_linked_source: input.delete_linked_source };
    if (input.mode === "preview") return api.post(`/v1/memories/${input.memory_id}/forget-preview`, previewPayload);
    if (!input.preview_token || !input.confirmation || !input.idempotency_key) throw new McpApiError("INVALID_ARGUMENT", "execute requires preview_token, confirmation, and idempotency_key.", false);
    return api.post(`/v1/memories/${input.memory_id}/forget`, { ...previewPayload, preview_token: input.preview_token, confirmation: toApiConfirmation(input.confirmation) }, input.idempotency_key);
  }));

  return server;
};

const main = async () => {
  const api = new McpApiClient(loadMcpApiClientConfig());
  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`Second Brain MCP server failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
