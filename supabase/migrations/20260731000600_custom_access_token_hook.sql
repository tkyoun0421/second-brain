begin;

-- JWT 권한은 Auth 사용자별로 분리한다. private schema는 PostgREST에 노출되지 않으며,
-- Supabase Auth hook에 필요한 최소 읽기 권한만 부여한다.
create schema if not exists private;
revoke all on schema private from public;

create table private.auth_principal_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  principal_type text not null check (
    principal_type in ('github_sync', 'mcp_agent', 'operator', 'user')
  ),
  permissions text[] not null default '{}'::text[] check (
    permissions <@ array[
      'github_source:write',
      'github_sync:checkpoint',
      'github_quarantine:retry',
      'context:read',
      'memory:read',
      'memory:propose',
      'memory:confirm',
      'memory:supersede',
      'memory:forget',
      'memory:forget_sensitive',
      'agent_run:write',
      'operations:credential_revoke'
    ]::text[]
  ),
  repository_ids text[] not null default '{}'::text[] check (
    array_position(repository_ids, '') is null
  ),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger auth_principal_claims_set_updated_at
before update on private.auth_principal_claims
for each row
execute function public.set_updated_at();

alter table private.auth_principal_claims enable row level security;
alter table private.auth_principal_claims force row level security;

create policy auth_principal_claims_auth_hook_read
on private.auth_principal_claims
for select
to supabase_auth_admin
using (true);

grant usage on schema private to supabase_auth_admin;
grant select on private.auth_principal_claims to supabase_auth_admin;

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  original_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  principal_claims jsonb;
begin
  select jsonb_build_object(
    'principal_type', claims.principal_type,
    'permissions', to_jsonb(claims.permissions),
    'repository_ids', to_jsonb(claims.repository_ids)
  )
  into principal_claims
  from private.auth_principal_claims as claims
  where claims.user_id = (event->>'user_id')::uuid
    and claims.is_active;

  -- An unprovisioned or disabled user may still authenticate with Supabase,
  -- but cannot call this API because the verifier requires these claims.
  if principal_claims is null then
    return jsonb_build_object('claims', original_claims);
  end if;

  return jsonb_build_object('claims', original_claims || principal_claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke all on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;

commit;
