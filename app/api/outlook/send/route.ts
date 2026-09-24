import { NextRequest, NextResponse } from "next/server";
import { signUnsub } from "@/lib/unsubscribe";
import { reqOrigin } from "@/lib/gmail";
import { humanHtml, needsHtml } from "@/lib/emailHtml";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { outlookSendOrDraft } from "@/lib/outlook";

export const runtime = "nodejs";
export const maxDuration = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Create a draft in the user's Outlook (or send it), from their connected address.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { to, subject, body, cc, mode: modeOverride, attachment, attachments } = await req.json();
  if (!to || !EMAIL_RE.test(String(to))) {
    return NextResponse.json(
      { error: "This draft has no email address to send to." },
      { status: 400 }
    );
  }

  const { data } = await supabaseAdmin
    .from("outlook_connections")
    .select("email, refresh_token, send_mode")
    .eq("user_id", uid)
    .maybeSingle();
  if (!data?.refresh_token) {
    return NextResponse.json({ error: "Connect Outlook first." }, { status: 400 });
  }

  const mode =
    modeOverride === "send" || modeOverride === "draft"
      ? modeOverride
      : data.send_mode === "send"
      ? "send"
      : "draft";

  // Cold outreach carries the same header-only opt-out as Gmail sends: the
  // one-click unsubscribe lives in the header, never as a visible footer.
  const recipient = String(to).toLowerCase();
  const token = signUnsub(uid, recipient);
  const unsubUrl = `${reqOrigin(req)}/api/unsubscribe?t=${encodeURIComponent(token)}`;
  const listUnsubscribe = `<${unsubUrl}>, <mailto:${data.email || "me"}?subject=unsubscribe>`;

  const rawList = (
    Array.isArray(attachments) ? attachments : attachment ? [attachment] : []
  ).slice(0, 8);
  const atts: { name: string; mime: string; dataBase64: string }[] = [];
  let attTotal = 0;
  for (const a of rawList) {
    if (!a || !a.dataUrl) continue;
    const m2 = String(a.dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
    const base64 = m2 ? m2[2] : String(a.dataUrl).replace(/^data:[^,]*,/, "");
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
      mime: (m2 && m2[1]) || a.mime || "application/octet-stream",
      dataBase64: base64,
    });
  }

  try {
    const result = await outlookSendOrDraft({
      refreshToken: data.refresh_token,
      to: String(to),
      cc: String(cc || "") || undefined,
      subject: String(subject || ""),
      body: String(body || ""),
      html: needsHtml(String(body || "")) ? humanHtml(String(body || "")) : undefined,
      mode,
      listUnsubscribe,
      attachments: atts.length ? atts : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Outlook request failed." },
      { status: 502 }
    );
  }
}
