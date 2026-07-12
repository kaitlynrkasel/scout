// Teams: workspaces, shared projects, and shared finds. Server-only. Every
// function takes the caller's id/email (from userFromReq) and enforces access in
// code, since the queries run with the service-role key (which bypasses RLS).

import { supabaseAdmin } from "./supabaseAdmin";

export class TeamError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function db() {
  if (!supabaseAdmin) throw new TeamError("Teams are not configured on the server.", 500);
  return supabaseAdmin;
}

// ---- Membership guards ----

async function assertWorkspaceMember(uid: string, workspaceId: string) {
  const { data } = await db()
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", uid)
    .maybeSingle();
  if (!data) throw new TeamError("You are not a member of this workspace.", 403);
  return data.role as string;
}

async function assertProjectMember(uid: string, sharedProjectId: string) {
  const { data } = await db()
    .from("shared_project_members")
    .select("user_id")
    .eq("shared_project_id", sharedProjectId)
    .eq("user_id", uid)
    .maybeSingle();
  if (!data) throw new TeamError("You do not have access to this shared project.", 403);
}

// ---- Roles ----
// Increasing power: viewer < editor < admin < owner. Unknown/legacy roles read
// as editor so nobody is accidentally locked out mid-migration.
export const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"] as const;
function rankOf(role: string | null | undefined): number {
  return ROLE_RANK[String(role || "")] ?? ROLE_RANK.editor;
}

// Assert the caller is a workspace member of at least `min` power; returns role.
async function assertRole(uid: string, workspaceId: string, min: keyof typeof ROLE_RANK) {
  const role = await assertWorkspaceMember(uid, workspaceId);
  if (rankOf(role) < ROLE_RANK[min])
    throw new TeamError(`This needs the ${min} role or higher.`, 403);
  return role;
}

// The caller's workspace role for the workspace that owns a shared project.
// Asserts project membership too. Viewers get read access; editor+ can change.
async function projectWorkspaceRole(uid: string, sharedProjectId: string) {
  await assertProjectMember(uid, sharedProjectId);
  const { data: proj } = await db()
    .from("shared_projects")
    .select("workspace_id, owner_user_id")
    .eq("id", sharedProjectId)
    .maybeSingle();
  if (!proj) throw new TeamError("Shared project not found.", 404);
  const role = await assertWorkspaceMember(uid, proj.workspace_id);
  return { role, workspaceId: proj.workspace_id, ownerUserId: proj.owner_user_id };
}
async function assertProjectEditor(uid: string, sharedProjectId: string) {
  const { role } = await projectWorkspaceRole(uid, sharedProjectId);
  if (rankOf(role) < ROLE_RANK.editor)
    throw new TeamError("Viewers can see the shared pipeline but can't change it.", 403);
  return role;
}

// ---- Workspaces ----

export async function createWorkspace(
  uid: string,
  email: string,
  name: string,
  details: { about?: string; website?: string; industry?: string; stage?: string } = {}
) {
  const nm = String(name || "").trim();
  if (!nm) throw new TeamError("Give your company a name.");
  const full = {
    name: nm,
    created_by: uid,
    about: (details.about || "").trim() || null,
    website: (details.website || "").trim() || null,
    industry: (details.industry || "").trim() || null,
    stage: (details.stage || "").trim() || null,
  };
  let { data: ws, error } = await db()
    .from("workspaces")
    .insert(full)
    .select("id, name, about, website, industry, stage, created_by, created_at")
    .single();
  // If the DB predates the about/website/industry/stage columns (teams.sql not
  // fully applied), don't hard-fail, create the company with just its name so the
  // user isn't blocked. Those details save once the migration is run.
  if (error && /about|website|industry|stage|schema cache|column/i.test(error.message || "")) {
    ({ data: ws, error } = await db()
      .from("workspaces")
      .insert({ name: nm, created_by: uid })
      .select("id, name, created_by, created_at")
      .single());
  }
  if (error || !ws) throw new TeamError(error?.message || "Could not create workspace.", 500);
  await db()
    .from("workspace_members")
    .insert({ workspace_id: ws.id, user_id: uid, email, role: "owner" });
  return ws;
}

