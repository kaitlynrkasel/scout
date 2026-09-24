import { NextRequest, NextResponse } from "next/server";
import { humanHtml, needsHtml } from "@/lib/emailHtml";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { gmailSendOrDraft, reqOrigin } from "@/lib/gmail";
import { signUnsub } from "@/lib/unsubscribe";

export const runtime = "nodejs";
export const maxDuration = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Create a draft in the user's Gmail (or send it), from their connected address.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { to, subject, body, cc, mode: modeOverride, threadId, attachment, attachments } = await req.json();
  // CC is optional; when present every address must parse, or the whole send
  // aborts (a silently dropped CC would lie about who saw the message).
  const ccStr = String(cc || "")
    .split(/[,;\s]+/)
    .filter(Boolean)
    .join(", ");
  if (ccStr && !ccStr.split(", ").every((a) => EMAIL_RE.test(a))) {
    return NextResponse.json({ error: "One of the CC addresses doesn't look like an email." }, { status: 400 });
  }
  if (!to || !EMAIL_RE.test(String(to))) {
    return NextResponse.json(
      { error: "This draft has no email address to send to." },
      { status: 400 }
    );
  }

  // Optional attachments (song, press kit, resume). Accept data: URLs or raw
  // base64; legacy callers still send a single `attachment`. A combined
  // ~24MB base64 cap keeps the built message inside Gmail's limit.
  const rawList = (
    Array.isArray(attachments) ? attachments : attachment ? [attachment] : []
  ).slice(0, 8);
  const atts: { name: string; mime: string; dataBase64: string }[] = [];
  let attTotal = 0;
  for (const a of rawList) {
    if (!a || !a.dataUrl) continue;
    const m = String(a.dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
    const base64 = m ? m[2] : String(a.dataUrl).replace(/^data:[^,]*,/, "");
    if (!base64) continue;
    attTotal += base64.length;
    if (attTotal > 24_000_000) {
      return NextResponse.json(
        { error: "Attachments are too big together (about 18MB max). Drop one and try again." },
        { status: 400 }
      );
    }
    atts.push({
      name: String(a.name || "file"),
      mime: (m && m[1]) || a.mime || "application/octet-stream",
      dataBase64: base64,
    });
  }

  const { data } = await supabaseAdmin
    .from("gmail_connections")
    .select("email, refresh_token, send_mode")
    .eq("user_id", uid)
    .maybeSingle();
  if (!data?.refresh_token) {
    return NextResponse.json({ error: "Connect Gmail first." }, { status: 400 });
  }

  const mode =
    modeOverride === "send" || modeOverride === "draft"
      ? modeOverride
      : data.send_mode === "send"
      ? "send"
      : "draft";

  const recipient = String(to).trim().toLowerCase();

  // Honor prior opt-outs: if this recipient unsubscribed from your outreach,
  // don't send or draft to them again. Fail open if the table isn't set up yet
  // (see supabase/unsubscribes.sql) so sending is never blocked by a missing
  // migration.
  try {
    const { data: sup } = await supabaseAdmin
      .from("unsubscribes")
      .select("email")
      .eq("user_id", uid)
      .eq("email", recipient)
      .maybeSingle();
    if (sup) {
      return NextResponse.json(
        { error: "This person opted out of your outreach, so Scout won't message them again." },
        { status: 409 }
      );
    }
  } catch {
    /* table not present yet — allow the send */
  }

  // First contact (no threadId) is cold outreach: attach a standard opt-out. A
  // reply inside an existing thread doesn't need one.
  const isColdOutreach = !threadId;
  const fromAddr = data.email || "me";
  let outBody = String(body || "");
  let listUnsubscribe: string | undefined;
  if (isColdOutreach) {
    const token = signUnsub(uid, recipient);
    const url = `${reqOrigin(req)}/api/unsubscribe?t=${encodeURIComponent(token)}`;
    listUnsubscribe = `<${url}>, <mailto:${fromAddr}?subject=unsubscribe>`;
    // No visible unsubscribe line in the body: a token URL under a personal
    // note reads as bulk mail and kills the human register. The one-click
    // opt-out lives in the List-Unsubscribe header instead, which Gmail and
    // friends surface as their own Unsubscribe control; opt-outs still land
    // in the suppression table and are honored before every send.
  }

  try {
    const result = await gmailSendOrDraft({
      refreshToken: data.refresh_token,
      from: fromAddr,
      to: String(to),
      cc: ccStr || undefined,
      subject: String(subject || ""),
      body: outBody,
      mode,
      threadId: threadId ? String(threadId) : undefined,
      attachments: atts.length ? atts : undefined,
      listUnsubscribe,
      // Links in the note become real hyperlinks; attachments keep the plain
      // part (the multipart builder has no HTML branch).
      html: !atts.length && needsHtml(outBody) ? humanHtml(outBody) : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Gmail request failed." },
      { status: 502 }
    );
  }
}
