-- =====================================================================
-- Scout: the three tables still missing from the live database, found by
-- the automated readiness check on 2026-08-20.
-- Paste the WHOLE file into the Supabase SQL editor and run it once.
-- Every statement is idempotent; running it twice is harmless.
--   guest_searches    -> durable guest trial metering (cost cap)
--   auto_tune_log     -> the self-tuning audit trail
--   admin_seeded_finds-> concierge hand-picked finds
-- =====================================================================

-- Anonymous trial metering. Counts how many searches each IP has run per day so
-- guests (no account) can try Scout a few times before being asked to sign up,
-- without opening an unbounded cost hole on anonymous traffic. Paste into the
-- Supabase SQL editor and run once. Idempotent.

create table if not exists guest_searches (
  ip text not null,
  day date not null,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip, day)
);

-- Housekeeping: this table only needs "today", old rows can be pruned anytime
-- with: delete from guest_searches where day < current_date - 7;

alter table guest_searches enable row level security;

-- No anon policy on purpose: only the discover API route (service role) reads
-- or writes this. Service role bypasses RLS, so enabling it with no policy
-- simply denies the anon client entirely.

-- One-time Supabase migration for the auto-tune audit log.
-- Paste into the Supabase SQL editor and run once. Idempotent.
--
-- Kept as its own table (not folded into user_state's JSON blob) on purpose:
-- the client's own autosave upserts REPLACE the whole user_state.data column,
-- and the client has no notion of this field, so anything the cron job wrote
-- there would get silently wiped on the next save. Written by the server
-- (service-role key) from /api/cron/auto-tune; the user's own session may only
-- READ their own rows, to render the change log in the app.

create table if not exists auto_tune_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  slot text not null,           -- which TUNABLE_*_CLAUSE constant was edited
  label text not null,          -- human-readable description of the slot
  old_clause text not null,     -- the clause's value before this edit
  new_clause text not null,     -- the clause's value after this edit
  commit_url text,              -- link to the GitHub commit that shipped it
  signal jsonb not null         -- the TuningSignal that triggered this edit
);

create index if not exists auto_tune_log_user_id_idx
  on auto_tune_log (user_id, created_at desc);

alter table auto_tune_log enable row level security;

create policy "Users can read their own auto-tune log"
  on auto_tune_log for select
  using (auth.uid() = user_id);

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
