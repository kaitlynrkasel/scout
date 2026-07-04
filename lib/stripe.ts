// Server-only Stripe client + tier configuration. NEVER import from a client
// component. Null when STRIPE_SECRET_KEY is unset (mirrors supabaseAdmin), so
// the app keeps building/running before billing is configured.

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY || "";

// Let the SDK use its pinned API version (don't hard-code one here).
export const stripe: Stripe | null = key ? new Stripe(key) : null;
export const stripeEnabled = !!key;

export type Tier = "free" | "starter" | "pro";
export type PaidTier = "starter" | "pro";

// The two paid plans. `priceEnvKey` names the env var holding that plan's Stripe
// price id; `limit` is the monthly search allowance; `price` is the USD/month.
export const TIERS: Record<
  PaidTier,
  { label: string; priceEnvKey: string; limit: number; price: number }
> = {
  starter: { label: "Starter", priceEnvKey: "STRIPE_PRICE_STARTER", limit: 30, price: 15 },
  pro: { label: "Pro", priceEnvKey: "STRIPE_PRICE_PRO", limit: 60, price: 30 },
};

// Free (non-subscriber) monthly search allowance.
export const FREE_LIMIT = 5;

export function priceIdForTier(tier: PaidTier): string | null {
  return process.env[TIERS[tier].priceEnvKey] || null;
}

// Map a Stripe price id back to our tier (used by the webhook).
export function tierForPriceId(priceId: string | null | undefined): PaidTier | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

export function limitForTier(tier: Tier): number {
  if (tier === "starter" || tier === "pro") return TIERS[tier].limit;
  return 0;
}

// The base URL for Checkout/Portal redirects. Prefer the configured public URL,
// else fall back to the request origin.
export function appBaseUrl(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}
