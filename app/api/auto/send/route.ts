import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { verifyAction } from "@/lib/autoSearch";
import { gmailSendOrDraft } from "@/lib/gmail";
import { outlookSendOrDraft } from "@/lib/outlook";
import type { Opportunity } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Send (or save as a draft) the edited message for an approved digest contact,
// via the user's own connected mailbox. Authorized by the signed email token;
// the user has explicitly edited and clicked Send/Save on the /auto/draft page.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = verifyAction(String(body?.t || ""));
  if (!parsed) return NextResponse.json({ error: "This link couldn't be verified." }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Not configured." }, { status: 500 });

  const mode: "send" | "draft" = body?.mode === "draft" ? "draft" : "send";
  const subject = String(body?.subject || "").slice(0, 300);
  const messageBody = String(body?.body || "");
  if (!messageBody.trim()) return NextResponse.json({ error: "The message is empty." }, { status: 400 });

  const { findId } = parsed;
  const { data: row } = await supabaseAdmin
    .from("auto_finds")
    .select("id, user_id, opp")
    .eq("id", findId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "That find is no longer available." }, { status: 404 });

  const opp = ((row as any).opp || {}) as Opportunity;
  const uid = (row as any).user_id as string;
  const to = String(opp.contactEmail || "").trim();
  if (!to || !/.+@.+\..+/.test(to)) {
    return NextResponse.json(
      { error: "This contact has no email, so Scout can't send it. Copy the message and reach out on their channel." },
      { status: 400 }
    );
  }

  // The user's connected mailbox (Gmail preferred, else Outlook).
  const gmail = await supabaseAdmin
    .from("gmail_connections")
    .select("email, refresh_token")
    .eq("user_id", uid)
    .maybeSingle();
  const outlook = gmail.data?.refresh_token
    ? { data: null as any }
    : await supabaseAdmin
        .from("outlook_connections")
        .select("email, refresh_token")
        .eq("user_id", uid)
        .maybeSingle();

  try {
    if (gmail.data?.refresh_token) {
      await gmailSendOrDraft({
        refreshToken: gmail.data.refresh_token as string,
        from: (gmail.data.email as string) || "me",
        to,
        subject: subject || `Hello from ${opp.name || "Scout"}`,
        body: messageBody,
        mode,
      });
    } else if (outlook.data?.refresh_token) {
      await outlookSendOrDraft({
        refreshToken: outlook.data.refresh_token as string,
        to,
        subject: subject || `Hello`,
        body: messageBody,
        mode,
      });
    } else {
      return NextResponse.json(
        { error: "No mailbox connected. Connect Gmail or Outlook in Scout first." },
        { status: 400 }
      );
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Send failed." }, { status: 500 });
  }

  await supabaseAdmin
    .from("auto_finds")
    .update({ status: "drafted", decided_at: new Date().toISOString() })
    .eq("id", findId);

  return NextResponse.json({ ok: true, mode, to });
}
