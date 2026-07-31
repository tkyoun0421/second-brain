begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create type public.github_account_type as enum (
  'user',
  'organization'
);

create type public.repository_location_kind as enum (
  'checkout',
  'worktree'
);

create type public.memory_scope_type as enum (
  'global',
  'organization',
  'repository',
  'project',
  'path',
  'task'
);

create type public.source_type as enum (
  'github_issue',
  'github_comment',
  'user_message',
  'agent_run',
  'test_result',
  'manual'
);

create type public.source_lifecycle_status as enum (
  'active',
  'missing_candidate',
  'deleted'
);

create type public.memory_kind as enum (
  'learning',
  'decision',
  'preference',
  'failure',
  'procedure',
  'constraint'
);

create type public.memory_status as enum (
  'proposed',
  'confirmed',
  'verified',
  'superseded',
  'deprecated',
  'deleted'
);

create type public.failure_resolution_status as enum (
  'observed',
  'investigating',
  'hypothesis',
  'resolved',
  'verified',
  'recurring'
);

create type public.agent_run_status as enum (
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled'
);

create type public.memory_run_relation as enum (
  'used',
  'created'
);

create type public.memory_feedback as enum (
  'helpful',
  'irrelevant',
  'outdated',
  'incorrect',
  'conflicting'
);

create type public.sync_mode as enum (
  'incremental',
  'reconcile',
  'manual'
);

create type public.sync_status as enum (
  'running',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'skipped_concurrent'
);

create type public.sync_item_status as enum (
  'pending',
  'accepted',
  'duplicate',
  'retryable_error',
  'quarantined_permanent'
);

create type public.idempotency_status as enum (
  'in_progress',
  'succeeded',
  'failed'
);

create type public.audit_actor_type as enum (
  'user',
  'github_sync',
  'mcp_agent',
  'operator',
  'system'
);

create type public.audit_operation as enum (
  'read',
  'create',
  'update',
  'delete',
  'confirm',
  'supersede',
  'export',
  'sync',
  'tool_call'
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.github_accounts (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  github_account_id bigint not null check (github_account_id > 0),
  login text not null check (btrim(login) <> ''),
  account_type public.github_account_type not null,
  html_url text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint github_accounts_owner_github_id_key
    unique (owner_id, github_account_id),
  constraint github_accounts_owner_id_id_key
    unique (owner_id, id)
);

create table public.repositories (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  github_repository_id bigint not null check (github_repository_id > 0),
  github_node_id text,
  github_owner_id bigint,
  full_name text not null check (btrim(full_name) <> ''),
  html_url text not null check (btrim(html_url) <> ''),
  default_branch text,
  is_private boolean not null default false,
  is_archived boolean not null default false,
  github_created_at timestamptz,
  github_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repositories_owner_github_id_key
    unique (owner_id, github_repository_id),
  constraint repositories_owner_id_id_key
    unique (owner_id, id),
  constraint repositories_owner_github_owner_fkey
    foreign key (owner_id, github_owner_id)
    references public.github_accounts (owner_id, id)
);

create index repositories_owner_github_owner_idx
  on public.repositories (owner_id, github_owner_id)
  where github_owner_id is not null;

create unique index repositories_owner_node_id_key
  on public.repositories (owner_id, github_node_id)
  where github_node_id is not null;

create table public.repository_locations (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  repository_id bigint not null,
  kind public.repository_location_kind not null,
  path text not null check (btrim(path) <> ''),
  normalized_path text not null check (btrim(normalized_path) <> ''),
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_locations_owner_path_key
    unique (owner_id, normalized_path),
  constraint repository_locations_owner_id_id_key
    unique (owner_id, id),
  constraint repository_locations_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete cascade
);

create index repository_locations_owner_repository_idx
  on public.repository_locations (owner_id, repository_id);

create table public.projects (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  repository_id bigint not null,
  name text not null check (btrim(name) <> ''),
  root_path text not null default '.'
    check (btrim(root_path) <> ''),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_owner_repository_root_key
    unique (owner_id, repository_id, root_path),
  constraint projects_owner_id_id_key
    unique (owner_id, id),
  constraint projects_owner_repository_id_id_key
    unique (owner_id, repository_id, id),
  constraint projects_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete cascade
);

create table public.memory_scopes (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  scope_type public.memory_scope_type not null,
  organization_id bigint,
  repository_id bigint,
  project_id bigint,
  path text,
  task_key text,
  scope_key text generated always as (
    case
      when scope_type = 'global' then 'global'
      when scope_type = 'organization' then organization_id::text
      when scope_type = 'repository' then repository_id::text
      when scope_type = 'project' then project_id::text
      when scope_type = 'path' then repository_id::text || ':' || path
      when scope_type = 'task' then task_key
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_scopes_shape_check check (
    (
      scope_type = 'global'
      and organization_id is null
      and repository_id is null
      and project_id is null
      and path is null
      and task_key is null
    )
    or (
      scope_type = 'organization'
      and organization_id is not null
      and repository_id is null
      and project_id is null
      and path is null
      and task_key is null
    )
    or (
      scope_type = 'repository'
      and organization_id is null
      and repository_id is not null
      and project_id is null
      and path is null
      and task_key is null
    )
    or (
      scope_type = 'project'
      and organization_id is null
      and repository_id is null
      and project_id is not null
      and path is null
      and task_key is null
    )
    or (
      scope_type = 'path'
      and organization_id is null
      and repository_id is not null
      and project_id is null
      and btrim(path) <> ''
      and task_key is null
    )
    or (
      scope_type = 'task'
      and organization_id is null
      and repository_id is null
      and project_id is null
      and path is null
      and btrim(task_key) <> ''
    )
  ),
  constraint memory_scopes_owner_type_key
    unique (owner_id, scope_type, scope_key),
  constraint memory_scopes_owner_id_id_key
    unique (owner_id, id),
  constraint memory_scopes_owner_organization_fkey
    foreign key (owner_id, organization_id)
    references public.github_accounts (owner_id, id),
  constraint memory_scopes_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete cascade,
  constraint memory_scopes_owner_project_fkey
    foreign key (owner_id, project_id)
    references public.projects (owner_id, id)
    on delete cascade
);

create index memory_scopes_owner_organization_idx
  on public.memory_scopes (owner_id, organization_id)
  where organization_id is not null;

create index memory_scopes_owner_repository_idx
  on public.memory_scopes (owner_id, repository_id)
  where repository_id is not null;

create index memory_scopes_owner_project_idx
  on public.memory_scopes (owner_id, project_id)
  where project_id is not null;

create or replace function public.validate_memory_scope_target()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scope_type = 'organization' and not exists (
    select 1
    from public.github_accounts
    where owner_id = new.owner_id
      and id = new.organization_id
      and account_type = 'organization'
  ) then
    raise exception 'organization scope must reference a GitHub organization';
  end if;

  return new;
end;
$$;

create trigger memory_scopes_validate_target
before insert or update of owner_id, scope_type, organization_id
on public.memory_scopes
for each row
execute function public.validate_memory_scope_target();

create table public.sync_runs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  repository_id bigint not null,
  mode public.sync_mode not null,
  status public.sync_status not null default 'running',
  idempotency_key text,
  client_run_id text,
  overlap_started_at timestamptz,
  cursor_before jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor_before) = 'object'),
  cursor_after jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor_after) = 'object'),
  counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(counts) = 'object'),
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_runs_finished_after_started_check
    check (finished_at is null or finished_at >= started_at),
  constraint sync_runs_client_run_id_check
    check (client_run_id is null or btrim(client_run_id) <> ''),
  constraint sync_runs_status_finished_check check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  constraint sync_runs_owner_id_id_key
    unique (owner_id, id),
  constraint sync_runs_owner_repository_id_id_key
    unique (owner_id, repository_id, id),
  constraint sync_runs_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete cascade
);

