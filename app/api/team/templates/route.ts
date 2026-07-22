import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import {
  listSharedTemplates,
  publishSharedTemplates,
  removeSharedTemplate,
  TeamError,
} from "@/lib/teams";

export const runtime = "nodejs";

// GET ?workspaceId=... -> the workspace's shared template library.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const workspaceId = req.nextUrl.searchParams.get("workspaceId") || "";
    if (!workspaceId) return NextResponse.json({ templates: [] });
    return NextResponse.json({ templates: await listSharedTemplates(u.id, workspaceId) });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// POST { workspaceId, templates: [...] } -> publish/sync the caller's templates.
// POST { removeId } -> remove one shared template (own, or admin+).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.removeId) {
      return NextResponse.json(await removeSharedTemplate(u.id, String(body.removeId)));
    }
    const r = await publishSharedTemplates(
      u.id,
      u.email,
      String(body.workspaceId || ""),
      Array.isArray(body.templates) ? body.templates : []
    );
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
