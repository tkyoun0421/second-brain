-- Minimal Supabase-compatible objects for validating the schema on plain PostgreSQL.
-- Production Supabase projects already provide these roles, schema, table and function.

do $$
begin
  create role anon nologin;
exception
  when duplicate_object then
    null;
end;
$$;

do $$
begin
  create role authenticated nologin;
exception
  when duplicate_object then
    null;
end;
$$;

do $$
begin
  create role service_role nologin bypassrls;
exception
  when duplicate_object then
    null;
end;
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
