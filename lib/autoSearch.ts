// Signed, no-login action tokens for the auto-search digest emails. Each find's
// Approve / Not-a-fit link carries one of these, so a tap from the inbox records
// the decision without a session. HMAC-signed with the cron secret so links
// can't be forged.

import crypto from "crypto";

function secret(): string {
  return (
    process.env.ACTION_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "scout-action-secret"
  );
}

export type AutoAction = "approve" | "deny";

// Sign { auto_find id, action } into a compact, URL-safe token.
export function signAction(findId: string, action: AutoAction): string {
  const payload = Buffer.from(JSON.stringify({ f: findId, a: action })).toString(
    "base64url"
  );
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAction(
  token: string
): { findId: string; action: AutoAction } | null {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { f, a: action } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!f || (action !== "approve" && action !== "deny")) return null;
    return { findId: String(f), action };
  } catch {
    return null;
  }
}

// When the next run should fire, given a cadence and the moment it just ran.
export function nextRunAt(cadence: string, from: Date): Date {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + (cadence === "weekly" ? 7 : 1));
  return d;
}
