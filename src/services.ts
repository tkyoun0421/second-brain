import type { SqlClient, Database } from "./database.js";
import { ApiError, invalidArgument } from "./errors.js";
import { canonicalJson, sha256 } from "./hash.js";
import { executeIdempotent } from "./idempotency.js";
import {
  assertRepositoryAllowed,
  requireAnyPermission,
  requirePermission,
  type Principal,
} from "./principal.js";
import type {
  DecisionInput,
  FailureInput,
  SyncCompleteInput,
  SyncItem,
  SyncStartInput,
} from "./schemas.js";

interface RepositoryRow {
  id: string;
  github_node_id: string | null;
}

interface SyncRunRow extends RepositoryRow {
  sync_run_id: string;
  mode: "incremental" | "reconcile" | "manual";
  status: string;
}

const notFound = () =>
  new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "요청한 리소스를 찾을 수 없습니다." });

const conflict = (reason: string, message: string) =>
  new ApiError({
    statusCode: 409,
    code: "CONFLICT",
    message,
    details: [{ path: "/", reason }],
  });

const toJson = (value: unknown) => JSON.stringify(value);

const getRepositoryByNode = async (
  client: SqlClient,
  ownerId: string,
  nodeId: string,
): Promise<RepositoryRow | undefined> => {
  const result = await client.query<RepositoryRow>(
    `select id::text, github_node_id
       from public.repositories
      where owner_id = $1 and github_node_id = $2`,
    [ownerId, nodeId],
  );
  return result.rows[0];
};

