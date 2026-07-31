import type { Database, SqlClient } from "./database.js";
import { ApiError, invalidArgument } from "./errors.js";
import { assertRepositoryAllowed, requirePermission, type Principal } from "./principal.js";
import type { ContextQueryInput, MemorySearchInput } from "./schemas.js";

interface MemoryRow {
  id: string;
  kind: "learning" | "decision" | "preference" | "failure" | "procedure" | "constraint";
  statement: string;
  rationale: string | null;
  status: "proposed" | "confirmed" | "verified" | "superseded" | "deprecated" | "deleted";
  confidence: string;
  revision: string;
  valid_from: string;
  valid_until: string | null;
  tags: string[];
  scope_type: "global" | "organization" | "repository" | "project" | "path" | "task";
  scope_key: string;
  repository_node_id: string | null;
  created_at: string;
  updated_at: string;
  supersedes_id: string | null;
}

interface SourceRef {
  source_type: string;
  source_id: string;
  source_uri: string | null;
  source_excerpt: string | null;
}

const notFound = () => new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "요청한 리소스를 찾을 수 없습니다." });

const visibleMemorySql = `
  from public.memories m
  join public.memory_scopes s on s.owner_id = m.owner_id and s.id = m.scope_id
  left join public.repositories scope_repository
    on scope_repository.owner_id = s.owner_id and scope_repository.id = s.repository_id
  left join public.projects scope_project
    on scope_project.owner_id = s.owner_id and scope_project.id = s.project_id
  left join public.repositories project_repository
    on project_repository.owner_id = scope_project.owner_id and project_repository.id = scope_project.repository_id
`;

const visibleMemoryColumns = `
  m.id::text, m.kind::text, m.statement, m.rationale, m.status::text, m.confidence::text,
  m.revision::text, m.valid_from::text, m.valid_until::text, m.tags,
  s.scope_type::text, s.scope_key,
  coalesce(scope_repository.github_node_id, project_repository.github_node_id) as repository_node_id,
  m.created_at::text, m.updated_at::text, m.supersedes_id::text
`;

const accessPredicate = `
  (s.scope_type in ('global', 'task')
   or coalesce(scope_repository.github_node_id, project_repository.github_node_id) = any($2::text[]))
`;

const memorySummary = (memory: MemoryRow, sources: SourceRef[]) => ({
  id: memory.id,
  kind: memory.kind,
  statement: memory.statement,
  status: memory.status,
  scope: { type: memory.scope_type, id: memory.scope_key },
  source_refs: sources.map(({ source_type, source_id }) => ({ source_type, source_id })),
});

const getSources = async (
  client: SqlClient,
  ownerId: string,
  memoryIds: string[],
): Promise<Map<string, SourceRef[]>> => {
  const sources = new Map<string, SourceRef[]>();
  if (memoryIds.length === 0) return sources;
  const result = await client.query<{
    memory_id: string;
    source_type: string;
    source_id: string;
    source_uri: string | null;
    source_excerpt: string | null;
  }>(
    `select e.memory_id::text,
            coalesce(snapshot.payload->>'wire_source_type', source.source_type::text, 'agent_run') as source_type,
            coalesce(source.external_id, agent_run.id::text) as source_id,
            source.source_uri,
            e.source_excerpt
       from public.memory_evidence e
       left join public.source_snapshots snapshot
         on snapshot.owner_id = e.owner_id and snapshot.id = e.source_snapshot_id
       left join public.source_records source
         on source.owner_id = snapshot.owner_id and source.id = snapshot.source_id
       left join public.agent_runs agent_run
         on agent_run.owner_id = e.owner_id and agent_run.id = e.agent_run_id
      where e.owner_id = $1 and e.memory_id = any($2::bigint[])
      order by e.memory_id, e.id`,
    [ownerId, memoryIds],
  );
  for (const row of result.rows) {
    const rows = sources.get(row.memory_id) ?? [];
    rows.push({
      source_type: row.source_type,
      source_id: row.source_id,
      source_uri: row.source_uri,
      source_excerpt: row.source_excerpt,
    });
    sources.set(row.memory_id, rows);
  }
  return sources;
};

