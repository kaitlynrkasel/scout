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
export const FREE_LIMIT = 3;

// --- Comp (free-forever) access codes -------------------------------------
// A redeemed code grants unlimited searches without going through Stripe. Used
// for the team's own accounts and hand-outs, so we don't pay for our own tool.
// BYLER1864! is always valid; COMP_CODES (comma-separated env) adds more.
const BUILTIN_COMP_CODES = ["BYLER1864!"];
export const COMP_CODES = [
  ...BUILTIN_COMP_CODES,
  ...(process.env.COMP_CODES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
];

// Case-insensitive match against the valid code list.
export function isCompCode(code: string): boolean {
  const norm = (code || "").trim().toLowerCase();
  return !!norm && COMP_CODES.some((c) => c.toLowerCase() === norm);
}

// COMPANY promo codes: an owner redeems one to comp their WHOLE team (every
// member gets free unlimited use). Distinct from the per-account COMP_CODES.
// COMPANY1864! is always valid; COMPANY_COMP_CODES (comma-separated env) adds more.
const BUILTIN_COMPANY_CODES = ["COMPANY1864!"];
export const COMPANY_COMP_CODES = [
  ...BUILTIN_COMPANY_CODES,
  ...(process.env.COMPANY_COMP_CODES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
];
export function isCompanyCompCode(code: string): boolean {
  const norm = (code || "").trim().toLowerCase();
  return !!norm && COMPANY_COMP_CODES.some((c) => c.toLowerCase() === norm);
}

// A comped account is stored as a 'pro' subscription whose subscription id is
// tagged 'comp:' so we can tell it apart from a real Stripe subscription (and
// show "unlimited" rather than a giant number in the UI).
export const COMP_TAG = "comp:";
export const COMP_LIMIT = 1_000_000; // effectively unlimited
export function isCompSubscription(subId?: string | null): boolean {
  return !!subId && subId.startsWith(COMP_TAG);
}

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