const getSyncRun = async (
  client: SqlClient,
  principal: Principal,
  syncRunId: string,
  forUpdate = false,
): Promise<SyncRunRow> => {
  const result = await client.query<SyncRunRow>(
    `select sr.id::text as sync_run_id, sr.mode, sr.status,
            r.id::text, r.github_node_id
       from public.sync_runs sr
       join public.repositories r on r.owner_id = sr.owner_id and r.id = sr.repository_id
      where sr.owner_id = $1 and sr.id = $2::bigint
      ${forUpdate ? "for update of sr" : ""}`,
    [principal.userId, syncRunId],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  assertRepositoryAllowed(principal, row.github_node_id);
  return row;
};

const ensureSyncStillRunning = (syncRun: SyncRunRow) => {
  if (syncRun.status !== "running") {
    throw new ApiError({
      statusCode: 409,
      code: "INVALID_STATE_TRANSITION",
      message: "종료된 동기화 실행에는 변경을 기록할 수 없습니다.",
    });
  }
};

const makeOperation = (path: string) => `POST ${path}`;

export const getCheckpoint = async (
  database: Database,
  principal: Principal,
  githubNodeId: string,
) => database.transaction(principal, async (client) => {
  requirePermission(principal, "github_sync:checkpoint");
  const repository = await getRepositoryByNode(client, principal.userId, githubNodeId);
  if (!repository) throw notFound();
  assertRepositoryAllowed(principal, repository.github_node_id);
  const result = await client.query<{ revision: string | null; observed_through: string | null }>(
    `select max(revision)::text as revision, min(last_successful_at)::text as observed_through
       from public.sync_checkpoints
      where owner_id = $1 and repository_id = $2::bigint`,
    [principal.userId, repository.id],
  );
  const checkpoint = result.rows[0];
  const observedThrough = checkpoint?.observed_through ?? null;
  return {
    github_repository_id: githubNodeId,
    last_successful_observed_through: observedThrough,
    recommended_query_from: observedThrough
      ? new Date(new Date(observedThrough).getTime() - 900_000).toISOString()
      : null,
    overlap_seconds: 900,
    checkpoint_version: Number(checkpoint?.revision ?? 0),
  };
});

export const startSyncRun = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: SyncStartInput,
) => {
  requirePermission(principal, "github_sync:checkpoint");
  assertRepositoryAllowed(principal, input.repository.node_id);
  return executeIdempotent(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/github/sync-runs"),
      requestHash,
      requestId,
      audit: {
        operation: "sync",
        targetType: "sync_run",
        redactedInput: { mode: input.mode, repository_node_id: input.repository.node_id },
      },
    },
    async (client) => {
      const repository = await client.query<RepositoryRow>(
        `insert into public.repositories (
           owner_id, github_repository_id, github_node_id, full_name, html_url, is_private
         ) values ($1, $2::bigint, $3, $4, $5, $6)
         on conflict (owner_id, github_repository_id)
         do update set github_node_id = excluded.github_node_id,
                       full_name = excluded.full_name,
                       html_url = excluded.html_url,
                       is_private = excluded.is_private
         returning id::text, github_node_id`,
        [
          principal.userId,
          input.repository.github_id,
          input.repository.node_id,
          input.repository.full_name,
          input.repository.html_url,
          input.repository.visibility !== "public",
        ],
      );
      const repositoryRow = repository.rows[0];
      if (!repositoryRow) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "저장소를 저장하지 못했습니다.", retryable: true });

      await client.query(
        `insert into public.sync_checkpoints (owner_id, repository_id, stream)
         values ($1, $2::bigint, 'issues'), ($1, $2::bigint, 'comments')
         on conflict (owner_id, repository_id, stream) do nothing`,
        [principal.userId, repositoryRow.id],
      );
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [repositoryRow.id]);
      const active = await client.query<{ id: string }>(
        `select id::text from public.sync_runs
          where owner_id = $1 and repository_id = $2::bigint and status = 'running'
          for update`,
        [principal.userId, repositoryRow.id],
      );
      if (active.rows[0]) {
        throw conflict("sync_already_running", "이 저장소의 동기화가 이미 실행 중입니다.");
      }
      const created = await client.query<{ id: string; started_at: string }>(
        `insert into public.sync_runs (
           owner_id, repository_id, mode, idempotency_key, client_run_id, overlap_started_at
         ) values ($1, $2::bigint, $3::public.sync_mode, $4, $5, $6::timestamptz)
         returning id::text, started_at::text`,
        [
          principal.userId,
          repositoryRow.id,
          input.mode,
          sha256(`${principal.principalId}:${idempotencyKey}`),
          input.client_run_id ?? null,
          input.query_from ?? null,
        ],
      );
      const checkpoint = await client.query<{ revision: string }>(
        `select max(revision)::text as revision from public.sync_checkpoints
          where owner_id = $1 and repository_id = $2::bigint`,
        [principal.userId, repositoryRow.id],
      );
      const run = created.rows[0];
      if (!run) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "동기화 실행을 시작하지 못했습니다.", retryable: true });
      return {
        statusCode: 201,
        data: {
          sync_run_id: run.id,
          status: "running",
          repository_id: repositoryRow.id,
          checkpoint_version: Number(checkpoint.rows[0]?.revision ?? 0),
          started_at: run.started_at,
        },
      };
    },
  );
};

export const heartbeatSyncRun = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  syncRunId: string,
  input: { stream: "issues" | "comments"; pages_completed: number; items_accepted: number; observed_through: string },
) => {
  requirePermission(principal, "github_sync:checkpoint");
  return executeIdempotent(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/github/sync-runs/{sync_run_id}/heartbeat"),
      requestHash,
      requestId,
      audit: { operation: "sync", targetType: "sync_run", targetIds: [syncRunId], redactedInput: { stream: input.stream } },
    },
    async (client) => {
      const run = await getSyncRun(client, principal, syncRunId, true);
      ensureSyncStillRunning(run);
      const updated = await client.query<{ updated_at: string }>(
        `update public.sync_runs
            set counts = counts || jsonb_build_object(
                  'heartbeat', jsonb_build_object(
                    'stream', $1,
                    'pages_completed', $2,
                    'items_accepted', $3,
                    'observed_through', $4::timestamptz
                  )
                )
          where owner_id = $5 and id = $6::bigint
          returning updated_at::text`,
        [input.stream, input.pages_completed, input.items_accepted, input.observed_through, principal.userId, syncRunId],
      );
      return { statusCode: 200, data: { sync_run_id: syncRunId, status: "running", heartbeat_at: updated.rows[0]?.updated_at ?? new Date().toISOString() } };
    },
  );
};

