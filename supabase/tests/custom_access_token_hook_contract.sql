\set ON_ERROR_STOP on

begin;

insert into auth.users (id)
values
  ('00000000-0000-0000-0000-00000000000c'),
  ('00000000-0000-0000-0000-00000000000d');

insert into private.auth_principal_claims (
  user_id,
  tenant_user_id,
  principal_type,
  permissions,
  repository_ids
)
values (
  '00000000-0000-0000-0000-00000000000c',
  '00000000-0000-0000-0000-00000000000d',
  'github_sync',
  array['github_source:write', 'github_sync:checkpoint'],
  array['R_kgDOExample']
);

set local role supabase_auth_admin;

do $$
declare
  result jsonb;
begin
  select public.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-00000000000c',
    'claims', jsonb_build_object('sub', '00000000-0000-0000-0000-00000000000c')
  ))
  into result;

  if result->'claims'->>'principal_type' <> 'github_sync'
    or result->'claims'->>'user_id' <> '00000000-0000-0000-0000-00000000000d'
    or result->'claims'->'permissions' <> '["github_source:write", "github_sync:checkpoint"]'::jsonb
    or result->'claims'->'repository_ids' <> '["R_kgDOExample"]'::jsonb then
    raise exception 'custom access token claims were not added';
  end if;
end;
$$;

reset role;

do $$
begin
  perform public.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-00000000000c',
    'claims', '{}'::jsonb
  ));
  raise exception 'untrusted role unexpectedly executed custom access token hook';
exception
  when insufficient_privilege then
    null;
end;
$$;

rollback;
