import { ZodError } from "zod";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Array<Record<string, string>> | undefined;
  readonly headers?: Record<string, string> | undefined;

  constructor(options: {
    statusCode: number;
    code: string;
    message: string;
    retryable?: boolean;
    details?: Array<Record<string, string>> | undefined;
    headers?: Record<string, string> | undefined;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const invalidArgument = (
  message: string,
  details?: Array<Record<string, string>>,
) =>
  new ApiError({
    statusCode: 400,
    code: "INVALID_ARGUMENT",
    message,
    ...(details ? { details } : {}),
  });

export const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;

  if (error instanceof ZodError) {
    return invalidArgument(
      "요청 형식이 올바르지 않습니다.",
      error.issues.map((issue) => ({
        path: `/${issue.path.map(String).join("/")}`,
        reason: issue.code,
      })),
    );
  }

  const fastifyError = error as { code?: string; statusCode?: number };
  if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new ApiError({
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "요청 본문이 허용 크기를 초과했습니다.",
    });
  }

  if (fastifyError.code === "FST_ERR_CTP_INVALID_JSON") {
    return new ApiError({
      statusCode: 400,
      code: "INVALID_JSON",
      message: "JSON 본문을 해석할 수 없습니다.",
    });
  }

  return new ApiError({
    statusCode: fastifyError.statusCode && fastifyError.statusCode < 500
      ? fastifyError.statusCode
      : 500,
    code: "INTERNAL",
    message: "요청을 처리하지 못했습니다.",
    retryable: true,
  });
};
