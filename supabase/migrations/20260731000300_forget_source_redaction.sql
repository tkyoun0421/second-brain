begin;

create or replace function public.redact_memory_forget_sources(target_memory_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  redacted_count integer;
begin
  if exists (
    with target_sources as (
      select distinct ss.source_id
        from public.memory_evidence me
        join public.source_snapshots ss on ss.owner_id = me.owner_id and ss.id = me.source_snapshot_id
       where me.owner_id = (select auth.uid()) and me.memory_id = target_memory_id
    )
    select 1
      from public.memory_evidence me
      join public.source_snapshots ss on ss.owner_id = me.owner_id and ss.id = me.source_snapshot_id
      join public.memories m on m.owner_id = me.owner_id and m.id = me.memory_id
      join target_sources ts on ts.source_id = ss.source_id
     where me.owner_id = (select auth.uid())
       and me.memory_id <> target_memory_id
       and m.status in ('proposed', 'confirmed', 'verified')
  ) then
    raise exception 'linked source is used by another active memory';
  end if;

  update public.source_snapshots
     set hash_version = 'redacted-v1', content_hash = 'sha256:' || lpad(to_hex(id), 64, '0'),
         title = null, content = null, payload = '{}'::jsonb
   where owner_id = (select auth.uid())
     and source_id in (
       select ss.source_id
         from public.memory_evidence me
         join public.source_snapshots ss on ss.owner_id = me.owner_id and ss.id = me.source_snapshot_id
        where me.owner_id = (select auth.uid()) and me.memory_id = target_memory_id
     );

  update public.source_records
     set lifecycle_status = 'deleted', consecutive_complete_misses = greatest(consecutive_complete_misses, 2),
         first_missing_at = coalesce(first_missing_at, now()), deleted_at = now(),
         tombstone = jsonb_build_object('reason', 'memory_forget', 'redacted_at', now()),
         source_uri = null, current_snapshot_id = null, metadata = '{}'::jsonb
   where owner_id = (select auth.uid())
     and id in (
       select ss.source_id
         from public.memory_evidence me
         join public.source_snapshots ss on ss.owner_id = me.owner_id and ss.id = me.source_snapshot_id
        where me.owner_id = (select auth.uid()) and me.memory_id = target_memory_id
     );

  get diagnostics redacted_count = row_count;
  return redacted_count;
end;
$$;

revoke all on function public.redact_memory_forget_sources(bigint) from public;
grant execute on function public.redact_memory_forget_sources(bigint) to authenticated;

commit;
