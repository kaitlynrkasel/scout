-- Outreach opt-outs. When a recipient uses the unsubscribe link / one-click
-- button in an email, we record (sender user_id + recipient email) here, and the
-- Gmail send route refuses to message that recipient again. Paste into the
-- Supabase SQL editor and run once. Idempotent.

create table if not exists unsubscribes (
  user_id uuid not null,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, email)
);

-- Look up "has this sender's recipient opted out?" quickly at send time.
create index if not exists unsubscribes_user_email_idx on unsubscribes (user_id, email);

alter table unsubscribes enable row level security;

-- No anon/authenticated policy on purpose: only the send route and the
-- /api/unsubscribe endpoint (service role) read or write this. Service role
-- bypasses RLS, so enabling it with no policy denies direct client access.
