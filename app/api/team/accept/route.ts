import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { acceptInvite, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Accept an invite addressed to my email, joining that workspace.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId } = await req.json();
    const r = await acceptInvite(u.id, u.email, String(workspaceId || ""));
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