const parseCursor = (cursor: string | null) => {
  if (!cursor) return { updatedAt: null, id: null };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updated_at?: unknown; id?: unknown };
    if (typeof parsed.updated_at !== "string" || !/^\d+$/.test(String(parsed.id))) throw new Error("invalid");
    return { updatedAt: parsed.updated_at, id: String(parsed.id) };
  } catch {
    throw invalidArgument("cursor 형식이 올바르지 않습니다.");
  }
};

const nextCursor = (memory: MemoryRow | undefined) => memory
  ? Buffer.from(JSON.stringify({ updated_at: memory.updated_at, id: memory.id }), "utf8").toString("base64url")
  : null;

export const queryContext = async (
  database: Database,
  principal: Principal,
  input: ContextQueryInput,
) => database.transaction(principal, async (client) => {
  requirePermission(principal, "context:read");
  const repository = await client.query<{ id: string; github_node_id: string | null; full_name: string }>(
    `select id::text, github_node_id, full_name from public.repositories
      where owner_id = $1 and github_node_id = $2`,
    [principal.userId, input.repository.github_repository_id],
  );
  const repo = repository.rows[0];
  if (!repo) throw notFound();
  assertRepositoryAllowed(principal, repo.github_node_id);

  const memories = await client.query<MemoryRow>(
    `select ${visibleMemoryColumns}
     ${visibleMemorySql}
      where m.owner_id = $1
        and ${accessPredicate}
        and m.status in ('confirmed', 'verified')
        and (s.scope_type in ('global', 'task')
             or s.repository_id = $3::bigint
             or scope_project.repository_id = $3::bigint)
        and (cardinality($4::text[]) = 0 or m.tags && $4::text[])
      order by
        case m.kind
          when 'constraint' then 0 when 'decision' then 1 when 'preference' then 2
          when 'learning' then 3 when 'failure' then 4 else 5 end,
        m.updated_at desc, m.id desc
      limit $5`,
    [principal.userId, [...principal.repositoryNodeIds], repo.id, input.tags, input.limits.max_memories * 3],
  );
  const sourceMap = await getSources(client, principal.userId, memories.rows.map((memory) => memory.id));
  const perKind = new Map<string, number>();
  const selected: MemoryRow[] = [];
  let usedCharacters = 0;
  for (const memory of memories.rows) {
    const count = perKind.get(memory.kind) ?? 0;
    const estimate = Math.ceil((memory.statement.length + (memory.rationale?.length ?? 0)) / 4);
    if (count >= input.limits.max_per_kind || usedCharacters + estimate > input.limits.max_estimated_tokens) continue;
    perKind.set(memory.kind, count + 1);
    usedCharacters += estimate;
    selected.push(memory);
    if (selected.length === input.limits.max_memories) break;
  }
  const groups: Record<string, ReturnType<typeof memorySummary>[]> = {
    constraints: [], decisions: [], preferences: [], related_learning: [], past_failures: [], procedures: [],
  };
  const groupKey: Record<MemoryRow["kind"], keyof typeof groups> = {
    constraint: "constraints", decision: "decisions", preference: "preferences",
    learning: "related_learning", failure: "past_failures", procedure: "procedures",
  };
  for (const memory of selected) {
    const key = groupKey[memory.kind];
    const bucket = key ? groups[key] : undefined;
    if (bucket) bucket.push(memorySummary(memory, sourceMap.get(memory.id) ?? []));
  }
  return {
    repository: { id: repo.id, github_repository_id: input.repository.github_repository_id, name: repo.full_name },
    task: input.task,
    ...groups,
    conflicts: [],
    sources: [...sourceMap.values()].flat().map(({ source_type, source_id, source_uri }) => ({ source_type, source_id, source_uri })),
    has_more: memories.rows.length > selected.length,
  };
});

