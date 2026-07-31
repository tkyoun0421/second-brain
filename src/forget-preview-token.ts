import { createHmac, timingSafeEqual } from "node:crypto";

import { ApiError } from "./errors.js";

export type ForgetReasonCode = "user_requested" | "sensitive_data" | "retention_expired" | "unauthorized_source";

export interface ForgetPreviewTokenPayload {
  version: 1;
  ownerId: string;
  memoryId: string;
  expectedRevision: number;
  reasonCode: ForgetReasonCode;
  deleteLinkedSource: boolean;
  impactHash: string;
  expiresAt: string;
}

const prefix = "forget_preview_v1";

export const invalidForgetPreviewToken = () => new ApiError({
  statusCode: 409,
  code: "FORGET_PREVIEW_INVALID",
  message: "삭제 미리보기 토큰이 유효하지 않거나 만료되었습니다. 새 미리보기를 요청하세요.",
});

const sign = (encodedPayload: string, secret: string) =>
  createHmac("sha256", secret).update(`${prefix}.${encodedPayload}`, "utf8").digest("base64url");

export const createForgetPreviewToken = (payload: ForgetPreviewTokenPayload, secret: string): string => {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${prefix}.${encodedPayload}.${sign(encodedPayload, secret)}`;
};

export const verifyForgetPreviewToken = (token: string, secret: string): ForgetPreviewTokenPayload => {
  const [tokenPrefix, encodedPayload, signature, ...rest] = token.split(".");
  if (tokenPrefix !== prefix || !encodedPayload || !signature || rest.length !== 0) throw invalidForgetPreviewToken();

  const expected = Buffer.from(sign(encodedPayload, secret), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw invalidForgetPreviewToken();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw invalidForgetPreviewToken();
  }
  const payload = parsed as Partial<ForgetPreviewTokenPayload>;
  if (
    payload.version !== 1 ||
    typeof payload.ownerId !== "string" ||
    !/^\d+$/.test(payload.memoryId ?? "") ||
    typeof payload.expectedRevision !== "number" ||
    !Number.isSafeInteger(payload.expectedRevision) ||
    payload.expectedRevision < 1 ||
    !["user_requested", "sensitive_data", "retention_expired", "unauthorized_source"].includes(payload.reasonCode ?? "") ||
    typeof payload.deleteLinkedSource !== "boolean" ||
    !/^sha256:[0-9a-f]{64}$/.test(payload.impactHash ?? "") ||
    typeof payload.expiresAt !== "string" ||
    Number.isNaN(Date.parse(payload.expiresAt)) ||
    Date.parse(payload.expiresAt) <= Date.now()
  ) throw invalidForgetPreviewToken();

  return payload as ForgetPreviewTokenPayload;
};