const upsertSource = async (
  client: SqlClient,
  principal: Principal,
  run: SyncRunRow,
  item: Extract<SyncItem, { operation: "upsert" }>,
) => {
  const isIssue = item.resource_type === "issue";
  const sourceType = isIssue ? "github_issue" : "github_comment";
  const source = isIssue ? item.issue : item.comment;
  const externalId = isIssue ? String(item.issue.number) : item.comment.github_id;
  let parentSourceId: string | null = null;
  if (!isIssue) {
    const parent = await client.query<{ id: string }>(
      `select id::text from public.source_records
        where owner_id = $1 and repository_id = $2::bigint
          and source_type = 'github_issue' and external_id = $3`,
      [principal.userId, run.id, String(item.issue_number)],
    );
    parentSourceId = parent.rows[0]?.id ?? null;
    if (!parentSourceId) throw invalidArgument("댓글보다 먼저 부모 Issue를 수집해야 합니다.");
  }

  const metadata = isIssue
    ? { state: item.issue.state, state_reason: item.issue.state_reason, author_login: item.issue.author_login, locked: item.issue.locked, labels: item.issue.labels }
    : { author_login: item.comment.author_login };
  const sourceRecord = await client.query<{ id: string }>(
    `insert into public.source_records (
       owner_id, source_type, repository_id, external_id, provider_id, external_node_id,
       parent_source_id, source_uri, last_seen_sync_run_id, lifecycle_status,
       last_seen_at, external_created_at, external_updated_at, metadata
     ) values ($1, $2::public.source_type, $3::bigint, $4, $5, $6, $7::bigint, $8,
               $9::bigint, 'active', $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::jsonb)
     on conflict (owner_id, repository_id, source_type, external_id) where repository_id is not null
     do update set provider_id = excluded.provider_id,
                   external_node_id = excluded.external_node_id,
                   parent_source_id = excluded.parent_source_id,
                   source_uri = excluded.source_uri,
                   last_seen_sync_run_id = excluded.last_seen_sync_run_id,
                   lifecycle_status = 'active',
                   consecutive_complete_misses = 0,
                   first_missing_at = null,
                   deleted_at = null,
                   tombstone = null,
                   last_seen_at = excluded.last_seen_at,
                   external_created_at = excluded.external_created_at,
                   external_updated_at = excluded.external_updated_at,
                   metadata = excluded.metadata
     returning id::text`,
    [
      principal.userId,
      sourceType,
      run.id,
      externalId,
      source.github_id,
      source.node_id,
      parentSourceId,
      source.html_url,
      run.sync_run_id,
      item.observed_at,
      source.created_at,
      source.updated_at,
      toJson(metadata),
    ],
  );
  const sourceId = sourceRecord.rows[0]?.id;
  if (!sourceId) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "원본을 저장하지 못했습니다.", retryable: true });

  const title = isIssue ? item.issue.title : null;
  const content = isIssue ? item.issue.body : item.comment.body;
  const snapshotPayload = { resource_type: item.resource_type, source, observed_at: item.observed_at };
  const contentHash = sha256(canonicalJson(snapshotPayload));
  const insertedSnapshot = await client.query<{ id: string }>(
    `insert into public.source_snapshots (
       owner_id, source_id, hash_version, content_hash, title, content, payload,
       external_created_at, external_updated_at
     ) values ($1, $2::bigint, 'v1', $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
     on conflict (source_id, hash_version, content_hash) do nothing
     returning id::text`,
    [principal.userId, sourceId, contentHash, title, content, toJson(snapshotPayload), source.created_at, source.updated_at],
  );
  const created = Boolean(insertedSnapshot.rows[0]);
  const snapshotId = insertedSnapshot.rows[0]?.id ?? (
    await client.query<{ id: string }>(
      `select id::text from public.source_snapshots
        where owner_id = $1 and source_id = $2::bigint and hash_version = 'v1' and content_hash = $3`,
      [principal.userId, sourceId, contentHash],
    )
  ).rows[0]?.id;
  if (!snapshotId) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "원본 스냅샷을 저장하지 못했습니다.", retryable: true });
  await client.query(
    `update public.source_records set current_snapshot_id = $1::bigint
      where owner_id = $2 and id = $3::bigint`,
    [snapshotId, principal.userId, sourceId],
  );
  return { sourceId, snapshotId, created };
};

