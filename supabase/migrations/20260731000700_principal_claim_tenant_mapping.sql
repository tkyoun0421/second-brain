begin;

-- A technical principal (for example GitHub Actions) can have its own Auth
-- identity while operating on the owning user's tenant data.
alter table private.auth_principal_claims
  add column tenant_user_id uuid references auth.users (id);

alter table private.auth_principal_claims
  alter column tenant_user_id set not null;

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
    'user_id', claims.tenant_user_id,
    'principal_type', claims.principal_type,
    'permissions', to_jsonb(claims.permissions),
    'repository_ids', to_jsonb(claims.repository_ids)
  )
  into principal_claims
  from private.auth_principal_claims as claims
  where claims.user_id = (event->>'user_id')::uuid
    and claims.is_active;

  if principal_claims is null then
    return jsonb_build_object('claims', original_claims);
  end if;

  return jsonb_build_object('claims', original_claims || principal_claims);
end;
$$;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke all on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;

commit;
