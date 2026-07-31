\set ON_ERROR_STOP on

begin;

insert into auth.users (id)
values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b');

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-00000000000a',
  true
);

insert into public.github_accounts (
  owner_id,
  github_account_id,
  login,
  account_type
)
values (
  '00000000-0000-0000-0000-00000000000a',
  1001,
  'tenant-a',
  'user'
);

insert into public.repositories (
  owner_id,
  github_repository_id,
  github_owner_id,
  full_name,
  html_url
)
select
  '00000000-0000-0000-0000-00000000000a',
  2001,
  id,
  'tenant-a/repository',
  'https://github.example/tenant-a/repository'
from public.github_accounts
where github_account_id = 1001;

insert into public.sync_runs (
  owner_id,
  repository_id,
  mode,
  idempotency_key
)
select
  '00000000-0000-0000-0000-00000000000a',
  id,
  'incremental',
  'sync-run-a-000001'
from public.repositories
where github_repository_id = 2001;

do $$
begin
  begin
    insert into public.sync_runs (
      owner_id,
      repository_id,
      mode,
      idempotency_key
    )
    select
      '00000000-0000-0000-0000-00000000000a',
      id,
      'manual',
      'sync-run-a-000002'
    from public.repositories
    where github_repository_id = 2001;

    raise exception 'concurrent sync run unexpectedly succeeded';
  exception
    when unique_violation then
      null;
  end;
end;
$$;

insert into public.sync_checkpoints (
  owner_id,
  repository_id,
  stream,
  cursor
)
select
  '00000000-0000-0000-0000-00000000000a',
  id,
  'issues',
  '{"successful_through":"2026-07-31T00:00:00Z"}'::jsonb
from public.repositories
where github_repository_id = 2001;

update public.sync_checkpoints
set cursor =
  '{"successful_through":"2026-07-31T06:00:00Z"}'::jsonb
where stream = 'issues';

do $$
begin
  if (
    select revision
    from public.sync_checkpoints
    where stream = 'issues'
  ) <> 2 then
    raise exception 'sync checkpoint update did not bump revision';
  end if;
end;
$$;

insert into public.memory_scopes (owner_id, scope_type)
values (
  '00000000-0000-0000-0000-00000000000a',
  'global'
);

insert into public.source_records (
  owner_id,
  source_type,
  repository_id,
  external_id,
  provider_id,
  external_node_id,
  source_uri
)
select
  '00000000-0000-0000-0000-00000000000a',
  'github_issue',
  id,
  '42',
  '4200',
  'I_test_a',
  'https://github.example/tenant-a/repository/issues/42'
from public.repositories
where github_repository_id = 2001;

insert into public.source_snapshots (
  owner_id,
  source_id,
  hash_version,
  content_hash,
  title,
  content
)
select
  '00000000-0000-0000-0000-00000000000a',
  id,
  'v1',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'Tenant A source',
  'Source body'
from public.source_records
where external_id = '42';

update public.source_records
set current_snapshot_id = (
  select snapshot.id
  from public.source_snapshots as snapshot
  where snapshot.source_id = source_records.id
)
where external_id = '42';

insert into public.source_records (
  owner_id,
  source_type,
  repository_id,
  external_id,
  provider_id,
  parent_source_id
)
select
  '00000000-0000-0000-0000-00000000000a',
  'github_comment',
  repository_id,
  '9001',
  '9001',
  id
from public.source_records
where source_type = 'github_issue'
  and external_id = '42';

do $$
begin
  begin
    insert into public.source_records (
      owner_id,
      source_type,
      repository_id,
      external_id,
      provider_id,
      parent_source_id
    )
    select
      '00000000-0000-0000-0000-00000000000a',
      'github_comment',
      repository_id,
      '9002',
      '9002',
      id
    from public.source_records
    where source_type = 'github_comment'
      and external_id = '9001';

    raise exception 'comment-to-comment parent unexpectedly succeeded';
  exception
    when raise_exception then
      if sqlerrm not like '%parent must be an Issue%' then
        raise;
      end if;
  end;
end;
$$;

do $$
begin
  begin
    update public.source_snapshots
    set title = 'Mutated title';

    raise exception 'immutable snapshot update unexpectedly succeeded';
  exception
    when insufficient_privilege then
      null;
  end;
end;
$$;

