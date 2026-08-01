import type { SqlClient, Database } from "#app/database.js";
import { ApiError, invalidArgument } from "#app/errors.js";
import { canonicalJson, sha256 } from "#app/hash.js";
import {
  assessCaptureCandidate,
  toCapturedMemory,
  type AutomaticCaptureCandidate,
  type CapturedMemory,
} from "#app/memory-capture.js";
import {
  createForgetPreviewToken,
  invalidForgetPreviewToken,
  verifyForgetPreviewToken,
  type ForgetReasonCode,
} from "#app/forget-preview-token.js";
import { executeIdempotent } from "#app/idempotency.js";
import {
  assertRepositoryAllowed,
  requireAnyPermission,
  requirePermission,
  type Principal,
} from "#app/principal.js";
import type {
  AgentRunFinishInput,
  DecisionInput,
  FailureInput,
  MemoryCaptureInput,
  MemoryConfirmInput,
  MemoryForgetInput,
  MemoryForgetPreviewInput,
  MemorySupersedeInput,
  SyncCompleteInput,
  SyncItem,
  SyncStartInput,
} from "#app/schemas.js";

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

export const syncItemRequestHash = (item: SyncItem) => {
  if (item.operation === "tombstone") return sha256(canonicalJson(item));
  const { observed_at: _observedAt, ...stableItem } = item;
  return sha256(canonicalJson(stableItem));
};

export const syncItemIdempotencyKey = (item: SyncItem) => `v2:${item.idempotency_key}`;

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
                    'stream', $1::text,
                    'pages_completed', $2::integer,
                    'items_accepted', $3::integer,
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
  // `observed_at` records when this sync saw the source; it is not source content.
  // Keep it in the immutable payload for auditability, but exclude it from the v1
  // semantic hash so an unchanged overlap/reconcile pass does not create a snapshot.
  const snapshotPayload = { resource_type: item.resource_type, source, observed_at: item.observed_at };
  const contentHash = sha256(canonicalJson({ resource_type: item.resource_type, source }));
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
    `update public.source_records as source
        set lifecycle_status = 'deleted', consecutive_complete_misses = 2,
            last_missing_sync_run_id = $1::bigint,
            deleted_at = $2::timestamptz,
            tombstone = jsonb_build_object(
              'github_id', $3,
              'last_content_hash', snapshot.content_hash,
              'first_missing_at', source.first_missing_at,
              'confirmed_at', $2::timestamptz,
              'reconcile_run_id', $1::bigint
            )
       from public.source_snapshots as snapshot
      where source.owner_id = $4 and source.repository_id = $5::bigint
        and source.source_type = $6::public.source_type and source.provider_id = $3
        and source.lifecycle_status = 'missing_candidate'
        and snapshot.owner_id = source.owner_id and snapshot.id = source.current_snapshot_id
      returning source.id::text`,
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
      key: syncItemIdempotencyKey(item),
      operation: "github_source_item",
      requestHash: syncItemRequestHash(item),
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