const tombstoneSource = async (
  client: SqlClient,
  principal: Principal,
  run: SyncRunRow,
  item: Extract<SyncItem, { operation: "tombstone" }>,
) => {
  if (run.mode !== "reconcile") {
    throw invalidArgument("tombstone은 reconcile 동기화에서만 처리할 수 있습니다.");
  }
  const sourceType = item.resource_type === "issue" ? "github_issue" : "github_comment";
  const updated = await client.query<{ id: string }>(
    `update public.source_records
        set lifecycle_status = 'deleted', consecutive_complete_misses = 2,
            first_missing_at = coalesce(first_missing_at, now()),
            last_missing_sync_run_id = $1::bigint,
            deleted_at = $2::timestamptz,
            tombstone = jsonb_build_object('github_id', $3, 'deleted_at', $2::timestamptz)
      where owner_id = $4 and repository_id = $5::bigint
        and source_type = $6::public.source_type and provider_id = $3
      returning id::text`,
    [run.sync_run_id, item.deleted_at, item.github_id, principal.userId, run.id, sourceType],
  );
  if (!updated.rows[0]) throw notFound();
  return updated.rows[0].id;
};

export const processSyncItem = async (
  database: Database,
  principal: Principal,
  requestId: string,
  syncRunId: string,
  item: SyncItem,
) => {
  requirePermission(principal, "github_source:write");
  return executeIdempotent(
    database,
    principal,
    {
      key: item.idempotency_key,
      operation: "github_source_item",
      requestHash: sha256(canonicalJson(item)),
      requestId,
      audit: { operation: "sync", targetType: "source_item", targetIds: [syncRunId], redactedInput: { resource_type: item.resource_type, operation: item.operation } },
    },
    async (client) => {
      const run = await getSyncRun(client, principal, syncRunId, true);
      ensureSyncStillRunning(run);
      const result = item.operation === "upsert"
        ? await upsertSource(client, principal, run, item)
        : { sourceId: await tombstoneSource(client, principal, run, item), snapshotId: null, created: false };
      await client.query(
        `insert into public.sync_run_items (
           owner_id, sync_run_id, source_type, external_id, idempotency_key, request_hash,
           status, attempt_count, source_record_id, source_snapshot_id, redacted_diagnostic
         ) values ($1, $2::bigint, $3::public.source_type, $4, $5, $6,
                   'accepted', 1, $7::bigint, $8::bigint, $9::jsonb)
         on conflict (owner_id, sync_run_id, idempotency_key)
         do update set status = 'accepted', attempt_count = public.sync_run_items.attempt_count + 1,
                       source_record_id = excluded.source_record_id,
                       source_snapshot_id = excluded.source_snapshot_id,
                       redacted_diagnostic = excluded.redacted_diagnostic`,
        [
          principal.userId,
          syncRunId,
          item.resource_type === "issue" ? "github_issue" : "github_comment",
          item.operation === "upsert"
            ? (item.resource_type === "issue" ? String(item.issue.number) : item.comment.github_id)
            : item.github_id,
          item.idempotency_key,
          sha256(canonicalJson(item)),
          result.sourceId,
          result.snapshotId,
          toJson({ snapshot_created: result.created }),
        ],
      );
      await client.query(
        `update public.sync_runs
            set counts = jsonb_set(
                  counts, '{items_accepted}',
                  to_jsonb(coalesce((counts->>'items_accepted')::integer, 0) + 1), true
                )
          where owner_id = $1 and id = $2::bigint`,
        [principal.userId, syncRunId],
      );
      return {
        statusCode: 200,
        data: {
          item: {
            idempotency_key: item.idempotency_key,
            status: "accepted",
            source_id: result.sourceId,
            snapshot_id: result.snapshotId,
            snapshot_created: result.created,
          },
        },
      };
    },
  );
};