// A directory of every company (workspace) a new user could join, so onboarding
// can offer "join an existing company" from a dropdown. Companies whose members
// share the caller's email domain are surfaced first (likely their real
// employer). `alreadyMember` lets the UI skip ones they're already in.
export async function listJoinableWorkspaces(uid: string, email: string) {
  const domain = (email.split("@")[1] || "").toLowerCase();
  const { data: wsRows } = await db()
    .from("workspaces")
    .select("id, name, about, industry")
    .order("name");
  if (!wsRows?.length) return [];
  const { data: memberRows } = await db()
    .from("workspace_members")
    .select("workspace_id, user_id, email");
  const byWs = new Map<string, any[]>();
  for (const m of memberRows || []) {
    const arr = byWs.get(m.workspace_id) || [];
    arr.push(m);
    byWs.set(m.workspace_id, arr);
  }
  return (wsRows || [])
    .map((w: any) => {
      const members = byWs.get(w.id) || [];
      const domainMatch =
        !!domain &&
        members.some((m: any) => (m.email.split("@")[1] || "").toLowerCase() === domain);
      return {
        id: w.id,
        name: w.name,
        about: w.about || "",
        industry: w.industry || "",
        memberCount: members.length,
        domainMatch,
        alreadyMember: members.some((m: any) => m.user_id === uid),
      };
    })
    .sort(
      (a, b) => Number(b.domainMatch) - Number(a.domainMatch) || a.name.localeCompare(b.name)
    );
}

// Edit the company's onboarding answers (name / what it does / industry /
// website). Owner only — these are the shared company record. Returns the
// updated workspace.
export async function updateWorkspaceDetails(
  uid: string,
  workspaceId: string,
  patch: { name?: string; about?: string; website?: string; industry?: string; stage?: string }
) {
  await assertRole(uid, workspaceId, "admin");
  const update: Record<string, any> = {};
  if (typeof patch.name === "string") {
    const nm = patch.name.trim();
    if (!nm) throw new TeamError("The company needs a name.");
    update.name = nm;
  }
  if (typeof patch.about === "string") update.about = patch.about.trim() || null;
  if (typeof patch.website === "string") update.website = patch.website.trim() || null;
  if (typeof patch.industry === "string") update.industry = patch.industry.trim() || null;
  if (typeof patch.stage === "string") update.stage = patch.stage.trim() || null;
  if (!Object.keys(update).length) throw new TeamError("Nothing to update.");
  const { data, error } = await db()
    .from("workspaces")
    .update(update)
    .eq("id", workspaceId)
    .select("id, name, about, website, industry, stage")
    .single();
  if (error) throw new TeamError(error.message, 500);
  return data;
}

// Set how much a member's decisions count in team learning (owner only, 1-5).
// Default is 1 for everyone (equal); an admin can raise/lower a member.
export async function setMemberWeight(
  uid: string,
  workspaceId: string,
  targetUserId: string,
  weight: number
) {
  await assertRole(uid, workspaceId, "admin");
  const w = Math.max(1, Math.min(5, Math.round(Number(weight) || 1)));
  const { error } = await db()
    .from("workspace_members")
    .update({ weight: w })
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId);
  if (error) throw new TeamError(error.message, 500);
  return { weight: w };
}

// Join an existing company directly (onboarding "select from a dropdown"). Open
// join by design, a new hire picks their company and is added as a member.
export async function joinWorkspace(uid: string, email: string, workspaceId: string) {
  const { data: ws } = await db()
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws) throw new TeamError("That company no longer exists.", 404);
  await db()
    .from("workspace_members")
    .upsert(
      { workspace_id: workspaceId, user_id: uid, email, role: "member" },
      { onConflict: "workspace_id,user_id" }
    );
  return ws;
}

