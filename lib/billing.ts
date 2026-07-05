// Server-only billing helpers: read a user's entitlement, meter a search, and
// get-or-create their Stripe customer. All writes use the service-role client
// (bypasses RLS); the metering itself runs inside the atomic `consume_search`
// Postgres function so concurrent searches can't overrun a limit.

import { supabaseAdmin } from "./supabaseAdmin";
import {
  stripe,
  FREE_LIMIT,
  limitForTier,
  isCompSubscription,
  COMP_TAG,
  COMP_LIMIT,
  type Tier,
} from "./stripe";

export { FREE_LIMIT };

export interface Entitlement {
  tier: Tier;
  status: string;
  comp: boolean; // free-forever access via a redeemed code (unlimited searches)
  searchLimit: number; // paid monthly allowance (0 for free)
  searchesUsed: number; // consumed this billing period
  freeLimit: number; // free monthly allowance
  freeUsed: number; // consumed this calendar month (non-subscribers)
  periodEnd: string | null; // paid period end (ISO)
  freeResetsAt: string | null; // start of next calendar month (ISO), for free users
  stripeCustomerId: string | null;
}

// Start of next calendar month in UTC (when a non-subscriber's free searches reset).
function nextMonthStartISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

const FREE_ENTITLEMENT = (customerId: string | null = null): Entitlement => ({
  tier: "free",
  status: "inactive",
  comp: false,
  searchLimit: 0,
  searchesUsed: 0,
  freeLimit: FREE_LIMIT,
  freeUsed: 0,
  periodEnd: null,
  freeResetsAt: nextMonthStartISO(),
  stripeCustomerId: customerId,
});

// Read the user's current plan + usage. Defaults to the free tier when no row
// exists yet or Supabase isn't configured.
export async function getEntitlement(uid: string): Promise<Entitlement> {
  if (!supabaseAdmin) return FREE_ENTITLEMENT();
  const { data } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "tier, status, search_limit, searches_used, free_searches_used, period_end, stripe_customer_id, stripe_subscription_id"
    )
    .eq("user_id", uid)
    .maybeSingle();
  if (!data) return FREE_ENTITLEMENT();
  const comp = isCompSubscription(data.stripe_subscription_id);
  const tier = (data.tier || "free") as Tier;
  const isPaid = (tier === "starter" || tier === "pro") && data.status === "active";
  return {
    tier,
    status: data.status || "inactive",
    comp,
    searchLimit: isPaid ? data.search_limit || limitForTier(tier) : 0,
    searchesUsed: data.searches_used || 0,
    freeLimit: FREE_LIMIT,
    freeUsed: data.free_searches_used || 0,
    periodEnd: isPaid ? data.period_end || null : null,
    freeResetsAt: isPaid ? null : nextMonthStartISO(),
    stripeCustomerId: data.stripe_customer_id || null,
  };
}

// Grant free-forever (comp) access: store a 'pro'/'active' subscription tagged
// so it's unlimited and distinguishable from a real Stripe subscription. No
// migration needed — reuses existing columns. Idempotent per user.
export async function redeemComp(uid: string, code: string): Promise<string | null> {
  if (!supabaseAdmin) return "Accounts aren't configured yet.";
  const { error } = await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: uid,
      tier: "pro",
      status: "active",
      search_limit: COMP_LIMIT,
      searches_used: 0,
      stripe_subscription_id: `${COMP_TAG}${code.trim()}`,
      period_end: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    console.error("redeemComp failed:", error.message);
    return error.message;
  }
  return null;
}

export interface ConsumeResult {
  allowed: boolean;
  reason: "" | "quota" | "free_exhausted";
  tier: Tier;
  searchesUsed: number;
  searchLimit: number;
  freeUsed: number;
}

// Atomically meter one search. When Supabase isn't configured, allow (dev).
export async function consumeSearch(uid: string): Promise<ConsumeResult> {
  if (!supabaseAdmin) {
    return { allowed: true, reason: "", tier: "free", searchesUsed: 0, searchLimit: 0, freeUsed: 0 };
  }
  const { data, error } = await supabaseAdmin.rpc("consume_search", {
    p_user: uid,
    p_free_limit: FREE_LIMIT,
  });
  if (error || !data || !data.length) {
    throw new Error(error?.message || "Could not meter this search.");
  }
  const row = data[0];
  return {
    allowed: !!row.allowed,
    reason: (row.reason || "") as ConsumeResult["reason"],
    tier: (row.tier || "free") as Tier,
    searchesUsed: row.searches_used || 0,
    searchLimit: row.search_limit || 0,
    freeUsed: row.free_used || 0,
  };
}

// Return the user's Stripe customer id, creating (and persisting) one if needed.
export async function getOrCreateCustomer(uid: string, email: string): Promise<string> {
  if (!stripe || !supabaseAdmin) throw new Error("Billing is not configured.");
  const { data } = await supabaseAdmin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", uid)
    .maybeSingle();
  if (data?.stripe_customer_id) return data.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { user_id: uid },
  });
  await supabaseAdmin
    .from("subscriptions")
    .upsert(
      { user_id: uid, stripe_customer_id: customer.id, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  return customer.id;
}
