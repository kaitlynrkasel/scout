-- One-time Supabase migration for Stripe subscriptions + search metering.
-- Paste into the Supabase SQL editor and run once. Idempotent.
--
-- One row per user. Written by the server (service-role key) from the Stripe
-- webhook and the metering path; the user's own anon session may only READ its
-- row (own-row select policy) to render plan + usage in the app.

create extension if not exists "pgcrypto";

create table if not exists subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  tier text not null default 'free',          -- 'free' | 'starter' | 'pro'
  status text not null default 'inactive',    -- Stripe subscription status (active, past_due, canceled, …)
  search_limit int not null default 0,        -- monthly allowance for paid tiers (30 or 60)
  searches_used int not null default 0,       -- consumed this billing period; reset on renewal
  free_searches_used int not null default 0,  -- consumed this calendar month by a non-subscriber
  free_period_start timestamptz,              -- start of the current free month (reset boundary)
  period_start timestamptz,                   -- Stripe current_period_start
  period_end timestamptz,                     -- Stripe current_period_end
  updated_at timestamptz not null default now()
);

-- Look up a row by Stripe customer during webhook processing.
create index if not exists idx_subscriptions_customer
  on subscriptions (stripe_customer_id);

alter table subscriptions enable row level security;

-- The signed-in user may read (only) their own plan + usage via the anon client.
-- All writes happen through the service role, which bypasses RLS — so there is
-- deliberately no insert/update/delete policy here.
drop policy if exists "own subscription read" on subscriptions;
create policy "own subscription read" on subscriptions
  for select
  using (auth.uid() = user_id);

grant select on subscriptions to authenticated;

-- Atomically meter one search and report whether it was allowed. Runs as the
-- table owner (security definer) so it works when called with the service-role
-- key from the metering path. Avoids read-modify-write races by doing the
-- limit check inside a single guarded UPDATE.
--
-- Returns exactly one row:
--   allowed       – whether this search may proceed
--   reason        – '' when allowed, else 'quota' (paid limit hit) or
--                   'free_exhausted' (monthly free limit hit)
--   tier          – the caller's current tier
--   searches_used – paid searches consumed this period (after the increment)
--   search_limit  – paid monthly allowance
--   free_used     – free searches consumed this month (after the increment)
create or replace function consume_search(
  p_user uuid,
  p_free_limit int default 5
)
returns table (
  allowed boolean,
  reason text,
  tier text,
  searches_used int,
  search_limit int,
  free_used int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sub subscriptions%rowtype;
  is_paid boolean;
begin
  -- Ensure a row exists so free users are metered too.
  insert into subscriptions (user_id)
    values (p_user)
    on conflict (user_id) do nothing;

  select * into sub from subscriptions where user_id = p_user for update;

  is_paid := sub.tier in ('starter', 'pro') and sub.status = 'active';

  if is_paid then
    if sub.searches_used < sub.search_limit then
      update subscriptions
        set searches_used = sub.searches_used + 1, updated_at = now()
        where user_id = p_user
        returning subscriptions.searches_used into searches_used;
      allowed := true; reason := '';
    else
      searches_used := sub.searches_used;
      allowed := false; reason := 'quota';
    end if;
    tier := sub.tier; search_limit := sub.search_limit; free_used := sub.free_searches_used;
    return next;
    return;
  end if;

  -- Free (non-subscriber): roll the monthly window, then meter.
  if sub.free_period_start is null
     or sub.free_period_start < date_trunc('month', now()) then
    update subscriptions
      set free_searches_used = 0, free_period_start = date_trunc('month', now()), updated_at = now()
      where user_id = p_user;
    sub.free_searches_used := 0;
  end if;

  if sub.free_searches_used < p_free_limit then
    update subscriptions
      set free_searches_used = sub.free_searches_used + 1, updated_at = now()
      where user_id = p_user
      returning subscriptions.free_searches_used into free_used;
    allowed := true; reason := '';
  else
    free_used := sub.free_searches_used;
    allowed := false; reason := 'free_exhausted';
  end if;
  tier := 'free'; searches_used := 0; search_limit := 0;
  return next;
end;
$$;

-- Only the service role should call the meter.
revoke all on function consume_search(uuid, int) from public;
grant execute on function consume_search(uuid, int) to service_role;