// The caller's workspace context: the workspaces they belong to (each with its
// members), plus any pending invites addressed to their email.
export async function getWorkspaceContext(uid: string, email: string) {
  // Auto-join: the first time an invitee loads the app, silently accept any
  // invites addressed to them (role + project assignments come from the invite).
  try {
    await acceptAllPendingInvites(uid, email);
  } catch {
    /* non-fatal — they can still be shown the pending invite to accept manually */
  }
  const { data: memberships } = await db()
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", uid);
  const wsIds = (memberships || []).map((m: any) => m.workspace_id);

  let workspaces: any[] = [];
  if (wsIds.length) {
    const { data: wsRows } = await db()
      .from("workspaces")
      .select("id, name, about, website, industry, stage, created_by, created_at")
      .in("id", wsIds);
    const { data: memberRows } = await db()
      .from("workspace_members")
      .select("workspace_id, user_id, email, role, weight")
      .in("workspace_id", wsIds);
    workspaces = (wsRows || []).map((w: any) => ({
      ...w,
      role: (memberships || []).find((m: any) => m.workspace_id === w.id)?.role || "editor",
      members: (memberRows || []).filter((m: any) => m.workspace_id === w.id),
    }));
  }

  // Invites addressed to me, for workspaces I'm not already in.
  const { data: inviteRows } = await db()
    .from("workspace_invites")
    .select("id, workspace_id, invited_by, created_at, workspaces(name)")
    .eq("email", email);
  const invites = (inviteRows || [])
    .filter((i: any) => !wsIds.includes(i.workspace_id))
    .map((i: any) => ({
      id: i.id,
      workspaceId: i.workspace_id,
      workspaceName: i.workspaces?.name || "a workspace",
      createdAt: i.created_at,
    }));

  return { workspaces, invites };
}

export async function inviteToWorkspace(
  uid: string,
  workspaceId: string,
  inviteEmail: string,
  opts: { role?: string; projectIds?: string[] } = {}
) {
  // Admins and owners can grow the roster; editors/viewers cannot.
  const callerRole = await assertRole(uid, workspaceId, "admin");
  const em = String(inviteEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))
    throw new TeamError("Enter a valid email address.");
  let role = String(opts.role || "editor");
  if (!ASSIGNABLE_ROLES.includes(role as any)) role = "editor";
  // Only the owner can mint another admin.
  if (role === "admin" && callerRole !== "owner")
    throw new TeamError("Only the company owner can invite someone as an admin.", 403);
  const projectIds = (opts.projectIds || []).filter(Boolean);
  // Already a member? (match by email on existing members)
  const { data: existing } = await db()
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("email", em)
    .maybeSingle();
  if (existing) throw new TeamError("That person is already in this workspace.");
  await db()
    .from("workspace_invites")
    .upsert(
      { workspace_id: workspaceId, email: em, invited_by: uid, role, project_ids: projectIds },
      { onConflict: "workspace_id,email" }
    );
  return { invited: em, role };
}

// Join every workspace that has a pending invite for this email, applying the
// invite's role and pre-assigned projects. Called automatically the first time
// the invitee opens the app (via getWorkspaceContext), so signing up = joining.
export async function acceptAllPendingInvites(uid: string, email: string) {
  const em = String(email || "").trim().toLowerCase();
  if (!em) return { joined: 0 };
  const { data: invites } = await db()
    .from("workspace_invites")
    .select("id, workspace_id, role, project_ids")
    .eq("email", em);
  if (!invites?.length) return { joined: 0 };
  for (const inv of invites) {
    const { data: existing } = await db()
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", inv.workspace_id)
      .eq("user_id", uid)
      .maybeSingle();
    if (!existing) {
      const role = ASSIGNABLE_ROLES.includes(inv.role as any) ? inv.role : "editor";
      await db()
        .from("workspace_members")
        .upsert(
          { workspace_id: inv.workspace_id, user_id: uid, email: em, role },
          { onConflict: "workspace_id,user_id" }
        );
    }
    const pids: string[] = Array.isArray(inv.project_ids) ? inv.project_ids : [];
    if (pids.length) {
      const rows = pids.map((pid) => ({ shared_project_id: pid, user_id: uid, email: em }));
      await db()
        .from("shared_project_members")
        .upsert(rows, { onConflict: "shared_project_id,user_id" });
    }
    await db().from("workspace_invites").delete().eq("id", inv.id);
  }
  return { joined: invites.length };
}

export async function acceptInvite(uid: string, email: string, workspaceId: string) {
  await acceptAllPendingInvites(uid, email);
  return { joined: workspaceId };
}

// Owner/admin: change a member's role. Guards keep admins from touching the
// owner or minting/removing other admins (only the owner can do that).
export async function setMemberRole(
  uid: string,
  workspaceId: string,
  targetUserId: string,
  role: string
) {
  const callerRole = await assertRole(uid, workspaceId, "admin");
  if (!ASSIGNABLE_ROLES.includes(role as any))
    throw new TeamError("Pick admin, editor, or viewer.");
  const { data: target } = await db()
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (!target) throw new TeamError("That person is not on this team.", 404);
  if (target.role === "owner")
    throw new TeamError("The company owner's role can't be changed.", 403);
  // Only the owner can grant admin or change someone who is currently an admin.
  if ((role === "admin" || target.role === "admin") && callerRole !== "owner")
    throw new TeamError("Only the company owner can manage admins.", 403);
  await db()
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId);
  return { role };
}

