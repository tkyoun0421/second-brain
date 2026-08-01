import type { FastifyInstance } from "fastify";

import { hashRequest } from "#app/hash.js";
import { agentRunFinishSchema } from "#app/schemas.js";
import { rejectSensitiveData } from "#app/sensitive.js";
import { finishAgentRun } from "#app/services.js";
import {
  bodyOf,
  idempotencyKeyOf,
  principalOf,
  sendIdempotent,
  type RouteDependencies,
} from "#app/http/route-context.js";

export const registerAgentRunRoutes = (app: FastifyInstance, { database }: RouteDependencies) => {
  app.post("/v1/agent-runs/finish", async (request, reply) => {
    const principal = principalOf(request);
    const input = agentRunFinishSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await finishAgentRun(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input), input,
    ));
  });
};
