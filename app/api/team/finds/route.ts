import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import {
  listSharedFinds,
  addSharedFinds,
  publishFindsToTeam,
  removeMyFindsFromTeamProject,
  TeamError,
} from "@/lib/teams";

export const runtime = "nodejs";

// GET ?projectId=<sharedProjectId> -> the shared pipeline, with attribution.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const projectId = req.nextUrl.searchParams.get("projectId") || "";
    if (!projectId) return NextResponse.json({ finds: [] });
    return NextResponse.json({ finds: await listSharedFinds(u.id, projectId) });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// Add finds to a shared project (duplicates by prospect are ignored).
//
// Two shapes: pass `sharedProjectId` to add to a known project, or pass
// `workspaceId` + `projectName` to publish into the project of that name,
// opening one to the workspace if this is the first find under it.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json();
    const finds = Array.isArray(body.finds) ? body.finds : [];
    if (!body.sharedProjectId && body.workspaceId && body.projectName) {
      return NextResponse.json(
        await publishFindsToTeam(u.id, u.email, {
          workspaceId: String(body.workspaceId),
          projectName: String(body.projectName),
          useCase: String(body.useCase || ""),
          context: String(body.context || ""),
          finds,
        })
      );
    }
    const r = await addSharedFinds(u.id, u.email, String(body.sharedProjectId || ""), finds);
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// Drop this user's shared copies of a project's finds — used when they delete
// the project locally, so the finds don't reappear on the next lens refresh.
// Only ever removes rows the caller added; teammates' finds are left alone.
export async function DELETE(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json();
    return NextResponse.json(
      await removeMyFindsFromTeamProject(
        u.id,
        String(body.workspaceId || ""),
        String(body.projectName || "")
      )
    );
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
