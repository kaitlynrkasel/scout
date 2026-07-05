import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { setMemberWeight, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Owner-only: set how much a teammate's decisions count in team learning (1-5).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, targetUserId, weight } = await req.json();
    const res = await setMemberWeight(
      u.id,
      String(workspaceId || ""),
      String(targetUserId || ""),
      Number(weight)
    );
    return NextResponse.json(res);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
