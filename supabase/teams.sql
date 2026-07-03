-- Scout Teams: workspaces, shared projects, and shared finds.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL -> New query -> paste -> Run).
-- Safe to re-run: everything is guarded with "if not exists" / "drop ... if exists".
--
-- Model:
--   workspace            = your company / org (the basis for teammate recommendations)
--   workspace_members    = who belongs to a workspace
--   workspace_invites    = pending invites by email (accepted when that person signs in)
--   shared_projects      = a project shared to a workspace, with its own team of members
--   shared_project_members = the people on that project (a subset of the workspace, plus outside guests)
--   shared_finds         = the shared pipeline: one row per prospect, with who claimed it and its status
--
-- Security: the app writes through server routes that use the service-role key and
-- check membership in code. RLS below is defense in depth so that even a direct
-- client query can only READ rows for teams the caller belongs to; all writes go
-- through the service role.

-- ---------- Tables ----------

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  email text not null,
  role text not null default 'member', -- 'owner' | 'member'
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null, -- invited email, lowercased
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create table if not exists public.shared_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null,
  name text not null,
  use_case text default '',
  context text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.shared_project_members (
  shared_project_id uuid not null references public.shared_projects(id) on delete cascade,
  user_id uuid not null,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (shared_project_id, user_id)
);

create table if not exists public.shared_finds (
  id uuid primary key default gen_random_uuid(),
  shared_project_id uuid not null references public.shared_projects(id) on delete cascade,
  dedup_key text not null, -- normalized name+host, prevents two people adding the same prospect
  opp jsonb not null,
  status text not null default 'new', -- new | drafted | sent | replied | denied
  claimed_by uuid,          -- who is working on / submitting this one
  claimed_email text,
  draft jsonb,
  requirements text,
  gmail_thread_id text,
  deny_reason text,
  added_by uuid not null,
  added_email text,
  updated_by uuid,
  updated_email text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (shared_project_id, dedup_key)
);

create index if not exists shared_finds_project_idx on public.shared_finds (shared_project_id);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);
create index if not exists shared_project_members_user_idx on public.shared_project_members (user_id);
create index if not exists workspace_invites_email_idx on public.workspace_invites (email);

-- ---------- Membership helpers (security definer avoids RLS recursion) ----------

create or replace function public.is_workspace_member(wid uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists(
    select 1 from public.workspace_members m
    where m.workspace_id = wid and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_project_member(pid uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists(
    select 1 from public.shared_project_members m
    where m.shared_project_id = pid and m.user_id = auth.uid()
  );
$$;

-- ---------- Row-level security ----------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.shared_projects enable row level security;
alter table public.shared_project_members enable row level security;
alter table public.shared_finds enable row level security;

-- Read-only policies for the authenticated role. All writes happen via the
-- service-role key in the app's server routes (which bypasses RLS), so there are
-- deliberately no insert/update/delete policies here.

drop policy if exists workspaces_read on public.workspaces;
create policy workspaces_read on public.workspaces
  for select using (public.is_workspace_member(id));

drop policy if exists workspace_members_read on public.workspace_members;
create policy workspace_members_read on public.workspace_members
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists workspace_invites_read on public.workspace_invites;
create policy workspace_invites_read on public.workspace_invites
  for select using (
    public.is_workspace_member(workspace_id)
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

drop policy if exists shared_projects_read on public.shared_projects;
create policy shared_projects_read on public.shared_projects
  for select using (public.is_project_member(id));

drop policy if exists shared_project_members_read on public.shared_project_members;
create policy shared_project_members_read on public.shared_project_members
  for select using (public.is_project_member(shared_project_id));

drop policy if exists shared_finds_read on public.shared_finds;
create policy shared_finds_read on public.shared_finds
  for select using (public.is_project_member(shared_project_id));
