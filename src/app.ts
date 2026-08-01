import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { PrincipalVerifier } from "#app/common/auth/auth.service.js";
import type { Database } from "#app/common/database/database.js";
import { asApiError } from "#app/common/errors/errors.js";
import type { Principal } from "#app/common/auth/principal.js";
import { registerAgentRunsModule } from "#app/modules/agent-runs/agent-runs.module.js";
import { registerGithubSyncModule } from "#app/modules/github-sync/github-sync.module.js";
import { registerMemoriesModule } from "#app/modules/memories/memories.module.js";
import { registerVerificationModule } from "#app/modules/verification/verification.module.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppDependencies {
  database: Database;
  verifier: PrincipalVerifier;
  forgetPreviewSecret: string;
  dashboardAccessToken?: string;
}

const publicRoutes = new Set([
  "/v1/health",
  "/verification",
  "/verification/memories/inbox",
]);

const safeErrorMetadata = (error: unknown) => {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    error_name: error instanceof Error ? error.name : "UnknownError",
    ...(typeof candidate.code === "string" ? { error_code: candidate.code } : {}),
    ...(typeof candidate.constraint === "string" ? { database_constraint: candidate.constraint } : {}),
  };
};

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  const app = Fastify({
    bodyLimit: 4 * 1024 * 1024,
    logger: { level: "error" },
    genReqId: () => randomUUID(),
  });

  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.url && publicRoutes.has(request.routeOptions.url)) return;
    request.principal = await dependencies.verifier.verify(request.headers.authorization);
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = asApiError(error);
    if (apiError.statusCode >= 500) {
      request.log.error({
        request_id: request.id,
        route: request.routeOptions.url,
        ...safeErrorMetadata(error),
      }, "request failed");
    }
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

  registerVerificationModule(app, dependencies);
  registerGithubSyncModule(app, dependencies);
  registerMemoriesModule(app, dependencies);
  registerAgentRunsModule(app, dependencies);

  return app;
};
