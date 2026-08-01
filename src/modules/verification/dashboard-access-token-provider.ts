import type { AccessTokenProvider } from "#app/common/auth/access-token-provider.js";

const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class DashboardAccessTokenError extends Error {
  constructor(
    readonly code: "DASHBOARD_TOKEN_REFRESH_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DashboardAccessTokenError";
  }
}

export class StaticDashboardAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly accessToken: string) {}

  async getAccessToken(): Promise<string> {
    return this.accessToken;
  }
}

interface SupabasePasswordDashboardAccessTokenProviderConfig {
  supabaseUrl: string;
  publishableKey: string;
  email: string;
  password: string;
  requestTimeoutMs?: number;
  refreshWindowMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedAccessToken {
  value: string;
  refreshAt: number;
}

const isTokenResponse = (value: unknown): value is { access_token: string; expires_in: number } => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.access_token === "string"
    && candidate.access_token.length > 0
    && typeof candidate.expires_in === "number"
    && Number.isFinite(candidate.expires_in)
    && candidate.expires_in > 0;
};

export class SupabasePasswordDashboardAccessTokenProvider implements AccessTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshWindowMs: number;
  private readonly requestTimeoutMs: number;
  private cachedAccessToken: CachedAccessToken | undefined;
  private refreshInFlight: Promise<string> | undefined;

  constructor(private readonly config: SupabasePasswordDashboardAccessTokenProviderConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
    this.refreshWindowMs = config.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken && this.cachedAccessToken.refreshAt > this.now()) {
      return this.cachedAccessToken.value;
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = this.refreshAccessToken();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(new URL("/auth/v1/token?grant_type=password", this.config.supabaseUrl), {
          method: "POST",
          headers: {
            apikey: this.config.publishableKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: this.config.email, password: this.config.password }),
          signal: controller.signal,
        });
      } catch {
        throw new DashboardAccessTokenError(
          "DASHBOARD_TOKEN_REFRESH_FAILED",
          "Unable to obtain a dashboard access token.",
        );
      }

      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isTokenResponse(payload)) {
        throw new DashboardAccessTokenError(
          "DASHBOARD_TOKEN_REFRESH_FAILED",
          "Unable to obtain a dashboard access token.",
        );
      }

      this.cachedAccessToken = {
        value: payload.access_token,
        refreshAt: this.now() + Math.max((payload.expires_in * 1_000) - this.refreshWindowMs, 0),
      };
      return payload.access_token;
    } finally {
      clearTimeout(timeout);
    }
  }
}
