import type { FastifyInstance } from "fastify";

import type { RouteDependencies } from "#app/common/http/route-context.js";
import { registerGithubSyncController } from "#app/modules/github-sync/github-sync.controller.js";

export const registerGithubSyncModule = (app: FastifyInstance, dependencies: RouteDependencies) => {
  registerGithubSyncController(app, dependencies);
};
