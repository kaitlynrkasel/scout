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
