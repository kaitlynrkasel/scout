import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { listJoinableWorkspaces, joinWorkspace, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// The directory of existing companies a new user can join (onboarding dropdown).
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const companies = await listJoinableWorkspaces(u.id, u.email);
    return NextResponse.json({ companies });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// Join an existing company by id (onboarding "select from a dropdown").
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId } = await req.json();
    const ws = await joinWorkspace(u.id, u.email, String(workspaceId || ""));
    return NextResponse.json({ workspace: ws });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
