import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";
import { getEntitlement } from "@/lib/billing";
import { stripeEnabled } from "@/lib/stripe";

export const runtime = "nodejs";

// The signed-in user's current plan + usage, for the Billing tab and gating UI.
export async function GET(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const ent = await getEntitlement(uid);
  return NextResponse.json({
    billingEnabled: stripeEnabled,
    tier: ent.tier,
    status: ent.status,
    comp: ent.comp,
    searchLimit: ent.searchLimit,
    searchesUsed: ent.searchesUsed,
    freeLimit: ent.freeLimit,
    freeUsed: ent.freeUsed,
    periodEnd: ent.periodEnd,
    freeResetsAt: ent.freeResetsAt,
  });
}
