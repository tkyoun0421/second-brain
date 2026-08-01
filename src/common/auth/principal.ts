import { ApiError } from "#app/common/errors/errors.js";

export const permissionValues = [
  "github_source:write",
  "github_sync:checkpoint",
  "github_quarantine:retry",
  "context:read",
  "memory:read",
  "memory:propose",
  "memory:confirm",
  "memory:supersede",
  "memory:forget",
  "memory:forget_sensitive",
  "agent_run:write",
  "operations:credential_revoke",
] as const;

export type Permission = (typeof permissionValues)[number];
export type PrincipalType = "github_sync" | "mcp_agent" | "operator" | "user";

export interface Principal {
  principalId: string;
  principalType: PrincipalType;
  userId: string;
  permissions: ReadonlySet<Permission>;
  repositoryNodeIds: ReadonlySet<string>;
  credentialId?: string;
}

export const requirePermission = (principal: Principal, permission: Permission) => {
  if (!principal.permissions.has(permission)) {
    throw new ApiError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "이 작업에 필요한 권한이 없습니다.",
    });
  }
};

export const requireAnyPermission = (
  principal: Principal,
  permissions: readonly Permission[],
) => {
  if (!permissions.some((permission) => principal.permissions.has(permission))) {
    throw new ApiError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "이 작업에 필요한 권한이 없습니다.",
    });
  }
};

export const assertRepositoryAllowed = (principal: Principal, githubNodeId: string | null) => {
  if (!githubNodeId || !principal.repositoryNodeIds.has(githubNodeId)) {
    throw new ApiError({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "요청한 리소스를 찾을 수 없습니다.",
    });
  }
};
