import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";
import { redeemComp } from "@/lib/billing";
import { isCompCode } from "@/lib/stripe";

export const runtime = "nodejs";

// Redeem an access code for free-forever (comp) access. Validates the code
// server-side (the list never ships to the client) and, on success, upgrades
// the user's subscription row to unlimited via the service role.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  let code = "";
  try {
    const body = await req.json();
    code = String(body?.code || "");
  } catch {
    /* empty body → invalid */
  }

  if (!isCompCode(code)) {
    return NextResponse.json(
      { error: "That code isn't valid. Check for typos and try again." },
      { status: 400 }
    );
  }

  const err = await redeemComp(uid, code);
  if (err) {
    return NextResponse.json({ error: err }, { status: 500 });
  }
  return NextResponse.json({ ok: true, tier: "pro", comp: true });
}
