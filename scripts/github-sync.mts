import { createHash } from "node:crypto";

const GITHUB_API_URL = "https://api.github.com";
const MAX_BATCH_SIZE = 10;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

type SyncMode = "incremental" | "reconcile" | "manual";
type Stream = "issues" | "comments";
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface Repository {
  github_id: string;
  node_id: string;
  full_name: string;
  html_url: string;
  visibility: "public" | "private" | "internal";
}

interface Checkpoint {
  last_successful_observed_through: string | null;
  recommended_query_from: string | null;
  checkpoint_version: number;
}

interface SyncRun {
  sync_run_id: string;
  status: "running" | "skipped_concurrent";
  checkpoint_version: number;
}

interface Label {
  github_id: string;
  name: string;
  color: string;
}

interface SyncIssue {
  id: string | number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  user: { login?: string | null } | null;
  locked: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: Array<{ id: string | number; name: string; color: string }>;
  pull_request?: unknown;
}

interface SyncComment {
  id: string | number;
  node_id: string;
  issue_url: string;
  user: { login?: string | null } | null;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

type SyncItem =
  | {
    idempotency_key: string;
    resource_type: "issue";
    operation: "upsert";
    issue: {
      github_id: string;
      node_id: string;
      number: number;
      title: string;
      body: string | null;
      state: "open" | "closed";
      state_reason: string | null;
      author_login: string | null;
      locked: boolean;
      html_url: string;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
      labels: Label[];
    };
    observed_at: string;
  }
  | {
    idempotency_key: string;
    resource_type: "issue_comment";
    operation: "upsert";
    issue_number: number;
    comment: {
      github_id: string;
      node_id: string;
      author_login: string | null;
      body: string | null;
      html_url: string;
      created_at: string;
      updated_at: string;
    };
    observed_at: string;
  };

interface ItemResult {
  idempotency_key: string;
  status: "accepted" | "duplicate" | "retryable_error" | "quarantined_permanent";
  snapshot_created?: boolean;
  effect?: string;
}

interface SyncSummary {
  issues_seen: number;
  issue_snapshots_created: number;
  comments_seen: number;
  comment_snapshots_created: number;
  quarantined: number;
}

export interface GitHubSyncConfig {
  apiUrl: string;
  secondBrainToken: string;
  githubToken: string;
  repository: string;
  mode: SyncMode;
  clientRunId: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface GitHubSyncDependencies {
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface GitHubSyncResult {
  status: "completed" | "completed_with_errors" | "skipped_concurrent";
  mode: SyncMode;
  summary: SyncSummary;
}

class SyncError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

const sha256 = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex")}`;

const asRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncError("INVALID_RESPONSE", false, message);
  return value as Record<string, unknown>;
};

const asData = (value: unknown): Record<string, unknown> => asRecord(asRecord(value, "Second Brain API 응답 형식이 올바르지 않습니다.").data, "Second Brain API data가 없습니다.");

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new SyncError("INVALID_RESPONSE", false, `${name} 값이 올바르지 않습니다.`);
  return value;
};

const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SyncError("INVALID_RESPONSE", false, `${name} 값이 올바르지 않습니다.`);
  return value;
};

const retryAfterMs = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const retryDelayMs = (attempt: number, response?: Response) => {
  const retryAfter = response ? retryAfterMs(response) : undefined;
  if (retryAfter !== undefined) return Math.min(retryAfter, 60_000);
  return Math.min(8_000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 250);
};

const githubRateLimited = (response: Response) =>
  response.status === 429
  || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));

const apiBaseUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new SyncError("INVALID_CONFIGURATION", false, "SECOND_BRAIN_API_URL은 HTTPS URL이어야 합니다.");
  }
  return url.toString().replace(/\/$/, "");
};