// ---- Shared projects ----

export async function shareProject(
  uid: string,
  email: string,
  opts: {
    workspaceId: string;
    name: string;
    useCase?: string;
    context?: string;
    memberUserIds?: string[];
    finds?: any[];
  }
) {
  await assertRole(uid, opts.workspaceId, "editor");
  const nm = String(opts.name || "").trim();
  if (!nm) throw new TeamError("The project needs a name.");
  const { data: proj, error } = await db()
    .from("shared_projects")
    .insert({
      workspace_id: opts.workspaceId,
      owner_user_id: uid,
      name: nm,
      use_case: opts.useCase || "",
      context: opts.context || "",
    })
    .select("id, workspace_id, owner_user_id, name, use_case, context, created_at")
    .single();
  if (error || !proj) throw new TeamError(error?.message || "Could not share project.", 500);

  // Members: always the owner, plus any chosen workspace members.
  const { data: wsMembers } = await db()
    .from("workspace_members")
    .select("user_id, email")
    .eq("workspace_id", opts.workspaceId);
  const chosen = new Set([uid, ...(opts.memberUserIds || [])]);
  const memberRows = (wsMembers || [])
    .filter((m: any) => chosen.has(m.user_id))
    .map((m: any) => ({
      shared_project_id: proj.id,
      user_id: m.user_id,
      email: m.email,
    }));
  if (memberRows.length) {
    await db()
      .from("shared_project_members")
      .upsert(memberRows, { onConflict: "shared_project_id,user_id" });
  }

  // Seed the shared pipeline with the finds the owner already had locally.
  if (Array.isArray(opts.finds) && opts.finds.length) {
    await addSharedFinds(uid, email, proj.id, opts.finds);
  }
  return proj;
}

// Shared projects the caller can see, in a given workspace.
export async function listSharedProjects(uid: string, workspaceId: string) {
  await assertWorkspaceMember(uid, workspaceId);
  const { data: mine } = await db()
    .from("shared_project_members")
    .select("shared_project_id")
    .eq("user_id", uid);
  const ids = (mine || []).map((m: any) => m.shared_project_id);
  if (!ids.length) return [];
  const { data: projs } = await db()
    .from("shared_projects")
    .select("id, workspace_id, owner_user_id, name, use_case, context, created_at")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  const { data: members } = await db()
    .from("shared_project_members")
    .select("shared_project_id, user_id, email")
    .in("shared_project_id", ids);
  return (projs || []).map((p: any) => ({
    ...p,
    members: (members || []).filter((m: any) => m.shared_project_id === p.id),
  }));
}

// Workspace members who could be added to a shared project (not on it yet).
export async function projectRecommendations(uid: string, sharedProjectId: string) {
  await assertProjectMember(uid, sharedProjectId);
  const { data: proj } = await db()
    .from("shared_projects")
    .select("workspace_id")
    .eq("id", sharedProjectId)
    .maybeSingle();
  if (!proj) throw new TeamError("Shared project not found.", 404);
  const { data: wsMembers } = await db()
    .from("workspace_members")
    .select("user_id, email")
    .eq("workspace_id", proj.workspace_id);
  const { data: onProject } = await db()
    .from("shared_project_members")
    .select("user_id")
    .eq("shared_project_id", sharedProjectId);
  const on = new Set((onProject || []).map((m: any) => m.user_id));
  return (wsMembers || []).filter((m: any) => !on.has(m.user_id));
}

