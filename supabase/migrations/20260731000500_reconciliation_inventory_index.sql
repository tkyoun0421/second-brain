-- Supports owner-scoped reconcile updates without scanning unrelated source records.
create index source_records_reconcile_active_idx
  on public.source_records (owner_id, repository_id, lifecycle_status, source_type)
  where repository_id is not null
    and lifecycle_status in ('active', 'missing_candidate')
    and source_type in ('github_issue', 'github_comment');
