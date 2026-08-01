import type { FastifyInstance } from "fastify";

import { hashRequest } from "#app/hash.js";
import {
  decisionSchema,
  failureSchema,
  memoryCaptureSchema,
  memoryConfirmSchema,
  memoryForgetPreviewSchema,
  memoryForgetSchema,
  memorySupersedeSchema,
} from "#app/schemas.js";
import { rejectSensitiveData } from "#app/sensitive.js";
import {
  captureMemory,
  confirmMemory,
  createDecision,
  createFailure,
  forgetMemory,
  previewMemoryForget,
  supersedeMemory,
} from "#app/services.js";
import {
  bodyOf,
  idempotencyKeyOf,
  numericPathId,
  principalOf,
  sendIdempotent,
  type RouteDependencies,
} from "#app/http/route-context.js";

export const registerMemoryWriteRoutes = (app: FastifyInstance, { database, forgetPreviewSecret }: RouteDependencies) => {
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

  app.post("/v1/memories/capture", async (request, reply) => {
    const principal = principalOf(request);
    const input = memoryCaptureSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await captureMemory(
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
};
