import assert from "node:assert/strict";
import test from "node:test";

import {
  DashboardAccessTokenError,
  SupabasePasswordDashboardAccessTokenProvider,
} from "#app/modules/verification/dashboard-access-token-provider.js";

test("dashboard token provider caches a Supabase access token until its refresh window", async () => {
  let now = 0;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const responses = [
    { access_token: "first-access-token", expires_in: 120 },
    { access_token: "second-access-token", expires_in: 120 },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const provider = new SupabasePasswordDashboardAccessTokenProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    email: "dashboard-agent@example.com",
    password: "server-only-password",
    fetch: fetchImpl,
    now: () => now,
  });

  assert.equal(await provider.getAccessToken(), "first-access-token");
  now = 59_000;
  assert.equal(await provider.getAccessToken(), "first-access-token");
  now = 61_000;
  assert.equal(await provider.getAccessToken(), "second-access-token");

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://example.supabase.co/auth/v1/token?grant_type=password");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(requests[0]?.init?.headers, {
    apikey: "publishable-key",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    email: "dashboard-agent@example.com",
    password: "server-only-password",
  });
});

test("dashboard token provider deduplicates concurrent token refreshes", async () => {
  let resolveResponse: ((response: Response) => void) | undefined;
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
  };
  const provider = new SupabasePasswordDashboardAccessTokenProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    email: "dashboard-agent@example.com",
    password: "server-only-password",
    fetch: fetchImpl,
  });

  const first = provider.getAccessToken();
  const second = provider.getAccessToken();
  assert.equal(calls, 1);
  resolveResponse?.(new Response(JSON.stringify({ access_token: "shared-access-token", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  assert.deepEqual(await Promise.all([first, second]), ["shared-access-token", "shared-access-token"]);
});

test("dashboard token provider returns a sanitized error when Supabase sign-in fails", async () => {
  const provider = new SupabasePasswordDashboardAccessTokenProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    email: "dashboard-agent@example.com",
    password: "server-only-password",
    fetch: async () => new Response(JSON.stringify({ message: "invalid login credentials" }), { status: 400 }),
  });

  await assert.rejects(
    provider.getAccessToken(),
    (error: unknown) => error instanceof DashboardAccessTokenError
      && error.code === "DASHBOARD_TOKEN_REFRESH_FAILED"
      && error.message === "Unable to obtain a dashboard access token.",
  );
});