export const reconcileSyncRun = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  syncRunId: string,
) => {
  requirePermission(principal, "github_sync:checkpoint");
  requirePermission(principal, "github_source:write");
  return executeIdempotent(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/github/sync-runs/{sync_run_id}/reconcile"),
      requestHash,
      requestId,
      audit: { operation: "sync", targetType: "sync_run", targetIds: [syncRunId], redactedInput: { reconciliation: true } },
    },
    async (client) => {
      const run = await getSyncRun(client, principal, syncRunId, true);
      ensureSyncStillRunning(run);
      if (run.mode !== "reconcile") throw invalidArgument("누락 원본 대조는 reconcile 동기화에서만 실행할 수 있습니다.");

      // Every successful upsert sets last_seen_sync_run_id to this run. Only after
      // the caller has read every GitHub page can we safely advance missing state.
      const tombstones = await client.query<{ source_type: "github_issue" | "github_comment" }>(
        `update public.source_records as source
            set lifecycle_status = 'deleted',
                consecutive_complete_misses = 2,
                last_missing_sync_run_id = $1::bigint,
                deleted_at = now(),
                tombstone = jsonb_build_object(
                  'github_id', source.provider_id,
                  'last_content_hash', snapshot.content_hash,
                  'first_missing_at', source.first_missing_at,
                  'confirmed_at', now(),
                  'reconcile_run_id', $1::bigint
                )
           from public.source_snapshots as snapshot
          where source.owner_id = $2 and source.repository_id = $3::bigint
            and source.source_type in ('github_issue', 'github_comment')
            and source.lifecycle_status = 'missing_candidate'
            and source.last_seen_sync_run_id is distinct from $1::bigint
            and snapshot.owner_id = source.owner_id
            and snapshot.id = source.current_snapshot_id
          returning source.source_type`,
        [syncRunId, principal.userId, run.id],
      );
      const candidates = await client.query<{ source_type: "github_issue" | "github_comment" }>(
        `update public.source_records
            set lifecycle_status = 'missing_candidate',
                consecutive_complete_misses = 1,
                first_missing_at = now(),
                last_missing_sync_run_id = $1::bigint
          where owner_id = $2 and repository_id = $3::bigint
            and source_type in ('github_issue', 'github_comment')
            and lifecycle_status = 'active'
            and last_seen_sync_run_id is distinct from $1::bigint
          returning source_type`,
        [syncRunId, principal.userId, run.id],
      );
      const count = (rows: Array<{ source_type: "github_issue" | "github_comment" }>, sourceType: "github_issue" | "github_comment") =>
        rows.filter((row) => row.source_type === sourceType).length;
      return {
        statusCode: 200,
        data: {
          sync_run_id: syncRunId,
          missing_candidates: {
            issues: count(candidates.rows, "github_issue"),
            comments: count(candidates.rows, "github_comment"),
          },
          tombstones: {
            issues: count(tombstones.rows, "github_issue"),
            comments: count(tombstones.rows, "github_comment"),
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

interface MemoryCreationOptions {
  operationPath?: string;
  automaticCapture?: CapturedMemory["capture"];
}

const captureCandidate = (input: MemoryCaptureInput): AutomaticCaptureCandidate => ({
  ...input.candidate,
  signals: input.candidate.signals as AutomaticCaptureCandidate["signals"],
});

const toMemoryInput = (captured: CapturedMemory): DecisionInput | FailureInput => {
  if (captured.kind === "decision") {
    return {
      statement: captured.statement,
      rationale: captured.rationale,
      scope: captured.scope,
      status: captured.status,
      confidence: captured.confidence,
      sources: captured.sources,
      confirmation: captured.confirmation,
      valid_from: captured.valid_from,
      valid_until: captured.valid_until,
      tags: captured.tags,
      decision: captured.decision ?? { alternatives: [], decided_at: captured.valid_from },
    };
  }
  if (!captured.failure) {
    throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "Automatic failure capture was incomplete." });
  }
  return {
    statement: captured.statement,
    rationale: captured.rationale,
    scope: captured.scope,
    status: captured.status,
    confidence: captured.confidence,
    sources: captured.sources,
    confirmation: captured.confirmation,
    valid_from: captured.valid_from,
    valid_until: captured.valid_until,
    tags: captured.tags,
    failure: captured.failure,
  };
};

const createMemory = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: DecisionInput | FailureInput,
  kind: "decision" | "failure",
  options: MemoryCreationOptions = {},
) => {
  validateMemoryInput(principal, input, kind === "failure");
  return executeIdempotent<Record<string, unknown>>(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation(options.operationPath ?? (kind === "decision" ? "/v1/memories/decisions" : "/v1/memories/failures")),
      requestHash,
      requestId,
      audit: {
        operation: "create",
        targetType: "memory",
        redactedInput: {
          kind,
          status: input.status,
          source_count: input.sources.length,
          ...(options.automaticCapture ? {
            automatic_capture: true,
            importance_score: options.automaticCapture.importance_score,
            capture_trigger: options.automaticCapture.trigger,
          } : {}),
        },
      },
    },
    async (client) => {
      const scope = await resolveScope(client, principal, input.scope);
      const details = kind === "decision"
        ? { decision: (input as DecisionInput).decision, confirmation: input.confirmation ?? null }
        : { failure: (input as FailureInput).failure, confirmation: input.confirmation ?? null };
      const storedDetails = options.automaticCapture ? { ...details, capture: options.automaticCapture } : details;
      const memory = await client.query<{ id: string; revision: string; created_at: string; confirmed_at: string | null }>(
        `insert into public.memories (
           owner_id, kind, statement, rationale, scope_id, status, confidence,
           valid_from, valid_until, confirmed_at, tags, details,
           importance_score, importance_reasons, capture_trigger, auto_capture_key
         ) values ($1, $2::public.memory_kind, $3, $4, $5::bigint, $6::public.memory_status,
                   $7, $8::timestamptz, $9::timestamptz,
                   case when $6 in ('confirmed', 'verified') then now() else null end,
                   $10::text[], $11::jsonb, $12::smallint, $13::text[], $14, $15)
         on conflict (owner_id, auto_capture_key) where auto_capture_key is not null
         do nothing
         returning id::text, revision::text, created_at::text, confirmed_at::text`,
        [
          principal.userId, kind, input.statement, input.rationale ?? null, scope.scopeId,
          input.status, input.confidence, input.valid_from, input.valid_until,
          input.tags, toJson(storedDetails),
          options.automaticCapture?.importance_score ?? null,
          options.automaticCapture?.importance_reasons ?? [],
          options.automaticCapture?.trigger ?? null,
          options.automaticCapture?.dedupe_key ?? null,
        ],
      );
      const memoryRow = memory.rows[0];
      if (!memoryRow && options.automaticCapture) {
        const existing = await client.query<{ id: string; revision: string; created_at: string; confirmed_at: string | null; status: string }>(
          `select id::text, revision::text, created_at::text, confirmed_at::text, status::text
             from public.memories
            where owner_id = $1 and auto_capture_key = $2`,
          [principal.userId, options.automaticCapture.dedupe_key],
        );
        const existingMemory = existing.rows[0];
        if (!existingMemory) {
          throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "Automatic memory de-duplication could not be completed.", retryable: true });
        }
        return {
          statusCode: 200,
          data: {
            outcome: "duplicate" as const,
            importance: {
              importance_score: options.automaticCapture.importance_score,
              reasons: options.automaticCapture.importance_reasons,
              policy_version: options.automaticCapture.policy_version,
            },
            memory: {
              id: existingMemory.id,
              kind,
              status: existingMemory.status,
              revision: Number(existingMemory.revision),
              created_at: existingMemory.created_at,
              confirmed_at: existingMemory.confirmed_at,
            },
          },
        };
      }
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
      const memoryData = {
        id: memoryRow.id,
        kind,
        status: input.status,
        revision: Number(memoryRow.revision),
        created_at: memoryRow.created_at,
        confirmed_at: memoryRow.confirmed_at,
      };
      return {
        statusCode: 201,
        data: options.automaticCapture ? {
          outcome: "stored" as const,
          importance: {
            importance_score: options.automaticCapture.importance_score,
            reasons: options.automaticCapture.importance_reasons,
            policy_version: options.automaticCapture.policy_version,
          },
          memory: memoryData,
        } : { memory: memoryData },
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

export const captureMemory = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: MemoryCaptureInput,
) => {
  requirePermission(principal, "memory:propose");
  const candidate = captureCandidate(input);
  const assessment = assessCaptureCandidate(candidate);
  if (assessment.outcome === "discarded") {
    return {
      replayed: false,
      response: {
        statusCode: 200,
        body: {
          request_id: requestId,
          data: {
            outcome: "discarded",
            importance: {
              importance_score: assessment.importance_score,
              reasons: assessment.reasons,
              policy_version: assessment.policy_version,
            },
          },
        },
      },
    };
  }
  const captured = toCapturedMemory(candidate, assessment);
  return createMemory(
    database,
    principal,
    requestId,
    idempotencyKey,
    requestHash,
    toMemoryInput(captured),
    captured.kind,
    { operationPath: "/v1/memories/capture", automaticCapture: captured.capture },
  );
};

interface MemoryTransitionRow {
  id: string;
  kind: "learning" | "decision" | "preference" | "failure" | "procedure" | "constraint";
  scope_id: string;
  status: "proposed" | "confirmed" | "verified" | "superseded" | "deprecated" | "deleted";
  revision: string;
  supersedes_id: string | null;
}

const getMemoryForUpdate = async (
  client: SqlClient,
  principal: Principal,
  memoryId: string,
): Promise<MemoryTransitionRow> => {
  const result = await client.query<MemoryTransitionRow>(
    `select id::text, kind, scope_id::text, status, revision::text, supersedes_id::text
       from public.memories
      where owner_id = $1 and id = $2::bigint
      for update`,
    [principal.userId, memoryId],
  );
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
};

const requireExpectedRevision = (memory: MemoryTransitionRow, expectedRevision: number) => {
  if (Number(memory.revision) !== expectedRevision) {
    throw conflict("memory_revision", "기억이 다른 요청으로 변경되었습니다. 최신 revision으로 다시 시도하세요.");
  }
};

const invalidMemoryTransition = () => new ApiError({
  statusCode: 409,
  code: "INVALID_STATE_TRANSITION",
  message: "현재 기억 상태에서는 요청한 전이를 수행할 수 없습니다.",
});

const insertMemoryEvidence = async (
  client: SqlClient,
  principal: Principal,
  scope: ScopeResolution,
  memoryId: string,
  sources: ReadonlyArray<DecisionInput["sources"][number]>,
) => {
  for (const source of sources) {
    const evidence = await createManualEvidence(client, principal, scope, source);
    await client.query(
      `insert into public.memory_evidence (
         owner_id, memory_id, source_snapshot_id, agent_run_id, source_excerpt
       ) values ($1, $2::bigint, $3::bigint, $4::bigint, $5)
       on conflict do nothing`,
      [principal.userId, memoryId, evidence.sourceSnapshotId, evidence.agentRunId, source.source_excerpt],
    );
  }
};

export const finishAgentRun = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  input: AgentRunFinishInput,
) => {
  requirePermission(principal, "agent_run:write");
  return executeIdempotent(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/agent-runs/finish"),
      requestHash,
      requestId,
      audit: {
        operation: "create",
        targetType: "agent_run",
        ...(input.repository_id ? { repositoryId: input.repository_id } : {}),
        redactedInput: { result: input.result, changed_file_count: input.changed_files.length },
      },
    },
    async (client) => {
      if (input.repository_id) {
        const repository = await client.query<RepositoryRow>(
          "select id::text, github_node_id from public.repositories where owner_id = $1 and id = $2::bigint",
          [principal.userId, input.repository_id],
        );
        if (!repository.rows[0]) throw notFound();
        assertRepositoryAllowed(principal, repository.rows[0].github_node_id);
      }

      const run = await client.query<{ id: string; created_at: string }>(
        `insert into public.agent_runs (
           owner_id, session_id, idempotency_key, agent_name, repository_id, goal, status,
           result_summary, changed_files, commands_or_actions, verification, started_at, finished_at
         ) values ($1, $2, $3, $4, $5::bigint, $6, $7::public.agent_run_status,
                   $8, $9::text[], $10::jsonb, $11::jsonb, $12::timestamptz, $13::timestamptz)
         returning id::text, created_at::text`,
        [
          principal.userId, input.session_id, idempotencyKey, input.agent, input.repository_id ?? null,
          input.goal, input.result, input.summary ?? null, input.changed_files.map((file) => file.path),
          toJson(input.commands_or_actions), toJson({ items: input.verification, failure_ids: input.failure_ids }),
          input.started_at, input.finished_at,
        ],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "작업 실행 기록을 저장하지 못했습니다.", retryable: true });

      for (const used of input.used_memories) {
        const linked = await client.query(
          `insert into public.agent_run_memories (owner_id, agent_run_id, memory_id, relation, feedback)
           select $1, $2::bigint, m.id, 'used'::public.memory_run_relation, $4::public.memory_feedback
             from public.memories m
            where m.owner_id = $1 and m.id = $3::bigint
           on conflict (agent_run_id, memory_id, relation)
           do update set feedback = excluded.feedback`,
          [principal.userId, runRow.id, used.memory_id, used.rating],
        );
        if (linked.rowCount !== 1) throw notFound();
      }
      for (const memoryId of new Set([...input.created_memory_ids, ...input.failure_ids])) {
        const linked = await client.query(
          `insert into public.agent_run_memories (owner_id, agent_run_id, memory_id, relation)
           select $1, $2::bigint, m.id, 'created'::public.memory_run_relation
             from public.memories m
            where m.owner_id = $1 and m.id = $3::bigint
           on conflict do nothing`,
          [principal.userId, runRow.id, memoryId],
        );
        if (linked.rowCount !== 1) throw notFound();
      }

      return {
        statusCode: 201,
        data: {
          agent_run_id: runRow.id,
          session_id: input.session_id,
          result: input.result,
          created_at: runRow.created_at,
        },
      };
    },
  );
};

