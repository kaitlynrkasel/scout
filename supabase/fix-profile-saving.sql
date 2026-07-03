-- FIX: signed-in users can't save their profile / app state.
-- Symptom: people re-enter their info every visit; nothing persists to the account.
-- Cause: the "authenticated" role (a logged-in user) was never granted table
-- privileges on profiles / user_state, so every save fails with
-- "permission denied for table profiles" (SQLSTATE 42501). The app writes these
-- tables with the USER's own session, so the user role needs the grant. (The
-- earlier teams.sql only granted service_role, which these tables don't use.)
--
-- Run once in the Supabase SQL editor. Safe to re-run.

-- ---------- Grants for the logged-in user role ----------
-- RLS (below) still limits each user to their OWN row, so this is safe.
grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.user_state to authenticated;

-- ---------- Own-row RLS policies (idempotent) ----------
-- profiles keyed by id = auth.uid(); user_state keyed by user_id = auth.uid().
alter table public.profiles enable row level security;

drop policy if exists profiles_own_select on public.profiles;
create policy profiles_own_select on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_own_insert on public.profiles;
create policy profiles_own_insert on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_update on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

alter table public.user_state enable row level security;

drop policy if exists user_state_own_select on public.user_state;
create policy user_state_own_select on public.user_state
  for select using (auth.uid() = user_id);

drop policy if exists user_state_own_insert on public.user_state;
create policy user_state_own_insert on public.user_state
  for insert with check (auth.uid() = user_id);

drop policy if exists user_state_own_update on public.user_state;
create policy user_state_own_update on public.user_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Cover any future tables created by this same owner so this doesn't recur.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
