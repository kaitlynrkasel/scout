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
