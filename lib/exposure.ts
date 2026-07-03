// Anti-overexposure ledger: aggregate, cross-user record of which contacts have
// been reached, so Scout can stop surfacing a target once too many people have
// already contacted it (a hard cap). Server-only; uses the service role.
//
// Everything here degrades gracefully: if Supabase isn't configured or the
// target_contacts table doesn't exist yet, reads return "nothing capped" and
// writes are no-ops, so discovery keeps working normally.

import { supabaseAdmin } from "./supabaseAdmin";

// A target is hidden from NEW users once this many distinct users have contacted
// it within the window. Tuned low-ish so popular contacts spread instead of
// getting blasted; rare to hit with a small user base, bites as Scout scales.
export const EXPOSURE_CAP = 5;
export const EXPOSURE_WINDOW_DAYS = 30;

function normName(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function hostOf(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}

// A stable key identifying a contact across users. Prefer a real email; else the
// site host + name; else the name alone. Empty when there's nothing to key on.
export function targetKey(o: {
  contactEmail?: string;
  name?: string;
  outlet?: string;
  url?: string;
}): string {
  const email = String(o.contactEmail || "").trim().toLowerCase();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "email:" + email;
  const h = hostOf(o.url || "");
  const nm = normName(o.name || o.outlet || "");
  if (h && nm) return "site:" + h + "|" + nm;
  if (nm) return "name:" + nm;
  if (h) return "site:" + h;
  return "";
}

// Record that a user has contacted a target (idempotent per user+target).
export async function recordContact(userId: string, o: any): Promise<void> {
  if (!supabaseAdmin || !userId) return;
  const key = targetKey(o);
  if (!key) return;
  try {
    await supabaseAdmin.from("target_contacts").upsert(
      {
        target_key: key,
        user_id: userId,
        contacted_at: new Date().toISOString(),
        label: String(o?.name || o?.outlet || "").slice(0, 200) || null,
      },
      { onConflict: "target_key,user_id" }
    );
  } catch {
    // table missing / not configured: silently skip
  }
}

// Of the given keys, which are saturated — contacted by >= EXPOSURE_CAP distinct
// users within the window. Returns an empty set on any failure (fail-open).
export async function cappedKeys(keys: string[]): Promise<Set<string>> {
  const capped = new Set<string>();
  const uniq = Array.from(new Set(keys.filter(Boolean)));
  if (!supabaseAdmin || !uniq.length) return capped;
  try {
    const since = new Date(
      Date.now() - EXPOSURE_WINDOW_DAYS * 86400000
    ).toISOString();
    const { data, error } = await supabaseAdmin
      .from("target_contacts")
      .select("target_key, user_id")
      .in("target_key", uniq)
      .gte("contacted_at", since);
    if (error || !data) return capped;
    const byKey: Record<string, Set<string>> = {};
    for (const r of data as any[]) {
      (byKey[r.target_key] ||= new Set()).add(r.user_id);
    }
    for (const k of Object.keys(byKey)) {
      if (byKey[k].size >= EXPOSURE_CAP) capped.add(k);
    }
  } catch {
    // fail-open: never block discovery on a ledger error
  }
  return capped;
}
