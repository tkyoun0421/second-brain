begin;

create or replace function public.redact_memory_audit_payloads(target_memory_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  redacted_count integer;
begin
  update public.audit_events
     set redacted_input = '{}'::jsonb
   where owner_id = (select auth.uid())
     and target_ids @> jsonb_build_array(target_memory_id::text);

  get diagnostics redacted_count = row_count;
  return redacted_count;
end;
$$;

revoke all on function public.redact_memory_audit_payloads(bigint) from public;
grant execute on function public.redact_memory_audit_payloads(bigint) to authenticated;

commit;