export const confirmMemory = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  memoryId: string,
  input: MemoryConfirmInput,
) => {
  requirePermission(principal, "memory:confirm");
  return executeIdempotent<Record<string, unknown>>(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/memories/{memory_id}/confirm"),
      requestHash,
      requestId,
      audit: { operation: "confirm", targetType: "memory", targetIds: [memoryId], redactedInput: { expected_revision: input.expected_revision } },
    },
    async (client) => {
      const memory = await getMemoryForUpdate(client, principal, memoryId);
      requireExpectedRevision(memory, input.expected_revision);
      if (memory.status !== "proposed") throw invalidMemoryTransition();

      let supersededMemoryId: string | null = null;
      if (memory.supersedes_id) {
        const predecessor = await getMemoryForUpdate(client, principal, memory.supersedes_id);
        if (predecessor.status !== "confirmed" && predecessor.status !== "verified") throw invalidMemoryTransition();
        await client.query(
          "update public.memories set status = 'superseded' where owner_id = $1 and id = $2::bigint",
          [principal.userId, predecessor.id],
        );
        supersededMemoryId = predecessor.id;
      }

      const updated = await client.query<{ revision: string; confirmed_at: string }>(
        `update public.memories
            set status = 'confirmed', confirmed_at = now(),
                details = details || jsonb_build_object('confirmation', $3::jsonb)
          where owner_id = $1 and id = $2::bigint
          returning revision::text, confirmed_at::text`,
        [principal.userId, memory.id, toJson(input.confirmation)],
      );
      const row = updated.rows[0];
      if (!row) throw notFound();
      return {
        statusCode: 200,
        data: {
          memory_id: memory.id,
          status: "confirmed",
          revision: Number(row.revision),
          confirmed_at: row.confirmed_at,
          superseded_memory_id: supersededMemoryId,
        },
      };
    },
  );
};

