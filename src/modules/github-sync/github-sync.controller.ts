import type { FastifyInstance } from "fastify";

import { hashRequest } from "#app/common/crypto/hash.js";
import {
  abandonIdempotency,
  claimIdempotency,
  completeIdempotency,
  type IdempotencyInput,
} from "#app/common/idempotency/idempotency.service.js";
import {
  heartbeatSchema,
  syncCompleteSchema,
  syncItemsSchema,
  syncReconcileSchema,
  syncStartSchema,
} from "#app/common/validation/schemas.js";
import { rejectSensitiveData } from "#app/common/security/sensitive-data.js";
import {
  completeSyncRun,
  getCheckpoint,
  heartbeatSyncRun,
  processSyncItem,
  reconcileSyncRun,
  startSyncRun,
} from "#app/modules/github-sync/github-sync.service.js";
import {
  bodyOf,
  idempotencyKeyOf,
  numericPathId,
  principalOf,
  sendIdempotent,
  type RouteDependencies,
} from "#app/common/http/route-context.js";

export const registerGithubSyncController = (app: FastifyInstance, { database }: RouteDependencies) => {
  app.get<{ Params: { github_repository_id: string } }>(
    "/v1/github/repositories/:github_repository_id/checkpoint",
    async (request) => ({
      request_id: request.id,
      data: await getCheckpoint(database, principalOf(request), request.params.github_repository_id),
    }),
  );

  app.post("/v1/github/sync-runs", async (request, reply) => {
    const principal = principalOf(request);
    const input = syncStartSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await startSyncRun(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input), input,
    ));
  });

  app.post<{ Params: { sync_run_id: string } }>(
    "/v1/github/sync-runs/:sync_run_id/heartbeat",
    async (request, reply) => {
      const principal = principalOf(request);
      const input = heartbeatSchema.parse(bodyOf(request));
      rejectSensitiveData(input);
      return sendIdempotent(reply, await heartbeatSyncRun(
        database, principal, request.id, idempotencyKeyOf(request), hashRequest(input),
        numericPathId(request.params.sync_run_id, "sync_run_id"), input,
      ));
    },
  );

  app.post<{ Params: { sync_run_id: string } }>(
    "/v1/github/sync-runs/:sync_run_id/items",
    async (request, reply) => {
      const principal = principalOf(request);
      const input = syncItemsSchema.parse(bodyOf(request));
      const syncRunId = numericPathId(request.params.sync_run_id, "sync_run_id");
      const idempotencyKey = idempotencyKeyOf(request);
      const idempotency: IdempotencyInput = {
        key: idempotencyKey,
        operation: "POST /v1/github/sync-runs/{sync_run_id}/items",
        requestHash: hashRequest(input),
        requestId: request.id,
        audit: {
          operation: "sync",
          targetType: "sync_run",
          targetIds: [syncRunId],
          redactedInput: { item_count: input.items.length },
        },
      };
      const claim = await claimIdempotency(database, principal, idempotency);
      if (claim.replay) {
        reply.header("idempotency-replayed", "true");
        return reply.code(claim.replay.statusCode).send(claim.replay.body);
      }

      try {
        const results = [] as Array<Record<string, unknown>>;
        for (const item of input.items) {
          rejectSensitiveData(item);
          const result = await processSyncItem(database, principal, request.id, syncRunId, item);
          const data = result.response.body.data as { item: Record<string, unknown> };
          results.push({
            ...data.item,
            ...(result.replayed ? { status: "duplicate" } : {}),
          });
        }
        const body = {
          request_id: request.id,
          data: {
            sync_run_id: syncRunId,
            items: results,
            accepted_count: results.filter((result) => result.status === "accepted").length,
            duplicate_count: results.filter((result) => result.status === "duplicate").length,
          },
        };
        await completeIdempotency(database, principal, idempotency, claim.id, { statusCode: 200, body });
        return reply.code(200).send(body);
      } catch (error) {
        await abandonIdempotency(database, principal, claim.id).catch(() => undefined);
        throw error;
      }
    },
  );

  app.post<{ Params: { sync_run_id: string } }>(
    "/v1/github/sync-runs/:sync_run_id/complete",
    async (request, reply) => {
      const principal = principalOf(request);
      const input = syncCompleteSchema.parse(bodyOf(request));
      rejectSensitiveData(input);
      return sendIdempotent(reply, await completeSyncRun(
        database, principal, request.id, idempotencyKeyOf(request), hashRequest(input),
        numericPathId(request.params.sync_run_id, "sync_run_id"), input,
      ));
    },
  );

  app.post<{ Params: { sync_run_id: string } }>(
    "/v1/github/sync-runs/:sync_run_id/reconcile",
    async (request, reply) => {
      const principal = principalOf(request);
      const input = syncReconcileSchema.parse(bodyOf(request));
      return sendIdempotent(reply, await reconcileSyncRun(
        database, principal, request.id, idempotencyKeyOf(request), hashRequest(input),
        numericPathId(request.params.sync_run_id, "sync_run_id"),
      ));
    },
  );
};