export async function setProjectMembers(
  uid: string,
  opts: { sharedProjectId: string; addUserIds?: string[]; removeUserIds?: string[] }
) {
  // Assigning teammates to a project is an admin action (or the project's own
  // creator managing their project).
  const { role, ownerUserId } = await projectWorkspaceRole(uid, opts.sharedProjectId);
  if (rankOf(role) < ROLE_RANK.admin && uid !== ownerUserId)
    throw new TeamError("Only an admin or the project's creator can change who's on it.", 403);
  const { data: proj } = await db()
    .from("shared_projects")
    .select("workspace_id, owner_user_id")
    .eq("id", opts.sharedProjectId)
    .maybeSingle();
  if (!proj) throw new TeamError("Shared project not found.", 404);
  if (opts.addUserIds?.length) {
    const { data: wsMembers } = await db()
      .from("workspace_members")
      .select("user_id, email")
      .eq("workspace_id", proj.workspace_id)
      .in("user_id", opts.addUserIds);
    const rows = (wsMembers || []).map((m: any) => ({
      shared_project_id: opts.sharedProjectId,
      user_id: m.user_id,
      email: m.email,
    }));
    if (rows.length)
      await db()
        .from("shared_project_members")
        .upsert(rows, { onConflict: "shared_project_id,user_id" });
  }
  for (const rid of opts.removeUserIds || []) {
    if (rid === proj.owner_user_id) continue; // never drop the owner
    await db()
      .from("shared_project_members")
      .delete()
      .eq("shared_project_id", opts.sharedProjectId)
      .eq("user_id", rid);
  }
  return { ok: true };
}

// ---- Shared finds ----

export async function listSharedFinds(uid: string, sharedProjectId: string) {
  await assertProjectMember(uid, sharedProjectId);
  const { data } = await db()
    .from("shared_finds")
    .select("*")
    .eq("shared_project_id", sharedProjectId)
    .order("created_at", { ascending: false });
  return data || [];
}

// The prospects already in a team's shared pipeline, so a member's search (live
// or scheduled) can skip them and nobody re-finds the same person. Internal —
// callers validate project access before invoking.
export async function sharedPipelineExclusions(sharedProjectId: string) {
  const { data } = await db()
    .from("shared_finds")
    .select("dedup_key, opp")
    .eq("shared_project_id", sharedProjectId);
  const keys = new Set<string>();
  const names: string[] = [];
  for (const r of data || []) {
    if (r.dedup_key) keys.add(String(r.dedup_key));
    const n = (r.opp as any)?.name;
    if (n) names.push(String(n));
  }
  return { keys: [...keys], names };
}

export async function addSharedFinds(
  uid: string,
  email: string,
  sharedProjectId: string,
  finds: any[]
) {
  await assertProjectEditor(uid, sharedProjectId);
  const rows = (finds || [])
    .filter((f) => f && f.opp)
    .map((f) => ({
      shared_project_id: sharedProjectId,
      dedup_key: String(f.dedupKey || f.id || `${f.opp?.name || ""}`).slice(0, 400),
      opp: f.opp,
      status: f.status || "new",
      draft: f.draft || null,
      requirements: f.requirements || null,
      gmail_thread_id: f.gmailThreadId || null,
      deny_reason: f.denyReason || null,
      added_by: uid,
      added_email: email,
      updated_by: uid,
      updated_email: email,
    }));
  if (!rows.length) return { added: 0 };
  // Ignore rows that duplicate an existing prospect in this project.
  const { data } = await db()
    .from("shared_finds")
    .upsert(rows, { onConflict: "shared_project_id,dedup_key", ignoreDuplicates: true })
    .select("id");
  return { added: (data || []).length };
}

export async function updateSharedFind(
  uid: string,
  email: string,
  findId: string,
  patch: {
    status?: string;
    draft?: any;
    requirements?: string;
    denyReason?: string;
    gmailThreadId?: string;
    claim?: boolean; // true = I'm taking this, false = release
  }
) {
  // Find the row's project so we can check membership.
  const { data: row } = await db()
    .from("shared_finds")
    .select("id, shared_project_id")
    .eq("id", findId)
    .maybeSingle();
  if (!row) throw new TeamError("That find no longer exists.", 404);
  await assertProjectEditor(uid, row.shared_project_id);

  const update: Record<string, any> = {
    updated_by: uid,
    updated_email: email,
    updated_at: new Date().toISOString(),
  };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.draft !== undefined) update.draft = patch.draft;
  if (patch.requirements !== undefined) update.requirements = patch.requirements;
  if (patch.denyReason !== undefined) update.deny_reason = patch.denyReason;
  if (patch.gmailThreadId !== undefined) update.gmail_thread_id = patch.gmailThreadId;
  if (patch.claim === true) {
    update.claimed_by = uid;
    update.claimed_email = email;
  } else if (patch.claim === false) {
    update.claimed_by = null;
    update.claimed_email = null;
  }
  const { data, error } = await db()
    .from("shared_finds")
    .update(update)
    .eq("id", findId)
    .select("*")
    .single();
  if (error) throw new TeamError(error.message, 500);
  return data;
}
