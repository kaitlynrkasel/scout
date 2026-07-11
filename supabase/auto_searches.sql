-- Auto-search: recurring searches that run on a schedule and email the user a
-- digest of new finds with one-tap Approve / Not-a-fit links. Approvals flow
-- into their Scout pipeline (via admin_seeded_finds, same as concierge). Paste
-- into the Supabase SQL editor and run once. Idempotent.
--
-- Depends on supabase/concierge.sql (admin_seeded_finds) for the approve step.

create extension if not exists "pgcrypto";

create table if not exists auto_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,                 -- who to email (the user's own address)
  goal text not null,                  -- the search goal to run each time
  use_case text,
  about text,                          -- grounding snapshot (profile + company)
  label text,                          -- friendly name for the digest subject
  max_finds int not null default 5,    -- cap per run (cost control)
  cadence text not null default 'daily' check (cadence in ('daily','weekly')),
  email_digest boolean not null default true, -- also email the digest ("auto emails")
  active boolean not null default true,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

-- The finds a run produced, plus the user's emailed decision on each.
create table if not exists auto_finds (
  id uuid primary key default gen_random_uuid(),
  auto_search_id uuid references auto_searches(id) on delete cascade,
  user_id uuid not null,
  opp jsonb not null,
  status text not null default 'new' check (status in ('new','approved','denied','drafted')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- For installs that predate the email-digest toggle.
alter table auto_searches add column if not exists email_digest boolean not null default true;

create index if not exists idx_auto_searches_due
  on auto_searches (next_run_at)
  where active;

alter table auto_searches enable row level security;
alter table auto_finds enable row level security;

-- No anon policy: the app manages these through /api/auto-search and the cron /
-- action routes, all server-side with the service role + a verified token (the
-- magic-link approve/deny links are signed, not authenticated). Service role
-- bypasses RLS, so enabling it with no policy denies the anon client entirely.
