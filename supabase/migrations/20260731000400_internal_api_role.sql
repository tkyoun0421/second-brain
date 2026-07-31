begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api nologin inherit;
  end if;
end;
$$;

grant authenticated to app_api;

revoke all on function public.redact_memory_audit_payloads(bigint) from authenticated;
revoke all on function public.redact_memory_forget_sources(bigint) from authenticated;
grant execute on function public.redact_memory_audit_payloads(bigint) to app_api;
grant execute on function public.redact_memory_forget_sources(bigint) to app_api;

commit;
