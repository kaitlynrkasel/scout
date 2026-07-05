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

// ---- Workspaces ----

export async function createWorkspace(
  uid: string,
  email: string,
  name: string,
  details: { about?: string; website?: string; industry?: string } = {}
) {
  const nm = String(name || "").trim();
  if (!nm) throw new TeamError("Give your company a name.");
  const { data: ws, error } = await db()
    .from("workspaces")
    .insert({
      name: nm,
      created_by: uid,
      about: (details.about || "").trim() || null,
      website: (details.website || "").trim() || null,
      industry: (details.industry || "").trim() || null,
    })
    .select("id, name, about, website, industry, created_by, created_at")
    .single();
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
  patch: { name?: string; about?: string; website?: string; industry?: string }
) {
  const role = await assertWorkspaceMember(uid, workspaceId);
  if (role !== "owner")
    throw new TeamError("Only the company owner can edit the company details.", 403);
  const update: Record<string, any> = {};
  if (typeof patch.name === "string") {
    const nm = patch.name.trim();
    if (!nm) throw new TeamError("The company needs a name.");
    update.name = nm;
  }
  if (typeof patch.about === "string") update.about = patch.about.trim() || null;
  if (typeof patch.website === "string") update.website = patch.website.trim() || null;
  if (typeof patch.industry === "string") update.industry = patch.industry.trim() || null;
  if (!Object.keys(update).length) throw new TeamError("Nothing to update.");
  const { data, error } = await db()
    .from("workspaces")
    .update(update)
    .eq("id", workspaceId)
    .select("id, name, about, website, industry")
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
  const role = await assertWorkspaceMember(uid, workspaceId);
  if (role !== "owner")
    throw new TeamError("Only the company owner can set member weights.", 403);
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
  const { data: memberships } = await db()
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", uid);
  const wsIds = (memberships || []).map((m: any) => m.workspace_id);

  let workspaces: any[] = [];
  if (wsIds.length) {
    const { data: wsRows } = await db()
      .from("workspaces")
      .select("id, name, about, website, industry, created_by, created_at")
      .in("id", wsIds);
    const { data: memberRows } = await db()
      .from("workspace_members")
      .select("workspace_id, user_id, email, role, weight")
      .in("workspace_id", wsIds);
    workspaces = (wsRows || []).map((w: any) => ({
      ...w,
      role: (memberships || []).find((m: any) => m.workspace_id === w.id)?.role || "member",
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
  inviteEmail: string
) {
  await assertWorkspaceMember(uid, workspaceId);
  const em = String(inviteEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))
    throw new TeamError("Enter a valid email address.");
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
      { workspace_id: workspaceId, email: em, invited_by: uid },
      { onConflict: "workspace_id,email" }
    );
  return { invited: em };
}

export async function acceptInvite(uid: string, email: string, workspaceId: string) {
  const { data: invite } = await db()
    .from("workspace_invites")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", email)
    .maybeSingle();
  if (!invite) throw new TeamError("No invite found for you in this workspace.", 404);
  await db()
    .from("workspace_members")
    .upsert(
      { workspace_id: workspaceId, user_id: uid, email, role: "member" },
      { onConflict: "workspace_id,user_id" }
    );
  await db().from("workspace_invites").delete().eq("id", invite.id);
  return { joined: workspaceId };
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
  await assertWorkspaceMember(uid, opts.workspaceId);
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
  await assertProjectMember(uid, opts.sharedProjectId);
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

export async function addSharedFinds(
  uid: string,
  email: string,
  sharedProjectId: string,
  finds: any[]
) {
  await assertProjectMember(uid, sharedProjectId);
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
  await assertProjectMember(uid, row.shared_project_id);

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