const requestJson = async <T>(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  options: { maxRetries: number; timeoutMs: number; sleep: (milliseconds: number) => Promise<void>; label: string },
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetcher(url, { ...init, signal: controller.signal });
      if (response.ok) return await response.json() as T;

      const body = await response.json().catch(() => undefined) as unknown;
      const error = body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: unknown; retryable?: unknown; request_id?: unknown } }).error
        : undefined;
      const code = typeof error?.code === "string" ? error.code : `HTTP_${response.status}`;
      const requestId = error?.request_id;
      const retryable = error?.retryable === true || githubRateLimited(response) || response.status >= 500;
      if (!retryable || attempt >= options.maxRetries) {
        if (typeof requestId === "string" && /^[0-9a-f-]{36}$/i.test(requestId)) {
          throw new SyncError(code, retryable, `${options.label} request_id=${requestId}`);
        }
        throw new SyncError(code, retryable, `${options.label} 요청이 실패했습니다 (HTTP ${response.status}).`);
      }
    } catch (error) {
      if (error instanceof SyncError) {
        if (!error.retryable || attempt >= options.maxRetries) throw error;
      } else if (attempt >= options.maxRetries) {
        throw new SyncError("DEPENDENCY_UNAVAILABLE", true, `${options.label} 요청을 완료하지 못했습니다.`);
      }
    } finally {
      clearTimeout(timeout);
    }
    await options.sleep(retryDelayMs(attempt, response));
  }
};

const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": "second-brain-github-sync",
  "x-github-api-version": "2022-11-28",
});

const apiHeaders = (token: string, idempotencyKey?: string) => ({
  accept: "application/json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
});

const nextLink = (header: string | null): string | undefined => {
  if (!header) return undefined;
  return header.split(",").map((part) => part.trim()).find((part) => /rel="next"/.test(part))?.match(/^<([^>]+)>/)?.[1];
};

const issueNumberFromUrl = (issueUrl: string): number => {
  const matched = issueUrl.match(/\/issues\/(\d+)$/);
  if (!matched) throw new SyncError("INVALID_RESPONSE", false, "댓글의 부모 Issue 식별자를 해석할 수 없습니다.");
  return Number(matched[1]);
};

const toIso = (date: Date) => date.toISOString();

const normalizeLabels = (labels: SyncIssue["labels"]): Label[] => labels
  .map((label) => ({ github_id: String(label.id), name: label.name, color: label.color }))
  .sort((left, right) => left.github_id.localeCompare(right.github_id));

const normalizeBody = (value: string | null) => value?.replace(/\r\n/g, "\n") ?? null;

const toIssueItem = (repositoryNodeId: string, issue: SyncIssue, observedAt: string): SyncItem => {
  const payload = {
    github_id: String(issue.id),
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: normalizeBody(issue.body),
    state: issue.state,
    state_reason: issue.state_reason,
    author_login: issue.user?.login ?? null,
    locked: issue.locked,
    html_url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    labels: normalizeLabels(issue.labels),
  };
  const contentHash = sha256({ resource_type: "issue", issue: payload });
  return {
    idempotency_key: `gh:${repositoryNodeId}:issue:${payload.github_id}:${contentHash}`,
    resource_type: "issue",
    operation: "upsert",
    issue: payload,
    observed_at: observedAt,
  };
};

const toCommentItem = (repositoryNodeId: string, comment: SyncComment, observedAt: string): SyncItem => {
  const payload = {
    github_id: String(comment.id),
    node_id: comment.node_id,
    author_login: comment.user?.login ?? null,
    body: normalizeBody(comment.body),
    html_url: comment.html_url,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
  const contentHash = sha256({ resource_type: "issue_comment", issue_number: issueNumberFromUrl(comment.issue_url), comment: payload });
  return {
    idempotency_key: `gh:${repositoryNodeId}:comment:${payload.github_id}:${contentHash}`,
    resource_type: "issue_comment",
    operation: "upsert",
    issue_number: issueNumberFromUrl(comment.issue_url),
    comment: payload,
    observed_at: observedAt,
  };
};

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};

const statusOf = (value: unknown): ItemResult => {
  const item = asRecord(value, "수집 항목 응답 형식이 올바르지 않습니다.");
  const status = requireString(item.status, "item.status");
  if (!(["accepted", "duplicate", "retryable_error", "quarantined_permanent"] as string[]).includes(status)) {
    throw new SyncError("INVALID_RESPONSE", false, "알 수 없는 수집 항목 상태입니다.");
  }
  return {
    idempotency_key: requireString(item.idempotency_key, "item.idempotency_key"),
    status: status as ItemResult["status"],
    snapshot_created: item.snapshot_created === true,
    effect: typeof item.effect === "string" ? item.effect : undefined,
  };
};

const hasSnapshot = (item: ItemResult) => item.snapshot_created === true || item.effect === "snapshot_created";

