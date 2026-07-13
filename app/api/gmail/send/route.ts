import { NextRequest, NextResponse } from "next/server";
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
  const { to, subject, body, mode: modeOverride, threadId, attachment } = await req.json();
  if (!to || !EMAIL_RE.test(String(to))) {
    return NextResponse.json(
      { error: "This draft has no email address to send to." },
      { status: 400 }
    );
  }

  // Optional attachment (e.g. the resume). Accept a data: URL or raw base64.
  let att: { name: string; mime: string; dataBase64: string } | undefined;
  if (attachment && attachment.dataUrl) {
    const m = String(attachment.dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
    const base64 = m ? m[2] : String(attachment.dataUrl).replace(/^data:[^,]*,/, "");
    // ~7MB base64 cap so we never build an oversized message.
    if (base64 && base64.length < 7_000_000) {
      att = {
        name: String(attachment.name || "resume.pdf"),
        mime: (m && m[1]) || attachment.mime || "application/pdf",
        dataBase64: base64,
      };
    }
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
    outBody =
      outBody.replace(/\s+$/, "") +
      `\n\n—\nNot the right time? You can unsubscribe and I won't reach out again: ${url}`;
  }

  try {
    const result = await gmailSendOrDraft({
      refreshToken: data.refresh_token,
      from: fromAddr,
      to: String(to),
      subject: String(subject || ""),
      body: outBody,
      mode,
      threadId: threadId ? String(threadId) : undefined,
      attachment: att,
      listUnsubscribe,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Gmail request failed." },
      { status: 502 }
    );
  }
}
