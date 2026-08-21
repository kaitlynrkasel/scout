-- One-time Supabase migration for Web Push subscriptions.
-- Paste into Supabase SQL editor and run once. Idempotent.

create extension if not exists "pgcrypto";

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The push service's URL for this specific install. Unique per browser +
  -- device, so one account legitimately has several: laptop, phone, tablet.
  endpoint text not null,
  -- The keys the push service needs to encrypt a payload for this subscriber.
  p256dh text not null,
  auth text not null,
  -- Free text from the browser, only to tell one device from another in a list.
  label text,
  -- Set when a push service tells us the subscription is dead (404/410), so a
  -- stale row stops being retried without disappearing silently.
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- Re-subscribing on the same device produces the same endpoint, so upserting on
-- it keeps one row per install instead of accumulating duplicates.
create unique index if not exists idx_push_subscriptions_endpoint
  on push_subscriptions (endpoint);

-- The cron's only query: every live subscription for one user.
create index if not exists idx_push_subscriptions_user
  on push_subscriptions (user_id)
  where expired_at is null;

alter table push_subscriptions enable row level security;

-- Users manage only their own devices via the anon client.
drop policy if exists "own push subscriptions" on push_subscriptions;
create policy "own push subscriptions" on push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Service role (cron) bypasses RLS by default; no extra policy needed.
