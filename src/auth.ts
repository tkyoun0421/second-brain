import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { ApiError } from "#app/errors.js";
import { permissionValues, type Permission, type Principal, type PrincipalType } from "#app/principal.js";

export interface PrincipalVerifier {
  verify(authorization: string | undefined): Promise<Principal>;
}

const claimsSchema = z.object({
  sub: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  principal_id: z.string().uuid().optional(),
  principal_type: z.enum(["github_sync", "mcp_agent", "operator", "user"]),
  permissions: z.array(z.enum(permissionValues)),
  repository_ids: z.array(z.string().min(1)).default([]),
  credential_id: z.string().uuid().optional(),
});

export class SupabaseJwtVerifier implements PrincipalVerifier {
  private readonly keySet: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly options: {
      jwksUrl: URL;
      issuer: string;
      audience: string;
    },
  ) {
    this.keySet = createRemoteJWKSet(options.jwksUrl);
  }

  async verify(authorization: string | undefined): Promise<Principal> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw unauthenticated();

    try {
      const { payload } = await jwtVerify(token, this.keySet, {
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      const claims = claimsSchema.parse(payload);

      return {
        principalId: claims.principal_id ?? claims.sub,
        principalType: claims.principal_type as PrincipalType,
        userId: claims.user_id ?? claims.sub,
        permissions: new Set(claims.permissions as Permission[]),
        repositoryNodeIds: new Set(claims.repository_ids),
        ...(claims.credential_id ? { credentialId: claims.credential_id } : {}),
      };
    } catch {
      throw unauthenticated();
    }
  }
}

export const unauthenticated = () =>
  new ApiError({
    statusCode: 401,
    code: "UNAUTHENTICATED",
    message: "인증 정보를 확인할 수 없습니다.",
  });
