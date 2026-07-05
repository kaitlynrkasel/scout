// Outlook / Microsoft 365 OAuth + send/draft, server-side only. Dependency-free
// (raw REST calls to the Microsoft identity platform + Microsoft Graph). Mirrors
// lib/gmail.ts: user authorizes -> we store their refresh token -> we mint a
// short-lived access token per action and either create a draft or send.

import crypto from "crypto";

// "common" supports both personal Outlook.com and work/school accounts.
const TENANT = process.env.MICROSOFT_TENANT || "common";
const MS_AUTH = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const MS_TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";

// openid/email/profile identify the connected address; offline_access yields a
// refresh token; Mail.ReadWrite covers creating drafts; Mail.Send covers sending.
const SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "Mail.ReadWrite",
  "Mail.Send",
];

const STATE_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "scout-state-secret";

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
  return `${origin}/api/outlook/callback`;
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
    client_id: process.env.MICROSOFT_CLIENT_ID || "",
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    response_mode: "query",
    // No forced `prompt`: Microsoft shows the permission ("grant access") screen
    // only the first time these scopes are granted, then relies on SSO for later
    // connects instead of re-requesting access every time. The refresh token is
    // guaranteed by the `offline_access` scope, not by prompting for consent.
    state,
  });
  return `${MS_AUTH}?${p.toString()}`;
}

export async function exchangeCode(origin: string, code: string): Promise<any> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.MICROSOFT_CLIENT_ID || "",
    client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
    scope: SCOPES.join(" "),
  });
  const r = await fetch(MS_TOKEN, {
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
    client_id: process.env.MICROSOFT_CLIENT_ID || "",
    client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
    grant_type: "refresh_token",
    scope: SCOPES.join(" "),
  });
  const r = await fetch(MS_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token refresh failed: " + (await r.text()));
  const j = await r.json();
  return j.access_token as string;
}

// Pull the connected email out of the id_token (no network call needed).
// Personal accounts expose `email`; work/school accounts use `preferred_username`.
export function emailFromIdToken(idToken: string): string {
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString());
    return json.email || json.preferred_username || "";
  } catch {
    return "";
  }
}

function buildMessage(to: string, subject: string, body: string) {
  return {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: [{ emailAddress: { address: to } }],
  };
}

// Create a draft in the user's mailbox, or send outright. Returns the Graph
// conversation id (as threadId) so replies in that conversation can be detected.
export async function outlookSendOrDraft(opts: {
  refreshToken: string;
  to: string;
  subject: string;
  body: string;
  mode: "send" | "draft";
}): Promise<{ id: string; threadId: string; mode: "send" | "draft" }> {
  const at = await accessTokenFromRefresh(opts.refreshToken);
  // Always create the draft first (gives us id + conversationId), then send it
  // when in send mode. This keeps a copy in Sent Items and yields a thread id.
  const create = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
    body: JSON.stringify(buildMessage(opts.to, opts.subject, opts.body)),
  });
  if (!create.ok) throw new Error("graph draft failed: " + (await create.text()));
  const msg = await create.json();
  const id = msg.id || "";
  const threadId = msg.conversationId || "";

  if (opts.mode === "send") {
    const sent = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${at}` },
    });
    if (!sent.ok) throw new Error("graph send failed: " + (await sent.text()));
  }

  return { id, threadId, mode: opts.mode };
}

// Which of these conversations have a reply (a message from someone other than the
// user)? Reads only From + isDraft on the messages in each conversation, via the
// Mail.ReadWrite scope the connection already has (no extra consent needed).
export async function outlookConversationsWithReplies(
  refreshToken: string,
  userEmail: string,
  conversationIds: string[]
): Promise<Set<string>> {
  const at = await accessTokenFromRefresh(refreshToken);
  const me = userEmail.toLowerCase();
  const replied = new Set<string>();
  for (const cid of conversationIds.slice(0, 20)) {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${cid.replace(/'/g, "''")}'`,
      $select: "from,isDraft,sentDateTime",
      $top: "25",
    });
    const r = await fetch(`${GRAPH}/me/messages?${params.toString()}`, {
      headers: { authorization: `Bearer ${at}` },
    });
    if (r.status === 403) {
      const body = await r.text();
      throw Object.assign(new Error("insufficient scope: " + body), {
        needsReconnect: true,
      });
    }
    if (!r.ok) continue; // conversation gone/inaccessible, skip, don't fail the batch
    const j = await r.json();
    const msgs = j.value || [];
    const hasReply = msgs.some((m: any) => {
      if (m.isDraft) return false;
      const addr = String(m.from?.emailAddress?.address || "").toLowerCase();
      return addr && addr !== me;
    });
    if (hasReply) replied.add(cid);
  }
  return replied;
}
