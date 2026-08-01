import type { FastifyInstance } from "fastify";

import type { RouteDependencies } from "#app/common/http/route-context.js";
import { registerMemoriesReadController } from "#app/modules/memories/memories-read.controller.js";
import { registerMemoriesWriteController } from "#app/modules/memories/memories-write.controller.js";

export const registerMemoriesModule = (app: FastifyInstance, dependencies: RouteDependencies) => {
  registerMemoriesReadController(app, dependencies);
  registerMemoriesWriteController(app, dependencies);
};
