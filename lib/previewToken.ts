// Short-lived signed tokens gating /api/site-preview. The preview loads in an
// <iframe>, which can't carry an Authorization header, so the client mints a
// token from the auth'd /api/preview-token route and appends it to the iframe
// URL. Keeps the proxy usable for signed-in users while closing it as an open
// proxy for everyone else. HMAC + expiry only, no per-URL scoping needed: the
// capability being protected is "may proxy through us at all".

import crypto from "crypto";

function secret(): string {
  return (
    process.env.ACTION_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "dev-secret"
  );
}

export const PREVIEW_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h; client refreshes sooner

export function signPreviewToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: String(userId), e: Date.now() + PREVIEW_TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyPreviewToken(token: string): boolean {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return false;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof e === "number" && e > Date.now();
  } catch {
    return false;
  }
}
