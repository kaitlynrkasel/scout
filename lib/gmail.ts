// Gmail OAuth + send/draft, server-side only. Dependency-free (raw REST calls).
// Flow: user authorizes -> we store their refresh token -> we mint a short-lived
// access token per action and either create a draft in their inbox or send.

import crypto from "crypto";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
// openid+email let us learn which address connected; gmail.compose covers both
// creating drafts and sending; gmail.metadata lets us read thread HEADERS only
// (never message bodies) to detect replies for reply tracking.
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.metadata",
];

const STATE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "scout-state-secret";

// The public origin of the current request (matches a registered redirect URI).
export function reqOrigin(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const proto =
    req.headers.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export function redirectUri(origin: string): string {
  return `${origin}/api/gmail/callback`;
}

// Signed, short-lived state that carries the user id through the OAuth round-trip.
export function signState(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, t: Date.now() })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", STATE_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string): string | null {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto
    .createHmac("sha256", STATE_SECRET)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, t } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() - t > 15 * 60 * 1000) return null; // 15-minute window
    return u || null;
  } catch {
    return null;
  }
}

export function authUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // we want a refresh token
    prompt: "consent", // force the refresh token every time
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

export async function exchangeCode(origin: string, code: string): Promise<any> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token exchange failed: " + (await r.text()));
  return r.json();
}

export async function accessTokenFromRefresh(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    grant_type: "refresh_token",
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token refresh failed: " + (await r.text()));
  const j = await r.json();
  return j.access_token as string;
}

// Pull the connected email out of the id_token (no network call needed).
export function emailFromIdToken(idToken: string): string {
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString());
    return json.email || "";
  } catch {
    return "";
  }
}

// Encode a subject header if it has non-ASCII characters (RFC 2047).
function encodeHeader(v: string): string {
  return /[^\x00-\x7F]/.test(v)
    ? `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`
    : v;
}

function buildRaw(
  from: string,
  to: string,
  subject: string,
  body: string
): string {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  const msg = headers.join("\r\n") + "\r\n\r\n" + body;
  return Buffer.from(msg).toString("base64url");
}

// Create a draft in the user's inbox, or send outright. Returns the Gmail
// thread id so replies in that thread can be detected later.
export async function gmailSendOrDraft(opts: {
  refreshToken: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  mode: "send" | "draft";
}): Promise<{ id: string; threadId: string; mode: "send" | "draft" }> {
  const at = await accessTokenFromRefresh(opts.refreshToken);
  const raw = buildRaw(opts.from, opts.to, opts.subject, opts.body);
  const url =
    opts.mode === "send"
      ? "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
      : "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
  const payload = opts.mode === "send" ? { raw } : { message: { raw } };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${at}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("gmail api failed: " + (await r.text()));
  const j = await r.json();
  return {
    id: j.id || j.message?.id || "",
    threadId: j.threadId || j.message?.threadId || "",
    mode: opts.mode,
  };
}

// Which of these threads have a reply (a message from someone other than the
// user)? Uses metadata-only reads: headers, never bodies.
export async function gmailThreadsWithReplies(
  refreshToken: string,
  userEmail: string,
  threadIds: string[]
): Promise<Set<string>> {
  const at = await accessTokenFromRefresh(refreshToken);
  const me = userEmail.toLowerCase();
  const replied = new Set<string>();
  for (const tid of threadIds.slice(0, 20)) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(
        tid
      )}?format=metadata&metadataHeaders=From`,
      { headers: { authorization: `Bearer ${at}` } }
    );
    if (r.status === 403) {
      const body = await r.text();
      throw Object.assign(new Error("insufficient scope: " + body), {
        needsReconnect: true,
      });
    }
    if (!r.ok) continue; // thread gone/inaccessible — skip, don't fail the batch
    const j = await r.json();
    const msgs = j.messages || [];
    const hasReply = msgs.some((m: any) => {
      if ((m.labelIds || []).includes("DRAFT")) return false;
      const from = (m.payload?.headers || []).find(
        (h: any) => (h.name || "").toLowerCase() === "from"
      );
      return from && !String(from.value || "").toLowerCase().includes(me);
    });
    if (hasReply) replied.add(tid);
  }
  return replied;
}
