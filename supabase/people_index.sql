-- Shared people index: every engine-found person accumulates here so searches
-- get faster, cheaper, and better-informed over time. PUBLIC-WEB RESULTS ONLY,
-- manual and imported contacts are users' private data and never enter this
-- table. Diversity guards live in code (per-search cap, freshness window,
-- salted rotation, exposure suppression), so the index informs results without
-- homogenizing them. Idempotent: safe to paste again.

create table if not exists people_index (
  id uuid primary key default gen_random_uuid(),
  -- Normalized identity: email wins, else handle, else name + site host.
  key text unique not null,
  -- Latest merged Opportunity-shaped record (name, role, outlet, contacts...).
  opp jsonb not null,
  -- Accumulated evidence links from every sighting.
  sources jsonb not null default '[]'::jsonb,
  -- How many separate searches surfaced this person (confidence, NOT ranking).
  seen_count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Full-text retrieval over the person's descriptive fields. Generated, so it
  -- can never drift from the record.
  search_tsv tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(opp->>'name', '') || ' ' ||
      coalesce(opp->>'contactRole', '') || ' ' ||
      coalesce(opp->>'outlet', '') || ' ' ||
      coalesce(opp->>'location', '') || ' ' ||
      coalesce(opp->>'channel', '') || ' ' ||
      coalesce(opp->>'whyItFits', '')
    )
  ) stored
);

create index if not exists people_index_tsv on people_index using gin (search_tsv);
create index if not exists people_index_last_seen on people_index (last_seen_at desc);

alter table people_index enable row level security;
-- No anon/user policies on purpose: only the server (service role) reads and
-- writes this table, through the discovery engine and the owner admin view.