create unique index sync_runs_owner_idempotency_key
  on public.sync_runs (owner_id, idempotency_key)
  where idempotency_key is not null;

create unique index sync_runs_one_active_per_repository_key
  on public.sync_runs (owner_id, repository_id)
  where status = 'running';

create index sync_runs_owner_repository_started_idx
  on public.sync_runs (owner_id, repository_id, started_at desc);

create table public.sync_checkpoints (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  repository_id bigint not null,
  stream text not null check (btrim(stream) <> ''),
  revision bigint not null default 1 check (revision > 0),
  cursor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor) = 'object'),
  last_successful_sync_run_id bigint,
  last_successful_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_checkpoints_owner_repository_stream_key
    unique (owner_id, repository_id, stream),
  constraint sync_checkpoints_owner_id_id_key
    unique (owner_id, id),
  constraint sync_checkpoints_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete cascade,
  constraint sync_checkpoints_owner_repository_run_fkey
    foreign key (
      owner_id,
      repository_id,
      last_successful_sync_run_id
    )
    references public.sync_runs (owner_id, repository_id, id)
);

create index sync_checkpoints_owner_last_run_idx
  on public.sync_checkpoints (
    owner_id,
    repository_id,
    last_successful_sync_run_id
  )
  where last_successful_sync_run_id is not null;

