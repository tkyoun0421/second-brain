import type { Database, SqlClient } from "#app/database.js";
import { ApiError } from "#app/errors.js";
import type { Principal } from "#app/principal.js";

export interface StoredResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface IdempotencyInput {
  key: string;
  operation: string;
  requestHash: string;
  requestId: string;
  audit: {
    operation: "create" | "update" | "sync" | "confirm" | "supersede" | "delete" | "tool_call";
    targetType: string;
    targetIds?: string[];
    repositoryId?: string;
    redactedInput?: Record<string, unknown>;
  };
}

export interface ReservedRecord {
  id: string;
  replay?: StoredResponse;
}

const inProgress = () =>
  new ApiError({
    statusCode: 409,
    code: "IDEMPOTENCY_IN_PROGRESS",
    message: "같은 요청이 처리 중입니다.",
    retryable: true,
    headers: { "retry-after": "2" },
  });

const conflict = () =>
  new ApiError({
    statusCode: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "같은 멱등성 키에 다른 요청 본문을 사용할 수 없습니다.",
  });

const insertAudit = async (
  client: SqlClient,
  principal: Principal,
  requestId: string,
  idempotencyRecordId: string,
  input: IdempotencyInput["audit"],
) => {
  await client.query(
    `insert into public.audit_events (
       owner_id, request_id, idempotency_record_id, actor_type, actor_id,
       session_id, repository_id, operation, target_type, target_ids,
       redacted_input, success
     ) values ($1, $2::uuid, $3::bigint, $4::public.audit_actor_type, $5,
               null, $6::bigint, $7::public.audit_operation, $8, $9::jsonb,
               $10::jsonb, true)`,
    [
      principal.userId,
      requestId,
      idempotencyRecordId,
      principal.principalType,
      principal.principalId,
      input.repositoryId ?? null,
      input.operation,
      input.targetType,
      JSON.stringify(input.targetIds ?? []),
      JSON.stringify(input.redactedInput ?? {}),
    ],
  );
};

export const validateIdempotencyKey = (key: string | undefined): string => {
  if (!key || !/^[\x21-\x7e]{16,200}$/.test(key)) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_ARGUMENT",
      message: "X-Idempotency-Key는 16~200자의 출력 가능한 ASCII 문자열이어야 합니다.",
    });
  }
  return key;
};

const reserve = async (
  client: SqlClient,
  principal: Principal,
  input: Pick<IdempotencyInput, "key" | "operation" | "requestHash">,
): Promise<ReservedRecord> => {
  const inserted = await client.query<{ id: string }>(
    `insert into public.idempotency_records (
       owner_id, actor_type, actor_id, operation, idempotency_key, request_hash
     ) values ($1, $2::public.audit_actor_type, $3, $4, $5, $6)
     on conflict (owner_id, actor_type, actor_id, operation, idempotency_key)
     do nothing
     returning id::text`,
    [
      principal.userId,
      principal.principalType,
      principal.principalId,
      input.operation,
      input.key,
      input.requestHash,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };

  const existing = await client.query<{
    id: string;
    request_hash: string;
    status: "in_progress" | "succeeded" | "failed";
    response_status: number | null;
    response_body: Record<string, unknown> | null;
  }>(
    `select id::text, request_hash, status, response_status, response_body
       from public.idempotency_records
      where owner_id = $1
        and actor_type = $2::public.audit_actor_type
        and actor_id = $3
        and operation = $4
        and idempotency_key = $5
      for update`,
    [
      principal.userId,
      principal.principalType,
      principal.principalId,
      input.operation,
      input.key,
    ],
  );
  const row = existing.rows[0];
  if (!row) throw new ApiError({ statusCode: 500, code: "INTERNAL", message: "멱등성 상태를 확인하지 못했습니다.", retryable: true });
  if (row.request_hash !== input.requestHash) throw conflict();
  if (row.status === "in_progress") throw inProgress();
  if (row.response_status && row.response_body) {
    return { id: row.id, replay: { statusCode: row.response_status, body: row.response_body } };
  }
  throw inProgress();
};

export const claimIdempotency = async (
  database: Database,
  principal: Principal,
  input: Pick<IdempotencyInput, "key" | "operation" | "requestHash">,
): Promise<ReservedRecord> => database.transaction(principal, (client) => reserve(client, principal, input));

export const completeIdempotency = async (
  database: Database,
  principal: Principal,
  input: IdempotencyInput,
  id: string,
  response: StoredResponse,
): Promise<void> => {
  await database.transaction(principal, async (client) => {
    const updated = await client.query(
      `update public.idempotency_records
          set status = 'succeeded', response_status = $1, response_body = $2::jsonb
        where id = $3::bigint and status = 'in_progress'`,
      [response.statusCode, JSON.stringify(response.body), id],
    );
    if (updated.rowCount !== 1) throw inProgress();
    await insertAudit(client, principal, input.requestId, id, input.audit);
  });
};

export const abandonIdempotency = async (
  database: Database,
  principal: Principal,
  id: string,
): Promise<void> => {
  await database.transaction(principal, (client) =>
    client.query(
      "delete from public.idempotency_records where id = $1::bigint and status = 'in_progress'",
      [id],
    ).then(() => undefined),
  );
};

export const executeIdempotent = async <T extends Record<string, unknown>>(
  database: Database,
  principal: Principal,
  input: IdempotencyInput,
  action: (client: SqlClient) => Promise<{ statusCode: number; data: T }>,
): Promise<{ replayed: boolean; response: StoredResponse }> =>
  database.transaction(principal, async (client) => {
    const record = await reserve(client, principal, input);
    if (record.replay) return { replayed: true, response: record.replay };

    const result = await action(client);
    const body = { request_id: input.requestId, data: result.data };
    await client.query(
      `update public.idempotency_records
          set status = 'succeeded', response_status = $1, response_body = $2::jsonb
        where id = $3::bigint`,
      [result.statusCode, JSON.stringify(body), record.id],
    );
    await insertAudit(client, principal, input.requestId, record.id, input.audit);
    return { replayed: false, response: { statusCode: result.statusCode, body } };
  });