export const supersedeMemory = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  memoryId: string,
  input: MemorySupersedeInput,
) => {
  if (input.status_intent === "confirmed") requirePermission(principal, "memory:supersede");
  else requirePermission(principal, "memory:propose");
  return executeIdempotent<Record<string, unknown>>(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/memories/{memory_id}/supersede"),
      requestHash,
      requestId,
      audit: { operation: "supersede", targetType: "memory", targetIds: [memoryId], redactedInput: { status_intent: input.status_intent } },
    },
    async (client) => {
      const predecessor = await getMemoryForUpdate(client, principal, memoryId);
      requireExpectedRevision(predecessor, input.expected_revision);
      if (predecessor.status !== "confirmed" && predecessor.status !== "verified") throw invalidMemoryTransition();
      const scope = await resolveScope(client, principal, input.replacement.scope);
      if (predecessor.kind !== input.replacement.kind || predecessor.scope_id !== scope.scopeId) {
        throw invalidArgument("supersede replacement must retain the existing memory kind and scope");
      }
      if (input.replacement.kind === "failure" && input.replacement.failure?.resolution_status === "hypothesis" && input.status_intent !== "proposed") {
        throw invalidArgument("hypothesis failures may only be proposed");
      }

      const replacementStatus = input.status_intent;
      const replacement = await client.query<{ id: string; revision: string }>(
        `insert into public.memories (
           owner_id, kind, statement, rationale, scope_id, status, confidence, valid_from,
           valid_until, supersedes_id, confirmed_at, tags, details
         ) values ($1, $2::public.memory_kind, $3, $4, $5::bigint, $6::public.memory_status,
                   $7, $8::timestamptz, $9::timestamptz, $10::bigint,
                   case when $6 = 'confirmed' then now() else null end, $11::text[], $12::jsonb)
         returning id::text, revision::text`,
        [
          principal.userId, input.replacement.kind, input.replacement.statement, input.replacement.rationale ?? null,
          scope.scopeId, replacementStatus, input.replacement.confidence, input.replacement.valid_from,
          input.replacement.valid_until, predecessor.id, input.replacement.tags,
          toJson({ confirmation: input.confirmation }),
        ],
      );
      const replacementRow = replacement.rows[0];
      if (!replacementRow) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "교체 기억을 저장하지 못했습니다.", retryable: true });

      if (input.replacement.kind === "failure" && input.replacement.failure) {
        const failure = input.replacement.failure;
        await client.query(
          `insert into public.memory_failure_details (
             memory_id, owner_id, resolution_status, symptom, context, attempted_approaches, cause, resolution, verification
           ) values ($1::bigint, $2, $3::public.failure_resolution_status, $4, $5, $6::jsonb, $7, $8, $9)`,
          [
            replacementRow.id, principal.userId, failure.resolution_status, failure.symptom,
            failure.environment ?? null, toJson(failure.attempts), failure.cause_or_hypothesis ?? null,
            failure.resolution ?? null, failure.verification.join("\n"),
          ],
        );
      }
      await insertMemoryEvidence(client, principal, scope, replacementRow.id, input.replacement.sources);

      if (input.status_intent === "confirmed") {
        const updated = await client.query<{ revision: string }>(
          `update public.memories set status = 'superseded'
            where owner_id = $1 and id = $2::bigint
            returning revision::text`,
          [principal.userId, predecessor.id],
        );
        return {
          statusCode: 201,
          data: {
            superseded: { memory_id: predecessor.id, status: "superseded", revision: Number(updated.rows[0]?.revision) },
            replacement: { memory_id: replacementRow.id, status: "confirmed", revision: Number(replacementRow.revision) },
          },
        };
      }
      return {
        statusCode: 201,
        data: {
          existing: { memory_id: predecessor.id, status: predecessor.status, revision: Number(predecessor.revision) },
          replacement: { memory_id: replacementRow.id, status: "proposed", revision: Number(replacementRow.revision) },
          transition: "proposal_created",
        },
      };
    },
  );
};

