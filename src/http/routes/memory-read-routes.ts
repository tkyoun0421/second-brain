import type { FastifyInstance } from "fastify";

import { getMemoryDetail, listMemoryInbox, queryContext, searchMemories } from "#app/read-services.js";
import { contextQuerySchema, memoryInboxQuerySchema, memorySearchSchema } from "#app/schemas.js";
import { rejectSensitiveData } from "#app/sensitive.js";
import {
  bodyOf,
  numericPathId,
  principalOf,
  type RouteDependencies,
} from "#app/http/route-context.js";

export const registerMemoryReadRoutes = (app: FastifyInstance, { database }: RouteDependencies) => {
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

  app.get("/v1/memories/inbox", async (request) => {
    const input = memoryInboxQuerySchema.parse(request.query);
    return { request_id: request.id, data: await listMemoryInbox(database, principalOf(request), input) };
  });

  app.get<{ Params: { memory_id: string } }>("/v1/memories/:memory_id", async (request) => ({
    request_id: request.id,
    data: await getMemoryDetail(database, principalOf(request), numericPathId(request.params.memory_id, "memory_id")),
  }));
};
