import type { FastifyReply, FastifyRequest } from "fastify";

import type { PrincipalVerifier } from "#app/auth.js";
import type { Database } from "#app/database.js";
import { ApiError, invalidArgument } from "#app/errors.js";
import type { StoredResponse } from "#app/idempotency.js";
import { validateIdempotencyKey } from "#app/idempotency.js";
import type { Principal } from "#app/principal.js";

export interface RouteDependencies {
  database: Database;
  verifier: PrincipalVerifier;
  forgetPreviewSecret: string;
  dashboardAccessToken?: string;
}

export const numericPathId = (value: string, name: string) => {
  if (!/^\d+$/.test(value)) throw invalidArgument(`${name}는 숫자 ID여야 합니다.`);
  return value;
};

export const bodyOf = (request: FastifyRequest) => request.body as Record<string, unknown>;

export const principalOf = (request: FastifyRequest): Principal => {
  if (!request.principal) {
    throw new ApiError({ statusCode: 401, code: "UNAUTHENTICATED", message: "인증 정보를 확인할 수 없습니다." });
  }
  return request.principal;
};

export const idempotencyKeyOf = (request: FastifyRequest) => {
  const value = request.headers["x-idempotency-key"];
  return validateIdempotencyKey(Array.isArray(value) ? value[0] : value);
};

export const sendIdempotent = (
  reply: FastifyReply,
  outcome: { replayed: boolean; response: StoredResponse },
) => {
  const response = reply.code(outcome.response.statusCode);
  if (outcome.replayed) response.header("idempotency-replayed", "true");
  return response.send(outcome.response.body);
};