interface ForgetImpact {
  memories: number;
  linked_sources: number;
  snapshots: number;
  audit_payloads_to_redact: number;
  other_active_memories_using_source: number;
}

const getForgetImpact = async (
  client: SqlClient,
  principal: Principal,
  memoryId: string,
): Promise<ForgetImpact> => {
  const result = await client.query<ForgetImpact>(
    `with target_sources as (
       select distinct ss.source_id
         from public.memory_evidence me
         join public.source_snapshots ss on ss.owner_id = me.owner_id and ss.id = me.source_snapshot_id
        where me.owner_id = $1 and me.memory_id = $2::bigint
     ), affected_snapshots as (
       select ss.id, ss.source_id
         from public.source_snapshots ss
         join target_sources ts on ts.source_id = ss.source_id
        where ss.owner_id = $1
     )
     select
       1::integer as memories,
       (select count(*)::integer from target_sources) as linked_sources,
       (select count(*)::integer from affected_snapshots) as snapshots,
       (select count(*)::integer from public.audit_events ae
         where ae.owner_id = $1 and ae.target_ids @> jsonb_build_array($2::text)) as audit_payloads_to_redact,
       (select count(distinct me.memory_id)::integer
          from public.memory_evidence me
          join public.source_snapshots ss on ss.owner_id = me.owner_id and ss.id = me.source_snapshot_id
          join target_sources ts on ts.source_id = ss.source_id
          join public.memories m on m.owner_id = me.owner_id and m.id = me.memory_id
         where me.owner_id = $1 and me.memory_id <> $2::bigint
           and m.status in ('proposed', 'confirmed', 'verified')) as other_active_memories_using_source`,
    [principal.userId, memoryId],
  );
  const impact = result.rows[0];
  if (!impact) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "삭제 영향을 계산하지 못했습니다.", retryable: true });
  return impact;
};

