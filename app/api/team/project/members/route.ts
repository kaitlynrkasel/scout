import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { setProjectMembers, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Add or remove members on a shared project (its per-project team).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json();
    const r = await setProjectMembers(u.id, {
      sharedProjectId: String(body.sharedProjectId || ""),
      addUserIds: Array.isArray(body.addUserIds) ? body.addUserIds : [],
      removeUserIds: Array.isArray(body.removeUserIds) ? body.removeUserIds : [],
    });
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
