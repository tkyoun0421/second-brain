import type { FastifyInstance } from "fastify";

import { hashRequest } from "#app/common/crypto/hash.js";
import { agentRunFinishSchema } from "#app/common/validation/schemas.js";
import { rejectSensitiveData } from "#app/common/security/sensitive-data.js";
import { finishAgentRun } from "#app/modules/agent-runs/agent-runs.service.js";
import {
  bodyOf,
  idempotencyKeyOf,
  principalOf,
  sendIdempotent,
  type RouteDependencies,
} from "#app/common/http/route-context.js";

export const registerAgentRunsController = (app: FastifyInstance, { database }: RouteDependencies) => {
  app.post("/v1/agent-runs/finish", async (request, reply) => {
    const principal = principalOf(request);
    const input = agentRunFinishSchema.parse(bodyOf(request));
    rejectSensitiveData(input);
    return sendIdempotent(reply, await finishAgentRun(
      database, principal, request.id, idempotencyKeyOf(request), hashRequest(input), input,
    ));
  });
};