create table public.source_records (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  source_type public.source_type not null,
  repository_id bigint,
  external_id text not null check (btrim(external_id) <> ''),
  provider_id text,
  external_node_id text,
  parent_source_id bigint,
  source_uri text,
  current_snapshot_id bigint,
  last_seen_sync_run_id bigint,
  last_missing_sync_run_id bigint,
  lifecycle_status public.source_lifecycle_status not null default 'active',
  consecutive_complete_misses integer not null default 0
    check (consecutive_complete_misses >= 0),
  first_missing_at timestamptz,
  last_seen_at timestamptz not null default now(),
  external_created_at timestamptz,
  external_updated_at timestamptz,
  deleted_at timestamptz,
  tombstone jsonb
    check (tombstone is null or jsonb_typeof(tombstone) = 'object'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_records_github_repository_check check (
    source_type not in ('github_issue', 'github_comment')
    or repository_id is not null
  ),
  constraint source_records_comment_parent_check check (
    (source_type = 'github_comment') = (parent_source_id is not null)
  ),
  constraint source_records_sync_repository_check check (
    (last_seen_sync_run_id is null and last_missing_sync_run_id is null)
    or repository_id is not null
  ),
  constraint source_records_lifecycle_check check (
    (
      lifecycle_status = 'active'
      and consecutive_complete_misses = 0
      and first_missing_at is null
      and deleted_at is null
      and tombstone is null
    )
    or (
      lifecycle_status = 'missing_candidate'
      and consecutive_complete_misses >= 1
      and first_missing_at is not null
      and deleted_at is null
      and tombstone is null
    )
    or (
      lifecycle_status = 'deleted'
      and consecutive_complete_misses >= 2
      and first_missing_at is not null
      and deleted_at is not null
      and tombstone is not null
    )
  ),
  constraint source_records_external_time_check check (
    external_updated_at is null
    or external_created_at is null
    or external_updated_at >= external_created_at
  ),
  constraint source_records_owner_id_id_key
    unique (owner_id, id),
  constraint source_records_owner_repository_id_id_key
    unique (owner_id, repository_id, id),
  constraint source_records_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete cascade,
  constraint source_records_owner_repository_sync_run_fkey
    foreign key (owner_id, repository_id, last_seen_sync_run_id)
    references public.sync_runs (owner_id, repository_id, id),
  constraint source_records_owner_repository_missing_run_fkey
    foreign key (owner_id, repository_id, last_missing_sync_run_id)
    references public.sync_runs (owner_id, repository_id, id),
  constraint source_records_owner_repository_parent_fkey
    foreign key (owner_id, repository_id, parent_source_id)
    references public.source_records (owner_id, repository_id, id)
);

create unique index source_records_repository_identity_key
  on public.source_records (
    owner_id,
    repository_id,
    source_type,
    external_id
  )
  where repository_id is not null;

create unique index source_records_owner_identity_key
  on public.source_records (owner_id, source_type, external_id)
  where repository_id is null;

create unique index source_records_repository_provider_key
  on public.source_records (
    owner_id,
    repository_id,
    source_type,
    provider_id
  )
  where repository_id is not null
    and provider_id is not null;

create index source_records_owner_repository_updated_idx
  on public.source_records (
    owner_id,
    repository_id,
    source_type,
    external_updated_at desc
  )
  where repository_id is not null;

create index source_records_owner_sync_run_idx
  on public.source_records (
    owner_id,
    repository_id,
    last_seen_sync_run_id
  )
  where last_seen_sync_run_id is not null;

create index source_records_owner_missing_run_idx
  on public.source_records (
    owner_id,
    repository_id,
    last_missing_sync_run_id
  )
  where last_missing_sync_run_id is not null;

create index source_records_owner_parent_idx
  on public.source_records (owner_id, repository_id, parent_source_id)
  where parent_source_id is not null;

create index source_records_reconciliation_idx
  on public.source_records (
    owner_id,
    repository_id,
    lifecycle_status,
    consecutive_complete_misses
  )
  where repository_id is not null;

create index source_records_owner_current_snapshot_idx
  on public.source_records (owner_id, id, current_snapshot_id)
  where current_snapshot_id is not null;

create or replace function public.validate_source_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source_type <> 'github_comment' then
    return new;
  end if;

  if not exists (
    select 1
    from public.source_records
    where owner_id = new.owner_id
      and repository_id = new.repository_id
      and id = new.parent_source_id
      and source_type = 'github_issue'
  ) then
    raise exception 'GitHub comment parent must be an Issue in the same repository';
  end if;

  return new;
end;
$$;

create trigger source_records_validate_parent
before insert or update of owner_id, source_type, repository_id, parent_source_id
on public.source_records
for each row
execute function public.validate_source_parent();

create table public.source_snapshots (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  source_id bigint not null,
  hash_version text not null default 'v1'
    check (btrim(hash_version) <> ''),
  content_hash text not null
    check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  title text,
  content text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  external_created_at timestamptz,
  external_updated_at timestamptz,
  captured_at timestamptz not null default now(),
  constraint source_snapshots_external_time_check check (
    external_updated_at is null
    or external_created_at is null
    or external_updated_at >= external_created_at
  ),
  constraint source_snapshots_source_hash_key
    unique (source_id, hash_version, content_hash),
  constraint source_snapshots_owner_id_id_key
    unique (owner_id, id),
  constraint source_snapshots_owner_source_id_id_key
    unique (owner_id, source_id, id),
  constraint source_snapshots_owner_source_fkey
    foreign key (owner_id, source_id)
    references public.source_records (owner_id, id)
    on delete cascade
);

create index source_snapshots_source_captured_idx
  on public.source_snapshots (source_id, captured_at desc, id desc);

create index source_snapshots_search_trgm_idx
  on public.source_snapshots using gin (
    (lower(coalesce(title, '') || ' ' || coalesce(content, '')))
    extensions.gin_trgm_ops
  );

alter table public.source_records
  add constraint source_records_owner_current_snapshot_fkey
  foreign key (owner_id, id, current_snapshot_id)
  references public.source_snapshots (owner_id, source_id, id)
  deferrable initially deferred;

create table public.sync_run_items (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  sync_run_id bigint not null,
  source_type public.source_type not null,
  external_id text not null check (btrim(external_id) <> ''),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  request_hash text not null
    check (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  status public.sync_item_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  source_record_id bigint,
  source_snapshot_id bigint,
  error_code text,
  redacted_diagnostic jsonb not null default '{}'::jsonb
    check (jsonb_typeof(redacted_diagnostic) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_run_items_owner_run_key
    unique (owner_id, sync_run_id, idempotency_key),
  constraint sync_run_items_owner_id_id_key
    unique (owner_id, id),
  constraint sync_run_items_owner_run_fkey
    foreign key (owner_id, sync_run_id)
    references public.sync_runs (owner_id, id)
    on delete cascade,
  constraint sync_run_items_owner_source_fkey
    foreign key (owner_id, source_record_id)
    references public.source_records (owner_id, id),
  constraint sync_run_items_snapshot_requires_source_check
    check (source_snapshot_id is null or source_record_id is not null),
  constraint sync_run_items_owner_source_snapshot_fkey
    foreign key (owner_id, source_record_id, source_snapshot_id)
    references public.source_snapshots (owner_id, source_id, id)
);

create index sync_run_items_owner_run_status_idx
  on public.sync_run_items (
    owner_id,
    sync_run_id,
    status,
    created_at
  );

create index sync_run_items_owner_source_idx
  on public.sync_run_items (owner_id, source_record_id)
  where source_record_id is not null;

create index sync_run_items_owner_snapshot_idx
  on public.sync_run_items (owner_id, source_snapshot_id)
  where source_snapshot_id is not null;

create index sync_run_items_owner_source_snapshot_idx
  on public.sync_run_items (
    owner_id,
    source_record_id,
    source_snapshot_id
  )
  where source_snapshot_id is not null;

create table public.agent_runs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  session_id text not null check (btrim(session_id) <> ''),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  agent_name text not null check (btrim(agent_name) <> ''),
  repository_id bigint,
  project_id bigint,
  goal text not null check (btrim(goal) <> ''),
  status public.agent_run_status not null default 'running',
  result_summary text,
  changed_files text[] not null default '{}'::text[]
    check (array_position(changed_files, null) is null),
  commands_or_actions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(commands_or_actions) = 'array'),
  verification jsonb not null default '{}'::jsonb
    check (jsonb_typeof(verification) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_runs_finished_after_started_check
    check (finished_at is null or finished_at >= started_at),
  constraint agent_runs_status_finished_check check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  constraint agent_runs_project_requires_repository_check
    check (project_id is null or repository_id is not null),
  constraint agent_runs_owner_idempotency_key
    unique (owner_id, idempotency_key),
  constraint agent_runs_owner_id_id_key
    unique (owner_id, id),
  constraint agent_runs_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete set null (repository_id),
  constraint agent_runs_owner_repository_project_fkey
    foreign key (owner_id, repository_id, project_id)
    references public.projects (owner_id, repository_id, id)
    on delete set null (project_id)
);

create index agent_runs_owner_repository_started_idx
  on public.agent_runs (owner_id, repository_id, started_at desc)
  where repository_id is not null;

create index agent_runs_owner_repository_project_idx
  on public.agent_runs (owner_id, repository_id, project_id)
  where project_id is not null;

create index agent_runs_owner_session_idx
  on public.agent_runs (owner_id, session_id, started_at desc);

create table public.memories (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind public.memory_kind not null,
  statement text not null
    check (btrim(statement) <> '' and char_length(statement) <= 2000),
  rationale text
    check (rationale is null or char_length(rationale) <= 10000),
  scope_id bigint not null,
  status public.memory_status not null default 'proposed',
  revision bigint not null default 1 check (revision > 0),
  confidence numeric(4, 3) not null default 1.000
    check (confidence >= 0 and confidence <= 1),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  supersedes_id bigint,
  confirmed_at timestamptz,
  last_used_at timestamptz,
  use_count bigint not null default 0 check (use_count >= 0),
  tags text[] not null default '{}'::text[]
    check (
      array_position(tags, null) is null
      and cardinality(tags) <= 30
    ),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memories_valid_time_check
    check (valid_until is null or valid_until > valid_from),
  constraint memories_confirmation_time_check check (
    status in ('proposed', 'deleted')
    or confirmed_at is not null
  ),
  constraint memories_deleted_content_check check (
    status <> 'deleted'
    or (
      statement = '[deleted]'
      and rationale is null
      and cardinality(tags) = 0
      and details = '{}'::jsonb
    )
  ),
  constraint memories_no_self_supersession_check
    check (supersedes_id is null or supersedes_id <> id),
  constraint memories_owner_id_id_key
    unique (owner_id, id),
  constraint memories_owner_scope_fkey
    foreign key (owner_id, scope_id)
    references public.memory_scopes (owner_id, id),
  constraint memories_owner_supersedes_fkey
    foreign key (owner_id, supersedes_id)
    references public.memories (owner_id, id)
);

create unique index memories_single_successor_key
  on public.memories (owner_id, supersedes_id)
  where supersedes_id is not null;

create index memories_context_lookup_idx
  on public.memories (
    owner_id,
    scope_id,
    kind,
    last_used_at desc,
    updated_at desc
  )
  where status in ('confirmed', 'verified');

create index memories_inbox_idx
  on public.memories (owner_id, created_at desc)
  where status = 'proposed';

create index memories_tags_gin_idx
  on public.memories using gin (tags);

create index memories_search_trgm_idx
  on public.memories using gin (
    (lower(statement || ' ' || coalesce(rationale, '')))
    extensions.gin_trgm_ops
  );

create table public.memory_failure_details (
  memory_id bigint primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  resolution_status public.failure_resolution_status not null,
  symptom text not null check (btrim(symptom) <> ''),
  context text,
  attempted_approaches jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attempted_approaches) = 'array'),
  cause text,
  resolution text,
  verification text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_failure_details_owner_memory_key
    unique (owner_id, memory_id),
  constraint memory_failure_details_owner_memory_fkey
    foreign key (owner_id, memory_id)
    references public.memories (owner_id, id)
    on delete cascade
);

