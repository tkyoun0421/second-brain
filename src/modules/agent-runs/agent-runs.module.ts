import type { FastifyInstance } from "fastify";

import type { RouteDependencies } from "#app/common/http/route-context.js";
import { registerAgentRunsController } from "#app/modules/agent-runs/agent-runs.controller.js";

export const registerAgentRunsModule = (app: FastifyInstance, dependencies: RouteDependencies) => {
  registerAgentRunsController(app, dependencies);
};
