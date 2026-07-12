-- Google Sheets connection (separate from Gmail so sheet access is opt-in and
-- doesn't bloat the send-email consent). Stores the refresh token for the Sheets
-- scope. Paste into the Supabase SQL editor and run once. Idempotent.

create table if not exists public.sheets_connections (
  user_id uuid primary key,
  email text,
  refresh_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The app reads/writes this with the service role in server routes (RLS on, no
-- anon policy — same pattern as gmail_connections).
alter table public.sheets_connections enable row level security;

grant all privileges on public.sheets_connections to service_role;
