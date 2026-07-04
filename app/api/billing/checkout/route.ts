import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { getOrCreateCustomer, getEntitlement } from "@/lib/billing";
import { stripe, priceIdForTier, appBaseUrl, TIERS } from "@/lib/stripe";

export const runtime = "nodejs";

// Start a subscription Checkout Session for the given tier (subscribe or upgrade).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  if (!stripe) {
    return NextResponse.json({ error: "Billing is not configured yet." }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  if (body?.tier !== "starter" && body?.tier !== "pro") {
    return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
  }
  const tier: "starter" | "pro" = body.tier;
  const price = priceIdForTier(tier);
  if (!price) {
    return NextResponse.json(
      { error: `Missing price for the ${TIERS[tier].label} plan.` },
      { status: 500 }
    );
  }

  try {
    // Already subscribed? Switch the existing subscription's plan in place with
    // proration instead of creating a second one via Checkout (a one-click
    // upgrade/downgrade). The webhook then syncs the new tier + limit.
    const ent = await getEntitlement(u.id);
    if (ent.status === "active" && ent.stripeCustomerId) {
      const subs = await stripe.subscriptions.list({
        customer: ent.stripeCustomerId,
        status: "active",
        limit: 1,
      });
      const sub = subs.data[0];
      if (sub) {
        if (sub.items.data[0]?.price?.id === price) {
          return NextResponse.json({ error: "You're already on that plan." }, { status: 400 });
        }
        await stripe.subscriptions.update(sub.id, {
          items: [{ id: sub.items.data[0].id, price }],
          proration_behavior: "always_invoice",
          metadata: { user_id: u.id },
        });
        return NextResponse.json({ updated: true });
      }
    }

    const customer = await getOrCreateCustomer(u.id, u.email);
    const base = appBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      // So the webhook can attribute the subscription even if metadata is missed.
      subscription_data: { metadata: { user_id: u.id } },
      success_url: `${base}/app?billing=success`,
      cancel_url: `${base}/app?billing=cancel`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Could not start checkout." },
      { status: 500 }
    );
  }
}