const requireForgetPermission = (principal: Principal, reasonCode: ForgetReasonCode) => {
  requirePermission(principal, reasonCode === "sensitive_data" ? "memory:forget_sensitive" : "memory:forget");
};

const validateForgetConfirmation = (input: MemoryForgetInput) => {
  const expectedOrigin = input.reason_code === "user_requested" ? "explicit_user" : "policy_enforcement";
  if (input.confirmation.origin !== expectedOrigin) {
    throw invalidArgument(`confirmation.origin must be ${expectedOrigin} for this forget reason`);
  }
  if (expectedOrigin === "policy_enforcement" && input.confirmation.source.type !== "policy_event") {
    throw invalidArgument("policy-enforced deletion requires a policy_event confirmation source");
  }
};

const assertForgettableMemory = (memory: MemoryTransitionRow) => {
  if (memory.status === "deleted") throw invalidMemoryTransition();
};

export const previewMemoryForget = async (
  database: Database,
  principal: Principal,
  memoryId: string,
  input: MemoryForgetPreviewInput,
  tokenSecret: string,
) => {
  requireForgetPermission(principal, input.reason_code);
  return database.transaction(principal, async (client) => {
    const result = await client.query<MemoryTransitionRow>(
      `select id::text, kind, scope_id::text, status, revision::text, supersedes_id::text
         from public.memories
        where owner_id = $1 and id = $2::bigint`,
      [principal.userId, memoryId],
    );
    const memory = result.rows[0];
    if (!memory) throw notFound();
    assertForgettableMemory(memory);
    requireExpectedRevision(memory, input.expected_revision);
    const impact = await getForgetImpact(client, principal, memoryId);
    if (input.delete_linked_source && impact.other_active_memories_using_source > 0) {
      throw conflict("linked_source_in_use", "다른 활성 기억이 사용하는 근거는 함께 삭제할 수 없습니다.");
    }
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const previewToken = createForgetPreviewToken({
      version: 1,
      ownerId: principal.userId,
      memoryId,
      expectedRevision: input.expected_revision,
      reasonCode: input.reason_code,
      deleteLinkedSource: input.delete_linked_source,
      impactHash: sha256(canonicalJson(impact)),
      expiresAt,
    }, tokenSecret);
    return { memory_id: memoryId, impact, preview_token: previewToken, expires_at: expiresAt };
  });
};

