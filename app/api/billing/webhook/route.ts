import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { stripe, tierForPriceId, limitForTier } from "@/lib/stripe";

// Stripe needs the raw body + Node runtime for signature verification.
export const runtime = "nodejs";

const toISO = (unix?: number | null) =>
  typeof unix === "number" ? new Date(unix * 1000).toISOString() : null;

// Figure out which Scout user a subscription belongs to: prefer metadata set at
// checkout, then the customer's metadata, then the stored customer→user mapping.
async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
  const fromSub = (sub.metadata && sub.metadata.user_id) || null;
  if (fromSub) return fromSub;
  try {
    const customer = await stripe!.customers.retrieve(sub.customer as string);
    if (customer && !("deleted" in customer && customer.deleted)) {
      const uid = (customer as Stripe.Customer).metadata?.user_id;
      if (uid) return uid;
    }
  } catch {
    /* fall through to the DB mapping */
  }
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from("subscriptions")
      .select("user_id")
      .eq("stripe_customer_id", sub.customer as string)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }
  return null;
}

// Upsert our row from a fresh Subscription object. Resets the period usage
// counter whenever the billing period advances (a renewal), but preserves it on
// mid-cycle plan changes (an upgrade should keep prior usage against the new,
// higher limit).
async function syncSubscription(subId: string) {
  if (!stripe || !supabaseAdmin) return;
  const sub = await stripe.subscriptions.retrieve(subId);
  const uid = await resolveUserId(sub);
  if (!uid) return;

  const priceId = sub.items.data[0]?.price?.id;
  const tier = tierForPriceId(priceId);
  if (!tier) return; // a price we don't recognize — ignore

  const periodStart = toISO((sub as any).current_period_start);
  const periodEnd = toISO((sub as any).current_period_end);

  const { data: existing } = await supabaseAdmin
    .from("subscriptions")
    .select("period_start")
    .eq("user_id", uid)
    .maybeSingle();
  const periodAdvanced = !existing?.period_start || existing.period_start !== periodStart;

  const row: Record<string, any> = {
    user_id: uid,
    stripe_customer_id: sub.customer as string,
    stripe_subscription_id: sub.id,
    tier,
    status: sub.status,
    search_limit: limitForTier(tier),
    period_start: periodStart,
    period_end: periodEnd,
    updated_at: new Date().toISOString(),
  };
  if (periodAdvanced) row.searches_used = 0;

  await supabaseAdmin.from("subscriptions").upsert(row, { onConflict: "user_id" });
}

async function downgrade(sub: Stripe.Subscription) {
  if (!supabaseAdmin) return;
  const uid = await resolveUserId(sub);
  if (!uid) return;
  await supabaseAdmin
    .from("subscriptions")
    .update({
      tier: "free",
      status: "canceled",
      search_limit: 0,
      stripe_subscription_id: null,
      period_start: null,
      period_end: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uid);
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!stripe || !secret) {
    return NextResponse.json({ error: "Billing is not configured." }, { status: 500 });
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (e: any) {
    return NextResponse.json({ error: `Invalid signature: ${e?.message}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.subscription) await syncSubscription(s.subscription as string);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub.id);
        break;
      }
      case "customer.subscription.deleted": {
        await downgrade(event.data.object as Stripe.Subscription);
        break;
      }
      case "invoice.paid": {
        // Renewal — re-sync to roll the period + reset the usage counter.
        const inv = event.data.object as Stripe.Invoice;
        const subId = (inv as any).subscription as string | null;
        if (subId) await syncSubscription(subId);
        break;
      }
      default:
        break;
    }
  } catch (e: any) {
    // Log and 500 so Stripe retries.
    console.error("Stripe webhook handler failed:", e?.message);
    return NextResponse.json({ error: "Handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