export const runGitHubSync = async (
  config: GitHubSyncConfig,
  dependencies: GitHubSyncDependencies = {},
): Promise<GitHubSyncResult> => {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? defaultSleep;
  const log = dependencies.log ?? ((message) => console.log(message));
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [owner, name, ...extra] = config.repository.split("/");
  if (!owner || !name || extra.length > 0) throw new SyncError("INVALID_CONFIGURATION", false, "GITHUB_REPOSITORY는 owner/repository 형식이어야 합니다.");
  if (!config.secondBrainToken || !config.githubToken || !config.clientRunId) throw new SyncError("INVALID_CONFIGURATION", false, "동기화에 필요한 시크릿 또는 실행 ID가 없습니다.");
  const secondBrainUrl = apiBaseUrl(config.apiUrl);
  const requestOptions = { maxRetries, timeoutMs, sleep };
  const githubUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const githubRequest = <T>(url: string) => requestJson<T>(fetcher, url, { headers: githubHeaders(config.githubToken) }, { ...requestOptions, label: "GitHub" });
  const apiRequest = <T>(path: string, method: "GET" | "POST", body?: unknown, idempotencyKey?: string) => requestJson<T>(
    fetcher,
    `${secondBrainUrl}${path}`,
    { method, headers: apiHeaders(config.secondBrainToken, idempotencyKey), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { ...requestOptions, label: "Second Brain API" },
  );

  const githubRepository = asRecord(await githubRequest<unknown>(githubUrl), "GitHub repository 응답 형식이 올바르지 않습니다.");
  const repository: Repository = {
    github_id: String(requireNumber(githubRepository.id, "repository.id")),
    node_id: requireString(githubRepository.node_id, "repository.node_id"),
    full_name: requireString(githubRepository.full_name, "repository.full_name"),
    html_url: requireString(githubRepository.html_url, "repository.html_url"),
    visibility: githubRepository.visibility === "public" || githubRepository.visibility === "internal" ? githubRepository.visibility : "private",
  };

  let checkpoint: Checkpoint = { last_successful_observed_through: null, recommended_query_from: null, checkpoint_version: 0 };
  try {
    const response = await apiRequest<unknown>(`/v1/github/repositories/${encodeURIComponent(repository.node_id)}/checkpoint`, "GET");
    const data = asData(response);
    checkpoint = {
      last_successful_observed_through: data.last_successful_observed_through === null ? null : requireString(data.last_successful_observed_through, "checkpoint.last_successful_observed_through"),
      recommended_query_from: data.recommended_query_from === null ? null : requireString(data.recommended_query_from, "checkpoint.recommended_query_from"),
      checkpoint_version: requireNumber(data.checkpoint_version, "checkpoint.checkpoint_version"),
    };
  } catch (error) {
    if (!(error instanceof SyncError) || error.code !== "NOT_FOUND") throw error;
  }

  const mode: SyncMode = checkpoint.last_successful_observed_through === null ? "reconcile" : config.mode;
  const runStartedAt = toIso(now());
  const runData = asData(await apiRequest<unknown>(
    "/v1/github/sync-runs",
    "POST",
    {
      repository,
      mode,
      query_from: mode === "incremental" ? checkpoint.recommended_query_from : null,
      client_run_id: config.clientRunId,
    },
    `github-sync:${config.clientRunId}:start`,
  ));
  const run: SyncRun = {
    sync_run_id: requireString(runData.sync_run_id, "sync_run_id"),
    status: requireString(runData.status, "sync run status") as SyncRun["status"],
    checkpoint_version: requireNumber(runData.checkpoint_version, "sync run checkpoint_version"),
  };
  if (run.status === "skipped_concurrent") {
    log(`GitHub sync skipped because another run is active for ${repository.full_name}.`);
    return { status: "skipped_concurrent", mode, summary: { issues_seen: 0, issue_snapshots_created: 0, comments_seen: 0, comment_snapshots_created: 0, quarantined: 0 } };
  }
  if (run.status !== "running") throw new SyncError("INVALID_RESPONSE", false, "동기화 실행 상태가 올바르지 않습니다.");

  const summary: SyncSummary = { issues_seen: 0, issue_snapshots_created: 0, comments_seen: 0, comment_snapshots_created: 0, quarantined: 0 };
  let envelopeSequence = 0;
  const nextEnvelopeKey = (operation: string) => `github-sync:${config.clientRunId}:${operation}:${++envelopeSequence}`;
  const heartbeat = async (stream: Stream, pagesCompleted: number) => {
    await apiRequest(`/v1/github/sync-runs/${encodeURIComponent(run.sync_run_id)}/heartbeat`, "POST", {
      stream,
      pages_completed: pagesCompleted,
      items_accepted: stream === "issues" ? summary.issues_seen : summary.comments_seen,
      observed_through: runStartedAt,
    }, nextEnvelopeKey(`heartbeat-${stream}`));
  };

  const sendItems = async (items: SyncItem[], stream: Stream) => {
    for (const batch of chunks(items, MAX_BATCH_SIZE)) {
      let pending = batch;
      for (let retry = 0; pending.length > 0; retry += 1) {
        const response = asData(await apiRequest<unknown>(`/v1/github/sync-runs/${encodeURIComponent(run.sync_run_id)}/items`, "POST", { items: pending }, nextEnvelopeKey(`items-${stream}`)));
        const rawItems = response.items;
        if (!Array.isArray(rawItems) || rawItems.length !== pending.length) throw new SyncError("INVALID_RESPONSE", false, "수집 항목 응답이 요청과 일치하지 않습니다.");
        const results = rawItems.map(statusOf);
        const pendingKeys = new Set(pending.map((item) => item.idempotency_key));
        if (results.some((result) => !pendingKeys.has(result.idempotency_key))) throw new SyncError("INVALID_RESPONSE", false, "수집 항목 응답 키가 요청과 일치하지 않습니다.");
        const retryableKeys = new Set<string>();
        for (const result of results) {
          if (result.status === "retryable_error") retryableKeys.add(result.idempotency_key);
          if (result.status === "quarantined_permanent") summary.quarantined += 1;
          // The current ingestion API records only newly accepted rows in this run's
          // completion summary. Replayed item keys are terminal, but must not inflate
          // the summary that the completion endpoint validates against sync_run_items.
          if (result.status === "accepted") {
            if (stream === "issues") {
              summary.issues_seen += 1;
              if (hasSnapshot(result)) summary.issue_snapshots_created += 1;
            } else {
              summary.comments_seen += 1;
              if (hasSnapshot(result)) summary.comment_snapshots_created += 1;
            }
          }
        }
        pending = pending.filter((item) => retryableKeys.has(item.idempotency_key));
        if (pending.length > 0 && retry >= maxRetries) throw new SyncError("DEPENDENCY_UNAVAILABLE", true, "재시도 가능한 수집 항목이 남아 있습니다.");
        if (pending.length > 0) await sleep(retryDelayMs(retry));
      }
    }
  };

  const listGitHubPages = async <T>(firstUrl: string, stream: Stream, toItem: (value: T, observedAt: string) => SyncItem | undefined) => {
    let url: string | undefined = firstUrl;
    let pagesCompleted = 0;
    while (url) {
      let response: Response | undefined;
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetcher(url, { headers: githubHeaders(config.githubToken), signal: controller.signal });
          if (response.ok) break;
          const retryable = githubRateLimited(response) || response.status >= 500;
          if (!retryable || attempt >= maxRetries) {
            throw new SyncError(response.status === 403 ? "GITHUB_FORBIDDEN" : `GITHUB_HTTP_${response.status}`, retryable, "GitHub 목록 조회가 실패했습니다.");
          }
        } catch (error) {
          if (error instanceof SyncError) {
            if (!error.retryable || attempt >= maxRetries) throw error;
          } else if (attempt >= maxRetries) {
            throw new SyncError("DEPENDENCY_UNAVAILABLE", true, "GitHub 목록 조회를 완료하지 못했습니다.");
          }
        } finally {
          clearTimeout(timeout);
        }
        await sleep(retryDelayMs(attempt, response));
      }
      if (!response) throw new SyncError("DEPENDENCY_UNAVAILABLE", true, "GitHub 목록 조회를 완료하지 못했습니다.");
      const raw = await response.json() as unknown;
      if (!Array.isArray(raw)) throw new SyncError("INVALID_RESPONSE", false, "GitHub 목록 응답이 배열이 아닙니다.");
      const observedAt = toIso(now());
      await sendItems(raw.map((value) => toItem(value as T, observedAt)).filter((item): item is SyncItem => item !== undefined), stream);
      pagesCompleted += 1;
      await heartbeat(stream, pagesCompleted);
      url = nextLink(response.headers.get("link"));
    }
  };

  const query = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: "100" });
  if (mode === "incremental" && checkpoint.recommended_query_from) query.set("since", checkpoint.recommended_query_from);
  const issueListUrl = `${githubUrl}/issues?${query.toString()}`;
  const commentQuery = new URLSearchParams({ per_page: "100" });
  if (mode === "incremental" && checkpoint.recommended_query_from) commentQuery.set("since", checkpoint.recommended_query_from);
  const commentListUrl = `${githubUrl}/issues/comments?${commentQuery.toString()}`;

  try {
    await listGitHubPages<SyncIssue>(issueListUrl, "issues", (issue, observedAt) => issue.pull_request ? undefined : toIssueItem(repository.node_id, issue, observedAt));
    await listGitHubPages<SyncComment>(commentListUrl, "comments", (comment, observedAt) => toCommentItem(repository.node_id, comment, observedAt));
    if (mode === "reconcile") {
      const reconciliation = asData(await apiRequest<unknown>(
        `/v1/github/sync-runs/${encodeURIComponent(run.sync_run_id)}/reconcile`,
        "POST",
        {},
        nextEnvelopeKey("reconcile"),
      ));
      const missingCandidates = asRecord(reconciliation.missing_candidates, "reconcile missing candidate 응답이 올바르지 않습니다.");
      const tombstones = asRecord(reconciliation.tombstones, "reconcile tombstone 응답이 올바르지 않습니다.");
      const missingIssues = requireNumber(missingCandidates.issues, "missing_candidates.issues");
      const missingComments = requireNumber(missingCandidates.comments, "missing_candidates.comments");
      const tombstoneIssues = requireNumber(tombstones.issues, "tombstones.issues");
      const tombstoneComments = requireNumber(tombstones.comments, "tombstones.comments");
      log(`GitHub reconcile marked ${missingIssues} issue(s), ${missingComments} comment(s), ${tombstoneIssues} issue tombstone(s), and ${tombstoneComments} comment tombstone(s).`);
    }
    const finalStatus = summary.quarantined > 0 ? "completed_with_errors" : "completed";
    await apiRequest(`/v1/github/sync-runs/${encodeURIComponent(run.sync_run_id)}/complete`, "POST", {
      status: finalStatus,
      observed_through: runStartedAt,
      expected_checkpoint_version: run.checkpoint_version,
      summary: {
        issues_seen: summary.issues_seen,
        issue_snapshots_created: summary.issue_snapshots_created,
        comments_seen: summary.comments_seen,
        comment_snapshots_created: summary.comment_snapshots_created,
      },
    }, nextEnvelopeKey("complete"));
    return { status: finalStatus, mode, summary };
  } catch (error) {
    const code = error instanceof SyncError ? error.code : "SYNC_FAILED";
    await apiRequest(`/v1/github/sync-runs/${encodeURIComponent(run.sync_run_id)}/complete`, "POST", {
      status: "failed",
      error: { code, message: "GitHub 또는 Second Brain API 동기화를 완료하지 못했습니다." },
    }, nextEnvelopeKey("failed")).catch(() => undefined);
    throw error;
  }
};

