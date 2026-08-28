-- Personal use inside a company account: the workspace decides whether its
-- members may run a Personal lens (their own projects and searches, outside
-- the company), which sits on the higher company tier. Default off. Run once
-- in the Supabase SQL editor; safe to re-run.

alter table public.workspaces
  add column if not exists allow_personal boolean not null default false;
