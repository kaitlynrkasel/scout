-- Concierge / white-glove find seeding.
-- Lets an owner hand-pick opportunities for a specific account (or an email
-- that hasn't signed up yet) from the Admin page. The rows sit here keyed by
-- email until that user's client pulls them in — on next load and after their
-- next search — via /api/seeded-finds, which verifies the caller's email from
-- their JWT server-side. Paste into the Supabase SQL editor and run once.
-- Idempotent.

create extension if not exists "pgcrypto";

create table if not exists admin_seeded_finds (
  id uuid primary key default gen_random_uuid(),
  email text not null,                 -- target user's email (lowercased)
  opp jsonb not null,                  -- the Opportunity payload to inject
  note text,                           -- operator note (why recommended)
  created_by text,                     -- operator email (who seeded it)
  created_at timestamptz not null default now(),
  consumed_at timestamptz              -- set when the user's client merges it in
);

-- For existing installs that predate any column here.
alter table admin_seeded_finds add column if not exists note text;
alter table admin_seeded_finds add column if not exists created_by text;
alter table admin_seeded_finds add column if not exists consumed_at timestamptz;

-- Fast lookup for "what's pending for this email" — index only un-consumed rows.
create index if not exists idx_admin_seeded_email
  on admin_seeded_finds (lower(email))
  where consumed_at is null;

alter table admin_seeded_finds enable row level security;

-- No anon/authenticated policy on purpose: only the service role touches this
-- table. Owners write it through /api/admin/seed; users read + consume it
-- through /api/seeded-finds, both of which run server-side with the service
-- role and check identity from the verified access token. Service role bypasses
-- RLS, so enabling it with no policy simply denies the anon client entirely.
