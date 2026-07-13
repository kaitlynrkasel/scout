import crypto from "crypto";

// Signed, tamper-proof unsubscribe tokens. A recipient's one-click / link
// unsubscribe carries (sender user id + recipient email); the token proves the
// link came from us so the opt-out can't be forged for arbitrary pairs. Reuses
// the same server secret family as the OAuth state signer.
const SECRET =
  process.env.UNSUBSCRIBE_SECRET || process.env.GOOGLE_CLIENT_SECRET || "scout-unsub-secret";

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

// Token binds the sender (user id) to the recipient email. No expiry: an
// unsubscribe link should keep working for as long as the recipient has the mail.
export function signUnsub(userId: string, email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, e: email.trim().toLowerCase() })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyUnsub(token: string): { userId: string; email: string } | null {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expect = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!u || !e) return null;
    return { userId: String(u), email: String(e) };
  } catch {
    return null;
  }
}
