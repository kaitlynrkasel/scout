import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { createWorkspace, getWorkspaceContext, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// The caller's workspaces (with members) + pending invites addressed to them.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    return NextResponse.json(await getWorkspaceContext(u.id, u.email));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed." }, { status: e?.status || 500 });
  }
}

// Create a workspace (the caller becomes its owner).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { name } = await req.json();
    const ws = await createWorkspace(u.id, u.email, String(name || ""));
    return NextResponse.json({ workspace: ws });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