insert into public.idempotency_records (
  owner_id,
  actor_type,
  actor_id,
  operation,
  idempotency_key,
  request_hash
)
values (
  '00000000-0000-0000-0000-00000000000a',
  'mcp_agent',
  'agent-a',
  'POST /v1/memories/decisions',
  'mcp:session-a:call-0001',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);

do $$
begin
  begin
    insert into public.idempotency_records (
      owner_id,
      actor_type,
      actor_id,
      operation,
      idempotency_key,
      request_hash
    )
    values (
      '00000000-0000-0000-0000-00000000000a',
      'mcp_agent',
      'agent-a',
      'POST /v1/memories/decisions',
      'mcp:session-a:call-0001',
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    );

    raise exception 'idempotency key reuse unexpectedly succeeded';
  exception
    when unique_violation then
      null;
  end;
end;
$$;

insert into public.memories (
  owner_id,
  kind,
  statement,
  scope_id,
  status,
  confirmed_at
)
select
  '00000000-0000-0000-0000-00000000000a',
  'decision',
  'Use PostgreSQL.',
  id,
  'confirmed',
  now()
from public.memory_scopes
where scope_type = 'global';

insert into public.memory_evidence (
  owner_id,
  memory_id,
  source_snapshot_id,
  source_excerpt
)
select
  '00000000-0000-0000-0000-00000000000a',
  memory.id,
  snapshot.id,
  'Explicit decision'
from public.memories as memory
cross join public.source_snapshots as snapshot
where memory.statement = 'Use PostgreSQL.'
  and snapshot.content_hash =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

set constraints all immediate;
set constraints all deferred;

do $$
begin
  begin
    insert into public.source_snapshots (
      owner_id,
      source_id,
      hash_version,
      content_hash
    )
    select
      '00000000-0000-0000-0000-00000000000a',
      id,
      'v1',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    from public.source_records
    where external_id = '42';

    raise exception 'duplicate snapshot unexpectedly succeeded';
  exception
    when unique_violation then
      null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.memories (
      owner_id,
      kind,
      statement,
      scope_id
    )
    select
      '00000000-0000-0000-0000-00000000000a',
      'learning',
      'This memory has no evidence.',
      id
    from public.memory_scopes
    where scope_type = 'global';

    set constraints all immediate;
    raise exception 'memory without evidence unexpectedly succeeded';
  exception
    when raise_exception then
      if sqlerrm not like '%requires at least one evidence%' then
        raise;
      end if;
  end;

  set constraints all deferred;
end;
$$;

insert into public.memories (
  owner_id,
  kind,
  statement,
  scope_id,
  status,
  confirmed_at
)
select
  '00000000-0000-0000-0000-00000000000a',
  'failure',
  'A verified failure.',
  id,
  'verified',
  now()
from public.memory_scopes
where scope_type = 'global';

insert into public.memory_failure_details (
  memory_id,
  owner_id,
  resolution_status,
  symptom,
  resolution,
  verification
)
select
  id,
  owner_id,
  'verified',
  'Synthetic symptom',
  'Synthetic resolution',
  'Synthetic test passed'
from public.memories
where statement = 'A verified failure.';

insert into public.memory_evidence (
  owner_id,
  memory_id,
  source_snapshot_id
)
select
  '00000000-0000-0000-0000-00000000000a',
  memory.id,
  snapshot.id
from public.memories as memory
cross join public.source_snapshots as snapshot
where memory.statement = 'A verified failure.'
  and snapshot.content_hash =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

set constraints all immediate;
set constraints all deferred;

insert into public.memories (
  owner_id,
  kind,
  statement,
  scope_id,
  status,
  supersedes_id
)
select
  old.owner_id,
  old.kind,
  'Use PostgreSQL 17.',
  old.scope_id,
  'proposed',
  old.id
from public.memories as old
where old.statement = 'Use PostgreSQL.';

insert into public.memory_evidence (
  owner_id,
  memory_id,
  source_snapshot_id
)
select
  '00000000-0000-0000-0000-00000000000a',
  memory.id,
  snapshot.id
from public.memories as memory
cross join public.source_snapshots as snapshot
where memory.statement = 'Use PostgreSQL 17.'
  and snapshot.content_hash =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

set constraints all immediate;

