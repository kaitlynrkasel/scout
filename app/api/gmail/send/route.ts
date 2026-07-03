import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { gmailSendOrDraft } from "@/lib/gmail";

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

  try {
    const result = await gmailSendOrDraft({
      refreshToken: data.refresh_token,
      from: data.email || "me",
      to: String(to),
      subject: String(subject || ""),
      body: String(body || ""),
      mode,
      threadId: threadId ? String(threadId) : undefined,
      attachment: att,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Gmail request failed." },
      { status: 502 }
    );
  }
}
