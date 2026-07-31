import { z } from "zod";

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional(),
  }),
});

export class McpApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "McpApiError";
  }
}

export interface McpApiClientConfig {
  apiBaseUrl: string;
  accessToken: string;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
}

export class McpApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: McpApiClientConfig) {
    this.baseUrl = config.apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? fetch;
  }

  async get(path: string): Promise<{ requestId?: string; data: unknown }> {
    return this.request(path, { method: "GET" });
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<{ requestId?: string; data: unknown }> {
    return this.request(path, {
      method: "POST",
      ...(idempotencyKey ? { headers: { "x-idempotency-key": idempotencyKey } } : {}),
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<{ requestId?: string; data: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.config.accessToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(payload);
        if (parsed.success) {
          throw new McpApiError(
            parsed.data.error.code,
            parsed.data.error.message,
            parsed.data.error.retryable ?? response.status >= 500,
            parsed.data.error.request_id,
            parsed.data.error.details,
          );
        }
        throw new McpApiError(
          response.status >= 500 ? "DEPENDENCY_UNAVAILABLE" : "INTERNAL",
          "Second Brain API returned an invalid error response.",
          response.status >= 500,
        );
      }
      if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new McpApiError("DEPENDENCY_UNAVAILABLE", "Second Brain API returned an invalid response.", true);
      }
      const result = payload as { request_id?: unknown; data: unknown };
      return { ...(typeof result.request_id === "string" ? { requestId: result.request_id } : {}), data: result.data };
    } catch (error) {
      if (error instanceof McpApiError) throw error;
      throw new McpApiError(
        "DEPENDENCY_UNAVAILABLE",
        error instanceof DOMException && error.name === "AbortError"
          ? "Second Brain API request timed out. Retry this exact write with the same idempotency key."
          : "Second Brain API is unavailable. Retry this exact write with the same idempotency key.",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

const mcpEnvironmentSchema = z.object({
  SECOND_BRAIN_API_URL: z.string().url(),
  SECOND_BRAIN_MCP_ACCESS_TOKEN: z.string().min(1),
  SECOND_BRAIN_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
});

export const loadMcpApiClientConfig = (environment: NodeJS.ProcessEnv = process.env): McpApiClientConfig => {
  const value = mcpEnvironmentSchema.parse(environment);
  return {
    apiBaseUrl: value.SECOND_BRAIN_API_URL,
    accessToken: value.SECOND_BRAIN_MCP_ACCESS_TOKEN,
    requestTimeoutMs: value.SECOND_BRAIN_MCP_REQUEST_TIMEOUT_MS,
  };
};
