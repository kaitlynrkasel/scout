import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { updateSharedFind, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Update one shared find: status, draft, requirements, deny reason, or claim it
// (claim = "I'm taking this one") so teammates don't double up.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const body = await req.json();
    const row = await updateSharedFind(u.id, u.email, String(body.findId || ""), {
      status: body.status,
      draft: body.draft,
      requirements: body.requirements,
      denyReason: body.denyReason,
      gmailThreadId: body.gmailThreadId,
      claim: body.claim,
    });
    return NextResponse.json({ find: row });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
