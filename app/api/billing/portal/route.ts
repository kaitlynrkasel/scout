import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { getEntitlement } from "@/lib/billing";
import { stripe, appBaseUrl } from "@/lib/stripe";

export const runtime = "nodejs";

// Open the Stripe Customer Portal so the user can cancel, switch, or update card.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  if (!stripe) {
    return NextResponse.json({ error: "Billing is not configured yet." }, { status: 500 });
  }

  const ent = await getEntitlement(u.id);
  if (!ent.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account yet, subscribe to a plan first." },
      { status: 400 }
    );
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: ent.stripeCustomerId,
      return_url: `${appBaseUrl(req)}/app?tab=billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Could not open the billing portal." },
      { status: 500 }
    );
  }
}
