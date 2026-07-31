import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { PrincipalVerifier } from "./auth.js";
import type { Database } from "./database.js";
import { asApiError, ApiError, invalidArgument } from "./errors.js";
import { hashRequest } from "./hash.js";
import {
  abandonIdempotency,
  claimIdempotency,
  completeIdempotency,
  type IdempotencyInput,
  validateIdempotencyKey,
} from "./idempotency.js";
import type { Principal } from "./principal.js";
import {
  decisionSchema,
  failureSchema,
  agentRunFinishSchema,
  heartbeatSchema,
  contextQuerySchema,
  memoryConfirmSchema,
  memoryForgetPreviewSchema,
  memoryForgetSchema,
  memorySearchSchema,
  memorySupersedeSchema,
  syncCompleteSchema,
  syncItemsSchema,
  syncStartSchema,
} from "./schemas.js";
import { getMemoryDetail, queryContext, searchMemories } from "./read-services.js";
import { rejectSensitiveData } from "./sensitive.js";
import {
  completeSyncRun,
  confirmMemory,
  createDecision,
  createFailure,
  finishAgentRun,
  getCheckpoint,
  heartbeatSyncRun,
  processSyncItem,
  startSyncRun,
  supersedeMemory,
  forgetMemory,
  previewMemoryForget,
} from "./services.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppDependencies {
  database: Database;
  verifier: PrincipalVerifier;
  forgetPreviewSecret: string;
}

const numericPathId = (value: string, name: string) => {
  if (!/^\d+$/.test(value)) throw invalidArgument(`${name}는 숫자 ID여야 합니다.`);
  return value;
};

const bodyOf = (request: FastifyRequest) => request.body as Record<string, unknown>;

const principalOf = (request: FastifyRequest): Principal => {
  if (!request.principal) {
    throw new ApiError({ statusCode: 401, code: "UNAUTHENTICATED", message: "인증 정보를 확인할 수 없습니다." });
  }
  return request.principal;
};

const idempotencyKeyOf = (request: FastifyRequest) => {
  const value = request.headers["x-idempotency-key"];
  return validateIdempotencyKey(Array.isArray(value) ? value[0] : value);
};

const sendIdempotent = (
  reply: { code(statusCode: number): { header(name: string, value: string): unknown; send(body: unknown): unknown } },
  outcome: { replayed: boolean; response: { statusCode: number; body: Record<string, unknown> } },
) => {
  const response = reply.code(outcome.response.statusCode);
  if (outcome.replayed) response.header("idempotency-replayed", "true");
  return response.send(outcome.response.body);
};

export const buildApp = ({ database, verifier, forgetPreviewSecret }: AppDependencies): FastifyInstance => {
  const app = Fastify({
    bodyLimit: 4 * 1024 * 1024,
    logger: false,
    genReqId: () => randomUUID(),
  });

  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.url === "/v1/health") return;
    request.principal = await verifier.verify(request.headers.authorization);
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = asApiError(error);
    if (apiError.headers) {
      for (const [name, value] of Object.entries(apiError.headers)) reply.header(name, value);
    }
    return reply.code(apiError.statusCode).send({
      error: {
        code: apiError.code,
        message: apiError.message,
        request_id: request.id,
        retryable: apiError.retryable,
        ...(apiError.details ? { details: apiError.details } : {}),
      },
    });
  });

  app.get("/v1/health", async (request) => ({ request_id: request.id, data: { status: "ok" } }));

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

  app.post("/v1/context/query", async (request) => {
    const input = contextQuerySchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return { request_id: request.id, data: await queryContext(database, principalOf(request), input) };
  });

  app.post("/v1/memories/search", async (request) => {
    const input = memorySearchSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return { request_id: request.id, data: await searchMemories(database, principalOf(request), input) };
  });

  app.get<{ Params: { memory_id: string } }>("/v1/memories/:memory_id", async (request) => ({
    request_id: request.id,
    data: await getMemoryDetail(database, principalOf(request), numericPathId(request.params.memory_id, "memory_id")),
  }));

  app.post("/v1/memories/decisions", async (request, reply) => {
    const principal = principalOf(request);
    const input = decisionSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await createDecision(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input), input,
    ));
  });

  app.post("/v1/memories/failures", async (request, reply) => {
    const principal = principalOf(request);
    const input = failureSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await createFailure(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input), input,
    ));
  });

  app.post("/v1/agent-runs/finish", async (request, reply) => {
    const principal = principalOf(request);
    const input = agentRunFinishSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await finishAgentRun(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input), input,
    ));
  });

  app.post<{ Params: { memory_id: string } }>("/v1/memories/:memory_id/confirm", async (request, reply) => {
    const principal = principalOf(request);
    const input = memoryConfirmSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await confirmMemory(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input),
      numericPathId(request.params.memory_id, "memory_id"), input,
    ));
  });

  app.post<{ Params: { memory_id: string } }>("/v1/memories/:memory_id/supersede", async (request, reply) => {
    const principal = principalOf(request);
    const input = memorySupersedeSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await supersedeMemory(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input),
      numericPathId(request.params.memory_id, "memory_id"), input,
    ));
  });

  app.post<{ Params: { memory_id: string } }>("/v1/memories/:memory_id/forget-preview", async (request) => {
    const input = memoryForgetPreviewSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return {
      request_id: request.id,
      data: await previewMemoryForget(
        database, principalOf(request), numericPathId(request.params.memory_id, "memory_id"), input, forgetPreviewSecret,
      ),
    };
  });

  app.post<{ Params: { memory_id: string } }>("/v1/memories/:memory_id/forget", async (request, reply) => {
    const principal = principalOf(request);
    const input = memoryForgetSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await forgetMemory(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input),
      numericPathId(request.params.memory_id, "memory_id"), input, forgetPreviewSecret,
    ));
  });

  return app;
};