export const completeSyncRun = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  syncRunId: string,
  input: SyncCompleteInput,
) => {
  requirePermission(principal, "github_sync:checkpoint");
  return executeIdempotent(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/github/sync-runs/{sync_run_id}/complete"),
      requestHash,
      requestId,
      audit: { operation: "sync", targetType: "sync_run", targetIds: [syncRunId], redactedInput: { status: input.status } },
    },
    async (client) => {
      const run = await getSyncRun(client, principal, syncRunId, true);
      ensureSyncStillRunning(run);
      if (input.status === "completed" || input.status === "completed_with_errors") {
        const actual = await client.query<{ issue_count: string; comment_count: string; issue_snapshots: string; comment_snapshots: string }>(
          `select
             count(*) filter (where source_type = 'github_issue')::text as issue_count,
             count(*) filter (where source_type = 'github_comment')::text as comment_count,
             count(*) filter (where source_type = 'github_issue' and (redacted_diagnostic->>'snapshot_created')::boolean)::text as issue_snapshots,
             count(*) filter (where source_type = 'github_comment' and (redacted_diagnostic->>'snapshot_created')::boolean)::text as comment_snapshots
             from public.sync_run_items
            where owner_id = $1 and sync_run_id = $2::bigint and status = 'accepted'`,
          [principal.userId, syncRunId],
        );
        const count = actual.rows[0];
        const summaryMatches = count
          && Number(count.issue_count) === input.summary.issues_seen
          && Number(count.comment_count) === input.summary.comments_seen
          && Number(count.issue_snapshots) === input.summary.issue_snapshots_created
          && Number(count.comment_snapshots) === input.summary.comment_snapshots_created;
        if (!summaryMatches) throw conflict("sync_summary", "동기화 요약이 저장된 item 결과와 일치하지 않습니다.");

        const checkpoints = await client.query<{ id: string; revision: string }>(
          `select id::text, revision::text from public.sync_checkpoints
            where owner_id = $1 and repository_id = $2::bigint
            for update`,
          [principal.userId, run.id],
        );
        const revision = Math.max(...checkpoints.rows.map((checkpoint) => Number(checkpoint.revision)), 0);
        if (revision !== input.expected_checkpoint_version) {
          throw conflict("checkpoint_revision", "동기화 체크포인트가 변경되었습니다.");
        }
        await client.query(
          `update public.sync_checkpoints
              set last_successful_sync_run_id = $1::bigint, last_successful_at = $2::timestamptz
            where owner_id = $3 and repository_id = $4::bigint`,
          [syncRunId, input.observed_through, principal.userId, run.id],
        );
      }
      const updated = await client.query<{ finished_at: string }>(
        `update public.sync_runs
            set status = $1::public.sync_status, finished_at = now(),
                error_code = $2, error_message = $3
          where owner_id = $4 and id = $5::bigint
          returning finished_at::text`,
        [
          input.status,
          input.status === "failed" || input.status === "cancelled" ? (input.error?.code ?? null) : null,
          input.status === "failed" || input.status === "cancelled" ? (input.error?.message ?? null) : null,
          principal.userId,
          syncRunId,
        ],
      );
      const checkpoint = await client.query<{ revision: string | null; observed_through: string | null }>(
        `select max(revision)::text as revision, min(last_successful_at)::text as observed_through
           from public.sync_checkpoints
          where owner_id = $1 and repository_id = $2::bigint`,
        [principal.userId, run.id],
      );
      return {
        statusCode: 200,
        data: {
          sync_run_id: syncRunId,
          status: input.status,
          finished_at: updated.rows[0]?.finished_at ?? new Date().toISOString(),
          checkpoint: {
            last_successful_observed_through: checkpoint.rows[0]?.observed_through ?? null,
            checkpoint_version: Number(checkpoint.rows[0]?.revision ?? 0),
          },
        },
      };
    },
  );
};

