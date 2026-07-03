# Scout Teams — setup

Teams let a group share a project's finds and see who is working on / submitting to
each one, so nobody pitches the same contact twice.

## One-time database setup

Teams need a few new tables in your Supabase project. You only do this once.

1. Open your Supabase dashboard → **SQL Editor** → **New query**.
2. Open [`supabase/teams.sql`](./teams.sql), copy the whole file, paste it in.
3. Click **Run**. It's safe to re-run if you ever need to.

That creates: `workspaces`, `workspace_members`, `workspace_invites`,
`shared_projects`, `shared_project_members`, `shared_finds`, plus row-level-security
so people can only read data for teams they belong to.

No new environment variables are needed — Teams reuses the same Supabase keys already
in `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`).

## How it works

- **Workspace** = your company or crew. It's the basis for teammate recommendations
  (recommendations come from people already in your workspace, which works even
  though everyone signs in with different email providers).
- **Invite** anyone by email — inside or outside your company. They see the invite the
  next time they sign in and click **Join**.
- **Share a project** from the Team tab. Its current finds become a shared pipeline.
  Pick which teammates are on it (its per-project team).
- **Shared finds** show each prospect's status and who has claimed it. Hit **I'll take
  it** to claim one so teammates know not to double up; change the status as you go.

## What's verified vs. not

Built and checked here: the full build, types, all `/api/team/*` routes, and that every
team route rejects unauthenticated calls. **Not** exercised from the dev environment:
true two-account flows (one person invites, another joins and shares a claim) — that
needs the migration applied and two signed-in users. Run the SQL above, then try it
with a teammate (or a second account) to confirm end to end.
