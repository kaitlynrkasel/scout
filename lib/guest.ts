// Anonymous "no account" trial metering. A guest can run a few searches per IP
// per day before we ask them to create an account — enough to feel the value,
// capped so anonymous traffic can't run up Tavily/Claude cost. Backed by the
// `guest_searches` table (service role only); see supabase/guest_searches.sql.

import { supabaseAdmin } from "./supabaseAdmin";

export const GUEST_DAILY_CAP = 3;

// Best-effort client IP from the proxy headers Vercel sets.
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  const first = fwd.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Read-only pre-check: does this IP still have trial searches left today?
export async function guestSearchAllowed(ip: string): Promise<boolean> {
  if (!supabaseAdmin) return true; // unmetered when there's no service role
  const { data } = await supabaseAdmin
    .from("guest_searches")
    .select("count")
    .eq("ip", ip)
    .eq("day", today())
    .maybeSingle();
  return Number(data?.count || 0) < GUEST_DAILY_CAP;
}

// Record a successful guest search (increment today's counter for this IP).
export async function recordGuestSearch(ip: string): Promise<void> {
  if (!supabaseAdmin) return;
  const day = today();
  const { data } = await supabaseAdmin
    .from("guest_searches")
    .select("count")
    .eq("ip", ip)
    .eq("day", day)
    .maybeSingle();
  const next = Number(data?.count || 0) + 1;
  await supabaseAdmin
    .from("guest_searches")
    .upsert(
      { ip, day, count: next, updated_at: new Date().toISOString() },
      { onConflict: "ip,day" }
    );
}
