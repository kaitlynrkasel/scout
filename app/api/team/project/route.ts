import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import {
  shareProject,
  listSharedProjects,
  projectRecommendations,
  TeamError,
} from "@/lib/teams";

export const runtime = "nodejs";

// GET ?workspaceId=... -> shared projects in that workspace the caller can see.
// GET ?recommendationsFor=<sharedProjectId> -> workspace members not on it yet.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const recFor = req.nextUrl.searchParams.get("recommendationsFor");
    if (recFor) {
      return NextResponse.json({ recommendations: await projectRecommendations(u.id, recFor) });
    }
    const workspaceId = req.nextUrl.searchParams.get("workspaceId") || "";
    if (!workspaceId) return NextResponse.json({ projects: [] });
    return NextResponse.json({ projects: await listSharedProjects(u.id, workspaceId) });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// Share a project to a workspace (optionally seeding it with existing finds).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json();
    const proj = await shareProject(u.id, u.email, {
      workspaceId: String(body.workspaceId || ""),
      name: String(body.name || ""),
      useCase: body.useCase || "",
      context: body.context || "",
      memberUserIds: Array.isArray(body.memberUserIds) ? body.memberUserIds : [],
      finds: Array.isArray(body.finds) ? body.finds : [],
    });
    return NextResponse.json({ project: proj });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