interface ScopeResolution {
  scopeId: string;
  repositoryId: string | null;
}

const numericId = (value: string, label: string) => {
  if (!/^\d+$/.test(value)) throw invalidArgument(`${label}는 내부 숫자 ID여야 합니다.`);
  return value;
};

const resolveScope = async (
  client: SqlClient,
  principal: Principal,
  scope: { type: "global" | "organization" | "repository" | "project" | "path" | "task"; id: string },
): Promise<ScopeResolution> => {
  const insertScope = async (fields: Record<string, unknown>) => {
    const columns = ["owner_id", "scope_type", ...Object.keys(fields)];
    const values = [principal.userId, scope.type, ...Object.values(fields)];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const result = await client.query<{ id: string; repository_id: string | null }>(
      `insert into public.memory_scopes (${columns.join(", ")})
       values (${placeholders})
       on conflict (owner_id, scope_type, scope_key)
       do update set updated_at = now()
       returning id::text, repository_id::text`,
      values,
    );
    const row = result.rows[0];
    if (!row) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "기억 범위를 저장하지 못했습니다.", retryable: true });
    return { scopeId: row.id, repositoryId: row.repository_id };
  };

  if (scope.type === "global") return insertScope({});
  if (scope.type === "task") return insertScope({ task_key: scope.id });
  if (scope.type === "organization") return insertScope({ organization_id: numericId(scope.id, "organization scope.id") });
  if (scope.type === "repository") {
    const repositoryId = numericId(scope.id, "repository scope.id");
    const repo = await client.query<RepositoryRow>(
      "select id::text, github_node_id from public.repositories where owner_id = $1 and id = $2::bigint",
      [principal.userId, repositoryId],
    );
    if (!repo.rows[0]) throw notFound();
    assertRepositoryAllowed(principal, repo.rows[0].github_node_id);
    return insertScope({ repository_id: repositoryId });
  }
  if (scope.type === "project") {
    const projectId = numericId(scope.id, "project scope.id");
    const project = await client.query<RepositoryRow>(
      `select p.id::text, r.github_node_id
         from public.projects p join public.repositories r on r.owner_id = p.owner_id and r.id = p.repository_id
        where p.owner_id = $1 and p.id = $2::bigint`,
      [principal.userId, projectId],
    );
    if (!project.rows[0]) throw notFound();
    assertRepositoryAllowed(principal, project.rows[0].github_node_id);
    return insertScope({ project_id: projectId });
  }
  const [repositoryId, ...pathParts] = scope.id.split(":");
  const path = pathParts.join(":");
  if (!repositoryId || !path || path.startsWith("/") || path.includes("..") || /^[a-zA-Z]:/.test(path)) {
    throw invalidArgument("path scope.id는 'repository_id:상대/경로' 형식이어야 합니다.");
  }
  const repo = await client.query<RepositoryRow>(
    "select id::text, github_node_id from public.repositories where owner_id = $1 and id = $2::bigint",
    [principal.userId, numericId(repositoryId, "path repository_id")],
  );
  if (!repo.rows[0]) throw notFound();
  assertRepositoryAllowed(principal, repo.rows[0].github_node_id);
  return insertScope({ repository_id: repositoryId, path });
};