create table public.memory_evidence (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  memory_id bigint not null,
  source_snapshot_id bigint,
  agent_run_id bigint,
  source_excerpt text
    check (source_excerpt is null or char_length(source_excerpt) <= 2000),
  created_at timestamptz not null default now(),
  constraint memory_evidence_exactly_one_source_check check (
    (source_snapshot_id is not null)::integer
    + (agent_run_id is not null)::integer
    = 1
  ),
  constraint memory_evidence_owner_id_id_key
    unique (owner_id, id),
  constraint memory_evidence_owner_memory_fkey
    foreign key (owner_id, memory_id)
    references public.memories (owner_id, id)
    on delete cascade,
  constraint memory_evidence_owner_snapshot_fkey
    foreign key (owner_id, source_snapshot_id)
    references public.source_snapshots (owner_id, id)
    on delete cascade,
  constraint memory_evidence_owner_agent_run_fkey
    foreign key (owner_id, agent_run_id)
    references public.agent_runs (owner_id, id)
    on delete cascade
);

create unique index memory_evidence_snapshot_key
  on public.memory_evidence (memory_id, source_snapshot_id)
  where source_snapshot_id is not null;

create unique index memory_evidence_agent_run_key
  on public.memory_evidence (memory_id, agent_run_id)
  where agent_run_id is not null;