const environment = (name: string) => process.env[name]?.trim() ?? "";

const cliMode = (value: string | undefined): SyncMode => {
  if (value === undefined || value === "incremental") return "incremental";
  if (value === "reconcile" || value === "manual") return value;
  throw new SyncError("INVALID_CONFIGURATION", false, "--mode는 incremental, reconcile 또는 manual 이어야 합니다.");
};

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/github-sync.mts");

if (isMain) {
  const modeArgument = process.argv.find((argument) => argument.startsWith("--mode="))?.slice("--mode=".length);
  const mode = cliMode(modeArgument);
  const clientRunId = environment("GITHUB_RUN_ID") && environment("GITHUB_RUN_ATTEMPT")
    ? `github-actions:${environment("GITHUB_RUN_ID")}:${environment("GITHUB_RUN_ATTEMPT")}`
    : environment("SECOND_BRAIN_SYNC_RUN_ID");
  runGitHubSync({
    apiUrl: environment("SECOND_BRAIN_API_URL"),
    secondBrainToken: environment("SECOND_BRAIN_GITHUB_SYNC_TOKEN"),
    githubToken: environment("GITHUB_TOKEN"),
    repository: environment("GITHUB_REPOSITORY"),
    mode,
    clientRunId,
  }).then((result) => {
    console.log(JSON.stringify({ status: result.status, mode: result.mode, summary: result.summary }));
  }).catch((error: unknown) => {
    const code = error instanceof SyncError ? error.code : "SYNC_FAILED";
    const detail = error instanceof SyncError ? error.message : "Unexpected sync runner failure.";
    console.error(`GitHub sync failed: ${code} ${detail}`);
    process.exitCode = 1;
  });
}