export const forgetMemory = async (
  database: Database,
  principal: Principal,
  requestId: string,
  idempotencyKey: string,
  requestHash: string,
  memoryId: string,
  input: MemoryForgetInput,
  tokenSecret: string,
) => {
  requireForgetPermission(principal, input.reason_code);
  validateForgetConfirmation(input);
  const token = verifyForgetPreviewToken(input.preview_token, tokenSecret);
  if (
    token.ownerId !== principal.userId ||
    token.memoryId !== memoryId ||
    token.expectedRevision !== input.expected_revision ||
    token.reasonCode !== input.reason_code ||
    token.deleteLinkedSource !== input.delete_linked_source
  ) throw invalidForgetPreviewToken();

  return executeIdempotent<Record<string, unknown>>(
    database,
    principal,
    {
      key: idempotencyKey,
      operation: makeOperation("/v1/memories/{memory_id}/forget"),
      requestHash,
      requestId,
      audit: {
        operation: "delete",
        targetType: "memory",
        targetIds: [memoryId],
        redactedInput: { reason_code: input.reason_code, delete_linked_source: input.delete_linked_source },
      },
    },
    async (client) => {
      const memory = await getMemoryForUpdate(client, principal, memoryId);
      assertForgettableMemory(memory);
      requireExpectedRevision(memory, input.expected_revision);
      const impact = await getForgetImpact(client, principal, memoryId);
      if (sha256(canonicalJson(impact)) !== token.impactHash) throw invalidForgetPreviewToken();
      if (input.delete_linked_source && impact.other_active_memories_using_source > 0) {
        throw conflict("linked_source_in_use", "다른 활성 기억이 사용하는 근거는 함께 삭제할 수 없습니다.");
      }
      if (memory.kind === "failure") {
        await client.query(
          `update public.memory_failure_details
              set resolution_status = 'observed', symptom = '[deleted]', context = null,
                  attempted_approaches = '[]'::jsonb, cause = null, resolution = null, verification = null
            where owner_id = $1 and memory_id = $2::bigint`,
          [principal.userId, memoryId],
        );
      }
      if (input.delete_linked_source) {
        await client.query("select public.redact_memory_forget_sources($1::bigint)", [memoryId]);
      }
      await client.query(
        "delete from public.memory_evidence where owner_id = $1 and memory_id = $2::bigint",
        [principal.userId, memoryId],
      );
      await client.query("select public.redact_memory_audit_payloads($1::bigint)", [memoryId]);
      const updated = await client.query<{ revision: string }>(
        `update public.memories
            set status = 'deleted', statement = '[deleted]', rationale = null, tags = '{}'::text[], details = '{}'::jsonb
          where owner_id = $1 and id = $2::bigint
          returning revision::text`,
        [principal.userId, memoryId],
      );
      const row = updated.rows[0];
      if (!row) throw notFound();
      return {
        statusCode: 200,
        data: {
          memory_id: memoryId,
          status: "deleted",
          revision: Number(row.revision),
          impact,
          linked_sources_redacted: input.delete_linked_source,
        },
      };
    },
  );
};
