-- Generic admin key-value store (first user: the editable algorithm metrics
-- on Admin > Metrics). Server-only access; owners read and write through
-- owner-gated API routes. Run once in the Supabase SQL editor; safe to re-run.

create table if not exists public.admin_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

grant all privileges on public.admin_config to service_role;

-- RLS on with no client policies: only the server touches this table.
alter table public.admin_config enable row level security;