create index memory_evidence_owner_memory_idx
  on public.memory_evidence (owner_id, memory_id);

create index memory_evidence_owner_snapshot_idx
  on public.memory_evidence (owner_id, source_snapshot_id)
  where source_snapshot_id is not null;

create index memory_evidence_owner_agent_run_idx
  on public.memory_evidence (owner_id, agent_run_id)
  where agent_run_id is not null;

create table public.agent_run_memories (
  owner_id uuid not null references auth.users (id) on delete cascade,
  agent_run_id bigint not null,
  memory_id bigint not null,
  relation public.memory_run_relation not null,
  feedback public.memory_feedback,
  created_at timestamptz not null default now(),
  primary key (agent_run_id, memory_id, relation),
  constraint agent_run_memories_feedback_relation_check check (
    relation = 'used'
    or feedback is null
  ),
  constraint agent_run_memories_owner_run_fkey
    foreign key (owner_id, agent_run_id)
    references public.agent_runs (owner_id, id)
    on delete cascade,
  constraint agent_run_memories_owner_memory_fkey
    foreign key (owner_id, memory_id)
    references public.memories (owner_id, id)
    on delete cascade
);

create index agent_run_memories_owner_run_idx
  on public.agent_run_memories (owner_id, agent_run_id);

create index agent_run_memories_owner_memory_idx
  on public.agent_run_memories (owner_id, memory_id);

