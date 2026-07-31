begin;

alter table public.memories
  add column importance_score smallint,
  add column importance_reasons text[] not null default '{}'::text[],
  add column capture_trigger text,
  add column auto_capture_key text;

alter table public.memories
  add constraint memories_importance_score_check
    check (importance_score is null or importance_score between 4 and 10),
  add constraint memories_importance_reasons_check
    check (array_position(importance_reasons, null) is null),
  add constraint memories_capture_trigger_check
    check (capture_trigger is null or capture_trigger in (
      'agent_checkpoint',
      'user_choice',
      'error_resolution'
    )),
  add constraint memories_auto_capture_key_check
    check (auto_capture_key is null or auto_capture_key ~ '^auto:importance-v1:sha256:[0-9a-f]{64}$'),
  add constraint memories_auto_capture_metadata_check
    check (
      (
        auto_capture_key is null
        and capture_trigger is null
        and importance_score is null
        and cardinality(importance_reasons) = 0
      )
      or (
        auto_capture_key is not null
        and capture_trigger is not null
        and importance_score is not null
        and cardinality(importance_reasons) > 0
      )
    );

create unique index memories_auto_capture_owner_key
  on public.memories (owner_id, auto_capture_key)
  where auto_capture_key is not null;

drop index public.memories_inbox_idx;

create index memories_inbox_idx
  on public.memories (
    owner_id,
    (coalesce(importance_score, -1)) desc,
    created_at desc,
    id desc
  )
  where status = 'proposed';

commit;
