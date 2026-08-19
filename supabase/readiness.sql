-- Launch-readiness checklist state: one row per checklist item, shared by the
-- whole founding team so everyone's verdicts show up for everyone, live.
-- Idempotent: safe to paste again.

create table if not exists readiness_checks (
  key text primary key,          -- stable item key (section + title slug)
  verdict text not null default '', -- '', 'ok', 'warn', 'bad'
  owner_name text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now()
);

alter table readiness_checks enable row level security;
-- Server-only access (service role) through /api/readiness, which gates on the
-- shared READINESS_KEY link secret.
