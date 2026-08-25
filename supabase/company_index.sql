-- Company index: a long, growing list of employers Scout has seen, so job
-- and internship searches can go straight at company careers pages instead
-- of gated job boards. Grows automatically from engine results (public-web
-- only, same privacy class as people_index: organizations, never private
-- individuals). Run once in the Supabase SQL editor; safe to re-run.

create table if not exists public.company_index (
  id uuid primary key default gen_random_uuid(),
  -- Normalized company name (lowercase, alphanumeric).
  key text unique not null,
  name text not null,
  -- The company's own site host (their careers pages live under it).
  host text not null default '',
  -- Accumulated descriptor words from the goals that surfaced them, so
  -- "indie label" searches pull indie labels, not restaurants.
  industries text not null default '',
  seen_count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  search_tsv tsvector generated always as (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(industries, '') || ' ' || coalesce(host, '')
    )
  ) stored
);

create index if not exists company_index_tsv on public.company_index using gin (search_tsv);
create index if not exists company_index_last_seen on public.company_index (last_seen_at desc);

grant all privileges on public.company_index to service_role;

-- RLS on with no client policies: only the server touches this table.
alter table public.company_index enable row level security;