export const searchMemories = async (
  database: Database,
  principal: Principal,
  input: MemorySearchInput,
) => database.transaction(principal, async (client) => {
  requirePermission(principal, "memory:read");
  const cursor = parseCursor(input.cursor);
  const kinds = input.kinds ?? ["learning", "decision", "preference", "failure", "procedure", "constraint"];
  const statuses = input.statuses ?? ["confirmed", "verified"];
  const requestedScopes = input.scopes?.map((scope) => `${scope.type}:${scope.id}`) ?? [];
  const result = await client.query<MemoryRow>(
    `select ${visibleMemoryColumns}
     ${visibleMemorySql}
      where m.owner_id = $1
        and ${accessPredicate}
        and m.kind = any($3::public.memory_kind[])
        and m.status = any($4::public.memory_status[])
        and lower(m.statement || ' ' || coalesce(m.rationale, '')) like '%' || lower($5) || '%'
        and (cardinality($6::text[]) = 0 or (s.scope_type::text || ':' || s.scope_key) = any($6::text[]))
        and (cardinality($7::text[]) = 0 or m.tags && $7::text[])
        and ($8::timestamptz is null or (m.updated_at, m.id) < ($8::timestamptz, $9::bigint))
      order by m.updated_at desc, m.id desc
      limit $10`,
    [
      principal.userId, [...principal.repositoryNodeIds], kinds, statuses, input.query,
      requestedScopes, input.tags ?? [], cursor.updatedAt, cursor.id, input.limit + 1,
    ],
  );
  const hasMore = result.rows.length > input.limit;
  const page = result.rows.slice(0, input.limit);
  const sourceMap = await getSources(client, principal.userId, page.map((memory) => memory.id));
  return {
    items: page.map((memory) => memorySummary(memory, sourceMap.get(memory.id) ?? [])),
    next_cursor: hasMore ? nextCursor(page.at(-1)) : null,
  };
});

export const getMemoryDetail = async (
  database: Database,
  principal: Principal,
  memoryId: string,
) => database.transaction(principal, async (client) => {
  requirePermission(principal, "memory:read");
  const result = await client.query<MemoryRow>(
    `select ${visibleMemoryColumns}
     ${visibleMemorySql}
      where m.owner_id = $1 and m.id = $3::bigint and ${accessPredicate}`,
    [principal.userId, [...principal.repositoryNodeIds], memoryId],
  );
  const memory = result.rows[0];
  if (!memory) throw notFound();
  const sourceMap = await getSources(client, principal.userId, [memory.id]);
  const successor = await client.query<{ id: string; status: string }>(
    `select id::text, status::text from public.memories
      where owner_id = $1 and supersedes_id = $2::bigint`,
    [principal.userId, memory.id],
  );
  const usage = await client.query<{
    last_used_at: string | null;
    helpful: string; irrelevant: string; outdated: string; incorrect: string; conflicting: string;
  }>(
    `select m.last_used_at::text,
            count(*) filter (where arm.feedback = 'helpful')::text as helpful,
            count(*) filter (where arm.feedback = 'irrelevant')::text as irrelevant,
            count(*) filter (where arm.feedback = 'outdated')::text as outdated,
            count(*) filter (where arm.feedback = 'incorrect')::text as incorrect,
            count(*) filter (where arm.feedback = 'conflicting')::text as conflicting
       from public.memories m
       left join public.agent_run_memories arm on arm.owner_id = m.owner_id and arm.memory_id = m.id
      where m.owner_id = $1 and m.id = $2::bigint
      group by m.id`,
    [principal.userId, memory.id],
  );
  const usageSummary = usage.rows[0];
  return {
    memory: {
      id: memory.id, kind: memory.kind, statement: memory.statement, rationale: memory.rationale,
      status: memory.status, confidence: Number(memory.confidence),
      scope: { type: memory.scope_type, id: memory.scope_key },
      valid_from: memory.valid_from, valid_until: memory.valid_until, tags: memory.tags,
      revision: Number(memory.revision), created_at: memory.created_at, updated_at: memory.updated_at,
    },
    sources: sourceMap.get(memory.id) ?? [],
    supersedes: memory.supersedes_id ? { memory_id: memory.supersedes_id } : null,
    superseded_by: successor.rows[0] ? { memory_id: successor.rows[0].id, status: successor.rows[0].status } : null,
    usage_summary: {
      last_used_at: usageSummary?.last_used_at ?? null,
      helpful: Number(usageSummary?.helpful ?? 0),
      irrelevant: Number(usageSummary?.irrelevant ?? 0),
      outdated: Number(usageSummary?.outdated ?? 0),
      incorrect: Number(usageSummary?.incorrect ?? 0),
      conflicting: Number(usageSummary?.conflicting ?? 0),
    },
  };
});
