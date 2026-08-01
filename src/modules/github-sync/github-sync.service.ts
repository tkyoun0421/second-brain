import type { SqlClient, Database } from "#app/common/database/database.js";
import { ApiError, invalidArgument } from "#app/common/errors/errors.js";
import { canonicalJson, sha256 } from "#app/common/crypto/hash.js";
import {
  assessCaptureCandidate,
  toCapturedMemory,
  type AutomaticCaptureCandidate,
  type CapturedMemory,
} from "#app/modules/memories/memory-capture-policy.js";
import {
  createForgetPreviewToken,
  invalidForgetPreviewToken,
  verifyForgetPreviewToken,
  type ForgetReasonCode,
} from "#app/modules/memories/forget-preview-token.js";
import { executeIdempotent } from "#app/common/idempotency/idempotency.service.js";
import {
  assertRepositoryAllowed,
  requireAnyPermission,
  requirePermission,
  type Principal,
} from "#app/common/auth/principal.js";
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
} from "#app/common/validation/schemas.js";

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

