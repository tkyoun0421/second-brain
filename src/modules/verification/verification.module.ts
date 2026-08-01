import type { FastifyInstance } from "fastify";

import type { RouteDependencies } from "#app/common/http/route-context.js";
import { registerVerificationController } from "#app/modules/verification/verification.controller.js";

export const registerVerificationModule = (app: FastifyInstance, dependencies: RouteDependencies) => {
  registerVerificationController(app, dependencies);
};
