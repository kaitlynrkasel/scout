-- Optional: make cross-device sync instant instead of near-instant.
--
-- Scout keeps each user's app state in one row of public.user_state, and every
-- open copy of the app re-reads that row when it comes back to the foreground,
-- when the window regains focus, and on a slow poll while it is on screen. That
-- alone is enough: a search run on a laptop shows up on the phone as soon as
-- the phone is looked at.
--
-- Running this adds the push half. Postgres then tells the other device the
-- moment the row changes, so two copies open side by side update in about a
-- second rather than within the poll interval. The client already subscribes
-- (see pullRemoteState in app/app/page.tsx); until this runs, no events are
-- delivered and nothing breaks.
--
-- Safe to run more than once.

-- Realtime only publishes tables in this publication.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'user_state'
  ) then
    alter publication supabase_realtime add table public.user_state;
  end if;
end
$$;

-- Realtime enforces the table's own row-level security, so a user is only ever
-- told about their own row (user_state's policies are in fix-profile-saving.sql,
-- all keyed on user_id = auth.uid()). The payload still has to carry enough of
-- the old row to match the user_id filter on a delete, hence REPLICA IDENTITY
-- FULL; the client's filter is user_id=eq.<uid>.
alter table public.user_state replica identity full;
