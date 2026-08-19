import { NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only: hand the admin page the keyed /readiness link so the checklist
// can be embedded and shared from there without hardcoding the secret client-side.
export async function GET(req: Request) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  const k = process.env.READINESS_KEY || "";
  if (!k) return NextResponse.json({ error: "READINESS_KEY not set." }, { status: 500 });
  return NextResponse.json({ path: `/readiness?k=${encodeURIComponent(k)}` });
}
