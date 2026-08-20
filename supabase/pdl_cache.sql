-- Roster-query cache for the licensed people directory. A directory lookup
-- costs real credits, and the same roster (a school, an employer, a title) gets
-- asked for by many users over time, so every query is stored and reused.
-- Idempotent: safe to paste again.

create table if not exists pdl_roster_cache (
  filter_key text primary key,     -- hash of the normalized filter set
  filters jsonb not null,          -- what was asked, for debugging + the admin view
  people jsonb not null,           -- the directory's answer
  total int not null default 0,    -- how many the directory says match overall
  hits int not null default 1,     -- how many times this cache row was reused
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists pdl_roster_cache_used on pdl_roster_cache (last_used_at desc);

alter table pdl_roster_cache enable row level security;
-- Server-only (service role): the engine reads and writes this, users never do.
