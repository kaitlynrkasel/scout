-- Search history: what each user asked Scout for, kept ONLY to make their
-- future searches better and to anticipate what they need next. Never sold,
-- never shared for advertising; that promise is in the privacy policy.
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.search_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  goal text not null,
  use_case text default '',
  project_name text default '',
  category_name text default '',
  created_at timestamptz not null default now()
);

create index if not exists search_history_user_time
  on public.search_history (user_id, created_at desc);

grant all privileges on public.search_history to service_role;

-- RLS on with no client policies: only the server touches this table.
alter table public.search_history enable row level security;
