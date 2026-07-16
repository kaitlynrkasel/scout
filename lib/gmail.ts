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

export interface MailAttachment {
  name: string;
  mime: string; // e.g. application/pdf
  dataBase64: string; // raw base64 (no data: prefix)
}

function buildRaw(
  from: string,
  to: string,
  subject: string,
  body: string,
  attachment?: MailAttachment,
  listUnsubscribe?: string,
  html?: string // when set (and no attachment), send text/html instead of plain
): string {
  const baseHeaders = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];
  // RFC 2369 / RFC 8058: a standard opt-out mail clients surface as a one-click
  // "Unsubscribe" control. Present only on first-contact outreach (callers pass
  // this for cold sends, not for replies inside an existing thread).
  if (listUnsubscribe) {
    baseHeaders.push(`List-Unsubscribe: ${listUnsubscribe}`);
    if (/^<https/i.test(listUnsubscribe)) {
      baseHeaders.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    }
  }

  // No attachment: a single-part message — HTML when the caller supplied a
  // rendered body (e.g. Scout's own notification emails), plain text otherwise.
  if (!attachment) {
    const msg =
      [
        ...baseHeaders,
        html ? 'Content-Type: text/html; charset="UTF-8"' : 'Content-Type: text/plain; charset="UTF-8"',
      ].join("\r\n") +
      "\r\n\r\n" +
      (html || body);
    return Buffer.from(msg).toString("base64url");
  }

  // With an attachment: a multipart/mixed message (text part + file part).
  const boundary = "scout_boundary_" + Buffer.from(from + to).toString("hex").slice(0, 16);
  const safeName = attachment.name.replace(/["\\\r\n]/g, "_") || "resume.pdf";
  // Gmail wants base64 body lines wrapped at 76 chars.
  const wrapped = attachment.dataBase64.replace(/[\r\n]/g, "").replace(/.{1,76}/g, "$&\r\n");
  const parts = [
    baseHeaders.join("\r\n"),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
    `--${boundary}`,
    `Content-Type: ${attachment.mime || "application/octet-stream"}; name="${safeName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeName}"`,
    "",
    wrapped,
    `--${boundary}--`,
  ];
  return Buffer.from(parts.join("\r\n")).toString("base64url");
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
  threadId?: string; // when set, the message is placed in that existing thread
  attachment?: MailAttachment; // optional file (e.g. the user's resume)
  listUnsubscribe?: string; // RFC 2369 List-Unsubscribe value for cold outreach
  html?: string; // rendered HTML body (notifications); body stays the text fallback
}): Promise<{ id: string; threadId: string; mode: "send" | "draft" }> {
  const at = await accessTokenFromRefresh(opts.refreshToken);
  const raw = buildRaw(
    opts.from,
    opts.to,
    opts.subject,
    opts.body,
    opts.attachment,
    opts.listUnsubscribe,
    opts.html
  );
  const url =
    opts.mode === "send"
      ? "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
      : "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
  // Threading a reply: Gmail associates the message with the thread when threadId
  // is on the message object (and the subject stays "Re: ...").
  const tid = opts.threadId || undefined;
  const payload =
    opts.mode === "send"
      ? { raw, ...(tid ? { threadId: tid } : {}) }
      : { message: { raw, ...(tid ? { threadId: tid } : {}) } };
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
// A delivery-failure message, not a real reply: sent by the mail system, or a
// classic bounce subject. Reading it as a "reply" would falsely mark dead
// addresses as answered and pollute outcome learning, so classify it apart.
function looksLikeBounce(from: string, subject: string): boolean {
  const f = from.toLowerCase();
  if (/mailer-daemon|postmaster@|mail delivery (subsystem|system)/i.test(f)) return true;
  return /(delivery (status notification|has failed|incomplete)|undeliverable|undelivered mail|address not found|returned to sender|failure notice|delivery failure|mail delivery failed|couldn'?t be delivered|message not delivered|550[ -])/i.test(
    subject
  );
}

export async function gmailThreadsWithReplies(
  refreshToken: string,
  userEmail: string,
  threadIds: string[]
): Promise<{ replied: Set<string>; bounced: Set<string> }> {
  const at = await accessTokenFromRefresh(refreshToken);
  const me = userEmail.toLowerCase();
  const replied = new Set<string>();
  const bounced = new Set<string>();
  for (const tid of threadIds.slice(0, 20)) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(
        tid
      )}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { authorization: `Bearer ${at}` } }
    );
    if (r.status === 403) {
      const body = await r.text();
      throw Object.assign(new Error("insufficient scope: " + body), {
        needsReconnect: true,
      });
    }
    if (!r.ok) continue; // thread gone/inaccessible, skip, don't fail the batch
    const j = await r.json();
    const msgs = j.messages || [];
    let realReply = false;
    let bounce = false;
    for (const m of msgs) {
      if ((m.labelIds || []).includes("DRAFT")) continue;
      const headers = m.payload?.headers || [];
      const hv = (name: string) =>
        String(headers.find((h: any) => (h.name || "").toLowerCase() === name)?.value || "");
      const from = hv("from");
      if (!from || from.toLowerCase().includes(me)) continue; // our own message
      if (looksLikeBounce(from, hv("subject"))) bounce = true;
      else realReply = true;
    }
    // A genuine reply wins over a bounce (bounced once, then replied elsewhere).
    if (realReply) replied.add(tid);
    else if (bounce) bounced.add(tid);
  }
  return { replied, bounced };
}
