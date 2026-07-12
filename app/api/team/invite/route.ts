import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { inviteToWorkspace, revokeInvite, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Invite someone to a workspace by email (they can be outside your company).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, email, role, projectIds } = await req.json();
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    const proto = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
    const origin = process.env.NEXT_PUBLIC_SITE_URL || (host ? `${proto}://${host}` : "");
    const r = await inviteToWorkspace(u.id, String(workspaceId || ""), String(email || ""), {
      role: role ? String(role) : undefined,
      projectIds: Array.isArray(projectIds) ? projectIds.map(String) : undefined,
      origin: origin || undefined,
    });
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// Cancel a pending invite (owner/admin).
export async function DELETE(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, email } = await req.json();
    const r = await revokeInvite(u.id, String(workspaceId || ""), String(email || ""));
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
