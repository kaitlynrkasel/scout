import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { getInviteCode, resetInviteCode, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Owner/admin: get the shareable invite code. POST { workspaceId, reset? }.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, reset } = await req.json();
    const r = reset
      ? await resetInviteCode(u.id, String(workspaceId || ""))
      : await getInviteCode(u.id, String(workspaceId || ""));
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
