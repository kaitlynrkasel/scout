import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { loadWorkspaceState, saveWorkspaceState, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// GET ?workspaceId=... -> the workspace's shared projects + categories.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const workspaceId = req.nextUrl.searchParams.get("workspaceId") || "";
    if (!workspaceId) return NextResponse.json({ state: {} });
    return NextResponse.json({ state: await loadWorkspaceState(u.id, workspaceId) });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// POST { workspaceId, projects, categories } -> replace the shared structure.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const r = await saveWorkspaceState(u.id, String(body.workspaceId || ""), {
      projects: Array.isArray(body.projects) ? body.projects : [],
      categories: Array.isArray(body.categories) ? body.categories : [],
    });
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
