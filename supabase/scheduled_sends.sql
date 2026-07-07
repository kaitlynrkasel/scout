-- One-time Supabase migration for scheduled outreach.
-- Paste into Supabase SQL editor and run once. Idempotent.

create extension if not exists "pgcrypto";

create table if not exists scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail','outlook')),
  find_id text,                                   -- Scout Find id, so we can mark the find sent
  opportunity_id text,                            -- for logging + dedup
  to_addr text not null,
  subject text not null,
  body text not null,
  attachment jsonb,                               -- { name, mime, dataUrl } for resume attach
  send_at timestamptz not null,                   -- when the cron should fire it
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  attempts int not null default 0,
  last_error text,
  sent_at timestamptz,                            -- when it actually went out
  is_followup boolean not null default false,     -- an auto follow-up (reply-guarded)
  thread_id text,                                 -- thread to reply-check before a follow-up fires
  created_at timestamptz not null default now()
);

-- For existing installs that predate the follow-up columns.
alter table scheduled_sends add column if not exists is_followup boolean not null default false;
alter table scheduled_sends add column if not exists thread_id text;

-- Fast lookup for "what's due right now" — index only pending rows.
create index if not exists idx_scheduled_sends_due
  on scheduled_sends (send_at)
  where status = 'pending';

alter table scheduled_sends enable row level security;

-- Users can see + cancel their own queued messages via the anon client.
drop policy if exists "own scheduled sends" on scheduled_sends;
create policy "own scheduled sends" on scheduled_sends
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Service role (cron) bypasses RLS by default; no extra policy needed.