const createManualEvidence = async (
  client: SqlClient,
  principal: Principal,
  scope: ScopeResolution,
  source: DecisionInput["sources"][number] | FailureInput["sources"][number],
) => {
  const sourceType = source.source_type === "document" || source.source_type === "policy_event"
    ? "manual"
    : source.source_type;
  if (sourceType === "github_issue" || sourceType === "github_comment") {
    if (!scope.repositoryId) throw invalidArgument("GitHub 근거에는 repository 범위가 필요합니다.");
    const existing = await client.query<{ current_snapshot_id: string | null }>(
      `select current_snapshot_id::text from public.source_records
        where owner_id = $1 and repository_id = $2::bigint
          and source_type = $3::public.source_type
          and (id::text = $4 or external_id = $4 or provider_id = $4)
        limit 1`,
      [principal.userId, scope.repositoryId, sourceType, source.source_id],
    );
    const snapshotId = existing.rows[0]?.current_snapshot_id;
    if (!snapshotId) throw invalidArgument("GitHub 근거는 수집된 Issue 또는 댓글을 참조해야 합니다.");
    return { sourceSnapshotId: snapshotId, agentRunId: null };
  }
  if (source.source_type === "agent_run" && /^\d+$/.test(source.source_id)) {
    const agentRun = await client.query<{ id: string }>(
      "select id::text from public.agent_runs where owner_id = $1 and id = $2::bigint",
      [principal.userId, source.source_id],
    );
    if (agentRun.rows[0]) return { sourceSnapshotId: null, agentRunId: agentRun.rows[0].id };
  }
  const sourceConflict = scope.repositoryId
    ? `on conflict (owner_id, repository_id, source_type, external_id) where repository_id is not null
       do update set source_uri = excluded.source_uri, metadata = excluded.metadata`
    : `on conflict (owner_id, source_type, external_id) where repository_id is null
       do update set source_uri = excluded.source_uri, metadata = excluded.metadata`;
  const sourceRecord = await client.query<{ id: string }>(
    `insert into public.source_records (
       owner_id, source_type, repository_id, external_id, source_uri, metadata
     ) values ($1, $2::public.source_type, $3::bigint, $4, $5, $6::jsonb)
     ${sourceConflict}
     returning id::text`,
    [
      principal.userId,
      sourceType,
      scope.repositoryId,
      `${source.source_type}:${source.source_id}`,
      source.source_uri,
      toJson({ wire_source_type: source.source_type }),
    ],
  );
  const sourceId = sourceRecord.rows[0]?.id;
  if (!sourceId) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "근거 원본을 저장하지 못했습니다.", retryable: true });
  const contentHash = sha256(canonicalJson({ source_id: source.source_id, excerpt: source.source_excerpt, uri: source.source_uri }));
  const insertedSnapshot = await client.query<{ id: string }>(
    `insert into public.source_snapshots (owner_id, source_id, content_hash, content, payload)
     values ($1, $2::bigint, $3, $4, $5::jsonb)
     on conflict (source_id, hash_version, content_hash) do nothing
     returning id::text`,
    [principal.userId, sourceId, contentHash, source.source_excerpt, toJson({ source_uri: source.source_uri, wire_source_type: source.source_type })],
  );
  const snapshotId = insertedSnapshot.rows[0]?.id ?? (
    await client.query<{ id: string }>(
      `select id::text from public.source_snapshots
        where owner_id = $1 and source_id = $2::bigint and hash_version = 'v1' and content_hash = $3`,
      [principal.userId, sourceId, contentHash],
    )
  ).rows[0]?.id;
  if (!snapshotId) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "근거 스냅샷을 저장하지 못했습니다.", retryable: true });
  await client.query("update public.source_records set current_snapshot_id = $1::bigint where owner_id = $2 and id = $3::bigint", [snapshotId, principal.userId, sourceId]);
  return { sourceSnapshotId: snapshotId, agentRunId: null };
};

