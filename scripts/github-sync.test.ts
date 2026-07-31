import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubSync } from "./github-sync.mts";

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  ...init,
});

const apiResponse = (data: Record<string, unknown>) => json({ request_id: "request-1", data });

const issue = {
  id: 101,
  node_id: "I_kwDOExample",
  number: 42,
  title: "sync this",
  body: "body",
  state: "open",
  state_reason: null,
  user: { login: "octocat" },
  locked: false,
  html_url: "https://github.com/acme/brain/issues/42",
  created_at: "2026-07-31T00:00:00.000Z",
  updated_at: "2026-07-31T00:01:00.000Z",
  closed_at: null,
  labels: [{ id: 9, name: "learning", color: "0e8a16" }],
};

const comment = {
  id: 202,
  node_id: "IC_kwDOExample",
  issue_url: "https://api.github.com/repos/acme/brain/issues/42",
  user: { login: "octocat" },
  body: "comment",
  html_url: "https://github.com/acme/brain/issues/42#issuecomment-202",
  created_at: "2026-07-31T00:02:00.000Z",
  updated_at: "2026-07-31T00:03:00.000Z",
};

test("incremental sync maps GitHub issues and comments, then advances the checkpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://api.github.com/repos/acme/brain") {
      return json({ id: 123, node_id: "R_kgDOExample", full_name: "acme/brain", html_url: "https://github.com/acme/brain", visibility: "private" });
    }
    if (url.includes("/checkpoint")) return apiResponse({ last_successful_observed_through: "2026-07-31T00:00:00.000Z", recommended_query_from: "2026-07-30T23:45:00.000Z", checkpoint_version: 4 });
    if (url.endsWith("/sync-runs")) return apiResponse({ sync_run_id: "99", status: "running", checkpoint_version: 4 });
    if (url.includes("/issues?") && !url.includes("/issues/comments")) return json([issue]);
    if (url.includes("/issues/comments?")) return json([comment]);
    if (url.includes("/heartbeat")) return apiResponse({ sync_run_id: "99", status: "running" });
    if (url.includes("/items")) {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ idempotency_key: string; resource_type: string }> };
      return apiResponse({ items: body.items.map((item) => ({ idempotency_key: item.idempotency_key, status: "accepted", snapshot_created: true })) });
    }
    if (url.includes("/complete")) return apiResponse({ sync_run_id: "99", status: "completed" });
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runGitHubSync({
    apiUrl: "https://second-brain.example",
    secondBrainToken: "second-brain-token",
    githubToken: "github-token",
    repository: "acme/brain",
    mode: "incremental",
    clientRunId: "github-actions:123:1",
  }, { fetch, now: () => new Date("2026-07-31T01:00:00.000Z"), sleep: async () => undefined, log: () => undefined });

  assert.deepEqual(result, {
    status: "completed",
    mode: "incremental",
    summary: { issues_seen: 1, issue_snapshots_created: 1, comments_seen: 1, comment_snapshots_created: 1, quarantined: 0 },
  });
  const itemCalls = calls.filter((call) => call.url.includes("/items"));
  assert.equal(itemCalls.length, 2);
  const issueBody = JSON.parse(String(itemCalls[0].init?.body));
  assert.equal(issueBody.items[0].resource_type, "issue");
  assert.match(issueBody.items[0].idempotency_key, /^gh:R_kgDOExample:issue:101:sha256:/);
  const completeCall = calls.find((call) => call.url.includes("/complete"));
  assert.ok(completeCall);
  assert.deepEqual(JSON.parse(String(completeCall.init?.body)).summary, {
    issues_seen: 1,
    issue_snapshots_created: 1,
    comments_seen: 1,
    comment_snapshots_created: 1,
  });
  assert.equal((calls.find((call) => call.url.includes("/issues?"))?.url.includes("since=2026-07-30T23%3A45%3A00.000Z")), true);
});

test("a missing checkpoint forces the first run to reconcile", async () => {
  const startBodies: unknown[] = [];
  let reconciled = false;
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/brain") return json({ id: 123, node_id: "R_kgDOExample", full_name: "acme/brain", html_url: "https://github.com/acme/brain", visibility: "private" });
    if (url.includes("/checkpoint")) return json({ error: { code: "NOT_FOUND", retryable: false } }, { status: 404 });
    if (url.endsWith("/sync-runs")) {
      startBodies.push(JSON.parse(String(init?.body)));
      return apiResponse({ sync_run_id: "99", status: "running", checkpoint_version: 0 });
    }
    if (url.includes("/issues?") || url.includes("/issues/comments?")) return json([]);
    if (url.includes("/heartbeat")) return apiResponse({});
    if (url.includes("/reconcile")) {
      reconciled = true;
      return apiResponse({ sync_run_id: "99", missing_candidates: { issues: 0, comments: 0 }, tombstones: { issues: 0, comments: 0 } });
    }
    if (url.includes("/complete")) return apiResponse({});
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runGitHubSync({
    apiUrl: "https://second-brain.example",
    secondBrainToken: "second-brain-token",
    githubToken: "github-token",
    repository: "acme/brain",
    mode: "incremental",
    clientRunId: "github-actions:123:1",
  }, { fetch, now: () => new Date("2026-07-31T01:00:00.000Z"), sleep: async () => undefined, log: () => undefined });

  assert.equal(result.mode, "reconcile");
  assert.deepEqual(startBodies[0], {
    repository: { github_id: "123", node_id: "R_kgDOExample", full_name: "acme/brain", html_url: "https://github.com/acme/brain", visibility: "private" },
    mode: "reconcile",
    query_from: null,
    client_run_id: "github-actions:123:1",
  });
  assert.equal(reconciled, true);
});

test("retryable item results are resent with their stable item idempotency key", async () => {
  let itemAttempt = 0;
  const itemBodies: Array<{ items: Array<{ idempotency_key: string }> }> = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/brain") return json({ id: 123, node_id: "R_kgDOExample", full_name: "acme/brain", html_url: "https://github.com/acme/brain", visibility: "private" });
    if (url.includes("/checkpoint")) return apiResponse({ last_successful_observed_through: "2026-07-31T00:00:00.000Z", recommended_query_from: "2026-07-30T23:45:00.000Z", checkpoint_version: 4 });
    if (url.endsWith("/sync-runs")) return apiResponse({ sync_run_id: "99", status: "running", checkpoint_version: 4 });
    if (url.includes("/issues?") && !url.includes("/issues/comments")) return json([issue]);
    if (url.includes("/issues/comments?")) return json([]);
    if (url.includes("/heartbeat")) return apiResponse({});
    if (url.includes("/items")) {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ idempotency_key: string }> };
      itemBodies.push(body);
      itemAttempt += 1;
      return apiResponse({ items: body.items.map((item) => ({ idempotency_key: item.idempotency_key, status: itemAttempt === 1 ? "retryable_error" : "accepted" })) });
    }
    if (url.includes("/complete")) return apiResponse({});
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await runGitHubSync({
    apiUrl: "https://second-brain.example",
    secondBrainToken: "second-brain-token",
    githubToken: "github-token",
    repository: "acme/brain",
    mode: "incremental",
    clientRunId: "github-actions:123:1",
  }, { fetch, now: () => new Date("2026-07-31T01:00:00.000Z"), sleep: async () => undefined, log: () => undefined });

  assert.equal(result.status, "completed");
  assert.equal(itemBodies.length, 2);
  assert.equal(itemBodies[0].items[0].idempotency_key, itemBodies[1].items[0].idempotency_key);
});