create table public.idempotency_records (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  actor_type public.audit_actor_type not null,
  actor_id text not null check (btrim(actor_id) <> ''),
  operation text not null check (btrim(operation) <> ''),
  idempotency_key text not null
    check (char_length(idempotency_key) between 16 and 200),
  request_hash text not null
    check (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  status public.idempotency_status not null default 'in_progress',
  response_status integer
    check (response_status is null or response_status between 100 and 599),
  response_body jsonb,
  resource_type text,
  resource_id text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idempotency_records_actor_operation_key
    unique (
      owner_id,
      actor_type,
      actor_id,
      operation,
      idempotency_key
    ),
  constraint idempotency_records_owner_id_id_key
    unique (owner_id, id),
  constraint idempotency_records_owner_actor_id_id_key
    unique (owner_id, actor_type, actor_id, id)
);

create index idempotency_records_expiry_idx
  on public.idempotency_records (expires_at)
  where expires_at is not null;

create table public.audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  request_id uuid not null default gen_random_uuid(),
  idempotency_record_id bigint,
  actor_type public.audit_actor_type not null,
  actor_id text,
  agent_name text,
  session_id text,
  repository_id bigint,
  tool_name text,
  operation public.audit_operation not null,
  target_type text,
  target_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(target_ids) = 'array'),
  redacted_input jsonb not null default '{}'::jsonb
    check (jsonb_typeof(redacted_input) = 'object'),
  success boolean not null,
  error_code text,
  error_message text,
  occurred_at timestamptz not null default now(),
  constraint audit_events_idempotency_actor_check
    check (idempotency_record_id is null or actor_id is not null),
  constraint audit_events_owner_id_id_key
    unique (owner_id, id),
  constraint audit_events_owner_actor_idempotency_fkey
    foreign key (
      owner_id,
      actor_type,
      actor_id,
      idempotency_record_id
    )
    references public.idempotency_records (
      owner_id,
      actor_type,
      actor_id,
      id
    ),
  constraint audit_events_owner_repository_fkey
    foreign key (owner_id, repository_id)
    references public.repositories (owner_id, id)
    on delete set null (repository_id)
);

create index audit_events_owner_occurred_idx
  on public.audit_events (owner_id, occurred_at desc, id desc);

create index audit_events_owner_request_idx
  on public.audit_events (owner_id, request_id);

create index audit_events_owner_idempotency_idx
  on public.audit_events (
    owner_id,
    actor_type,
    actor_id,
    idempotency_record_id
  )
  where idempotency_record_id is not null;

create index audit_events_owner_repository_idx
  on public.audit_events (owner_id, repository_id, occurred_at desc)
  where repository_id is not null;

create or replace function public.bump_memory_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision = old.revision + 1;
  return new;
end;
$$;

create trigger memories_bump_revision
before update of
  kind,
  statement,
  rationale,
  scope_id,
  status,
  confidence,
  valid_from,
  valid_until,
  supersedes_id,
  confirmed_at,
  tags,
  details
on public.memories
for each row
execute function public.bump_memory_revision();

create or replace function public.validate_memory_supersession()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  predecessor_kind public.memory_kind;
  predecessor_scope_id bigint;
begin
  if new.supersedes_id is null then
    return new;
  end if;

  select kind, scope_id
    into predecessor_kind, predecessor_scope_id
  from public.memories
  where owner_id = new.owner_id
    and id = new.supersedes_id;

  if predecessor_kind is null then
    return new;
  end if;

  if predecessor_kind <> new.kind then
    raise exception 'a memory may only supersede the same memory kind';
  end if;

  if predecessor_scope_id <> new.scope_id then
    raise exception 'a memory may only supersede within the same scope';
  end if;

  if exists (
    with recursive predecessor_chain as (
      select id, supersedes_id
      from public.memories
      where owner_id = new.owner_id
        and id = new.supersedes_id

      union all

      select memory.id, memory.supersedes_id
      from public.memories as memory
      join predecessor_chain as chain
        on memory.id = chain.supersedes_id
      where memory.owner_id = new.owner_id
    )
    select 1
    from predecessor_chain
    where id = new.id
  ) then
    raise exception 'memory supersession must not contain a cycle';
  end if;

  return new;
end;
$$;

create trigger memories_validate_supersession
before insert or update of owner_id, kind, scope_id, supersedes_id
on public.memories
for each row
execute function public.validate_memory_supersession();

create or replace function public.validate_supersession_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_owner_id uuid;
begin
  if tg_op = 'DELETE' then
    target_owner_id := old.owner_id;
  else
    target_owner_id := new.owner_id;
  end if;

  if exists (
    select 1
    from public.memories as predecessor
    where predecessor.owner_id = target_owner_id
      and predecessor.status = 'superseded'
      and not exists (
        select 1
        from public.memories as successor
        where successor.owner_id = predecessor.owner_id
          and successor.supersedes_id = predecessor.id
          and successor.confirmed_at is not null
      )
  ) then
    raise exception 'a superseded memory requires a confirmed successor';
  end if;

  if exists (
    select 1
    from public.memories as successor
    join public.memories as predecessor
      on predecessor.owner_id = successor.owner_id
      and predecessor.id = successor.supersedes_id
    where successor.owner_id = target_owner_id
      and successor.status in ('confirmed', 'verified')
      and predecessor.status <> 'superseded'
  ) then
    raise exception 'confirming a successor must supersede its predecessor';
  end if;

  return null;
end;
$$;

create constraint trigger memories_validate_supersession_consistency
after insert or update or delete
on public.memories
deferrable initially deferred
for each row
execute function public.validate_supersession_consistency();

create or replace function public.validate_failure_memory_detail()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_memory_id bigint;
  target_owner_id uuid;
  target_kind public.memory_kind;
  target_status public.memory_status;
  detail_exists boolean;
  detail_is_redacted boolean;
