import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { setMemberRole, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Owner/admin: change a teammate's role (admin | editor | viewer).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, userId, role } = await req.json();
    const r = await setMemberRole(
      u.id,
      String(workspaceId || ""),
      String(userId || ""),
      String(role || "")
    );
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
