-- Custom per-company role permissions for the "What each role can do" table.
-- Null means the built-in defaults; a jsonb object overrides per capability,
-- e.g. {"invite": {"editor": true}}. Owners always can do everything.
alter table public.workspaces
  add column if not exists permissions jsonb;
