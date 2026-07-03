-- Scout anti-overexposure: a shared, aggregate ledger of which contacts have been
-- reached, so the same person doesn't get blasted by many users at once.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- One row per (contact, user) the first time that user drafts/contacts the target.
-- Discovery counts distinct users per target within a recent window and, once a
-- target passes a cap, stops surfacing it to NEW users (a hard cap).
--
-- Privacy: this is internal, aggregate-only. RLS is enabled with NO client
-- policies, so browsers can never read it; only the server (service role) touches
-- it. It stores a normalized contact key + which user reached them, never message
-- content.

create table if not exists public.target_contacts (
  target_key text not null,       -- normalized: email:..., site:host|name, or name:...
  user_id uuid not null,
  contacted_at timestamptz not null default now(),
  label text,                     -- human-readable name/outlet, for debugging only
  primary key (target_key, user_id)
);

create index if not exists target_contacts_key_time_idx
  on public.target_contacts (target_key, contacted_at);

-- Grants: the server routes use the service role for this table.
grant usage on schema public to service_role;
grant all privileges on public.target_contacts to service_role;

-- RLS on, no policies => only the service role (which bypasses RLS) can read or
-- write it. Clients get nothing, which is what we want for an internal ledger.
alter table public.target_contacts enable row level security;
