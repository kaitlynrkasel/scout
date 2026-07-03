import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { inviteToWorkspace, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Invite someone to a workspace by email (they can be outside your company).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, email } = await req.json();
    const r = await inviteToWorkspace(u.id, String(workspaceId || ""), String(email || ""));
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
