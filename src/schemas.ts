import { z } from "zod";

const nonBlank = z.string().trim().min(1);
const githubId = z.string().regex(/^[1-9]\d*$/, "GitHub ID는 양의 정수 문자열이어야 합니다.");
const timestamp = z.string().datetime({ offset: true });

export const syncStartSchema = z.object({
  repository: z.object({
    github_id: githubId,
    node_id: nonBlank,
    full_name: nonBlank.max(500),
    html_url: z.string().url(),
    visibility: z.enum(["public", "private", "internal"]),
  }),
  mode: z.enum(["incremental", "reconcile", "manual"]),
  query_from: timestamp.nullable().optional(),
  client_run_id: nonBlank.max(500).optional(),
});

export const heartbeatSchema = z.object({
  stream: z.enum(["issues", "comments"]),
  pages_completed: z.number().int().nonnegative(),
  items_accepted: z.number().int().nonnegative(),
  observed_through: timestamp,
});

const labelSchema = z.object({
  github_id: githubId,
  name: nonBlank.max(100),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
});

const issuePayloadSchema = z.object({
  github_id: githubId,
  node_id: nonBlank,
  number: z.number().int().positive(),
  title: z.string().max(10_000),
  body: z.string().max(2_000_000).nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().max(100).nullable(),
  author_login: z.string().max(255).nullable(),
  locked: z.boolean(),
  html_url: z.string().url(),
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: timestamp.nullable(),
  labels: z.array(labelSchema).max(100),
});

const commentPayloadSchema = z.object({
  github_id: githubId,
  node_id: nonBlank,
  author_login: z.string().max(255).nullable(),
  body: z.string().max(2_000_000).nullable(),
  html_url: z.string().url(),
  created_at: timestamp,
  updated_at: timestamp,
});

const itemBase = z.object({
  idempotency_key: nonBlank.min(16).max(200),
});

export const syncItemSchema = z.union([
  itemBase.extend({
    resource_type: z.literal("issue"),
    operation: z.literal("upsert"),
    issue: issuePayloadSchema,
    observed_at: timestamp,
  }),
  itemBase.extend({
    resource_type: z.literal("issue_comment"),
    operation: z.literal("upsert"),
    issue_number: z.number().int().positive(),
    comment: commentPayloadSchema,
    observed_at: timestamp,
  }),
  itemBase.extend({
    resource_type: z.enum(["issue", "issue_comment"]),
    operation: z.literal("tombstone"),
    github_id: githubId,
    deleted_at: timestamp,
  }),
]);

export const syncItemsSchema = z.object({ items: z.array(syncItemSchema).min(1).max(100) });

export const syncCompleteSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["completed", "completed_with_errors"]),
    observed_through: timestamp,
    expected_checkpoint_version: z.number().int().nonnegative(),
    summary: z.object({
      issues_seen: z.number().int().nonnegative(),
      issue_snapshots_created: z.number().int().nonnegative(),
      comments_seen: z.number().int().nonnegative(),
      comment_snapshots_created: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    status: z.enum(["failed", "cancelled"]),
    error: z.object({ code: nonBlank.max(100), message: nonBlank.max(2_000) }).optional(),
  }),
]);

const scopeSchema = z.object({
  type: z.enum(["global", "organization", "repository", "project", "path", "task"]),
  id: nonBlank.max(1_000),
});

const sourceSchema = z.object({
  source_type: z.enum(["github_issue", "github_comment", "user_message", "test_result", "document", "agent_run", "policy_event"]),
  source_id: nonBlank.max(1_000),
  source_uri: z.string().url().nullable(),
  source_excerpt: z.string().max(2_000).nullable(),
});

const confirmationSchema = z.object({
  origin: z.enum(["explicit_user", "agent_inference", "verified_execution", "policy_enforcement"]),
  source: z.object({ type: nonBlank.max(100), id: nonBlank.max(1_000) }),
  confirmed_at: timestamp,
});

const memoryInputSchema = z.object({
  statement: nonBlank.max(2_000),
  rationale: z.string().max(10_000).nullable().optional(),
  scope: scopeSchema,
  status: z.enum(["proposed", "confirmed", "verified"]),
  confidence: z.number().min(0).max(1),
  sources: z.array(sourceSchema).min(1),
  confirmation: confirmationSchema.optional(),
  valid_from: timestamp,
  valid_until: timestamp.nullable(),
  tags: z.array(nonBlank.max(100)).max(30),
});

export const decisionSchema = memoryInputSchema.extend({
  decision: z.object({
    alternatives: z.array(nonBlank.max(500)).max(50),
    decided_at: timestamp,
  }),
});

export const failureSchema = memoryInputSchema.extend({
  failure: z.object({
    resolution_status: z.enum(["observed", "investigating", "hypothesis", "resolved", "verified", "recurring"]),
    symptom: nonBlank.max(10_000),
    environment: z.string().max(10_000).nullable().optional(),
    attempts: z.array(nonBlank.max(10_000)).max(50),
    cause_or_hypothesis: z.string().max(10_000).nullable().optional(),
    resolution: z.string().max(10_000).nullable().optional(),
    verification: z.array(nonBlank.max(10_000)).max(50),
  }),
});

export const contextQuerySchema = z.object({
  repository: z.object({
    github_repository_id: nonBlank,
    full_name: nonBlank.max(500).optional(),
  }),
  task: z.string().max(10_000).default(""),
  paths: z.array(nonBlank.max(1_000)).max(50).default([]),
  tags: z.array(nonBlank.max(100)).max(30).default([]),
  limits: z.object({
    max_memories: z.number().int().min(1).max(100).default(20),
    max_per_kind: z.number().int().min(1).max(20).default(5),
    max_estimated_tokens: z.number().int().min(100).max(20_000).default(3_000),
  }).default({ max_memories: 20, max_per_kind: 5, max_estimated_tokens: 3_000 }),
});

export const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  kinds: z.array(z.enum(["learning", "decision", "preference", "failure", "procedure", "constraint"])).max(6).optional(),
  scopes: z.array(scopeSchema).max(50).optional(),
  statuses: z.array(z.enum(["proposed", "confirmed", "verified", "superseded", "deprecated", "deleted"])).max(6).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1_000).nullable().default(null),
});

export type SyncStartInput = z.infer<typeof syncStartSchema>;
export type SyncItem = z.infer<typeof syncItemSchema>;
export type SyncCompleteInput = z.infer<typeof syncCompleteSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
export type FailureInput = z.infer<typeof failureSchema>;
export type ContextQueryInput = z.infer<typeof contextQuerySchema>;
export type MemorySearchInput = z.infer<typeof memorySearchSchema>;