begin
  if tg_table_name = 'memories' then
    target_memory_id := new.id;
    target_owner_id := new.owner_id;
    target_kind := new.kind;
    target_status := new.status;
  elsif tg_op = 'DELETE' then
    target_memory_id := old.memory_id;
    target_owner_id := old.owner_id;

    select kind, status
      into target_kind, target_status
    from public.memories
    where owner_id = target_owner_id
      and id = target_memory_id;

    if target_kind is null then
      return null;
    end if;
  else
    target_memory_id := new.memory_id;
    target_owner_id := new.owner_id;

    select kind, status
      into target_kind, target_status
    from public.memories
    where owner_id = target_owner_id
      and id = target_memory_id;

    if target_kind is null then
      return null;
    end if;
  end if;

  select exists (
    select 1
    from public.memory_failure_details
    where owner_id = target_owner_id
      and memory_id = target_memory_id
  )
  into detail_exists;

  if target_kind = 'failure' and not detail_exists then
    raise exception 'failure memory % requires failure details', target_memory_id;
  end if;

  if target_kind <> 'failure' and detail_exists then
    raise exception 'only failure memories may have failure details';
  end if;

  if target_kind = 'failure' and target_status = 'deleted' then
    select exists (
      select 1
      from public.memory_failure_details
      where owner_id = target_owner_id
        and memory_id = target_memory_id
        and symptom = '[deleted]'
        and context is null
        and attempted_approaches = '[]'::jsonb
        and cause is null
        and resolution is null
        and verification is null
    )
    into detail_is_redacted;

    if not detail_is_redacted then
      raise exception 'deleted failure memory details must be redacted';
    end if;
  end if;

  return null;
end;
$$;

create constraint trigger memories_require_failure_detail
after insert or update of kind, status
on public.memories
deferrable initially deferred
for each row
execute function public.validate_failure_memory_detail();

create constraint trigger failure_details_validate_memory_kind
after insert or update or delete
on public.memory_failure_details
deferrable initially deferred
for each row
execute function public.validate_failure_memory_detail();

create or replace function public.protect_memory_evidence_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id
    or new.memory_id is distinct from old.memory_id
    or new.source_snapshot_id is distinct from old.source_snapshot_id
    or new.agent_run_id is distinct from old.agent_run_id
  then
    raise exception 'memory evidence links are immutable';
  end if;

  return new;
end;
$$;

create trigger memory_evidence_protect_identity
before update
on public.memory_evidence
for each row
execute function public.protect_memory_evidence_identity();

create or replace function public.validate_memory_has_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_memory_id bigint;
  target_owner_id uuid;
  target_status public.memory_status;
  evidence_exists boolean;
begin
  if tg_table_name = 'memories' then
    target_memory_id := new.id;
    target_owner_id := new.owner_id;
  elsif tg_op = 'DELETE' then
    target_memory_id := old.memory_id;
    target_owner_id := old.owner_id;
  else
    target_memory_id := new.memory_id;
    target_owner_id := new.owner_id;
  end if;

  select status
    into target_status
    from public.memories
    where owner_id = target_owner_id
      and id = target_memory_id;

  if target_status is null then
    return null;
  end if;

  select exists (
    select 1
    from public.memory_evidence
    where owner_id = target_owner_id
      and memory_id = target_memory_id
  )
  into evidence_exists;

  if target_status = 'deleted' and evidence_exists then
    raise exception 'deleted memory % must not retain evidence', target_memory_id;
  end if;

  if target_status <> 'deleted' and not evidence_exists then
    raise exception 'memory % requires at least one evidence record', target_memory_id;
  end if;

  return null;
end;
$$;

create constraint trigger memories_require_evidence
after insert or update of status
on public.memories
deferrable initially deferred
for each row
execute function public.validate_memory_has_evidence();

create constraint trigger memory_evidence_preserve_evidence
after insert or update or delete
on public.memory_evidence
deferrable initially deferred
for each row
execute function public.validate_memory_has_evidence();

create trigger github_accounts_set_updated_at
before update on public.github_accounts
for each row execute function public.set_updated_at();

create trigger repositories_set_updated_at
before update on public.repositories
for each row execute function public.set_updated_at();

create trigger repository_locations_set_updated_at
before update on public.repository_locations
for each row execute function public.set_updated_at();

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create trigger memory_scopes_set_updated_at
before update on public.memory_scopes
for each row execute function public.set_updated_at();

create trigger sync_runs_set_updated_at
before update on public.sync_runs
for each row execute function public.set_updated_at();

create or replace function public.bump_sync_checkpoint_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision = old.revision + 1;
  return new;
end;
$$;

create trigger sync_checkpoints_bump_revision
before update
on public.sync_checkpoints
for each row
execute function public.bump_sync_checkpoint_revision();

create trigger sync_checkpoints_set_updated_at
before update on public.sync_checkpoints
for each row execute function public.set_updated_at();

create trigger sync_run_items_set_updated_at
before update on public.sync_run_items
for each row execute function public.set_updated_at();

create trigger source_records_set_updated_at
before update on public.source_records
for each row execute function public.set_updated_at();