do $$
begin
  if (
    select status
    from public.memories
    where statement = 'Use PostgreSQL.'
  ) <> 'confirmed' then
    raise exception 'proposed replacement deactivated confirmed memory';
  end if;

  if (
    select revision
    from public.memories
    where statement = 'Use PostgreSQL.'
  ) <> 1 then
    raise exception 'unexpected initial memory revision';
  end if;
end;
$$;

set constraints all deferred;

update public.memories
set status = 'superseded'
where statement = 'Use PostgreSQL.';

update public.memories
set
  status = 'confirmed',
  confirmed_at = now()
where statement = 'Use PostgreSQL 17.';

set constraints all immediate;

do $$
begin
  if (
    select revision
    from public.memories
    where statement = 'Use PostgreSQL.'
  ) <> 2 then
    raise exception 'semantic memory update did not bump revision';
  end if;
end;
$$;

set constraints all deferred;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-00000000000b',
  true
);

do $$
begin
  if exists (select 1 from public.repositories) then
    raise exception 'tenant B can see tenant A repository';
  end if;
end;
$$;

insert into public.github_accounts (
  owner_id,
  github_account_id,
  login,
  account_type
)
values (
  '00000000-0000-0000-0000-00000000000b',
  1002,
  'tenant-b',
  'user'
);

insert into public.repositories (
  owner_id,
  github_repository_id,
  github_owner_id,
  full_name,
  html_url
)
select
  '00000000-0000-0000-0000-00000000000b',
  2002,
  id,
  'tenant-b/repository',
  'https://github.example/tenant-b/repository'
from public.github_accounts
where github_account_id = 1002;

insert into public.source_records (
  owner_id,
  source_type,
  repository_id,
  external_id
)
select
  '00000000-0000-0000-0000-00000000000b',
  'github_issue',
  id,
  '42'
from public.repositories
where github_repository_id = 2002;

insert into public.source_snapshots (
  owner_id,
  source_id,
  content_hash
)
select
  '00000000-0000-0000-0000-00000000000b',
  id,
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
from public.source_records
where external_id = '42';

reset role;

do $$
begin
  begin
    insert into public.memory_evidence (
      owner_id,
      memory_id,
      source_snapshot_id
    )
    select
      '00000000-0000-0000-0000-00000000000a',
      memory.id,
      snapshot.id
    from public.memories as memory
    cross join public.source_snapshots as snapshot
    where memory.owner_id = '00000000-0000-0000-0000-00000000000a'
      and memory.statement = 'Use PostgreSQL 17.'
      and snapshot.owner_id =
        '00000000-0000-0000-0000-00000000000b';

    raise exception 'cross-tenant evidence unexpectedly succeeded';
  exception
    when foreign_key_violation then
      null;
  end;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-00000000000a',
  true
);

delete from public.memory_evidence
where memory_id = (
  select id
  from public.memories
  where statement = 'Use PostgreSQL 17.'
);

update public.memories
set
  status = 'deleted',
  statement = '[deleted]',
  rationale = null,
  tags = '{}'::text[],
  details = '{}'::jsonb
where statement = 'Use PostgreSQL 17.';

set constraints all immediate;

do $$
begin
  if exists (
    select 1
    from public.memories as memory
    join public.memory_evidence as evidence
      on evidence.memory_id = memory.id
    where memory.status = 'deleted'
  ) then
    raise exception 'deleted memory retained evidence';
  end if;
end;
$$;

reset role;

do $$
declare
  missing_index record;
begin
  select
    constraint_record.conrelid::regclass as table_name,
    constraint_record.conname
  into missing_index
  from pg_constraint as constraint_record
  where constraint_record.contype = 'f'
    and constraint_record.connamespace = 'public'::regnamespace
    and not exists (
      select 1
      from pg_index as index_record
      where index_record.indrelid = constraint_record.conrelid
        and index_record.indisvalid
        and index_record.indnkeyatts >=
          cardinality(constraint_record.conkey)
        and not exists (
          select 1
          from generate_subscripts(
            constraint_record.conkey,
            1
          ) as position
          where constraint_record.conkey[position] <>
            index_record.indkey[position - 1]
        )
    )
  limit 1;

  if found then
    raise exception 'foreign key % on % has no child-side index',
      missing_index.conname,
      missing_index.table_name;
  end if;
end;
$$;

rollback;