const validateMemoryInput = (
  principal: Principal,
  input: DecisionInput | FailureInput,
  isFailure: boolean,
) => {
  if (input.valid_until && input.valid_until <= input.valid_from) throw invalidArgument("valid_until은 valid_from 이후여야 합니다.");
  if (input.status === "proposed") requirePermission(principal, "memory:propose");
  if (input.status === "confirmed") {
    requirePermission(principal, "memory:confirm");
    if (input.confirmation?.origin !== "explicit_user") throw invalidArgument("confirmed 기억에는 explicit_user 확인 근거가 필요합니다.");
  }
  if (input.status === "verified") {
    requirePermission(principal, "memory:confirm");
    if (input.confirmation?.origin !== "verified_execution" || !input.sources.some((source) => source.source_type === "test_result" || source.source_type === "agent_run")) {
      throw invalidArgument("verified 기억에는 검증 실행 근거가 필요합니다.");
    }
  }
  if (isFailure && "failure" in input && input.failure.resolution_status === "hypothesis" && input.status !== "proposed") {
    throw invalidArgument("가설 단계의 실패 기억은 proposed 상태여야 합니다.");
  }
};

const createMemory = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: DecisionInput | FailureInput,
  kind: "decision" | "failure",
) => {
  validateMemoryInput(principal, input, kind === "failure");
  return executeIdempotent(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation(kind === "decision" ? "/v1/memories/decisions" : "/v1/memories/failures"),
      requestHash,
      requestId,
      audit: { operation: "create", targetType: "memory", redactedInput: { kind, status: input.status, source_count: input.sources.length } },
    },
    async (client) => {
      const scope = await resolveScope(client, principal, input.scope);
      const details = kind === "decision"
        ? { decision: (input as DecisionInput).decision, confirmation: input.confirmation ?? null }
        : { failure: (input as FailureInput).failure, confirmation: input.confirmation ?? null };
      const memory = await client.query<{ id: string; revision: string; created_at: string; confirmed_at: string | null }>(
        `insert into public.memories (
           owner_id, kind, statement, rationale, scope_id, status, confidence,
           valid_from, valid_until, confirmed_at, tags, details
         ) values ($1, $2::public.memory_kind, $3, $4, $5::bigint, $6::public.memory_status,
                   $7, $8::timestamptz, $9::timestamptz,
                   case when $6 in ('confirmed', 'verified') then now() else null end,
                   $10::text[], $11::jsonb)
         returning id::text, revision::text, created_at::text, confirmed_at::text`,
        [
          principal.userId, kind, input.statement, input.rationale ?? null, scope.scopeId,
          input.status, input.confidence, input.valid_from, input.valid_until,
          input.tags, toJson(details),
        ],
      );
      const memoryRow = memory.rows[0];
      if (!memoryRow) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "기억을 저장하지 못했습니다.", retryable: true });
      if (kind === "failure") {
        const failure = (input as FailureInput).failure;
        await client.query(
          `insert into public.memory_failure_details (
             memory_id, owner_id, resolution_status, symptom, context,
             attempted_approaches, cause, resolution, verification
           ) values ($1::bigint, $2, $3::public.failure_resolution_status, $4, $5,
                     $6::jsonb, $7, $8, $9)`,
          [
            memoryRow.id, principal.userId, failure.resolution_status, failure.symptom,
            failure.environment ?? null, toJson(failure.attempts), failure.cause_or_hypothesis ?? null,
            failure.resolution ?? null, failure.verification.join("\n"),
          ],
        );
      }
      for (const source of input.sources) {
        const evidence = await createManualEvidence(client, principal, scope, source);
        await client.query(
          `insert into public.memory_evidence (
             owner_id, memory_id, source_snapshot_id, agent_run_id, source_excerpt
           ) values ($1, $2::bigint, $3::bigint, $4::bigint, $5)`,
          [principal.userId, memoryRow.id, evidence.sourceSnapshotId, evidence.agentRunId, source.source_excerpt],
        );
      }
      return {
        statusCode: 201,
        data: {
          memory: {
            id: memoryRow.id,
            kind,
            status: input.status,
            revision: Number(memoryRow.revision),
            created_at: memoryRow.created_at,
            confirmed_at: memoryRow.confirmed_at,
          },
        },
      };
    },
  );
};

export const createDecision = (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: DecisionInput,
) => createMemory(database, principal, requestId, idempotencyKey, requestHash, input, "decision");

export const createFailure = (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: FailureInput,
) => createMemory(database, principal, requestId, idempotencyKey, requestHash, input, "failure");
