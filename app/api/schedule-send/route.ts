import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 30;

// Queue an outreach message for future sending via Gmail or Outlook. The cron
// endpoint (/api/cron/send-scheduled) picks these up when send_at <= now().
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const {
    provider,
    to,
    subject,
    body: messageBody,
    sendAt,
    findId,
    opportunityId,
    attachment,
    isFollowup,
    threadId,
  } = body || {};

  if (provider !== "gmail" && provider !== "outlook") {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }
  if (!to || !subject || !messageBody) {
    return NextResponse.json(
      { error: "Missing recipient, subject, or message body." },
      { status: 400 }
    );
  }
  const sendAtDate = sendAt ? new Date(sendAt) : null;
  if (!sendAtDate || Number.isNaN(sendAtDate.getTime())) {
    return NextResponse.json({ error: "Invalid send time." }, { status: 400 });
  }
  // Guard against absurd future dates, a year is more than enough headroom for
  // outreach; anything past that is almost certainly a typo.
  const oneYear = 365 * 86400 * 1000;
  if (sendAtDate.getTime() > Date.now() + oneYear) {
    return NextResponse.json(
      { error: "That send time is more than a year out." },
      { status: 400 }
    );
  }

  // Confirm the user actually has that provider connected, no point queueing
  // a message we couldn't send when the cron fires.
  const conn = await supabaseAdmin
    .from(provider === "gmail" ? "gmail_connections" : "outlook_connections")
    .select("refresh_token")
    .eq("user_id", uid)
    .maybeSingle();
  if (!conn.data?.refresh_token) {
    return NextResponse.json(
      { error: `Connect ${provider === "gmail" ? "Gmail" : "Outlook"} first.` },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("scheduled_sends")
    .insert({
      user_id: uid,
      provider,
      to_addr: String(to),
      subject: String(subject),
      body: String(messageBody),
      send_at: sendAtDate.toISOString(),
      find_id: findId ? String(findId) : null,
      opportunity_id: opportunityId ? String(opportunityId) : null,
      attachment: attachment && attachment.dataUrl ? attachment : null,
      is_followup: !!isFollowup,
      thread_id: threadId ? String(threadId) : null,
    })
    .select("id, send_at")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Failed to schedule: ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, id: data.id, sendAt: data.send_at });
}
