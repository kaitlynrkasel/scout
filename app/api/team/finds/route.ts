import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { listSharedFinds, addSharedFinds, TeamError } from "@/lib/teams";

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
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json();
    const r = await addSharedFinds(
      u.id,
      u.email,
      String(body.sharedProjectId || ""),
      Array.isArray(body.finds) ? body.finds : []
    );
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