create trigger agent_runs_set_updated_at
before update on public.agent_runs
for each row execute function public.set_updated_at();

create trigger memories_set_updated_at
before update on public.memories
for each row execute function public.set_updated_at();

create trigger memory_failure_details_set_updated_at
before update on public.memory_failure_details
for each row execute function public.set_updated_at();

create trigger idempotency_records_set_updated_at
before update on public.idempotency_records
for each row execute function public.set_updated_at();

alter table public.github_accounts enable row level security;
alter table public.github_accounts force row level security;
alter table public.repositories enable row level security;
alter table public.repositories force row level security;
alter table public.repository_locations enable row level security;
alter table public.repository_locations force row level security;
alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.memory_scopes enable row level security;
alter table public.memory_scopes force row level security;
alter table public.sync_runs enable row level security;
alter table public.sync_runs force row level security;
alter table public.sync_checkpoints enable row level security;
alter table public.sync_checkpoints force row level security;
alter table public.sync_run_items enable row level security;
alter table public.sync_run_items force row level security;
alter table public.source_records enable row level security;
alter table public.source_records force row level security;
alter table public.source_snapshots enable row level security;
alter table public.source_snapshots force row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_runs force row level security;
alter table public.memories enable row level security;
alter table public.memories force row level security;
alter table public.memory_failure_details enable row level security;
alter table public.memory_failure_details force row level security;
alter table public.memory_evidence enable row level security;
alter table public.memory_evidence force row level security;
alter table public.agent_run_memories enable row level security;
alter table public.agent_run_memories force row level security;
alter table public.idempotency_records enable row level security;
alter table public.idempotency_records force row level security;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy github_accounts_owner_policy
on public.github_accounts
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy repositories_owner_policy
on public.repositories
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy repository_locations_owner_policy
on public.repository_locations
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy projects_owner_policy
on public.projects
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy memory_scopes_owner_policy
on public.memory_scopes
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy sync_runs_owner_policy
on public.sync_runs
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy sync_checkpoints_owner_policy
on public.sync_checkpoints
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy sync_run_items_owner_policy
on public.sync_run_items
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy source_records_owner_policy
on public.source_records
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy source_snapshots_owner_policy
on public.source_snapshots
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy agent_runs_owner_policy
on public.agent_runs
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy memories_owner_policy
on public.memories
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy memory_failure_details_owner_policy
on public.memory_failure_details
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy memory_evidence_owner_policy
on public.memory_evidence
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy agent_run_memories_owner_policy
on public.agent_run_memories
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy idempotency_records_owner_policy
on public.idempotency_records
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy audit_events_owner_policy
on public.audit_events
for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

revoke all on table
  public.github_accounts,
  public.repositories,
  public.repository_locations,
  public.projects,
  public.memory_scopes,
  public.sync_runs,
  public.sync_checkpoints,
  public.sync_run_items,
  public.source_records,
  public.source_snapshots,
  public.agent_runs,
  public.memories,
  public.memory_failure_details,
  public.memory_evidence,
  public.agent_run_memories,
  public.idempotency_records,
  public.audit_events
from anon, authenticated;

grant usage on schema extensions to authenticated;

grant select, insert, update, delete on table
  public.github_accounts,
  public.repositories,
  public.repository_locations,
  public.projects,
  public.memory_scopes,
  public.sync_runs,
  public.sync_checkpoints,
  public.sync_run_items,
  public.source_records,
  public.agent_runs,
  public.memories,
  public.memory_failure_details,
  public.memory_evidence,
  public.agent_run_memories,
  public.idempotency_records
to authenticated;

grant select, insert on table
  public.source_snapshots,
  public.audit_events
to authenticated;

grant usage, select on sequence
  public.github_accounts_id_seq,
  public.repositories_id_seq,
  public.repository_locations_id_seq,
  public.projects_id_seq,
  public.memory_scopes_id_seq,
  public.sync_runs_id_seq,
  public.sync_checkpoints_id_seq,
  public.sync_run_items_id_seq,
  public.source_records_id_seq,
  public.source_snapshots_id_seq,
  public.agent_runs_id_seq,
  public.memories_id_seq,
  public.memory_evidence_id_seq,
  public.idempotency_records_id_seq,
  public.audit_events_id_seq
to authenticated;

revoke all on function public.set_updated_at()
from public, anon, authenticated;

revoke all on function public.validate_memory_scope_target()
from public, anon, authenticated;

revoke all on function public.validate_source_parent()
from public, anon, authenticated;

revoke all on function public.bump_memory_revision()
from public, anon, authenticated;

revoke all on function public.bump_sync_checkpoint_revision()
from public, anon, authenticated;

revoke all on function public.validate_memory_supersession()
from public, anon, authenticated;

revoke all on function public.validate_supersession_consistency()
from public, anon, authenticated;

revoke all on function public.validate_failure_memory_detail()
from public, anon, authenticated;

revoke all on function public.protect_memory_evidence_identity()
from public, anon, authenticated;

revoke all on function public.validate_memory_has_evidence()
from public, anon, authenticated;

commit;
