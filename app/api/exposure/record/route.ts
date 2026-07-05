import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";
import { recordContact } from "@/lib/exposure";

export const runtime = "nodejs";

// Record that the signed-in user has contacted a target (drafted/sent to it), so
// the shared ledger can stop over-surfacing that contact to everyone else.
// No-ops for signed-out users (they have no stable id to count) and never errors
// the caller, this is best-effort background bookkeeping.
export async function POST(req: NextRequest) {
  try {
    const uid = await userIdFromReq(req);
    if (!uid) return NextResponse.json({ ok: false }); // anon: nothing to record
    const { opp } = await req.json();
    if (opp && typeof opp === "object") await recordContact(uid, opp);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
