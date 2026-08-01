import type { FastifyInstance } from "fastify";

import { ApiError } from "#app/common/errors/errors.js";
import { listMemoryInbox } from "#app/modules/memories/memories-query.service.js";
import { memoryInboxQuerySchema } from "#app/common/validation/schemas.js";
import { verificationDashboardHtml } from "#app/modules/verification/verification-dashboard.js";
import type { RouteDependencies } from "#app/common/http/route-context.js";

const isLoopbackAddress = (address: string) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

export const registerVerificationController = (app: FastifyInstance, { database, verifier, dashboardAccessToken }: RouteDependencies) => {
  app.get("/v1/health", async (request) => ({ request_id: request.id, data: { status: "ok" } }));

  app.get("/verification", async (_request, reply) => reply
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(verificationDashboardHtml()));

  app.get("/verification/memories/inbox", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      throw new ApiError({ statusCode: 403, code: "FORBIDDEN", message: "The verification data proxy is only available on loopback." });
    }
    if (!dashboardAccessToken) {
      return reply.code(503).send({
        error: {
          code: "DASHBOARD_TOKEN_NOT_CONFIGURED",
          message: "The dashboard access token is not configured.",
          request_id: request.id,
          retryable: false,
        },
      });
    }
    const input = memoryInboxQuerySchema.parse(request.query);
    const principal = await verifier.verify(`Bearer ${dashboardAccessToken}`);
    reply.header("cache-control", "no-store");
    return { request_id: request.id, data: await listMemoryInbox(database, principal, input) };
  });
};
